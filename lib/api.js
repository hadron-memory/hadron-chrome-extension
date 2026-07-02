// Thin GraphQL client for the Hadron server, plus the specific operations the
// extension needs. All calls attach the stored bearer token.
//
// Operations verified against hadron-server/src/api/graphql/schema:
//   myMemories      resolvers.query.memory.ts / typeDefs.ts:1855
//   myApps          resolvers.query.app.ts    / typeDefs.ts:1882
//   appNodes        typeDefs.ts:1900
//   createNode / updateNode   resolvers.mutation.node.ts (spec 039 Phase 0,
//                             hadron-server#460 — upsertNode was removed)
//   runTask         resolvers.mutation.session.ts / typeDefs.ts:2132
//   globalSearch    typeDefs.ts:1828 (cross-entity search)
//   findNodes       typeDefs.ts:1805 (runnable-task listing)
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

export async function listMemories() {
  const data = await gql(
    `query { myMemories { id urn name class } }`,
  );
  return data?.myMemories || [];
}

export async function listApps() {
  const data = await gql(
    `query { myApps { id urn name appType } }`,
  );
  return data?.myApps || [];
}

/** Runnable task nodes for an app (appNodes filtered to isRunnable). */
export async function listAppTasks(appId) {
  const data = await gql(
    `query($appId: ID!) {
       appNodes(appId: $appId, limit: 200) {
         id loc name nodeType isRunnable memoryId
       }
     }`,
    { appId },
  );
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
export async function runTask({ taskName, memory, args }) {
  const data = await gql(
    `mutation($task: String, $memory: String, $args: JSON) {
       runTask(task: $task, memory: $memory, args: $args)
     }`,
    { task: taskName, memory: memory || null, args: args || null },
  );
  return data?.runTask;
}

/** Cross-entity search for the Find tab. Returns flat, ranked hits. */
export async function globalSearch(query, { limit = 30 } = {}) {
  const data = await gql(
    `query($query: String!, $limit: Int) {
       globalSearch(query: $query, limit: $limit) {
         hits {
           entityType id urn name description matchedField score memoryId
         }
       }
     }`,
    { query, limit },
  );
  return data?.globalSearch?.hits || [];
}

/** Runnable task nodes across the caller's accessible memories (Tasks tab). */
export async function listTasks({ limit = 200 } = {}) {
  const data = await gql(
    `query($limit: Int) {
       findNodes(filter: { isRunnable: true }, limit: $limit) {
         hits {
           node { id loc name nodeType abstract memoryId }
         }
       }
     }`,
    { limit },
  );
  return (data?.findNodes?.hits || []).map((h) => h.node).filter(Boolean);
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
