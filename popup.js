// Popup UI controller. Pure presentation: every privileged action (OAuth,
// network, page capture, file import) is delegated to the service worker.
//
// When opened outside an extension context (e.g. the dev preview), it falls
// back to in-memory mock data so the layout can be inspected without Chrome.

import { portalUrlForUrn, portalUrlForNode, PORTAL_URL } from './lib/config.js';
import { parseDisplayUrn, buildResolverUrl, CANONICAL_SCHEME } from './lib/urn.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const IN_EXTENSION =
  typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

// ── service-worker bridge (with mock fallback) ───────────────────────────────

function bg(type, extra = {}) {
  if (!IN_EXTENSION) return mockBg(type, extra);
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!resp || !resp.ok) {
        const err = new Error(resp?.error || 'Request failed');
        err.unauthorized = resp?.unauthorized;
        return reject(err);
      }
      resolve(resp);
    });
  });
}

// Mock backend for the dev preview (no Chrome APIs). Returns representative
// data so the layout renders; never used inside the real extension.
function mockBg(type, extra = {}) {
  const organizations = [
    { id: 'org1', name: 'Acme', urn: 'hrn:org:acme.com', isVisible: true },
    { id: 'org2', name: 'Holger (personal)', urn: 'hrn:org:holger', isVisible: null },
  ];
  const memoriesAll = [
    { id: 'm1', organizationId: 'org1', urn: 'hrn:memory:acme.com::knowledge-base', name: 'Knowledge Base', class: 'knowledge', shortDescription: 'Shared org knowledge.', description: 'The organization-wide knowledge base: product docs, decisions, and reference material clipped from the web.' },
    { id: 'm2', organizationId: 'org1', urn: 'hrn:memory:acme.com::research', name: 'Research', class: 'group', shortDescription: 'Research notes.', description: 'Working memory for the research team — sources, summaries, and in-progress findings.' },
    { id: 'm3', organizationId: 'org2', urn: 'hrn:memory:holger::personal', name: 'Personal', class: 'personal', shortDescription: 'My private memory.', description: 'Personal, private clips and notes visible only to me.' },
    ...Array.from({ length: 11 }, (_, i) => ({
      id: `mx${i + 1}`, organizationId: 'org1',
      urn: `hrn:memory:acme.com::project-${i + 1}`,
      name: `Project ${i + 1}`,
      class: i % 2 === 0 ? 'group' : 'knowledge',
      shortDescription: `Memory for project ${i + 1}.`,
      description: `Working memory for project ${i + 1}.`,
    })),
  ];
  const appsAll = [
    { id: 'a1', organizationId: 'org1', urn: 'hrn:app:acme.com::research-assistant', name: 'Research Assistant', appType: 'AGENT' },
    { id: 'a2', organizationId: 'org1', urn: 'hrn:app:acme.com::clipper', name: 'Web Clipper', appType: 'AUTOMATION' },
  ];
  const tasksAll = [
    { id: 't1', organizationId: 'org1', loc: 'tasks:summarize', urn: 'hrn:node:acme.com::knowledge-base::tasks:summarize', name: 'Summarize content', nodeType: 'task', abstract: 'Summarize the imported page into five bullet points.', memoryId: 'm1' },
    { id: 't2', organizationId: 'org1', loc: 'tasks:extract-links', urn: 'hrn:node:acme.com::knowledge-base::tasks:extract-links', name: 'Extract links', nodeType: 'task', abstract: 'Pull every outbound link out of the page.', memoryId: 'm1' },
    { id: 't3', organizationId: 'org1', loc: 'tasks:tag', urn: 'hrn:node:acme.com::research::tasks:tag', name: 'Auto-tag', nodeType: 'task', abstract: 'Suggest tags for the node from its content.', memoryId: 'm2' },
  ];
  // orgId scoping (server-side in production; emulated here for the preview).
  const byOrg = (arr) => (extra.orgId ? arr.filter((x) => x.organizationId === extra.orgId) : arr);

  const allHits = extra.query
    ? [
        { entityType: 'memory', id: 'm2', organizationId: 'org1', urn: 'hrn:memory:acme.com::research', name: 'Research', description: 'A group memory.', matchedField: 'name', score: 0.95, memoryId: 'm2' },
        { entityType: 'app', id: 'a1', organizationId: 'org1', urn: 'hrn:app:acme.com::research-assistant', name: 'Research Assistant', description: 'An agent app.', matchedField: 'name', score: 0.9 },
        ...Array.from({ length: 21 }, (_, i) => ({
          entityType: 'node', id: `n${i + 1}`, organizationId: 'org1',
          urn: `hrn:node:acme.com::knowledge-base::web:${extra.query}-${i + 1}`,
          name: `Result ${i + 1} for “${extra.query}”`,
          description: i % 2 === 0 ? `A matching node about ${extra.query}.` : '',
          matchedField: 'content', score: 0.8 - i * 0.01, memoryId: 'm1',
        })),
      ]
    : [];
  const scopedHits = byOrg(allHits);
  const off = extra.offset || 0;
  const lim = extra.limit || 10;

  // Synthesize a plausible node URN for the import preview (real server echoes one).
  const mockNodeBase = extra.memoryUrn
    ? extra.memoryUrn.replace(/^hrn:memory:/, 'hrn:node:')
    : 'hrn:node:acme.com::knowledge-base';
  const mockNode = (loc) => ({ loc, urn: `${mockNodeBase}::${loc}`, memoryId: extra.memoryId || 'm1' });

  const data = {
    getAuthState: { signedIn: true },
    signIn: { signedIn: true },
    signOut: { signedIn: false },
    listOrganizations: { organizations },
    listMemories: { memories: byOrg(memoriesAll) },
    listApps: { apps: byOrg(appsAll) },
    listTasks: { tasks: byOrg(tasksAll) },
    listAppTasks: { tasks: tasksAll.filter((t) => t.memoryId === 'm1') },
    search: { hits: scopedHits.slice(off, off + lim), total: scopedHits.length },
    runTask: { result: '• Point one\n• Point two\n• Point three' },
    send: { node: mockNode(extra.loc || 'web:example:clip'), status: 'STORED', taskStarted: Boolean(extra.taskName || extra.taskUrn) },
    importFile: { node: mockNode(extra.loc || 'file:import'), status: 'STORED', taskStarted: Boolean(extra.taskName || extra.taskUrn) },
  };
  return Promise.resolve({ ok: true, ...(data[type] || {}) });
}

