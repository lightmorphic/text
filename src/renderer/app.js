'use strict';

// Screen orchestration: the guided first run, the snippet list, the editor,
// and the update dot. Everything that touches the filesystem or a process
// happens in the main process behind window.lightmorphicText.

const els = {};
[
  'header-actions', 'service-pill', 'service-text',
  'btn-power', 'btn-restart', 'btn-open-dir', 'btn-refresh',
  'update-widget', 'update-widget-version', 'update-dot', 'update-dot-ring-fill',
  'screen-setup', 'setup-steps', 'setup-heading', 'setup-lede', 'setup-facts',
  'setup-progress', 'setup-bar-fill', 'setup-progress-text', 'setup-error',
  'setup-command', 'setup-command-text', 'btn-copy-command',
  'setup-primary', 'setup-secondary',
  'screen-main', 'btn-new', 'search', 'list-count', 'entry-list',
  'edit-badge', 'edit-empty', 'edit-form', 'field-trigger', 'field-replace',
  'field-replace-wrap', 'field-raw-wrap', 'field-raw', 'raw-reason', 'field-word', 'field-propagate',
  'field-file', 'edit-error', 'edit-success', 'btn-save', 'btn-cancel', 'btn-delete',
].forEach((id) => {
  els[id.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = document.getElementById(id);
});

const state = {
  env: null,
  files: [],
  entries: [],
  selectedId: null,
  // A snippet being written for the first time has no id yet.
  drafting: false,
  query: '',
  setupStep: 'check',
  awaitingLogout: false,
  installing: false,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function show(el, visible) { el.hidden = !visible; }

function setNotice(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

// Flashes a confirmation that clears itself, so a save leaves no rubble on
// screen for the next edit.
let successTimer = null;
function flashSuccess(message) {
  setNotice(els.editSuccess, message);
  clearTimeout(successTimer);
  successTimer = setTimeout(() => setNotice(els.editSuccess, ''), 4000);
}

function firstLine(text, limit = 90) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

// An advanced snippet has no plain replacement to preview, so the raw YAML
// stands in — minus its leading comment, which belongs to the file rather
// than to the snippet and only crowds the list.
function preview(entry) {
  if (entry.replace !== null && entry.replace !== undefined) return entry.replace;
  return String(entry.raw || '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join(' ');
}

// Builds the highlighted label without ever putting a snippet's own text
// through innerHTML.
function highlighted(text, query) {
  const fragment = document.createDocumentFragment();
  if (!query) {
    fragment.append(text);
    return fragment;
  }
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) fragment.append(text.slice(from, at));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    fragment.append(mark);
    from = at + needle.length;
  }
  fragment.append(text.slice(from));
  return fragment;
}

// ---------------------------------------------------------------------------
// Update status widget: one dot, five states, no separate banner.
// ---------------------------------------------------------------------------

const RING_CIRCUMFERENCE = 2 * Math.PI * 8;
els.updateDotRingFill.style.strokeDasharray = String(RING_CIRCUMFERENCE);

const UPDATE_DOT_LABELS = {
  current: 'Up to date \u2014 click to check again',
  available: 'Update available \u2014 click to download',
  downloading: 'Downloading',
  downloaded: 'Click to restart',
  error: 'Can\u2019t connect to GitHub \u2014 click to try again',
};

let updateState = null;

function setUpdateDot(stateName, overrideLabel) {
  updateState = stateName;
  els.updateDot.dataset.state = stateName;
  // Only the in-flight download ignores clicks; every settled state has a
  // click action, including green (check again) and red (try again).
  els.updateDot.disabled = stateName === 'downloading';
  const label = overrideLabel || UPDATE_DOT_LABELS[stateName] || '';
  els.updateDot.dataset.tip = label;
  els.updateDot.setAttribute('aria-label', label);
}

function setRingProgress(fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  els.updateDotRingFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
}

window.lightmorphicText.appInfo().then(({ version }) => {
  // Always the version actually running, so it only changes after a restart.
  els.updateWidgetVersion.textContent = `v${version}`;
  show(els.updateWidget, true);
  setUpdateDot('current');
});

// True from a click on the dot until the next answer arrives, so that a
// manual check gets a spoken answer while the half-hourly one stays silent.
let manualCheck = false;

window.lightmorphicText.onUpdateState((incoming) => {
  if (incoming.status === 'none') setUpdateDot('current');
  else if (incoming.status === 'available') setUpdateDot('available');
  else if (incoming.status === 'downloading') {
    setUpdateDot('downloading');
    setRingProgress(incoming.percent / 100);
  } else if (incoming.status === 'downloaded') setUpdateDot('downloaded');
  else if (incoming.status === 'error') setUpdateDot('error');

  if (manualCheck) {
    manualCheck = false;
    // Yellow speaks for itself; green and red get their answer in words.
    if (incoming.status === 'none' && window.flashTooltip) {
      window.flashTooltip(els.updateDot, 'No update available');
    } else if (incoming.status === 'error' && window.flashTooltip) {
      window.flashTooltip(els.updateDot, 'Can\u2019t connect to GitHub');
    }
  }
  show(els.updateWidget, true);
});

els.updateDot.addEventListener('click', async () => {
  if (updateState === 'available') {
    setUpdateDot('downloading');
    setRingProgress(0);
    await window.lightmorphicText.updateDownload();
  } else if (updateState === 'downloaded') {
    await window.lightmorphicText.updateInstall();
  } else if (updateState === 'current' || updateState === 'error') {
    // A manual check: pulse while it happens, then answer out loud.
    els.updateDot.classList.remove('pulse');
    void els.updateDot.offsetWidth;
    els.updateDot.classList.add('pulse');
    manualCheck = true;
    await window.lightmorphicText.updateCheck();
  }
});

// ---------------------------------------------------------------------------
// Environment and the guided first run
// ---------------------------------------------------------------------------

const SESSION_WORDS = {
  wayland: 'Wayland',
  x11: 'X11',
  unknown: 'not detected',
};

function renderFacts(env) {
  els.setupFacts.textContent = '';
  const facts = [
    ['System', env.immutable ? `${env.distro} (immutable)` : env.distro],
    ['Display server', SESSION_WORDS[env.session] || env.session],
    ['Espanso', env.installed ? `version ${env.version}` : 'not installed'],
  ];
  if (env.session === 'wayland') {
    facts.push(['Keyboard permission', env.inInputGroup ? 'granted' : 'not granted yet']);
  }
  for (const [term, value] of facts) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    els.setupFacts.append(dt, dd);
  }
}

function setSteps(current, env) {
  const order = ['check', 'install', 'input', 'ready'];
  // The "keeps stopping" screen sits where "ready" would be.
  const key = current === 'health' ? 'ready' : current;
  const skipInput = env && env.session !== 'wayland';
  for (const li of els.setupSteps.querySelectorAll('.step')) {
    const name = li.dataset.step;
    if (name === 'input' && skipInput) {
      li.dataset.state = 'skipped';
      continue;
    }
    const position = order.indexOf(name) - order.indexOf(key);
    li.dataset.state = position < 0 ? 'done' : (position === 0 ? 'active' : 'todo');
  }
}

function setupCopy(step, env) {
  if (step === 'install') {
    return {
      heading: 'Espanso is not installed yet',
      lede: env.session === 'wayland'
        ? 'Lightmorphic Text will fetch the Wayland build of Espanso from its official GitHub release and '
          + 'put it in your home folder. Nothing is installed system-wide, so there is no password '
          + 'to type and nothing for your distribution to object to.'
        : 'Lightmorphic Text will fetch the X11 build of Espanso from its official GitHub release and put it '
          + 'in your home folder. Nothing is installed system-wide, so there is no password to type.',
      primary: 'Install Espanso',
      secondary: 'Skip for now',
    };
  }
  if (step === 'input') {
    if (state.awaitingLogout) {
      return {
        heading: 'Log out and back in',
        lede: 'Permission has been granted. Linux only applies a new group when you next log in, so '
          + 'log out of your desktop and back in — a full restart works too — then press Check again.',
        primary: 'Check again',
        secondary: null,
      };
    }
    return {
      heading: 'Give Espanso permission to read your keyboard',
      lede: 'On Wayland, no application can watch what you type through the display server. Espanso '
        + 'instead reads the keyboard device directly, and your user account needs to be in the '
        + '"input" group for that to be allowed. This is a one-off, and your desktop will ask you '
        + 'to confirm it.',
      primary: 'Give permission',
      secondary: 'Check again',
    };
  }
  if (step === 'health') {
    if (state.diag && state.diag.hint === 'input') {
      return {
        heading: 'The keyboard permission has not taken effect',
        lede: 'Espanso starts and then stops straight away, because it still cannot read the '
          + 'keyboard. Lightmorphic Text has stopped it retrying, so the flashing window stops too. '
          + 'Give the permission again below, and if it asks, log out and back in afterwards.',
        primary: 'Give permission again',
        secondary: 'Open my snippets anyway',
      };
    }
    if (state.diag && state.diag.hint === 'clipboard') {
      return {
        heading: 'A clipboard helper is missing',
        lede: 'Espanso needs a small tool called wl-clipboard to work with the clipboard on '
          + 'Wayland, and this system does not include it. Lightmorphic Text can fetch it and keep it '
          + 'in its own folder — nothing is installed system-wide, and no password is needed.',
        primary: 'Add it and start Espanso',
        secondary: 'Open my snippets anyway',
      };
    }
    return {
      heading: 'Espanso keeps stopping',
      lede: 'Espanso starts and then stops again straight away. Lightmorphic Text has stopped it '
        + 'retrying, so the flashing window stops too. Espanso’s own words about what went '
        + 'wrong are below — the copy button puts them on your clipboard.',
      primary: 'Try starting it again',
      secondary: 'Open my snippets anyway',
    };
  }
  if (step === 'ready') {
    return {
      heading: 'All set',
      lede: 'Espanso is installed and running. Anything you add here takes effect straight away.',
      primary: 'Open my snippets',
      secondary: null,
    };
  }
  return {
    heading: 'Checking this computer',
    lede: 'Just a moment while Lightmorphic Text works out what is already here.',
    primary: 'Continue',
    secondary: null,
  };
}

function renderSetup(step, env) {
  state.setupStep = step;
  setSteps(step, env);
  renderFacts(env);
  const copy = setupCopy(step, env);
  els.setupHeading.textContent = copy.heading;
  els.setupLede.textContent = copy.lede;
  els.setupPrimary.textContent = copy.primary;
  els.setupSecondary.textContent = copy.secondary || '';
  show(els.setupSecondary, Boolean(copy.secondary));
  els.setupPrimary.disabled = false;
}

function showScreen(which) {
  show(els.screenSetup, which === 'setup');
  show(els.screenMain, which === 'main');
  show(els.headerActions, which === 'main');
}

function serviceWords(env) {
  if (!env.installed) return ['unknown', 'Espanso not installed'];
  if (env.service === 'running') return ['running', 'Espanso running'];
  if (env.service === 'failing') return ['stopped', 'Espanso keeps stopping'];
  if (env.service === 'stopped' && env.enabled === false) return ['stopped', 'Espanso turned off'];
  if (env.service === 'stopped') return ['stopped', 'Espanso stopped'];
  return ['unregistered', 'Espanso not started'];
}

function renderService(env) {
  const [pillState, words] = serviceWords(env);
  els.servicePill.dataset.state = pillState;
  els.serviceText.textContent = words;
  // The power button mirrors the service: it always offers the opposite.
  const off = env.installed && env.service !== 'running' && env.enabled === false;
  const label = off
    ? 'Turn Espanso on'
    : 'Turn Espanso off — text expansion stops until you turn it back on';
  els.btnPower.dataset.tip = label;
  els.btnPower.setAttribute('aria-label', label);
  els.btnPower.dataset.off = off ? 'true' : 'false';
  els.btnPower.disabled = !env.installed;
}

async function refreshEnvironment() {
  const env = await window.lightmorphicText.describeEnvironment();
  if (env.error) {
    setNotice(els.setupError, env.error);
    return null;
  }
  state.env = env;
  renderService(env);
  return env;
}

// Works out which of the setup steps still has something outstanding, and
// goes straight there rather than marching the user through screens that
// have nothing to say.
async function routeStartup({ allowSkip = false } = {}) {
  const env = await refreshEnvironment();
  if (!env) { showScreen('setup'); return; }

  if (!env.installed && !allowSkip) {
    showScreen('setup');
    renderSetup('install', env);
    return;
  }
  if (env.needsInputGroup && !allowSkip) {
    showScreen('setup');
    renderSetup('input', env);
    return;
  }
  if (env.installed && env.service === 'failing' && !allowSkip) {
    // Espanso is dying on startup. Lightmorphic Text has already stopped the
    // restart loop; show its own words about why.
    state.diag = await window.lightmorphicText.diagnoseService();
    showScreen('setup');
    renderSetup('health', env);
    if (state.diag && state.diag.log) {
      els.setupCommandText.textContent = state.diag.log;
      show(els.setupCommand, true);
    }
    return;
  }

  // Espanso is there and allowed to run: make sure it actually is running,
  // then get out of the way.
  await window.lightmorphicText.ensureConfig();
  if (env.installed && env.service !== 'running' && env.enabled !== false) {
    // Someone who turned Espanso off stays in charge of turning it on.
    await window.lightmorphicText.service('start');
    await refreshEnvironment();
  }
  showScreen('main');
  await loadMatches();
}

els.setupPrimary.addEventListener('click', async () => {
  setNotice(els.setupError, '');
  show(els.setupCommand, false);

  if (state.setupStep === 'install') {
    await runInstall();
    return;
  }
  if (state.setupStep === 'input') {
    if (state.awaitingLogout) {
      await routeStartup();
      return;
    }
    els.setupPrimary.disabled = true;
    const result = await window.lightmorphicText.addToInputGroup();
    els.setupPrimary.disabled = false;
    if (result.ok) {
      state.awaitingLogout = true;
      renderSetup('input', state.env);
      return;
    }
    setNotice(els.setupError, result.error || 'That did not work.');
    if (result.command) {
      els.setupCommandText.textContent = result.command;
      show(els.setupCommand, true);
    }
    return;
  }
  if (state.setupStep === 'health') {
    els.setupPrimary.disabled = true;
    if (state.diag && state.diag.hint === 'input') {
      const result = await window.lightmorphicText.addToInputGroup();
      els.setupPrimary.disabled = false;
      if (result.ok) {
        state.awaitingLogout = true;
        renderSetup('input', state.env);
        return;
      }
      setNotice(els.setupError, result.error || 'That did not work.');
      if (result.command) {
        els.setupCommandText.textContent = result.command;
        show(els.setupCommand, true);
      }
      return;
    }
    const result = await window.lightmorphicText.retryService();
    els.setupPrimary.disabled = false;
    if (result.ok) {
      state.diag = null;
      await routeStartup();
      return;
    }
    state.diag = await window.lightmorphicText.diagnoseService();
    renderSetup('health', state.env);
    setNotice(els.setupError, result.error || 'That did not work.');
    if (state.diag && state.diag.log) {
      els.setupCommandText.textContent = state.diag.log;
      show(els.setupCommand, true);
    }
    return;
  }
  if (state.setupStep === 'ready') {
    await routeStartup();
    return;
  }
  await routeStartup();
});

els.setupSecondary.addEventListener('click', async () => {
  setNotice(els.setupError, '');
  if (state.setupStep === 'health') {
    // A broken Espanso is no reason to lock someone out of their snippets.
    await window.lightmorphicText.ensureConfig();
    showScreen('main');
    await loadMatches();
    return;
  }
  if (state.setupStep === 'install') {
    // Espanso missing is not a reason to lock someone out of their own
    // snippets — they can still be written now and take effect later.
    await window.lightmorphicText.ensureConfig();
    showScreen('main');
    await loadMatches();
    return;
  }
  await routeStartup();
});

els.btnCopyCommand.addEventListener('click', () => {
  window.lightmorphicText.copyText(els.setupCommandText.textContent);
});

window.lightmorphicText.onInstallProgress(({ step, fraction }) => {
  els.setupProgressText.textContent = step;
  els.setupBarFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
});

async function runInstall() {
  state.installing = true;
  els.setupPrimary.disabled = true;
  show(els.setupSecondary, false);
  show(els.setupProgress, true);
  els.setupBarFill.style.width = '0%';
  els.setupProgressText.textContent = 'Starting';
  setNotice(els.setupError, '');

  const result = await window.lightmorphicText.installEspanso();
  state.installing = false;
  show(els.setupProgress, false);
  els.setupPrimary.disabled = false;

  if (result.error) {
    setNotice(els.setupError, result.error);
    renderSetup('install', state.env);
    return;
  }
  const env = await refreshEnvironment();
  if (env && env.needsInputGroup) {
    renderSetup('input', env);
  } else {
    renderSetup('ready', env || state.env);
  }
}

// ---------------------------------------------------------------------------
// The snippet list
// ---------------------------------------------------------------------------

async function loadMatches({ keepSelection = true } = {}) {
  const data = await window.lightmorphicText.readMatches();
  if (data.error) {
    els.entryList.textContent = '';
    const p = document.createElement('p');
    p.className = 'entry-empty';
    p.textContent = data.error;
    els.entryList.append(p);
    return;
  }
  state.files = data.files;
  state.entries = data.entries;
  renderFileOptions();
  if (!keepSelection || !state.entries.some((e) => e.id === state.selectedId)) {
    if (!state.drafting) selectEntry(null);
  }
  renderList();
}

function renderFileOptions() {
  const previous = els.fieldFile.value;
  els.fieldFile.textContent = '';
  const writable = state.files.filter((file) => !file.readOnly && !file.error);
  for (const file of writable) {
    const option = document.createElement('option');
    option.value = file.relPath;
    option.textContent = file.relPath;
    els.fieldFile.append(option);
  }
  if (writable.length === 0) {
    const option = document.createElement('option');
    option.value = 'base.yml';
    option.textContent = 'base.yml';
    els.fieldFile.append(option);
  }
  if (previous && writable.some((f) => f.relPath === previous)) els.fieldFile.value = previous;
}

function visibleEntries() {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.entries;
  return state.entries.filter((entry) => {
    if (entry.triggers.some((t) => t.toLowerCase().includes(query))) return true;
    if (entry.replace && entry.replace.toLowerCase().includes(query)) return true;
    if (entry.label && entry.label.toLowerCase().includes(query)) return true;
    return false;
  });
}

function renderList() {
  const entries = visibleEntries();
  els.entryList.textContent = '';

  const total = state.entries.length;
  if (total === 0) {
    els.listCount.textContent = '';
  } else if (entries.length === total) {
    els.listCount.textContent = `${total} snippet${total === 1 ? '' : 's'}`;
  } else {
    els.listCount.textContent = `${entries.length} of ${total} snippets`;
  }

  if (entries.length === 0) {
    const p = document.createElement('p');
    p.className = 'entry-empty';
    p.textContent = total === 0
      ? 'No snippets yet. Press the plus button to write your first one.'
      : 'Nothing matches that search.';
    els.entryList.append(p);
    return;
  }

  const query = state.query.trim();
  const showFile = state.files.length > 1;
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'entry';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(entry.id === state.selectedId));
    button.dataset.id = entry.id;

    const head = document.createElement('span');
    head.className = 'entry-trigger';
    head.append(highlighted(entry.triggers[0] || '(no trigger)', query));
    if (entry.triggers.length > 1) {
      const extra = document.createElement('span');
      extra.className = 'entry-extra';
      extra.textContent = `+${entry.triggers.length - 1} more`;
      head.append(extra);
    }
    if (entry.advanced) {
      const extra = document.createElement('span');
      extra.className = 'entry-extra';
      extra.textContent = 'advanced';
      head.append(extra);
    }
    if (entry.readOnly) {
      const extra = document.createElement('span');
      extra.className = 'entry-extra';
      extra.textContent = 'package';
      head.append(extra);
    }
    button.append(head);

    const body = document.createElement('span');
    body.className = 'entry-replace';
    body.append(highlighted(firstLine(preview(entry)), query));
    button.append(body);

    if (showFile) {
      const file = document.createElement('span');
      file.className = 'entry-file';
      file.textContent = entry.file;
      button.append(file);
    }

    els.entryList.append(button);
  }
}

