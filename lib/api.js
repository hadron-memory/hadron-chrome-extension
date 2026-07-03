// Thin GraphQL client for the Hadron server, plus the specific operations the
// extension needs. All calls attach the stored bearer token.
//
// Operations verified against hadron-server/src/api/graphql/schema:
//   myMemories      resolvers.query.memory.ts / typeDefs.ts:1855
//   myApps          resolvers.query.app.ts    / typeDefs.ts:1882
//   appNodes        typeDefs.ts:1900
//   upsertNode      resolvers.mutation.node.ts / typeDefs.ts:2061
//   runTask         resolvers.mutation.session.ts / typeDefs.ts:2132
//   globalSearch    resolvers.query.org.ts:145 (cross-entity search)
//   appNodes        (aggregated across myApps for the Tasks tab)
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
    throw new Error(first?.message || 'GraphQL error');
  }
  if (!res.ok || !payload) {
    throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}`);
  }
  return payload.data;
}

// ── operations ───────────────────────────────────────────────────────────────

export async function listMemories() {
  const data = await gql(
    `query { myMemories { id urn name class shortDescription description } }`,
  );
  return data?.myMemories || [];
}

export async function listApps() {
  const data = await gql(
    `query { myApps { id urn name appType } }`,
  );
  return data?.myApps || [];
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
  const run = () =>
    gql(
      `query($appId: ID!) { appNodes(appId: $appId, limit: 200) { ${taskNodeFields()} } }`,
      { appId },
    );
  let data;
  try {
    data = await run();
  } catch (e) {
    if (nodeHasUrn && /Cannot query field ["']?urn["']?/i.test(e?.message || '')) {
      nodeHasUrn = false; // this server doesn't expose Node.urn yet
      data = await run();
    } else {
      throw e;
    }
  }
  return (data?.appNodes || []).filter((n) => n.isRunnable);
}

/**
 * Create (upsert) a node from captured web content.
 * @param {object} p
 * @param {string} p.memoryId  memory id or fully-qualified URN
 * @param {string} p.loc       user-entered LOC/URN for the node
 * @param {string} p.name      display name (page title)
 * @param {string} p.content   URL string or full page HTML
 * @param {object} p.properties  unencrypted metadata ({ url, title, capturedAt, mode })
 */
export async function createNode({ memoryId, loc, name, content, properties }) {
  const data = await gql(
    `mutation($input: NodeInput!) {
       upsertNode(input: $input) {
         id loc name nodeType memoryId
       }
     }`,
    {
      input: {
        memoryId,
        loc,
        name,
        nodeType: 'webpage',
        content,
        properties,
        createOnly: false,
      },
    },
  );
  return data?.upsertNode;
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

/**
 * Cross-entity search for the Find tab. Returns flat, ranked hits.
 * We pass explicit `fields` so free-text queries match node/description/content
 * too — the server's default smart-sniff only matches name + urn, which made
 * most searches come back empty.
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
 * tagged with the app it came from.
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