async function getActiveTab() {
  if (!IN_EXTENSION) {
    return { id: 0, url: 'https://example.com/article', title: 'Example Article — A Sample Page' };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ── active organization ──────────────────────────────────────────────────────
// The server read queries (memories/apps/globalSearch/findNodes) take an orgId;
// we scope every tab to the chosen org and persist the choice locally.

let orgs = [];
let activeOrgId = null;
let mockOrgId = null; // preview-only persistence

async function getStoredOrgId() {
  if (!IN_EXTENSION) return mockOrgId;
  const o = await chrome.storage.local.get('activeOrgId');
  return o.activeOrgId || null;
}
async function storeOrgId(id) {
  if (!IN_EXTENSION) { mockOrgId = id; return; }
  if (id) await chrome.storage.local.set({ activeOrgId: id });
  else await chrome.storage.local.remove('activeOrgId');
}

// Sticky Import target memory: remember the last-picked memory so it's
// pre-selected next time the Import tab opens (issue #7).
let mockMemoryId = null; // preview-only persistence
async function getStoredMemoryId() {
  if (!IN_EXTENSION) return mockMemoryId;
  const o = await chrome.storage.local.get('importMemoryId');
  return o.importMemoryId || null;
}
async function storeMemoryId(id) {
  if (!IN_EXTENSION) { mockMemoryId = id; return; }
  if (id) await chrome.storage.local.set({ importMemoryId: id });
  else await chrome.storage.local.remove('importMemoryId');
}

// Sticky "prefix with today's date" preference: remembered across popup opens
// so the choice persists like the target memory (issue #11).
let mockAddDate = null; // preview-only persistence
async function getStoredAddDate() {
  if (!IN_EXTENSION) return !!mockAddDate;
  const o = await chrome.storage.local.get('importAddDate');
  return !!o.importAddDate;
}
async function storeAddDate(on) {
  if (!IN_EXTENSION) { mockAddDate = !!on; return; }
  await chrome.storage.local.set({ importAddDate: !!on });
}

// Recent Import targets: a short MRU list of (memory, LOC-prefix) pairs so a
// frequently-used parent can be re-picked in one click (issue #12).
const RECENT_TARGETS_MAX = 6;
let mockRecentTargets = null; // preview-only persistence
async function getRecentTargets() {
  if (!IN_EXTENSION) return mockRecentTargets || [];
  const o = await chrome.storage.local.get('importRecentTargets');
  return o.importRecentTargets || [];
}
async function storeRecentTargets(list) {
  if (!IN_EXTENSION) { mockRecentTargets = list; return; }
  await chrome.storage.local.set({ importRecentTargets: list });
}
// Push a just-used target to the front, de-duped by (memory, LOC-prefix).
async function recordRecentTarget({ memoryId, memoryName, memoryUrn, loc }) {
  if (!memoryId) return;
  const locPrefix = locPrefixOf(loc);
  const entry = { memoryId, memoryName, memoryUrn, locPrefix };
  const list = (await getRecentTargets()).filter(
    (t) => !(t.memoryId === memoryId && t.locPrefix === locPrefix),
  );
  list.unshift(entry);
  await storeRecentTargets(list.slice(0, RECENT_TARGETS_MAX));
}

/** Default active org: the stored one if still accessible, else personal, else first. */
function pickActiveOrg(list, stored) {
  if (!list.length) return null;
  if (stored && list.some((o) => o.id === stored)) return stored;
  const personal = list.find((o) => o.isVisible == null); // isVisible===null marks personal
  return (personal || list[0]).id;
}

async function initOrgs() {
  try {
    const { organizations } = await bg('listOrganizations');
    orgs = organizations || [];
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    orgs = []; // non-fatal — fall back to cross-org (orgId null)
  }
  activeOrgId = pickActiveOrg(orgs, await getStoredOrgId());
  const sel = $('#org-select');
  sel.innerHTML = '';
  for (const o of orgs) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name;
    opt.selected = o.id === activeOrgId;
    sel.appendChild(opt);
  }
  sel.classList.toggle('hidden', orgs.length <= 1); // hide when there's nothing to switch
}

async function onOrgChange() {
  activeOrgId = $('#org-select').value || null;
  await storeOrgId(activeOrgId);
  resetOrgScopedState();
  showTab(currentTab); // re-fetch the visible tab under the new org
}

// Clear everything that was fetched under the previous org.
function resetOrgScopedState() {
  allMemories = null; memoryFilter = ''; memoryPage = 0;
  allTasks = null;
  findQuery = ''; findPage = 0; findTotal = 0;
  importReady = false;
  resetImportResult(); // drop any stale success block from the previous org
  $('#find-input').value = '';
  $('#find-results').innerHTML = '';
  $('#find-pager').classList.add('hidden');
  $('#tasks-results').innerHTML = '';
  $('#task-find').value = '';
  $('#memories-results').innerHTML = '';
  $('#memories-find').value = '';
  $('#memories-pager').classList.add('hidden');
}

// ── views / tabs ─────────────────────────────────────────────────────────────

const views = {
  loading: $('#view-loading'),
  signedout: $('#view-signedout'),
  app: $('#view-app'),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.classList.toggle('hidden', key !== name);
  $('#btn-signout').classList.toggle('hidden', name !== 'app');
  if (name !== 'app') $('#org-select').classList.add('hidden');
  // Any top-level view change leaves the detail overlay + its header back button.
  $('#detail').classList.add('hidden');
  $('#header-back').classList.add('hidden');
  $('#brand').classList.remove('hidden');
}

let currentTab = 'find';

function showTab(name) {
  currentTab = name;
  $$('.tab').forEach((t) => {
    const isActive = t.dataset.tab === name;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  $$('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  if (name === 'find') $('#find-input').focus();
  if (name === 'tasks') loadTasks();
  if (name === 'memories') loadMemories();
  if (name === 'import') initImport();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t;
  const debounced = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  debounced.cancel = () => clearTimeout(t);
  return debounced;
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function suggestLoc(tab) {
  let host = 'page';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  return `web:${slugify(host)}:${slugify(tab.title) || 'clip'}`;
}

// ── LOC / URN composition helpers (issue #11) ────────────────────────────────

/** Local (not UTC) YYYY-MM-DD, used to prefix names/LOCs with a capture date. */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Passive hygiene for a plain LOC: drop stray whitespace, collapse doubled
// colons, and trim leading/trailing colons. Full display URNs (which carry a
// scheme + `::` separators) are left untouched.
function sanitizeLoc(s) {
  const v = (s || '').trim();
  if (/^(hrn|urn):/i.test(v)) return v; // a full URN (scheme-prefixed) — don't mangle it
  return v.replace(/\s+/g, '').replace(/:{2,}/g, ':').replace(/^:+|:+$/g, '');
}

/** Drop a leading `YYYY-MM-DD ` date prefix from a name. */
function stripDateName(name) {
  return (name || '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
}

/** Drop a leading `YYYY-MM-DD:` date segment from a LOC. */
function stripDateLoc(loc) {
  return (loc || '').replace(/^\d{4}-\d{2}-\d{2}:/, '');
}

/** Prefix a node name with today's date (re-dating replaces an existing prefix). */
function prefixDateName(name) {
  return `${todayStr()} ${stripDateName(name)}`.trim();
}

/** Prefix a LOC with a today's-date segment (re-dating replaces an existing one). */
function prefixDateLoc(loc) {
  return `${todayStr()}:${stripDateLoc(loc)}`.replace(/:+$/, ''); // no trailing colon when LOC is empty
}

/** The parent path of a LOC — everything up to and including the last colon. */
function locPrefixOf(loc) {
  const i = (loc || '').lastIndexOf(':');
  return i >= 0 ? loc.slice(0, i + 1) : '';
}

function handleUnauthorized() { showView('signedout'); }

/** Build a clickable list row. */
// A list row is a clickable container (opens detail) that can hold an
// interactive URN chip — so it's a <div role="button">, not a <button>
// (nesting the chip's copy buttons in a <button> would be invalid).
// The chip's buttons stopPropagation so a copy doesn't also open the detail.
function rowEl({ title, badge, urn, urnType, sub }, onClick) {
  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;

  const t = document.createElement('div');
  t.className = 'row-title';
  if (badge) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = badge;
    t.appendChild(b);
  }
  t.appendChild(document.createTextNode(title || '(untitled)'));
  row.appendChild(t);

  if (urn) {
    const chip = urnChip(urn, urnType);
    chip.classList.add('row-urn');
    row.appendChild(chip);
  }
  if (sub) {
    const s = document.createElement('div');
    s.className = 'row-sub';
    if (sub instanceof Node) s.appendChild(sub);
    else s.textContent = sub;
    row.appendChild(s);
  }

  row.addEventListener('click', onClick);
  row.addEventListener('keydown', (e) => {
    // Only when the row itself is focused — not when a keypress bubbles up from
    // a nested chip button (so Enter/Space there copies without opening detail).
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); }
  });
  return row;
}

// ── Find tab ─────────────────────────────────────────────────────────────────

const FIND_PAGE_SIZE = 10;
let findQuery = '';
let findPage = 0;
let findTotal = 0;

async function performFind(q) {
  // An immediate search (submit / Enter) supersedes any pending debounced one.
  if (runFind?.cancel) runFind.cancel();
  findQuery = q.trim();
  findPage = 0;
  if (!findQuery) {
    $('#find-results').innerHTML = '';
    $('#find-pager').classList.add('hidden');
    const empty = $('#find-empty');
    empty.textContent = 'Type to search nodes, memories, apps, and more.';
    empty.classList.remove('hidden');
    return;
  }
  await fetchFindPage();
}
// Typing searches after a short debounce; the submit button / Enter search now.
const runFind = debounce(performFind, 250);

// Server-side pagination: fetch one page of globalSearch (offset/limit + total).
async function fetchFindPage() {
  const list = $('#find-results');
  const pager = $('#find-pager');
  const empty = $('#find-empty');
  if (!findQuery) return;
  try {
    const { hits, total } = await bg('search', {
      query: findQuery,
      orgId: activeOrgId,
      limit: FIND_PAGE_SIZE,
      offset: findPage * FIND_PAGE_SIZE,
    });
    findTotal = total || 0;
    list.innerHTML = '';
    if (!hits.length) {
      pager.classList.add('hidden');
      empty.textContent = `No results for “${findQuery}”.`;
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    for (const h of hits) {
      list.appendChild(
        rowEl(
          { title: h.name || h.urn || h.id, badge: h.entityType, urn: h.urn, sub: h.description },
          () => openDetail(hitToDetail(h)),
        ),
      );
    }
    const start = findPage * FIND_PAGE_SIZE;
    if (findTotal > FIND_PAGE_SIZE) {
      pager.classList.remove('hidden');
      $('#find-range').textContent = `${start + 1}–${start + hits.length} of ${findTotal}`;
      $('#find-prev').disabled = findPage === 0;
      $('#find-next').disabled = (findPage + 1) * FIND_PAGE_SIZE >= findTotal;
    } else {
      pager.classList.add('hidden');
    }
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    list.innerHTML = '';
    pager.classList.add('hidden');
    empty.textContent = err.message;
    empty.classList.remove('hidden');
  }
}

// ── Import tab ───────────────────────────────────────────────────────────────

let importReady = false;
let activeTab = null;

async function initImport() {
  if (importReady) return;
  importReady = true;
  activeTab = await getActiveTab();
  if (activeTab) {
    $('#page-title').textContent = activeTab.title || '(untitled)';
    $('#page-url').textContent = activeTab.url || '';
    $('#name').value = activeTab.title || '';
    $('#loc').value = suggestLoc(activeTab);
  }
  // Restore the sticky "prefix with today's date" choice and apply it (issue #11).
  const addDate = await getStoredAddDate();
  $('#add-date').checked = addDate;
  if (addDate) {
    $('#name').value = prefixDateName($('#name').value);
    $('#loc').value = prefixDateLoc($('#loc').value);
  }
  try {
    const [{ memories }, { apps }] = await Promise.all([
      bg('listMemories', { orgId: activeOrgId }),
      bg('listApps', { orgId: activeOrgId }),
    ]);
    fillSelect($('#memory'), memories.map((m) => ({ value: m.id, urn: m.urn, label: `${m.name}${m.class ? '  ·  ' + m.class : ''}` })));
    fillSelect($('#app'), apps.map((a) => ({ value: a.id, urn: a.urn, label: a.name })), '— none —');
    // Restore the last-used target memory if it's still available (issue #7).
    const storedMemoryId = await getStoredMemoryId();
    if (storedMemoryId && memories.some((m) => m.id === storedMemoryId)) {
      $('#memory').value = storedMemoryId;
    }
    await renderRecentTargets(); // MRU quick-select of (memory, path) pairs (issue #12)
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    setStatus('#import-status', 'err', err.message);
  }
}

// Populate the "Recent targets" select, hiding it when there's nothing to show.
// Only targets whose memory still appears in the current org's picker are kept.
async function renderRecentTargets() {
  const sel = $('#recent-target');
  const field = $('#recent-field');
  sel.length = 1; // keep the placeholder option
  const memIds = new Set([...$('#memory').options].map((o) => o.value));
  const usable = (await getRecentTargets()).filter((t) => memIds.has(t.memoryId));
  for (const t of usable) {
    const o = document.createElement('option');
    o.value = JSON.stringify({ memoryId: t.memoryId, locPrefix: t.locPrefix });
    const name = (t.memoryName || t.memoryId).split('  ·  ')[0]; // drop the class suffix
    o.textContent = t.locPrefix ? `${name}  ·  ${t.locPrefix}` : name;
    sel.appendChild(o);
  }
  field.classList.toggle('hidden', usable.length === 0);
  sel.value = '';
}

// Apply a picked recent target: select its memory and swap in its LOC parent
// path while preserving the current final segment.
function onRecentTargetChange() {
  const raw = $('#recent-target').value;
  if (!raw) return;
  let t;
  try { t = JSON.parse(raw); } catch { return; }
  const mem = $('#memory');
  if (t.memoryId && [...mem.options].some((o) => o.value === t.memoryId)) {
    mem.value = t.memoryId;
    storeMemoryId(t.memoryId);
  }
  const cur = $('#loc').value.trim();
  const lastSeg = cur
    ? cur.slice(cur.lastIndexOf(':') + 1)
    : (activeTab ? suggestLoc(activeTab).split(':').pop() : 'clip');
  $('#loc').value = `${t.locPrefix}${lastSeg}`;
  resetImportResult();
}

// Sticky "prefix with today's date" checkbox: add or remove the date prefix on
// both the name and the LOC, and remember the choice for next time (issue #11).
async function onAddDateToggle() {
  const on = $('#add-date').checked;
  await storeAddDate(on);
  if (on) {
    $('#name').value = prefixDateName($('#name').value);
    $('#loc').value = prefixDateLoc($('#loc').value);
  } else {
    $('#name').value = stripDateName($('#name').value);
    $('#loc').value = stripDateLoc($('#loc').value);
  }
  resetImportResult();
}

function fillSelect(sel, items, placeholder) {
  sel.innerHTML = '';
  if (placeholder) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = placeholder;
    sel.appendChild(o);
  }
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.value;
    if (it.urn) o.dataset.urn = it.urn;
    o.textContent = it.label;
    sel.appendChild(o);
  }
}

function onSourceChange() {
  const src = $('input[name="source"]:checked').value;
  $('#src-page').classList.toggle('hidden', src !== 'page');
  $('#src-file').classList.toggle('hidden', src !== 'file');
}

async function onAppChange() {
  const appId = $('#app').value;
  const taskField = $('#task-field');
  const taskSel = $('#task');
  taskSel.length = 1; // keep the placeholder option
  taskSel.options[0].textContent = '— none —';
  taskSel.disabled = false;
  if (!appId) return taskField.classList.add('hidden');
  try {
    const { tasks } = await bg('listAppTasks', { appId });
    for (const t of tasks) {
      const o = document.createElement('option');
      o.value = t.name; // page-import runTask resolves the task by name
      if (t.urn) o.dataset.urn = t.urn; // file-import importNode wants the URN
      o.textContent = t.loc ? `${t.name}  ·  ${t.loc}` : t.name; // loc disambiguates same-named tasks across memories
      taskSel.appendChild(o);
    }
    // Always reveal the picker once an app is chosen — an empty, disabled state
    // makes it clear the app has no task nodes (vs. the control silently missing).
    if (tasks.length === 0) {
      taskSel.options[0].textContent = '— no task nodes in this app’s memories —';
      taskSel.disabled = true;
    }
    taskField.classList.remove('hidden');
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    setStatus('#import-status', 'err', err.message);
  }
}

// importNode v1 accepts text/html (→ Markdown) and text/markdown (as-is).
// Plain text is valid Markdown, so .txt is sent as text/markdown (stored as-is)
// rather than the unsupported text/plain. PDF (application/pdf) isn't accepted
// yet — hadron-server#488 — and errors gracefully until it ships.
const CONTENT_TYPES = {
  md: 'text/markdown', markdown: 'text/markdown',
  html: 'text/html', htm: 'text/html',
  txt: 'text/markdown', text: 'text/markdown',
  pdf: 'application/pdf',
};

function readFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const contentType = CONTENT_TYPES[ext] || file.type || 'text/plain';
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    if (contentType === 'application/pdf') {
      // Binary → base64 payload (data URL), stripped to raw base64.
      reader.onload = () => resolve({ content: String(reader.result).split(',')[1] || '', contentType });
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve({ content: String(reader.result), contentType });
      reader.readAsText(file);
    }
  });
}