els.entryList.addEventListener('click', (event) => {
  const button = event.target.closest('.entry');
  if (!button) return;
  selectEntry(button.dataset.id);
});

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  renderList();
});

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

function disarmDelete() {
  els.btnDelete.dataset.armed = 'false';
  els.btnDelete.textContent = 'Delete';
  clearTimeout(disarmDelete.timer);
}

function selectEntry(id) {
  state.selectedId = id;
  state.drafting = false;
  disarmDelete();
  setNotice(els.editError, '');
  setNotice(els.editSuccess, '');

  const entry = state.entries.find((e) => e.id === id);
  if (!entry) {
    show(els.editForm, false);
    show(els.editEmpty, true);
    show(els.editBadge, false);
    renderList();
    return;
  }

  show(els.editEmpty, false);
  show(els.editForm, true);

  const locked = entry.readOnly || entry.advanced;
  els.fieldTrigger.value = entry.triggers.join(', ');
  els.fieldReplace.value = entry.replace || '';
  els.fieldWord.checked = entry.word;
  els.fieldPropagate.checked = entry.propagateCase;
  els.fieldFile.value = entry.file;
  els.fieldFile.disabled = true;

  // For a snippet Lightmorphic Text won't rewrite, the raw YAML replaces the
  // replacement box outright — an empty, greyed-out field would only invite
  // someone to try typing in it.
  show(els.fieldRawWrap, entry.advanced);
  show(els.fieldReplaceWrap, !entry.advanced);
  if (entry.advanced) {
    els.fieldRaw.textContent = entry.raw;
    els.rawReason.textContent = entry.advancedReason || '';
  }

  els.fieldTrigger.disabled = locked;
  els.fieldReplace.disabled = locked;
  els.fieldWord.disabled = locked;
  els.fieldPropagate.disabled = locked;
  els.btnSave.disabled = locked;
  els.btnDelete.disabled = entry.readOnly;

  if (entry.readOnly) {
    els.editBadge.textContent = 'From a package';
    show(els.editBadge, true);
  } else if (entry.advanced) {
    els.editBadge.textContent = 'Read-only here';
    show(els.editBadge, true);
  } else {
    show(els.editBadge, false);
  }

  renderList();
}

