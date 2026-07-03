// Thin GraphQL client for the Hadron server, plus the specific operations the
// extension needs. All calls attach the stored bearer token.
//
// Operations verified against hadron-server/src/api/graphql/schema
// (uniform read surface, hadron-server#473/#475 — paginated { items, total }
// envelopes, limit default 50 / cap 200):
//   memories        replaces myMemories (MemoriesPage envelope)
//   apps            replaces myApps (AppsPage envelope)
//   appNodes        unchanged
//   createNode / updateNode   resolvers.mutation.node.ts (spec 039 Phase 0,
//                             hadron-server#460 — upsertNode was removed)
//   runTask         resolvers.mutation.session.ts / typeDefs.ts:2132
//   globalSearch    resolvers.query.org.ts:145 (cross-entity search)
//   appNodes        (aggregated across the user's apps for the Tasks tab)
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

export async function listMemories() {
  return fetchAllItems(async (limit, offset) => {
    const data = await gql(
      `query($limit: Int, $offset: Int) {
         memories(limit: $limit, offset: $offset) {
           items { id urn name class shortDescription description }
           total
         }
       }`,
      { limit, offset },
    );
    return data?.memories;
  });
}

export async function listApps() {
  return fetchAllItems(async (limit, offset) => {
    const data = await gql(
      `query($limit: Int, $offset: Int) {
         apps(limit: $limit, offset: $offset) {
           items { id urn name appType }
           total
         }
       }`,
      { limit, offset },
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
 * Cross-entity search for the Find tab. Returns flat, ranked hits.
 * We pass explicit `fields` so free-text queries match node/description/content
 * too — the server's default smart-sniff only matches name + urn, which made
 * most searches come back empty. Fetches a larger page so the Find tab can
 * paginate client-side (page size 10) until server offset/total lands (#465).
 */
export async function globalSearch(query, { limit = 100 } = {}) {
  const data = await gql(
    `query($query: String!, $fields: [SearchField!], $limit: Int) {
       globalSearch(query: $query, fields: $fields, limit: $limit) {
         hits {
           entityType id urn name description matchedField score memoryId
         }
       }
     }`,
    { query, fields: ['name', 'description', 'content', 'urn'], limit },
  );
  return data?.globalSearch?.hits || [];
}

/**
 * Runnable task nodes for the Tasks tab. Aggregated across the user's apps
 * (appNodes → isRunnable), because app/agent task nodes live in memories that
 * the node-search surface (findNodes) excludes. Deduped by node id, each hit
 * tagged with the app it came from. (Will collapse to the paginated myTasks
 * query once hadron-server#464 ships.)
 */
export async function listTasks() {
  const apps = await listApps();
  const perApp = await Promise.all(
    apps.map(async (a) => {
      try {
        const tasks = await listAppTasks(a.id);
        return tasks.map((t) => ({ ...t, appName: a.name, appUrn: a.urn }));
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set();
  const out = [];
  for (const t of perApp.flat()) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
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