async function onImport() {
  const btn = $('#btn-import');
  const memorySel = $('#memory');
  const memoryId = memorySel.value;
  const memoryUrn = memorySel.selectedOptions[0]?.dataset.urn || '';
  const loc = $('#loc').value.trim();
  const name = $('#name').value.trim();
  const source = $('input[name="source"]:checked').value;
  const taskSel = $('#task');
  const taskName = taskSel.value || null; // selected task display name (runTask fallback)
  const taskUrn = taskSel.selectedOptions[0]?.dataset.urn || null; // selected task URN (runTask URN bypass)

  setStatus('#import-status', null);
  resetImportResult();
  if (!memoryId) return setStatus('#import-status', 'err', 'Pick a target memory.');
  if (!loc) return setStatus('#import-status', 'err', 'Enter a LOC / URN for the node.');

  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    let resp;
    if (source === 'file') {
      const file = $('#file-input').files[0];
      if (!file) throw new Error('Choose a file to import.');
      const { content, contentType } = await readFile(file);
      resp = await bg('importFile', {
        memoryId, memoryUrn, loc, name: name || file.name, content, contentType,
        fileName: file.name, taskName, taskUrn,
      });
    } else {
      if (!activeTab) throw new Error('No active tab.');
      const mode = $('input[name="mode"]:checked').value;
      resp = await bg('send', {
        mode, tabId: activeTab.id, tabUrl: activeTab.url, tabTitle: activeTab.title,
        memoryId, memoryUrn, loc, name, taskName, taskUrn,
      });
    }
    await storeMemoryId(memoryId); // remember the target for next time (issue #7)
    // Record this (memory, path) pair in the recent-targets MRU (issue #12).
    const memoryName = memorySel.selectedOptions[0]?.textContent || '';
    await recordRecentTarget({ memoryId, memoryName, memoryUrn, loc });
    await renderRecentTargets();
    // Success: render the URN chip + Open button and keep the button disabled so
    // it's clear a second press isn't needed (issue #8). Editing any field
    // (see the reset wiring in init) clears this and re-enables importing.
    showImportResult(resp.node, loc);
    btn.textContent = 'Imported ✓';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Import to Hadron';
    if (err.unauthorized) return handleUnauthorized();
    setStatus('#import-status', 'err', err.message);
  }
}

