// Thin GraphQL client for the Hadron server, plus the specific operations the
// extension needs. All calls attach the stored bearer token.
//
// Operations verified against hadron-server/src/api/graphql/schema:
//   myMemories      resolvers.query.memory.ts / typeDefs.ts:1855
//   myApps          resolvers.query.app.ts    / typeDefs.ts:1882
//   appNodes        typeDefs.ts:1900
//   upsertNode      resolvers.mutation.node.ts / typeDefs.ts:2061
//   runTask         resolvers.mutation.session.ts / typeDefs.ts:2132

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

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload) {
    throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}`);
  }
  if (payload.errors && payload.errors.length) {
    const first = payload.errors[0];
    const code = first?.extensions?.code;
    if (code === 'UNAUTHENTICATED' || /unauthenticated/i.test(first?.message || '')) {
      await clearToken();
      throw new UnauthorizedError(first.message);
    }
    throw new Error(first?.message || 'GraphQL error');
  }
  return payload.data;
}

// ── operations ───────────────────────────────────────────────────────────────

export async function listMemories() {
  const data = await gql(
    `query { myMemories { id urn name class } }`,
  );
  return data.myMemories || [];
}

export async function listApps() {
  const data = await gql(
    `query { myApps { id urn name appType } }`,
  );
  return data.myApps || [];
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
  return (data.appNodes || []).filter((n) => n.isRunnable);
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
  return data.upsertNode;
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
  return data.runTask;
}