function startDraft() {
  state.selectedId = null;
  state.drafting = true;
  disarmDelete();
  setNotice(els.editError, '');
  setNotice(els.editSuccess, '');

  show(els.editEmpty, false);
  show(els.editForm, true);
  show(els.fieldRawWrap, false);
  show(els.fieldReplaceWrap, true);
  show(els.editBadge, true);
  els.editBadge.textContent = 'New snippet';

  els.fieldTrigger.value = '';
  els.fieldReplace.value = '';
  els.fieldWord.checked = false;
  els.fieldPropagate.checked = false;
  els.fieldFile.disabled = false;
  els.fieldTrigger.disabled = false;
  els.fieldReplace.disabled = false;
  els.fieldWord.disabled = false;
  els.fieldPropagate.disabled = false;
  els.btnSave.disabled = false;
  els.btnDelete.disabled = true;

  renderList();
  els.fieldTrigger.focus();
}

function currentFields() {
  return {
    triggers: els.fieldTrigger.value.split(',').map((t) => t.trim()).filter(Boolean),
    replace: els.fieldReplace.value,
    word: els.fieldWord.checked,
    propagateCase: els.fieldPropagate.checked,
  };
}

// Espanso is told to reload after every write; if that fails the snippet is
// still saved, and saying so is more use than pretending otherwise.
function reportSave(result, what) {
  if (result.restartError) {
    flashSuccess(`${what}, but Espanso would not reload. Try the restart button.`);
  } else if (result.restarted) {
    flashSuccess(`${what} and Espanso reloaded — it works right now.`);
  } else {
    flashSuccess(`${what}. It will work once Espanso is running.`);
  }
}