// Show the post-import success block: green message, the node's URN rendered the
// same way as elsewhere (copy-URN / copy-URL buttons), and an Open-in-portal
// button. Falls back to the plain LOC when the server didn't echo a URN.
function showImportResult(node, loc) {
  const urn = node?.urn || null;
  const urnBox = $('#import-result-urn');
  urnBox.innerHTML = '';
  if (urn) {
    urnBox.appendChild(urnChip(urn));
    urnBox.classList.remove('hidden');
  } else {
    urnBox.textContent = node?.loc || loc;
    urnBox.classList.remove('hidden');
  }

  const portal = $('#import-result-portal');
  // Fall back to the target memory (from the picker) when the server echoed no
  // node URN, so "Open in portal" still links somewhere useful.
  const href = portalUrlForUrn(urn) || portalUrlForNode(node?.memoryId || $('#memory').value, node?.id);
  if (href) {
    portal.href = href;
    portal.classList.remove('hidden');
  } else {
    portal.classList.add('hidden');
  }

  $('#import-status').classList.add('hidden');
  $('#import-result').classList.remove('hidden');
}

// Clear the success block and re-enable the Import button — called when the user
// edits an import field after a completed import. Also drops any stale error
// status so it clears the moment the user starts fixing the input.
function resetImportResult() {
  setStatus('#import-status', null);
  const result = $('#import-result');
  if (result.classList.contains('hidden')) return;
  result.classList.add('hidden');
  $('#import-result-urn').innerHTML = '';
  const btn = $('#btn-import');
  btn.disabled = false;
  btn.textContent = 'Import to Hadron';
}

