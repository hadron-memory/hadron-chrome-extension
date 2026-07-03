// Service worker: the single owner of OAuth, network, and page capture.
// The popup is pure UI and talks to this worker over chrome.runtime messages.

import { signIn, signOut, isSignedIn } from './lib/oauth.js';
import {
  listMemories,
  listApps,
  listAppTasks,
  listTasks,
  globalSearch,
  createNode,
  runTask,
  importNode,
  UnauthorizedError,
} from './lib/api.js';
import { capturePage } from './lib/capture.js';

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

  async listMemories() {
    return { memories: await listMemories() };
  },

  async listApps() {
    return { apps: await listApps() };
  },

  async listAppTasks({ appId }) {
    return { tasks: await listAppTasks(appId) };
  },

  async listTasks() {
    return { tasks: await listTasks() };
  },

  async search({ query }) {
    return { hits: await globalSearch(query) };
  },

  async runTask({ taskName, memory, urn, args }) {
    return { result: await runTask({ taskName, memory, urn, args }) };
  },

  // Import a local file via the planned importNode API. Inert (errors
  // gracefully) until hadron-server#457 ships the field.
  async importFile({ memoryId, loc, name, content, contentType, fileName, taskUrn }) {
    const result = await importNode({
      memoryId,
      loc,
      name,
      content,
      contentType,
      properties: { fileName, contentType, importedAt: new Date().toISOString() },
      taskUrn,
    });
    return { result };
  },

  // Capture (if needed), create the node, and optionally kick off a task.
  async send({ mode, tabId, tabUrl, tabTitle, memoryId, memoryUrn, loc, name, taskName }) {
    let content;
    let capturedUrl = tabUrl;
    let capturedTitle = tabTitle;

    if (mode === 'html') {
      const page = await capturePage(tabId);
      if (!page) throw new Error('Could not read the page content.');
      content = page.html;
      capturedUrl = page.url || tabUrl;
      capturedTitle = page.title || tabTitle;
    } else {
      content = tabUrl;
    }

    const node = await createNode({
      memoryId,
      loc,
      name: name || capturedTitle || capturedUrl,
      content,
      properties: {
        url: capturedUrl,
        title: capturedTitle,
        mode,
        capturedAt: new Date().toISOString(),
      },
    });

    if (!node || !node.loc) {
      throw new Error('Failed to create the node in Hadron.');
    }

    let taskResult = null;
    if (taskName) {
      // Pass the created node's URN so the task can reference the content.
      const nodeUrn = memoryUrn ? `${memoryUrn}:${node.loc}` : node.loc;
      taskResult = await runTask({
        taskName,
        memory: memoryUrn || undefined,
        args: { nodeUrn, nodeLoc: node.loc, url: capturedUrl },
      });
    }

    return { node, taskStarted: Boolean(taskName), taskResult };
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
