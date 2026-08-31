'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, Tray, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');

// Launched from a desktop icon, stdout and stderr can be dead pipes. An
// unhandled EPIPE from any stray write — electron-updater's logging is the
// usual culprit — would take the whole app down with it.
if (process.stdout) process.stdout.on('error', () => {});
if (process.stderr) process.stderr.on('error', () => {});

const espanso = require('./espanso');
const matches = require('./matches');

// Chromium's sandbox needs either a SUID helper (which an AppImage cannot
// carry) or unprivileged user namespaces. A few distros — Debian most
// notably — ship with those disabled, and the resulting crash is a wall of
// zygote errors with no hint of the cause. Check up front and say what's
// wrong in plain words instead. This runs before app.whenReady(), early
// enough that Chromium has not yet tried to fork anything sandboxed.
(function checkSandboxSupport() {
  if (process.platform !== 'linux') return;
  let value = null;
  try {
    value = fs.readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim();
  } catch {
    return; // No such knob means namespaces are simply allowed.
  }
  if (value !== '0') return;
  const { execFileSync } = require('node:child_process');
  const message =
    'Lightmorphic Text could not start because this system does not allow the '
    + 'sandbox it runs in (unprivileged user namespaces are switched off — '
    + 'the Debian default).\n\n'
    + 'To allow it, run this once in a terminal, then start Lightmorphic Text again:\n\n'
    + '    sudo sysctl -w kernel.unprivileged_userns_clone=1';
  try {
    execFileSync('zenity', ['--error', '--title=Lightmorphic Text', '--width=420', `--text=${message}`]);
  } catch {
    try {
      execFileSync('notify-send', ['--urgency=critical', 'Lightmorphic Text could not start', message]);
    } catch {
      // Neither dialog tool around: the console message below is all we have.
    }
  }
  console.error(`Lightmorphic Text: ${message}`);
  app.exit(1);
})();

let mainWindow = null;
let tray = null;
// Only true when a StatusNotifier watcher is actually on the bus. KDE always
// has one; stock GNOME has none (it needs the AppIndicator extension), and an
// app that "hides to the tray" with no tray becomes unreachable — a lesson
// learned the hard way on Talkin. No watcher, no hide-on-close.
let trayAvailable = false;
let quitting = false;
let hideNoticeShown = false;
let watcher = null;
let watchTimer = null;
// True while Lightmorphic Text is writing, so its own saves don't come back as
// "somebody changed this behind your back".
let selfWriting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#09090b',
    title: 'Lightmorphic Text',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // With a real tray present, closing the window keeps the app (and its
  // half-hourly update checks) alive in the background instead of quitting.
  mainWindow.on('close', (event) => {
    if (!trayAvailable || quitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!hideNoticeShown) {
      hideNoticeShown = true;
      const { execFile } = require('node:child_process');
      execFile('notify-send', ['--app-name=Lightmorphic Text',
        'Still running', 'Lightmorphic Text is in the tray. Use its menu to quit.'], () => {});
    }
  });

  // Links go to the system browser; nothing ever navigates inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Watching the match directory
//
// Espanso's own files are fair game for any other editor, and the Espanso
// package manager writes into match/packages. Rather than let the list drift
// out of date, watch the directory and tell the renderer to reload.
// ---------------------------------------------------------------------------

function startWatching() {
  stopWatching();
  const dir = matches.matchDir();
  if (!fs.existsSync(dir)) return;
  try {
    watcher = fs.watch(dir, { recursive: true }, () => {
      if (selfWriting) return;
      clearTimeout(watchTimer);
      // Editors write in bursts; one notification after things settle is
      // plenty, and avoids reloading the list five times per save.
      watchTimer = setTimeout(() => send('matches-changed'), 400);
    });
  } catch {
    // Recursive watching isn't available everywhere; the manual refresh
    // button covers it.
  }
}

function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  clearTimeout(watchTimer);
}

async function guardWrite(action) {
  selfWriting = true;
  try {
    return await action();
  } finally {
    // Give the watcher's event a moment to arrive and be ignored.
    setTimeout(() => { selfWriting = false; }, 600);
  }
}