// ── Tasks tab ────────────────────────────────────────────────────────────────

let allTasks = null;

async function loadTasks() {
  const empty = $('#tasks-empty');
  if (allTasks) return renderTasks($('#task-find').value);
  try {
    const { tasks } = await bg('listTasks', { orgId: activeOrgId });
    allTasks = tasks;
    renderTasks('');
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    empty.textContent = err.message;
    empty.classList.remove('hidden');
  }
}

function renderTasks(filter) {
  const list = $('#tasks-results');
  const empty = $('#tasks-empty');
  const q = (filter || '').toLowerCase();
  const rows = (allTasks || []).filter(
    (t) => !q || (t.name || '').toLowerCase().includes(q) || (t.loc || '').toLowerCase().includes(q),
  );
  list.innerHTML = '';
  if (!rows.length) {
    empty.textContent = allTasks?.length ? 'No tasks match your filter.' : 'No runnable tasks found.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  for (const t of rows) {
    list.appendChild(
      rowEl({ title: t.name, badge: 'task', urn: t.urn || null, sub: t.abstract }, () => openDetail(taskToDetail(t))),
    );
  }
}

// ── Memories tab ─────────────────────────────────────────────────────────────
// Mirrors the Find tab: a search input + a paginated (page size 10) list. The
// user's memories are drained fully up front (paged memories query), so the search filters
// them client-side rather than round-tripping.

