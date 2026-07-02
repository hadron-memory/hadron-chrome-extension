// Popup UI controller. Pure presentation: every privileged action (OAuth,
// network, page capture) is delegated to the service worker via messages.

const $ = (sel) => document.querySelector(sel);

const views = {
  loading: $('#view-loading'),
  signedout: $('#view-signedout'),
  form: $('#view-form'),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle('hidden', key !== name);
  }
}

// Promise wrapper around chrome.runtime.sendMessage. Rejects on transport
// failure or a handler error; surfaces `unauthorized` so we can bounce to
// the signed-out view.
function bg(type, extra = {}) {
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

let activeTab = null;

// ── helpers ──────────────────────────────────────────────────────────────────

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function suggestLoc(tab) {
  let host = '';
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    host = 'page';
  }
  const title = slugify(tab.title) || 'clip';
  return `web:${slugify(host)}:${title}`;
}

function setStatus(kind, message) {
  const el = $('#status');
  if (!kind) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = message;
  el.className = `status ${kind}`;
  el.classList.remove('hidden');
}

function handleUnauthorized() {
  showView('signedout');
}

// ── initialization ───────────────────────────────────────────────────────────

async function init() {
  showView('loading');
  try {
    const { signedIn } = await bg('getAuthState');
    if (!signedIn) return showView('signedout');
    await initForm();
  } catch (err) {
    console.error(err);
    showView('signedout');
  }
}

async function initForm() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    $('#page-title').textContent = activeTab.title || '(untitled)';
    $('#page-url').textContent = activeTab.url || '';
    $('#name').value = activeTab.title || '';
    $('#loc').value = suggestLoc(activeTab);
  }
  showView('form');

  // Load memories + apps in parallel.
  try {
    const [{ memories }, { apps }] = await Promise.all([
      bg('listMemories'),
      bg('listApps'),
    ]);
    populateMemories(memories);
    populateApps(apps);
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    setStatus('err', err.message);
  }
}

function populateMemories(memories) {
  const sel = $('#memory');
  sel.innerHTML = '';
  if (!memories.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No writable memories';
    opt.value = '';
    sel.appendChild(opt);
    return;
  }
  for (const m of memories) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.dataset.urn = m.urn || '';
    opt.textContent = m.name + (m.class ? `  ·  ${m.class}` : '');
    sel.appendChild(opt);
  }
}

function populateApps(apps) {
  const sel = $('#app');
  // Keep the leading "— none —" option.
  sel.length = 1;
  for (const a of apps) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.dataset.urn = a.urn || '';
    opt.textContent = a.name;
    sel.appendChild(opt);
  }
}

async function onAppChange() {
  const appId = $('#app').value;
  const taskField = $('#task-field');
  const taskSel = $('#task');
  taskSel.length = 1; // reset to "— none —"
  if (!appId) {
    taskField.classList.add('hidden');
    return;
  }
  try {
    const { tasks } = await bg('listAppTasks', { appId });
    for (const t of tasks) {
      const opt = document.createElement('option');
      opt.value = t.name; // runTask resolves a task by name
      opt.textContent = t.name;
      taskSel.appendChild(opt);
    }
    taskField.classList.toggle('hidden', tasks.length === 0);
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    setStatus('err', err.message);
  }
}

// ── actions ──────────────────────────────────────────────────────────────────

async function onSignIn() {
  const btn = $('#btn-signin');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await bg('signIn');
    await initForm();
  } catch (err) {
    console.error(err);
    setStatus('err', err.message);
    showView('signedout');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in to Hadron';
  }
}

async function onSignOut() {
  try {
    await bg('signOut');
  } finally {
    showView('signedout');
  }
}

async function onSend() {
  const btn = $('#btn-send');
  const memorySel = $('#memory');
  const memoryId = memorySel.value;
  const memoryUrn = memorySel.selectedOptions[0]?.dataset.urn || '';
  const loc = $('#loc').value.trim();
  const name = $('#name').value.trim();
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const taskName = $('#task').value || null;

  setStatus(null);
  if (!memoryId) return setStatus('err', 'Pick a target memory.');
  if (!loc) return setStatus('err', 'Enter a LOC / URN for the node.');
  if (!activeTab) return setStatus('err', 'No active tab.');

  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const resp = await bg('send', {
      mode,
      tabId: activeTab.id,
      tabUrl: activeTab.url,
      tabTitle: activeTab.title,
      memoryId,
      memoryUrn,
      loc,
      name,
      taskName,
    });
    const suffix = resp.taskStarted ? ` · task “${taskName}” started` : '';
    setStatus('ok', `Saved node ${resp.node.loc}${suffix}`);
  } catch (err) {
    if (err.unauthorized) return handleUnauthorized();
    setStatus('err', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to Hadron';
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

$('#btn-signin').addEventListener('click', onSignIn);
$('#btn-signout').addEventListener('click', onSignOut);
$('#btn-send').addEventListener('click', onSend);
$('#app').addEventListener('change', onAppChange);

init();