// ---------------------------------------------------------------------------
// Updates: GitHub Releases for Lightmorphic Text itself, and nothing else. Nothing
// downloads until the user clicks the dot.
// ---------------------------------------------------------------------------

function setupUpdates() {
  if (!app.isPackaged) {
    // The dot still exists in a dev run; answer it honestly.
    ipcMain.handle('update-check', async () => ({ ok: false }));
    return;
  }
  autoUpdater.logger = null;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => send('update-state', { status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send('update-state', { status: 'none' }));
  autoUpdater.on('download-progress', (p) => send('update-state', { status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update-state', { status: 'downloaded', version: info.version }));
  autoUpdater.on('error', () => send('update-state', { status: 'error' }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  ipcMain.handle('update-check', async () => { await check(); return { ok: true }; });
  setTimeout(check, 5000);
  setInterval(check, 30 * 60 * 1000);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  mainWindow.show();
  mainWindow.focus();
}

// Is anyone on the session bus offering to host tray icons? Tried with
// busctl first (systemd ships it everywhere), then gdbus. Only close-to-tray
// depends on the answer — the icon itself is created regardless, since a
// desktop with no tray simply never shows it.
function checkForTrayWatcher() {
  const { execFile } = require('node:child_process');
  const attempts = [
    ['busctl', ['--user', '--no-pager', 'status', 'org.kde.StatusNotifierWatcher']],
    ['gdbus', ['call', '--session',
      '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner',
      'org.kde.StatusNotifierWatcher']],
  ];
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= attempts.length) return resolve(false);
      execFile(attempts[i][0], attempts[i][1], { timeout: 5000 }, (error, stdout) => {
        if (attempts[i][0] === 'busctl') {
          if (!error) return resolve(true);
          // busctl present but name unowned exits non-zero; missing tool
          // (ENOENT) means try the next tool instead.
          if (error.code !== 'ENOENT') return resolve(false);
          return tryNext(i + 1);
        }
        if (!error) return resolve(String(stdout).includes('true'));
        return tryNext(i + 1);
      });
    };
    tryNext(0);
  });
}

// A tray icon served over StatusNotifier must be a real file on disk —
// a path inside the app's asar archive fails without a word.
function trayIconPath() {
  const bundled = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  try {
    const dest = path.join(app.getPath('userData'), 'tray-icon.png');
    fs.copyFileSync(bundled, dest);
    return dest;
  } catch {
    return bundled;
  }
}

async function setupTray() {
  try {
    tray = new Tray(trayIconPath());
  } catch {
    return; // No tray is a state, not an error; close keeps meaning quit.
  }
  tray.setToolTip('Lightmorphic Text');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Lightmorphic Text', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
  trayAvailable = await checkForTrayWatcher();
}

app.whenReady().then(() => {
  createWindow();
  setupUpdates();
  setupTray();
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  stopWatching();
  app.quit();
});

// ---------------------------------------------------------------------------
// IPC. Every handler returns a plain object; anything that can go wrong comes
// back as { error } in words the person reading it can act on.
// ---------------------------------------------------------------------------

function failed(err) {
  return { error: err && err.message ? err.message : 'Something went wrong.' };
}

ipcMain.handle('app-info', async () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
}));

// Held from the moment a crash-restart loop is noticed until Espanso next
// starts cleanly. Noticing it also stops the service: a unit stuck dying
// every three seconds flashes Espanso's broken helper window at the user
// on Wayland, and nothing useful comes from letting that continue.
let serviceTrouble = null;

ipcMain.handle('env-describe', async () => {
  try {
    const env = await espanso.describeEnvironment();
    if (env.binary) await espanso.ensureUnitCurrent(env.binary);
    if (env.service === 'failing') {
      serviceTrouble = await espanso.serviceDiagnostics();
      await espanso.calmService();
    } else if (env.service === 'running') {
      serviceTrouble = null;
    }
    if (serviceTrouble) env.service = 'failing';
    return env;
  } catch (err) {
    return failed(err);
  }
});

ipcMain.handle('espanso-service-diagnose', async () => {
  try {
    if (!serviceTrouble) serviceTrouble = await espanso.serviceDiagnostics();
    return serviceTrouble;
  } catch (err) {
    return failed(err);
  }
});