const MEM_PAGE_SIZE = 10;
let allMemories = null;
let memoryFilter = '';
let memoryPage = 0;

async function loadMemories() {
  if (allMemories) return renderMemoriesPage();
  try {
    const { memories } = await bg('listMemories', { orgId: activeOrgId });
    allMemories = memories;
    memoryPage = 0;
    renderMemoriesPage();
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    $('#memories-pager').classList.add('hidden');
    const empty = $('#memories-empty');
    empty.textContent = err.message;
    empty.classList.remove('hidden');
  }
}

function filterMemories(q) {
  memoryFilter = q || '';
  memoryPage = 0;
  renderMemoriesPage();
}

function renderMemoriesPage() {
  const list = $('#memories-results');
  const empty = $('#memories-empty');
  const pager = $('#memories-pager');
  const q = memoryFilter.toLowerCase();
  const filtered = (allMemories || []).filter(
    (m) => !q || (m.name || '').toLowerCase().includes(q) || (m.urn || '').toLowerCase().includes(q),
  );
  list.innerHTML = '';
  if (!filtered.length) {
    pager.classList.add('hidden');
    empty.textContent = allMemories?.length ? 'No memories match your search.' : 'No memories.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const pages = Math.ceil(filtered.length / MEM_PAGE_SIZE);
  memoryPage = Math.max(0, Math.min(memoryPage, pages - 1));
  const start = memoryPage * MEM_PAGE_SIZE;
  const slice = filtered.slice(start, start + MEM_PAGE_SIZE);
  for (const m of slice) {
    list.appendChild(
      rowEl({ title: m.name, badge: m.class, urn: m.urn }, () => openDetail(memoryToDetail(m))),
    );
  }

  if (filtered.length > MEM_PAGE_SIZE) {
    pager.classList.remove('hidden');
    $('#memories-range').textContent = `${start + 1}–${start + slice.length} of ${filtered.length}`;
    $('#memories-prev').disabled = memoryPage === 0;
    $('#memories-next').disabled = memoryPage >= pages - 1;
  } else {
    pager.classList.add('hidden');
  }
}

// ── detail overlay ───────────────────────────────────────────────────────────

function hitToDetail(h) {
  return {
    kind: h.entityType,
    title: h.name || h.urn || h.id,
    urn: h.urn,
    portal: portalUrlForUrn(h.urn) || portalUrlForNode(h.memoryId, h.entityType === 'node' ? h.id : null),
    fields: [
      h.matchedField && { k: 'Matched', v: h.matchedField },
    ].filter(Boolean),
    preview: h.description,
  };
}

function taskToDetail(t) {
  return {
    kind: 'task',
    title: t.name,
    urn: t.urn || null,
    portal: portalUrlForUrn(t.urn) || portalUrlForNode(t.memoryId, t.id),
    fields: [
      { k: 'LOC', v: t.loc, mono: true },
      t.nodeType && { k: 'Type', v: t.nodeType },
    ].filter(Boolean),
    preview: t.abstract,
    // Carry the node URN so Run uses the server's URN bypass (unambiguous),
    // instead of name-only resolution that can hit the wrong same-named task
    // or the server's default memory. Falls back to name when urn is absent.
    run: { taskName: t.name, urn: t.urn || null },
  };
}

function memoryToDetail(m) {
  return {
    kind: m.class || 'memory',
    title: m.name,
    urn: m.urn,
    portal: portalUrlForUrn(m.urn) || portalUrlForNode(m.id, null),
    fields: [
      m.shortDescription && { k: 'Summary', v: m.shortDescription },
    ].filter(Boolean),
    preview: m.description || m.shortDescription,
  };
}

// SVG markup for the chip's copy/link/check icons (matches the portal's Urn.svelte).
const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>',
};

