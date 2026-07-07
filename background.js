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
  getAppRun,
  importNode,
  UnauthorizedError,
} from './lib/api.js';
import { capturePage } from './lib/capture.js';

const RUN_TERMINAL = new Set(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

// Poll an app run to a terminal state (or return the last known state on
// timeout — the run keeps going server-side; the user can watch it in the portal).
async function pollAppRun(runId, { tries = 25, intervalMs = 1500 } = {}) {
  let run = null;
  for (let i = 0; i < tries; i++) {
    run = await getAppRun(runId);
    if (!run || RUN_TERMINAL.has(run.status)) return run;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return run;
}

// Post-import processing: EXECUTE the selected task server-side against the just
// -imported node (#21). runTask(appRef) mints a MANUAL app run and returns its
// id; we poll to a terminal state. Best-effort — the import already succeeded,
// so a run failure (e.g. the admin-only gate, hadron-server#530) is reported in
// the result, never thrown.
async function runImportTask(node, { taskUrn, appRef, extraArgs } = {}) {
  if (!node || !taskUrn || !appRef) return { ran: false };
  try {
    const runId = await runTask({
      urn: taskUrn,
      appRef,
      runAsSelf: true,
      args: { importedNodeUrn: node.urn, nodeLoc: node.loc, ...extraArgs },
    });
    if (!runId) return { ran: false };
    const run = await pollAppRun(runId);
    return { ran: true, runId, status: run?.status || 'PENDING', failure: run?.failure ?? null };
  } catch (err) {
    return { ran: false, error: err?.message || String(err) };
  }
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
  // server-side), then optionally EXECUTE the selected task on the new node.
  async importFile({ memoryId, loc, name, content, contentType, fileName, taskUrn, appRef }) {
    const result = await importNode({
      memoryId,
      loc,
      name,
      content,
      contentType,
      properties: { fileName, importedAt: new Date().toISOString() },
    });
    const node = result?.node;
    const task = await runImportTask(node, { taskUrn, appRef });
    return { node, status: result?.status, task };
  },

  // Import the current page via importNode:
  //  - Full HTML → the captured authenticated DOM as inline content
  //    (contentType text/html; the server converts HTML → Markdown). This is
  //    the only path that works behind an auth gate — a server-side fetch has
  //    no user session.
  //  - URL → hand the URL to the server to fetch + extract (public pages).
  // Post-import task processing (if any) is a separate runTask call.
  async send({ mode, tabId, tabUrl, tabTitle, memoryId, loc, name, taskUrn, appRef }) {
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

    const task = await runImportTask(node, {
      taskUrn,
      appRef,
      extraArgs: { url: properties.url },
    });

    return { node, status: result?.status, task };
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