ipcMain.handle('espanso-service-retry', async () => {
  try {
    const env = await espanso.describeEnvironment();
    if (!env.binary) return { ok: false, error: 'Espanso is not installed yet.' };
    // Repair what a retry can repair: fetch the Wayland clipboard tools if
    // they are the missing piece before starting Espanso again.
    try {
      await espanso.ensureWaylandTools();
    } catch (err) {
      return { ok: false, error: `The clipboard tools could not be fetched. ${err.message}` };
    }
    const started = await espanso.startService(env.binary);
    if (!started.ok) return started;
    // "Started" from systemd only means the process launched. Give it a
    // moment to fall over before telling the user it is fine.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (await espanso.serviceState(env.binary) === 'failing') {
      serviceTrouble = await espanso.serviceDiagnostics();
      await espanso.calmService();
      return { ok: false, error: 'Espanso stopped again straight away.' };
    }
    serviceTrouble = null;
    return { ok: true };
  } catch (err) {
    return failed(err);
  }
});

ipcMain.handle('espanso-install', async () => {
  try {
    const result = await espanso.install({
      onProgress: (state) => send('install-progress', state),
    });
    await espanso.ensureConfigSkeleton();
    await espanso.registerService(result.binary);
    await espanso.startService(result.binary);
    startWatching();
    return { ok: true, version: result.version };
  } catch (err) {
    return failed(err);
  }
});

ipcMain.handle('espanso-input-group', async () => {
  try {
    return await espanso.addToInputGroup();
  } catch (err) {
    return failed(err);
  }
});

ipcMain.handle('espanso-service', async (event, action) => {
  try {
    const env = await espanso.describeEnvironment();
    if (!env.binary) return { error: 'Espanso is not installed yet.' };
    if (action === 'start') return await espanso.startService(env.binary);
    if (action === 'stop') return await espanso.stopService();
    if (action === 'off') { serviceTrouble = null; return await espanso.setServiceOn(env.binary, false); }
    if (action === 'on') return await espanso.setServiceOn(env.binary, true);
    if (action === 'restart') return await espanso.restartService(env.binary);
    if (action === 'register') return { ok: await espanso.registerService(env.binary) };
    return { error: 'Unknown action.' };
  } catch (err) {
    return failed(err);
  }
});

ipcMain.handle('config-ensure', async () => {
  try {
    const dir = await espanso.ensureConfigSkeleton();
    startWatching();
    return { ok: true, configDir: dir };
  } catch (err) {
    return failed(err);
  }
});

ipcMain.handle('matches-read', async () => {
  try {
    startWatching();
    return await matches.readAll();
  } catch (err) {
    return failed(err);
  }
});

// One save path for the three write operations, so restarting Espanso after
// a change can never be forgotten for one of them.
async function saveThenReload(work) {
  const result = await guardWrite(work);
  if (result.error) return result;
  const env = await espanso.describeEnvironment();
  if (env.binary && env.service === 'running') {
    const restarted = await espanso.restartService(env.binary);
    return { ...result, restarted: restarted.ok, restartError: restarted.error || null };
  }
  return { ...result, restarted: false, restartError: null };
}

ipcMain.handle('match-create', async (event, relPath, fields) =>
  saveThenReload(() => matches.createEntry(relPath, fields)).catch(failed));

ipcMain.handle('match-update', async (event, id, fields) =>
  saveThenReload(() => matches.updateEntry(id, fields)).catch(failed));

ipcMain.handle('match-delete', async (event, id) =>
  saveThenReload(() => matches.deleteEntry(id)).catch(failed));

ipcMain.handle('file-create', async (event, name) => {
  try {
    return await guardWrite(() => matches.createFile(name));
  } catch (err) {
    return failed(err);
  }
});

ipcMain.handle('open-config-dir', async () => {
  const dir = espanso.configDir();
  if (fs.existsSync(dir)) shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle('copy-text', async (event, text) => {
  if (typeof text === 'string' && text.length < 10000) clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle('update-download', async () => {
  if (!app.isPackaged) return { ok: false };
  autoUpdater.downloadUpdate().catch(() => {});
  return { ok: true };
});

ipcMain.handle('update-install', async () => {
  if (!app.isPackaged) return { ok: false };
  autoUpdater.quitAndInstall();
  return { ok: true };
});