/**
 * The two-tone URN code element (`hrn:` `<type>:` `<bareValue>`), non-interactive.
 * Shared by the full chip and the compact in-row pill.
 */
function urnCodeEl(value, typeHint) {
  const { type, bareValue, fullUrn } = parseDisplayUrn(value, typeHint);
  const code = document.createElement('code');
  code.className = 'urn-code';
  code.title = fullUrn;
  const scheme = document.createElement('span');
  scheme.className = 'urn-scheme';
  scheme.textContent = `${CANONICAL_SCHEME}:`;
  const kind = document.createElement('span');
  kind.className = 'urn-scheme';
  kind.textContent = `${type}:`;
  const bare = document.createElement('span');
  bare.className = 'urn-bare';
  bare.textContent = bareValue;
  code.append(scheme, kind, bare);
  return { code, fullUrn };
}

/**
 * Build a portal-style URN chip: `hrn:` `<type>:` `<bareValue>` plus a
 * Copy-URN button and a Copy-URL button. Mirrors the portal's Urn.svelte.
 */
function urnChip(value, typeHint) {
  const wrap = document.createElement('span');
  wrap.className = 'urn-chip';
  const { code, fullUrn } = urnCodeEl(value, typeHint);

  const mkBtn = (icon, title, textToCopy) => {
    const b = document.createElement('button');
    b.className = 'urn-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = ICONS[icon];
    b.addEventListener('click', (e) => {
      // Don't let a copy click also trigger the enclosing row's open-detail.
      e.stopPropagation();
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(textToCopy).catch((err) => console.error('Copy failed', err));
      b.innerHTML = ICONS.check;
      setTimeout(() => { b.innerHTML = ICONS[icon]; }, 2000);
    });
    return b;
  };

  wrap.append(
    code,
    mkBtn('copy', 'Copy URN', fullUrn),
    mkBtn('link', 'Copy URL', buildResolverUrl(PORTAL_URL, fullUrn)),
  );
  return wrap;
}