els.editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setNotice(els.editError, '');
  els.btnSave.disabled = true;

  const wasDraft = state.drafting;
  const fields = currentFields();
  const result = wasDraft
    ? await window.lightmorphicText.createMatch(els.fieldFile.value, fields)
    : await window.lightmorphicText.updateMatch(state.selectedId, fields);

  els.btnSave.disabled = false;
  if (result.error) {
    setNotice(els.editError, result.error);
    return;
  }
  const newId = result.id || state.selectedId;
  state.drafting = false;
  state.selectedId = newId;
  await loadMatches();
  selectEntry(newId);
  reportSave(result, wasDraft ? 'Snippet added' : 'Snippet saved');
});

els.btnCancel.addEventListener('click', () => {
  if (state.drafting) {
    state.drafting = false;
    selectEntry(null);
  } else {
    selectEntry(state.selectedId);
  }
});

// Two deliberate clicks, no dialog: the button turns red in place and says
// what the next click will do, then gives up after a few seconds.
els.btnDelete.addEventListener('click', async () => {
  if (els.btnDelete.dataset.armed !== 'true') {
    els.btnDelete.dataset.armed = 'true';
    els.btnDelete.textContent = 'Click again to delete';
    disarmDelete.timer = setTimeout(disarmDelete, 5000);
    return;
  }
  disarmDelete();
  const result = await window.lightmorphicText.deleteMatch(state.selectedId);
  if (result.error) {
    setNotice(els.editError, result.error);
    return;
  }
  state.selectedId = null;
  await loadMatches({ keepSelection: false });
  selectEntry(null);
  reportSave(result, 'Snippet deleted');
});

