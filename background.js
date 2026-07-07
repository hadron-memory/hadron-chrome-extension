// Service worker: the single owner of OAuth, network, and page capture.
// The popup is pure UI and talks to this worker over chrome.runtime messages.

import { signIn, signOut, isSignedIn } from './lib/oauth.js';
import {
  listOrganizations,
  listMemories,
  listApps,
  listAppTasks,
  listTasks,
  globalSearch,
  runTask,
  importNode,
  UnauthorizedError,
} from './lib/api.js';
import { capturePage } from './lib/capture.js';

// Post-import processing: importNode dropped taskUrn (server D12), so running
// the selected task on the just-imported node is a separate runTask call.
// Prefer the task's URN (URN bypass); pass the imported node's URN as an arg.
async function runImportTask(node, { taskName, taskUrn, memory, extraArgs } = {}) {
  if (!node || (!taskName && !taskUrn)) return null;
  return runTask({
    taskName,
    urn: taskUrn || undefined,
    memory,
    args: { nodeUrn: node.urn, nodeLoc: node.loc, ...extraArgs },
  });
}

// Route a message to a handler and reply with { ok, data } or { ok:false, error }.
const handlers = {
  async getAuthState() {
    return { signedIn: await isSignedIn() };
  },

  async signIn() {
    await signIn();
    return { signedIn: true };
  },

  async signOut() {
    await signOut();
    return { signedIn: false };
  },

  async listOrganizations() {
    return { organizations: await listOrganizations() };
  },

  async listMemories({ orgId } = {}) {
    return { memories: await listMemories(orgId) };
  },

  async listApps({ orgId } = {}) {
    return { apps: await listApps(orgId) };
  },

  async listAppTasks({ appId }) {
    return { tasks: await listAppTasks(appId) };
  },

  async listTasks({ orgId } = {}) {
    return { tasks: await listTasks(orgId) };
  },

  async search({ query, orgId, limit, offset }) {
    return { ...(await globalSearch(query, { orgId, limit, offset })) };
  },

  async runTask({ taskName, memory, urn, args }) {
    return { result: await runTask({ taskName, memory, urn, args }) };
  },

  // Import a local file: inline content → importNode (HTML/Markdown converted
  // server-side), then optionally run the selected task on the new node.
  async importFile({ memoryId, loc, name, content, contentType, fileName, taskName, taskUrn }) {
    const result = await importNode({
      memoryId,
      loc,
      name,
      content,
      contentType,
      properties: { fileName, importedAt: new Date().toISOString() },
    });
    const node = result?.node;
    const taskResult = await runImportTask(node, { taskName, taskUrn });
    return { node, status: result?.status, taskStarted: Boolean(taskName || taskUrn), taskResult };
  },

  // Import the current page via importNode:
  //  - Full HTML → the captured authenticated DOM as inline content
  //    (contentType text/html; the server converts HTML → Markdown). This is
  //    the only path that works behind an auth gate — a server-side fetch has
  //    no user session.
  //  - URL → hand the URL to the server to fetch + extract (public pages).
  // Post-import task processing (if any) is a separate runTask call.
  async send({ mode, tabId, tabUrl, tabTitle, memoryId, memoryUrn, loc, name, taskName, taskUrn }) {
    const properties = { url: tabUrl, sourceUrl: tabUrl, title: tabTitle, mode, capturedAt: new Date().toISOString() };
    let result;

    if (mode === 'html') {
      const page = await capturePage(tabId);
      if (!page) throw new Error('Could not read the page content.');
      properties.url = page.url || tabUrl;
      properties.sourceUrl = page.url || tabUrl;
      properties.title = page.title || tabTitle;
      result = await importNode({
        memoryId,
        loc,
        name,
        content: page.html,
        contentType: 'text/html',
        properties,
      });
    } else {
      result = await importNode({ memoryId, loc, name, url: tabUrl, properties });
    }

    const node = result?.node;
    if (!node || !node.loc) throw new Error('Import failed.');

    const taskResult = await runImportTask(node, {
      taskName,
      taskUrn,
      memory: memoryUrn || undefined,
      extraArgs: { url: properties.url },
    });

    return { node, status: result?.status, taskStarted: Boolean(taskName || taskUrn), taskResult };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
    return false;
  }
  handler(message)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err?.message || String(err),
        unauthorized: err instanceof UnauthorizedError,
      });
    });
  return true; // keep the message channel open for the async response
});