function openDetail(item) {
  $('#detail-kind').textContent = item.kind || '';
  $('#detail-title').textContent = item.title || '';
  const body = $('#detail-body');
  body.innerHTML = '';
  if (item.urn) {
    const row = document.createElement('div');
    row.className = 'detail-row';
    row.innerHTML = '<span class="k">URN</span>';
    row.appendChild(urnChip(item.urn));
    body.appendChild(row);
  }
  for (const f of item.fields || []) {
    const row = document.createElement('div');
    row.className = 'detail-row';
    row.innerHTML = `<span class="k"></span><span class="v${f.mono ? ' mono' : ''}"></span>`;
    row.querySelector('.k').textContent = f.k;
    row.querySelector('.v').textContent = f.v;
    body.appendChild(row);
  }
  if (item.preview) {
    const pre = document.createElement('div');
    pre.className = 'detail-preview';
    pre.textContent = item.preview;
    body.appendChild(pre);
  }

  const portal = $('#detail-portal');
  if (item.portal) {
    portal.classList.remove('hidden');
    portal.href = item.portal;
  } else {
    portal.classList.add('hidden');
  }

  const runBtn = $('#detail-run');
  setStatus('#detail-status', null);
  if (item.run) {
    runBtn.classList.remove('hidden');
    runBtn.onclick = () => runDetailTask(item.run, runBtn);
  } else {
    runBtn.classList.add('hidden');
    runBtn.onclick = null;
  }

  // Detail overlay uses the header's Back button; swap brand → Back.
  $('#brand').classList.add('hidden');
  $('#header-back').classList.remove('hidden');
  views.app.classList.add('hidden');
  $('#detail').classList.remove('hidden');
}

async function runDetailTask(run, btn) {
  btn.disabled = true;
  btn.textContent = 'Running…';
  setStatus('#detail-status', null);
  try {
    const { result } = await bg('runTask', { taskName: run.taskName, urn: run.urn });
    setStatus('#detail-status', 'ok', typeof result === 'string' && result ? result.slice(0, 400) : 'Task run.');
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    setStatus('#detail-status', 'err', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run task';
  }
}

function closeDetail() {
  $('#detail').classList.add('hidden');
  $('#header-back').classList.add('hidden');
  $('#brand').classList.remove('hidden');
  views.app.classList.remove('hidden');
}

// ── status util ──────────────────────────────────────────────────────────────

function setStatus(sel, kind, message) {
  const el = $(sel);
  if (!kind) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = message;
  el.className = `status ${kind}`;
  el.classList.remove('hidden');
}

// ── auth actions ─────────────────────────────────────────────────────────────

async function onSignIn() {
  const btn = $('#btn-signin');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await bg('signIn');
    await enterApp();
  } catch (err) {
    console.error(err);
    showView('signedout');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in to Hadron';
  }
}

async function onSignOut() {
  try { await bg('signOut'); } finally { showView('signedout'); }
}

// ── init ─────────────────────────────────────────────────────────────────────

async function enterApp() {
  showView('app');
  await initOrgs(); // load orgs + active-org selection before the first tab fetch
  showTab('find');
}

async function init() {
  // wiring
  $('#btn-signin').addEventListener('click', onSignIn);
  $('#btn-signout').addEventListener('click', onSignOut);
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('#find-input').addEventListener('input', (e) => runFind(e.target.value));
  $('#find-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') performFind(e.target.value); });
  $('#find-submit').addEventListener('click', () => performFind($('#find-input').value));
  $('#find-prev').addEventListener('click', () => { findPage--; fetchFindPage(); });
  $('#find-next').addEventListener('click', () => { findPage++; fetchFindPage(); });
  $('#org-select').addEventListener('change', onOrgChange);
  $('#task-find').addEventListener('input', (e) => renderTasks(e.target.value));
  $('#task-find').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderTasks(e.target.value); });
  $('#task-submit').addEventListener('click', () => renderTasks($('#task-find').value));
  $('#memories-find').addEventListener('input', (e) => filterMemories(e.target.value));
  $('#memories-find').addEventListener('keydown', (e) => { if (e.key === 'Enter') filterMemories(e.target.value); });
  $('#memories-submit').addEventListener('click', () => filterMemories($('#memories-find').value));
  $('#memories-prev').addEventListener('click', () => { memoryPage--; renderMemoriesPage(); });
  $('#memories-next').addEventListener('click', () => { memoryPage++; renderMemoriesPage(); });
  $$('input[name="source"]').forEach((r) => r.addEventListener('change', () => { onSourceChange(); resetImportResult(); }));
  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) $('#name').value = $('#add-date').checked ? prefixDateName(file.name) : file.name;
    resetImportResult();
  });
  $('#app').addEventListener('change', () => { onAppChange(); resetImportResult(); });
  $('#task').addEventListener('change', resetImportResult);
  // Persist the target memory (issue #7); editing any field clears a prior
  // import result and re-enables the button (issue #8).
  $('#memory').addEventListener('change', (e) => { storeMemoryId(e.target.value); resetImportResult(); });
  $('#recent-target').addEventListener('change', onRecentTargetChange);
  $('#add-date').addEventListener('change', onAddDateToggle);
  $('#loc').addEventListener('blur', () => { $('#loc').value = sanitizeLoc($('#loc').value); });
  $('#loc').addEventListener('input', resetImportResult);
  $('#name').addEventListener('input', resetImportResult);
  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', resetImportResult));
  $('#btn-import').addEventListener('click', onImport);
  $('#header-back').addEventListener('click', closeDetail);

  showView('loading');
  try {
    const { signedIn } = await bg('getAuthState');
    if (signedIn) await enterApp();
    else showView('signedout');
  } catch (err) {
    console.error(err);
    showView('signedout');
  }
}

init();
