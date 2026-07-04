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
//   createNode / updateNode   resolvers.mutation.node.ts (spec 039 Phase 0,
//                             hadron-server#460 — upsertNode was removed)
//   runTask         resolvers.mutation.session.ts / typeDefs.ts:2132
//   importNode      PLANNED — hadron-server#457 (not yet on the server)

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
    // Carry the server's typed-error code (e.g. NodeLocConflictError) so
    // callers can branch on it — createNode's re-clip fallback needs it.
    err.code = code;
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

// Node's `urn` field is being added server-side; query it optimistically and
// fall back if this server build doesn't expose it yet, so task rows light up
// the URN chip automatically once it ships (without breaking today).
let nodeHasUrn = true;
function taskNodeFields() {
  return `id loc name nodeType isRunnable memoryId${nodeHasUrn ? ' urn' : ''}`;
}

/** Runnable task nodes for an app (appNodes filtered to isRunnable). */
export async function listAppTasks(appId) {
  // Capture the flag up front: listTasks fires these concurrently, so a sibling
  // call may flip nodeHasUrn to false mid-flight — this one must still retry.
  const hadUrnAtStart = nodeHasUrn;
  const run = () =>
    gql(
      `query($appId: ID!) { appNodes(appId: $appId, limit: 200) { ${taskNodeFields()} } }`,
      { appId },
    );
  let data;
  try {
    data = await run();
  } catch (e) {
    if (hadUrnAtStart && /Cannot query field ["']?urn["']?/i.test(e?.message || '')) {
      nodeHasUrn = false; // this server doesn't expose Node.urn yet
      data = await run();
    } else {
      throw e;
    }
  }
  return (data?.appNodes || []).filter((n) => n.isRunnable);
}

/**
 * Save a node from captured web content. Upsert-shaped by design: a re-clip
 * of the same loc silently replaces the previous capture. The server's
 * upsertNode mutation was removed (spec 039 Phase 0, hadron-server#460), so
 * this is createNode with an updateNode fallback on the loc-collision error —
 * one round trip for the common first-clip case.
 * @param {object} p
 * @param {string} p.memoryId  memory id or fully-qualified URN
 * @param {string} p.loc       user-entered LOC/URN for the node
 * @param {string} p.name      display name (page title)
 * @param {string} p.content   URL string or full page HTML
 * @param {object} p.properties  unencrypted metadata ({ url, title, capturedAt, mode })
 */
export async function createNode({ memoryId, loc, name, content, properties }) {
  const NODE_FIELDS = 'id loc name nodeType memoryId';
  const input = {
    memoryId,
    loc,
    name,
    nodeType: 'webpage',
    content,
    properties,
  };
  try {
    const data = await gql(
      `mutation($input: CreateNodeInput!) {
         createNode(input: $input) { ${NODE_FIELDS} }
       }`,
      { input },
    );
    return data?.createNode;
  } catch (e) {
    if (e?.code !== 'NodeLocConflictError') throw e;
    // Re-clip: the node already exists — replace its content.
    const data = await gql(
      `mutation($input: UpdateNodeInput!) {
         updateNode(input: $input) { ${NODE_FIELDS} }
       }`,
      { input },
    );
    return data?.updateNode;
  }
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
           hits { node { id loc name nodeType abstract memoryId } }
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
 * Import content into Hadron via the planned `importNode` API
 * (hadron-server#457). Accepts EITHER a `url` (server fetches later) OR inline
 * `content`, plus the target node. NOTE: the server field does not exist yet,
 * so this currently errors ("Cannot query field importNode") — the UI surfaces
 * that gracefully. Once the field ships, this is the single import path.
 * @param {object} p
 * @param {string} p.memoryId
 * @param {string} p.loc
 * @param {string} p.name
 * @param {string} [p.url]         source URL (server-side fetch)
 * @param {string} [p.content]     inline content (file text or page HTML)
 * @param {string} [p.contentType] e.g. "text/html", "text/markdown", "application/pdf"
 * @param {object} [p.properties]
 * @param {string} [p.taskUrn]     optional runnable node to process the import
 */
export async function importNode({
  memoryId,
  loc,
  name,
  url,
  content,
  contentType,
  properties,
  taskUrn,
}) {
  // Enforce the documented contract client-side so a bad call fails with a
  // clear message instead of a server-side validation error.
  if (!!url === !!content) {
    throw new Error('importNode: provide exactly one of `url` or `content`.');
  }
  const data = await gql(
    `mutation($input: ImportNodeInput!) {
       importNode(input: $input) {
         node { id loc name nodeType memoryId }
         status
         jobId
       }
     }`,
    {
      input: {
        memoryId,
        loc,
        name,
        nodeType: 'webpage',
        url: url || null,
        content: content || null,
        contentType: contentType || null,
        properties: properties || null,
        taskUrn: taskUrn || null,
      },
    },
  );
  return data?.importNode;
}