els.btnNew.addEventListener('click', startDraft);

// ---------------------------------------------------------------------------
// Header actions
// ---------------------------------------------------------------------------

els.btnPower.addEventListener('click', async () => {
  els.btnPower.disabled = true;
  const turningOff = els.btnPower.dataset.off !== 'true';
  els.serviceText.textContent = turningOff ? 'Turning off\u2026' : 'Starting\u2026';
  await window.lightmorphicText.service(turningOff ? 'off' : 'on');
  await refreshEnvironment();
  els.btnPower.disabled = false;
});

els.btnRestart.addEventListener('click', async () => {
  els.btnRestart.disabled = true;
  els.serviceText.textContent = 'Restarting…';
  await window.lightmorphicText.service('restart');
  await refreshEnvironment();
  els.btnRestart.disabled = false;
});

els.btnOpenDir.addEventListener('click', () => window.lightmorphicText.openConfigDir());

els.btnRefresh.addEventListener('click', async () => {
  els.btnRefresh.disabled = true;
  await refreshEnvironment();
  await loadMatches();
  els.btnRefresh.disabled = false;
});

// Somebody else editing the files — another editor, or Espanso's own package
// manager — should not leave this list showing yesterday's snippets.
window.lightmorphicText.onMatchesChanged(() => {
  if (!els.screenMain.hidden) loadMatches();
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== els.search
      && document.activeElement !== els.fieldTrigger
      && document.activeElement !== els.fieldReplace) {
    event.preventDefault();
    els.search.focus();
    els.search.select();
  }
});

// ---------------------------------------------------------------------------

showScreen('setup');
routeStartup();
