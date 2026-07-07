// Thin GraphQL client for the Hadron server, plus the specific operations the
// extension needs. All calls attach the stored bearer token.
//
// Operations verified against hadron-server/src/api/graphql/schema
// (uniform read surface, hadron-server#473/#475 — paginated { items, total }
// envelopes, limit default 50 / cap 200):
//   organizations   active-org switcher (OrganizationsPage envelope)
//   memories/apps   replace myMemories/myApps — paginated + orgId scope (#463)
//   globalSearch    cross-entity search — orgId + offset/total pagination (#465)
//   findNodes       Tasks tab (isRunnable nodes; #464 — no separate myTasks)
//   appNodes        Import app→task picker (per-app runnable nodes)
//   runTask         resolvers.mutation.session.ts / typeDefs.ts:2132
//   importNode      node writes — current-page + file import (#457,
//                   hadron-server#486 — spec cor:api:130)

import { GRAPHQL_ENDPOINT } from './config.js';
import { getStoredToken, clearToken } from './oauth.js';

/** Thrown when the server rejects the token (401 / auth error). */
export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

async function gql(query, variables) {
  const token = await getStoredToken();
  if (!token) throw new UnauthorizedError('Not signed in.');

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    await clearToken();
    throw new UnauthorizedError();
  }

  // Parse first so we can surface structured GraphQL errors even when the
  // HTTP status is non-2xx (e.g. a 400 carrying validation errors).
  const payload = await res.json().catch(() => null);
  if (payload?.errors && payload.errors.length) {
    const first = payload.errors[0];
    const code = first?.extensions?.code;
    if (code === 'UNAUTHENTICATED' || /unauthenticated/i.test(first?.message || '')) {
      await clearToken();
      throw new UnauthorizedError(first.message);
    }
    const err = new Error(first?.message || 'GraphQL error');
    err.code = code; // carry the server's typed-error code for callers to branch on
    throw err;
  }
  if (!res.ok || !payload) {
    throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}`);
  }
  return payload.data;
}

// ── operations ───────────────────────────────────────────────────────────────

// The uniform find-many queries (#473) return a paginated { items, total }
// envelope with limit capped server-side at 200. The popup expects COMPLETE
// lists (it filters/pages client-side, and listTasks aggregates across every
// app), so drain all pages here — the old myMemories/myApps were unbounded.
const PAGE_LIMIT = 200; // server cap
const MAX_PAGES = 50; // hard stop (10k entities) — guards against a buggy total

/**
 * Drain a paginated { items, total } envelope into a plain items array.
 * @param {(limit: number, offset: number) => Promise<{items?: object[], total?: number} | null | undefined>} fetchPage
 */
async function fetchAllItems(fetchPage) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const envelope = await fetchPage(PAGE_LIMIT, all.length);
    const items = envelope?.items || [];
    all.push(...items);
    const total = envelope?.total;
    if (
      items.length === 0 || // empty page: nothing more (and never loop on one)
      items.length < PAGE_LIMIT || // short page: this was the last one
      (Number.isFinite(total) && all.length >= total)
    ) {
      break;
    }
  }
  return all;
}

/**
 * The user's organizations, for the active-org switcher. `isVisible === null`
 * marks the personal org (single-active-org convention), used to pick a default.
 *
 * `filter.memberOnly: true` restricts to the caller's own memberships — a no-op
 * for regular users (that's already their scope) but essential for platform
 * ADMIN/OWNER accounts, whose unscoped reach would otherwise list every org.
 */
export async function listOrganizations() {
  return fetchAllItems(async (limit, offset) => {
    const data = await gql(
      `query($limit: Int, $offset: Int) {
         organizations(filter: { memberOnly: true }, limit: $limit, offset: $offset) {
           items { id name urn isVisible }
           total
         }
       }`,
      { limit, offset },
    );
    return data?.organizations;
  });
}

/** @param {string|null} [orgId] scope to a single organization (active-org switcher) */
export async function listMemories(orgId) {
  return fetchAllItems(async (limit, offset) => {
    const data = await gql(
      `query($orgId: ID, $limit: Int, $offset: Int) {
         memories(orgId: $orgId, limit: $limit, offset: $offset) {
           items { id urn name class shortDescription description }
           total
         }
       }`,
      { orgId: orgId || null, limit, offset },
    );
    return data?.memories;
  });
}

/** @param {string|null} [orgId] scope to a single organization */
export async function listApps(orgId) {
  return fetchAllItems(async (limit, offset) => {
    const data = await gql(
      `query($orgId: ID, $limit: Int, $offset: Int) {
         apps(orgId: $orgId, limit: $limit, offset: $offset) {
           items { id urn name appType }
           total
         }
       }`,
      { orgId: orgId || null, limit, offset },
    );
    return data?.apps;
  });
}

/**
 * Runnable task nodes an app can run on an imported node, for the Import task
 * picker.
 *
 * We deliberately DON'T use `appNodes` here: it gathers only the agents'
 * `memoryItems` and omits each agent's *system* memory, so a runnable task
 * authored in the system memory (the common case — e.g. `tasks:distill-…`) is
 * invisible. That's a server-side inconsistency (MCP access-control folds
 * `systemMemoryId` into the access map, but `appNodes` doesn't) tracked in a
 * hadron-server issue.
 *
 * Workaround: resolve the app's agents, collect their system + attached memory
 * IDs, and query those directly with `findNodes`. Naming a system memory in
 * `filter.memoryIds` overrides findNodes' default SYSTEM-class exclusion, and
 * the result is still intersected with the caller's own read access.
 */
export async function listAppTasks(appId) {
  const appData = await gql(
    `query($ref: ID!) {
       app(ref: $ref) {
         agents { id systemMemoryId memoryItems { memory { id } } }
       }
     }`,
    { ref: appId },
  );
  const agents = appData?.app?.agents || [];
  const memoryIds = [
    ...new Set(
      agents
        .flatMap((a) => [a?.systemMemoryId, ...(a?.memoryItems || []).map((m) => m?.memory?.id)])
        .filter(Boolean),
    ),
  ];
  if (memoryIds.length === 0) return [];

  const data = await gql(
    `query($memoryIds: [ID!], $limit: Int) {
       findNodes(filter: { memoryIds: $memoryIds, isRunnable: true }, limit: $limit) {
         hits { node { id loc name nodeType isRunnable memoryId urn } }
       }
     }`,
    { memoryIds, limit: 200 },
  );
  return (data?.findNodes?.hits || []).map((h) => h?.node).filter(Boolean);
}

/**
 * Kick off processing of a captured node by an app task.
 * runTask resolves a runnable node by name/urn and renders it with args.
 * We pass the created node's URN so the task can reference the content.
 * @param {object} p
 * @param {string} p.taskName   task node name (from listAppTasks)
 * @param {string} [p.memory]   memory hint (name or urn) for the task
 * @param {object} [p.args]     template args (e.g. { nodeUrn })
 */
export async function runTask({ taskName, memory, urn, args }) {
  const data = await gql(
    `mutation($task: String, $memory: String, $urn: String, $args: JSON) {
       runTask(task: $task, memory: $memory, urn: $urn, args: $args)
     }`,
    { task: taskName || null, memory: memory || null, urn: urn || null, args: args || null },
  );
  return data?.runTask;
}

/**
 * Cross-entity search for the Find tab — one page of ranked hits + the total.
 * We pass explicit `fields` so free-text queries match node/description/content
 * too (the server default matches only name + urn). Paginated server-side via
 * offset/limit (#465); `total` is bounded by the per-entity candidate cap.
 * @param {string} query
 * @param {{ orgId?: string|null, limit?: number, offset?: number }} [opts]
 * @returns {Promise<{ hits: object[], total: number }>}
 */
export async function globalSearch(query, { orgId = null, limit = 10, offset = 0 } = {}) {
  const data = await gql(
    `query($query: String!, $fields: [SearchField!], $orgId: ID, $limit: Int, $offset: Int) {
       globalSearch(query: $query, fields: $fields, orgId: $orgId, limit: $limit, offset: $offset) {
         hits {
           entityType id urn name description matchedField score memoryId
         }
         total
       }
     }`,
    { query, fields: ['name', 'description', 'content', 'urn'], orgId: orgId || null, limit, offset },
  );
  return { hits: data?.globalSearch?.hits || [], total: data?.globalSearch?.total ?? 0 };
}

/**
 * Runnable task nodes for the Tasks tab. Per hadron-server#464 there is no
 * separate `myTasks` surface — a task is simply an `isRunnable` node — so this
 * uses the uniform, org-scopable `findNodes(filter: { isRunnable: true })`.
 * Drained here (Tasks filters client-side); returns plain node objects.
 * @param {string|null} [orgId]
 */
export async function listTasks(orgId) {
  return fetchAllItems(async (limit, offset) => {
    const data = await gql(
      `query($orgId: ID, $limit: Int, $offset: Int) {
         findNodes(filter: { isRunnable: true }, orgId: $orgId, limit: $limit, offset: $offset) {
           hits { node { id loc name nodeType abstract memoryId urn } }
           total
         }
       }`,
      { orgId: orgId || null, limit, offset },
    );
    const page = data?.findNodes;
    // Adapt the { hits: [{ node }] } shape to fetchAllItems' { items, total }.
    return { items: (page?.hits || []).map((h) => h?.node).filter(Boolean), total: page?.total };
  });
}

/**
 * Import content into Hadron via the `importNode` API (hadron-server#457,
 * shipped by hadron-server#486 — spec cor:api:130). Accepts EITHER a `url`
 * (server-fetched synchronously in v1: SSRF-guarded, Readability-extracted,
 * no user credentials — authenticated pages must go through `content`) OR
 * inline `content`, plus the target node. Sync v1 always returns
 * status "STORED"; "FETCH_PENDING" + jobId are reserved for the future
 * async path. The old `taskUrn` hand-off was deferred server-side (D12) —
 * keep using runTask() separately for post-import processing.
 * @param {object} p
 * @param {string} p.memoryId
 * @param {string} p.loc
 * @param {string} [p.name]        optional — server falls back to the extracted title (and preserves an existing node's name on re-import)
 * @param {string} [p.url]         source URL (server-side fetch)
 * @param {string} [p.content]     inline content (file text or page HTML)
 * @param {string} [p.contentType] "text/html" (default) or "text/markdown"
 * @param {object} [p.properties]  merged; server records properties.url on the url path
 */
export async function importNode({
  memoryId,
  loc,
  name,
  url,
  content,
  contentType,
  properties,
}) {
  // Enforce the documented contract client-side so a bad call fails with a
  // clear message instead of a server-side validation error.
  if (!!url === !!content) {
    throw new Error('importNode: provide exactly one of `url` or `content`.');
  }
  const data = await gql(
    `mutation($input: ImportNodeInput!) {
       importNode(input: $input) {
         node { id loc name nodeType memoryId urn }
         status
         jobId
       }
     }`,
    {
      input: {
        memoryId,
        loc,
        name: name || null,
        nodeType: 'info',
        url: url || null,
        content: content || null,
        contentType: contentType || null,
        properties: properties || null,
      },
    },
  );
  return data?.importNode;
}
