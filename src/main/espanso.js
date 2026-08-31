'use strict';

// Everything that knows about Espanso itself: where it lives, which build
// this session needs, how to install one when there isn't one, and how to
// drive its systemd user service.
//
// Design notes, because the obvious approaches all fail somewhere:
//
//  * Espanso publishes a self-contained AppImage for X11 only. The Wayland
//    build ships as a .deb whose binary links against wxWidgets 3.2 from the
//    distro — which does not exist on Fedora Silverblue or Bazzite. So for a
//    Wayland session we take the binary from the .deb and borrow only the
//    libraries the system is actually missing out of the X11 AppImage.
//  * We never run the AppImage as an AppImage. It is unpacked with
//    --appimage-extract, which is self-contained and needs no FUSE at all,
//    so the "AppImages require FUSE" failure on FUSE3-only distros can't bite.
//  * Nothing is installed with a package manager, so an immutable host is
//    just another host.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const RELEASES_API = 'https://api.github.com/repos/espanso/espanso/releases/latest';
const X11_ASSET = 'Espanso-X11.AppImage';
const WAYLAND_ASSET = 'espanso-debian-wayland-amd64.deb';

const HOME = os.homedir();
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

const DATA_ROOT = path.join(DATA_HOME, 'lightmorphic-text');
// Where releases under the old name kept everything; migrated on first run.
const LEGACY_DATA_ROOT = path.join(DATA_HOME, 'textmorph');
const MANAGED_ROOT = path.join(DATA_ROOT, 'espanso');
const MANAGED_BIN = path.join(MANAGED_ROOT, 'bin', 'espanso');
const MANAGED_LIB = path.join(MANAGED_ROOT, 'lib');
const MANAGED_STAMP = path.join(MANAGED_ROOT, 'installed.json');
const WORK_DIR = path.join(DATA_ROOT, 'work');
const SHIM = path.join(HOME, '.local', 'bin', 'espanso');
const UNIT_DIR = path.join(CONFIG_HOME, 'systemd', 'user');
const UNIT_FILE = path.join(UNIT_DIR, 'espanso.service');

const SEARCH_PATHS = [
  MANAGED_BIN,
  path.join(HOME, '.local', 'bin', 'espanso'),
  '/usr/local/bin/espanso',
  '/usr/bin/espanso',
  '/bin/espanso',
];

// ---------------------------------------------------------------------------
// Small process helpers. Nothing here ever goes through a shell, so no value
// from a config file or a release listing can turn into a shell command.
// ---------------------------------------------------------------------------

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 20000, ...opts }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

function exists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

// Wayland sessions need a different Espanso build and a one-off permission
// step, so getting this wrong is the difference between "works" and "types
// nothing, ever". XDG_SESSION_TYPE is authoritative when it's set sensibly;
// the presence of WAYLAND_DISPLAY is the tiebreaker.
function detectSession() {
  const declared = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
  if (declared === 'wayland') return 'wayland';
  if (declared === 'x11') return 'x11';
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'unknown';
}

function readOsRelease() {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const fields = {};
      for (const line of text.split('\n')) {
        const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (match) fields[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
      }
      return fields;
    } catch { /* try the next one */ }
  }
  return {};
}

// An immutable host (Silverblue, Bazzite, and friends) has a read-only /usr,
// so "just install the package" is never an option there. We only report it —
// the install path is the same everywhere by design.
function isImmutable() {
  const id = readOsRelease();
  const variant = `${id.ID || ''} ${id.VARIANT_ID || ''} ${id.ID_LIKE || ''}`.toLowerCase();
  if (/silverblue|kinoite|bazzite|sericea|onyx|bluefin|aurora/.test(variant)) return true;
  if (exists('/run/ostree-booted')) return true;
  return false;
}

function distroName() {
  const id = readOsRelease();
  return id.PRETTY_NAME || id.NAME || 'Linux';
}

async function inInputGroup() {
  const result = await run('id', ['-nG']);
  if (!result.ok) return false;
  return result.stdout.split(/\s+/).includes('input');
}

function findEspanso() {
  for (const candidate of SEARCH_PATHS) {
    if (isExecutable(candidate)) {
      return { binary: candidate, managed: candidate === MANAGED_BIN };
    }
  }
  return null;
}

// The managed binary needs its borrowed libraries on the search path, and
// its own bin directory on PATH so helper tools kept beside it (wl-copy,
// wl-paste) are found. A system binary must get neither, or we would shadow
// the distro's own.
function envFor(binary) {
  if (binary !== MANAGED_BIN) return process.env;
  const env = { ...process.env };
  if (exists(MANAGED_LIB)) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${MANAGED_LIB}:${env.LD_LIBRARY_PATH}` : MANAGED_LIB;
  }
  const binDir = path.dirname(MANAGED_BIN);
  env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir;
  return env;
}

async function espansoVersion(binary) {
  const result = await run(binary, ['--version'], { env: envFor(binary) });
  if (!result.ok) return null;
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout);
  return match ? match[1] : result.stdout || null;
}

async function serviceState(binary) {
  if (!exists(UNIT_FILE)) return 'unregistered';
  // systemd knows the difference between "stopped" and "dying over and over";
  // Espanso's own status command does not.
  const unit = await run('systemctl', ['--user', 'is-active', 'espanso.service']);
  const answer = (unit.stdout || '').trim();
  if (answer === 'active') return 'running';
  if (answer === 'activating' || answer === 'failed') return 'failing';
  if (answer === 'inactive') {
    // Distinguish "never asked to run" from "gave up after repeated crashes":
    // a spent start limit leaves NRestarts behind.
    const restarts = await run('systemctl', ['--user', 'show', 'espanso.service', '-p', 'NRestarts', '--value']);
    if (parseInt(restarts.stdout, 10) > 0) return 'failing';
    return 'stopped';
  }
  const result = await run(binary, ['status'], { env: envFor(binary) });
  const text = `${result.stdout} ${result.stderr}`.toLowerCase();
  if (text.includes('not running')) return 'stopped';
  if (text.includes('running')) return 'running';
  return result.ok ? 'running' : 'stopped';
}

async function serviceEnabled() {
  if (!exists(UNIT_FILE)) return false;
  const r = await run('systemctl', ['--user', 'is-enabled', 'espanso.service']);
  return (r.stdout || '').trim() === 'enabled';
}

// The off switch. Off means off: disabled so no login or Lightmorphic Text launch
// brings it back, stopped so it ends now, and any crash-loop failure record
// cleared so nothing keeps flashing.
async function setServiceOn(binary, on) {
  if (on) {
    await run('systemctl', ['--user', 'enable', 'espanso.service']);
    return startService(binary);
  }
  await run('systemctl', ['--user', 'disable', 'espanso.service']);
  await calmService();
  return { ok: true };
}

// What Espanso itself said before it died, plus a reading of it. Used by the
// "Espanso keeps stopping" screen.
function classifyServiceLog(text) {
  if (/unable to open EVDEV|['"]?input['"]? group/i.test(text)) return 'input';
  // Checked before the layout warning: a log that panics over wl-clipboard
  // usually carries harmless layout warnings above the actual error.
  if (/wl-clipboard|wl-paste|wl-copy/i.test(text)) return 'clipboard';
  if (/keyboard layout/i.test(text) && /explicitly specify/i.test(text)) return 'layout';
  return null;
}

async function serviceDiagnostics() {
  const log = await run('journalctl', ['--user', '-u', 'espanso.service', '-n', '40', '--no-pager', '-o', 'cat']);
  const text = log.stdout || '';
  return { log: text, hint: classifyServiceLog(text) };
}

// Ends a crash-restart loop: stop the unit and clear its failure record so
// the flashing stops the moment Lightmorphic Text notices it.
async function calmService() {
  await run('systemctl', ['--user', 'stop', 'espanso.service']);
  await run('systemctl', ['--user', 'reset-failed', 'espanso.service']);
}

// The app was briefly named Textmorph; its data directory moves over in one
// rename (espanso, borrowed libs, work area and backups all live inside it),
// and a shim still pointing into the old directory is rewritten.
let migrationDone = false;
async function migrateLegacyData() {
  if (migrationDone) return;
  migrationDone = true;
  if (exists(LEGACY_DATA_ROOT) && !exists(DATA_ROOT)) {
    try { await fsp.rename(LEGACY_DATA_ROOT, DATA_ROOT); } catch { return; }
  }
  if (exists(SHIM) && exists(MANAGED_BIN)) {
    const current = await fsp.readFile(SHIM, 'utf8').catch(() => '');
    if (/Written by (Textmorph|Lightmorphic Text)/.test(current) && !current.includes(MANAGED_BIN)) {
      await writeShim();
    }
  }
}

async function describeEnvironment() {
  await migrateLegacyData();
  const session = detectSession();
  const found = findEspanso();
  const info = {
    session,
    distro: distroName(),
    immutable: isImmutable(),
    inInputGroup: await inInputGroup(),
    installed: Boolean(found),
    managed: found ? found.managed : false,
    binary: found ? found.binary : null,
    version: null,
    service: 'unregistered',
    enabled: false,
    // Only a Wayland session needs the input-group permission; on X11 the
    // question doesn't arise, so don't put the user through it.
    needsInputGroup: false,
    configDir: configDir(),
  };
  if (found) {
    info.version = await espansoVersion(found.binary);
    // A binary that won't even print its version is broken, not installed.
    if (info.version === null) {
      info.installed = false;
      info.binary = null;
    } else {
      info.service = await serviceState(found.binary);
      info.enabled = await serviceEnabled();
    }
  }
  info.needsInputGroup = session === 'wayland' && !info.inInputGroup;
  return info;
}

// ---------------------------------------------------------------------------
// Config directory
// ---------------------------------------------------------------------------

// Worked out from the XDG rules rather than by asking the binary: `espanso
// path` panics outright when no config directory exists yet, which is exactly
// the first-run case we most need an answer for.
function configDir() {
  const legacy = path.join(HOME, '.espanso');
  if (exists(path.join(legacy, 'match'))) return legacy;
  return path.join(CONFIG_HOME, 'espanso');
}

const DEFAULT_CONFIG = `# Espanso configuration, managed alongside Lightmorphic Text.
# Anything you set here applies to every application unless a more specific
# config file overrides it. See https://espanso.org/docs/configuration/
`;

const DEFAULT_MATCHES = `# Your text expansions live here.
# Lightmorphic Text edits this file for you, and leaves your comments alone.

matches:
  - trigger: ":tm"
    replace: "Typed by Lightmorphic Text"
`;

// On Wayland, Espanso reads key presses straight from the keyboard device
// and has to be told the layout — it cannot ask the compositor. Left
// unspecified it assumes US, so on a UK keyboard characters like # and @
// land on the wrong keys and any trigger using them never fires. The
// desktop knows the layout; pass it along.
function parseGnomeSources(text) {
  const m = /\(\s*'xkb'\s*,\s*'([^']+)'\s*\)/.exec(String(text || ''));
  return m ? m[1] : null;
}

function parseLocalectl(text) {
  const m = /X11 Layout:\s*(\S+)/.exec(String(text || ''));
  return m ? m[1].split(',')[0] : null;
}

// GNOME writes sources like 'gb' or 'gb+extd' — layout plus variant.
function splitXkbSource(source) {
  const [layout, variant] = String(source).split('+');
  return { layout, variant: variant || null };
}

async function detectKeyboardLayout() {
  const g = await run('gsettings', ['get', 'org.gnome.desktop.input-sources', 'sources']);
  const fromGnome = g.ok ? parseGnomeSources(g.stdout) : null;
  if (fromGnome) return splitXkbSource(fromGnome);
  const l = await run('localectl', ['status']);
  const fromLocalectl = l.ok ? parseLocalectl(l.stdout) : null;
  if (fromLocalectl) return splitXkbSource(fromLocalectl);
  return null;
}

async function ensureKeyboardLayout() {
  if (detectSession() !== 'wayland') return;
  const configFile = path.join(configDir(), 'config', 'default.yml');
  const current = await fsp.readFile(configFile, 'utf8').catch(() => null);
  if (current === null || current.includes('keyboard_layout')) return;
  const detected = await detectKeyboardLayout();
  if (!detected || !detected.layout) return;
  const block = `
# The keyboard layout, written by Lightmorphic Text. On Wayland, Espanso
# reads keys straight from the keyboard device and must be told the layout;
# without this it assumes US, and keys like # or @ land in the wrong place.
keyboard_layout:
  layout: "${detected.layout}"${detected.variant ? `\n  variant: "${detected.variant}"` : ''}
`;
  await fsp.writeFile(configFile, current + block, 'utf8');
}

async function ensureConfigSkeleton() {
  const root = configDir();
  await fsp.mkdir(path.join(root, 'config'), { recursive: true });
  await fsp.mkdir(path.join(root, 'match'), { recursive: true });
  const configFile = path.join(root, 'config', 'default.yml');
  const matchFile = path.join(root, 'match', 'base.yml');
  if (!exists(configFile)) await fsp.writeFile(configFile, DEFAULT_CONFIG, 'utf8');
  if (!exists(matchFile)) await fsp.writeFile(matchFile, DEFAULT_MATCHES, 'utf8');
  await ensureKeyboardLayout();
  return root;
}

// ---------------------------------------------------------------------------
// Download and install
// ---------------------------------------------------------------------------

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Lightmorphic Text', Accept: 'application/vnd.github+json' },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return resolve(getJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub replied ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
  });
}

function download(url, dest, onProgress, soFar = 0, span = 1) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Lightmorphic Text' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(download(res.headers.location, dest, onProgress, soFar, span));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (HTTP ${res.statusCode})`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total && onProgress) onProgress(soFar + (received / total) * span);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
  });
}

// A .deb is an ar archive: an 8-byte magic, then 60-byte headers each
// followed by their payload, padded to an even length. Parsing it here means
// not depending on `ar`, which is part of binutils and often absent.
async function extractDebData(debPath, outPath) {
  const buffer = await fsp.readFile(debPath);
  if (buffer.subarray(0, 8).toString('ascii') !== '!<arch>\n') {
    throw new Error('That download does not look like a Debian package.');
  }
  let offset = 8;
  while (offset + 60 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString('ascii').trim().replace(/\/$/, '');
    const size = parseInt(header.subarray(48, 58).toString('ascii').trim(), 10);
    if (!Number.isFinite(size)) throw new Error('The Debian package is malformed.');
    const start = offset + 60;
    if (name.startsWith('data.tar')) {
      await fsp.writeFile(outPath + path.extname(name), buffer.subarray(start, start + size));
      return outPath + path.extname(name);
    }
    offset = start + size + (size % 2);
  }
  throw new Error('The Debian package has no data archive in it.');
}

// Copies across only the libraries the host is genuinely missing, one round
// at a time — satisfying one library can reveal the next. Anything the system
// already provides is left well alone, which is what stops a bundled
// libmount/libgio from shadowing a newer system one and breaking the binary.
async function fillMissingLibraries(binary, sourceDir, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const env = { ...process.env, LD_LIBRARY_PATH: destDir };
  for (let round = 0; round < 8; round += 1) {
    const result = await run('ldd', [binary], { env });
    if (!result.ok && !result.stdout) {
      // No usable ldd: fall back to copying the whole bundle's wx stack,
      // which is what the .deb build is missing in practice.
      const all = await fsp.readdir(sourceDir).catch(() => []);
      for (const name of all.filter((n) => /^(libwx|libpcre2)/.test(n))) {
        await fsp.copyFile(path.join(sourceDir, name), path.join(destDir, name)).catch(() => {});
      }
      return;
    }
    const missing = result.stdout
      .split('\n')
      .filter((line) => line.includes('not found'))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    if (missing.length === 0) return;
    let copied = 0;
    for (const name of missing) {
      const from = path.join(sourceDir, name);
      const to = path.join(destDir, name);
      if (exists(from) && !exists(to)) {
        await fsp.copyFile(from, to);
        copied += 1;
      }
    }
    if (copied === 0) {
      throw new Error(
        `Espanso needs ${missing[0]}, which is not on this system and not in the ` +
        'download. Installing it through your distribution should fix this.'
      );
    }
  }
  throw new Error('Could not work out which libraries Espanso needs on this system.');
}

async function pickRelease() {
  const release = await getJson(RELEASES_API);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const byName = (name) => assets.find((asset) => asset.name === name);
  const x11 = byName(X11_ASSET);
  const wayland = byName(WAYLAND_ASSET);
  if (!x11) throw new Error('That Espanso release has no Linux build in it.');
  return {
    version: String(release.tag_name || '').replace(/^v/, ''),
    x11Url: x11.browser_download_url,
    waylandUrl: wayland ? wayland.browser_download_url : null,
  };
}

// Installs Espanso into Lightmorphic Text's own directory. Never touches anything
// outside the user's home, so it needs no password and works the same on an
// immutable system as on a normal one.
// ---------------------------------------------------------------------------
// The Wayland clipboard helpers
// ---------------------------------------------------------------------------

// On Wayland, Espanso drives the clipboard through the wl-clipboard tools
// (wl-copy and wl-paste) and panics on startup without them. Most desktops
// ship them; some minimal immutable systems — openSUSE Aeon, for one — do
// not. So Lightmorphic Text fetches the pair out of Debian's package pool and keeps
// them beside its managed Espanso, where the service's PATH finds them.
// They are two small static-ish binaries needing only libwayland-client,
// which every Wayland desktop has by definition.
const WL_POOL = 'https://deb.debian.org/debian/pool/main/w/wl-clipboard/';

function hasWlClipboard() {
  const dirs = ['/usr/bin', '/bin', '/usr/local/bin', path.dirname(MANAGED_BIN)];
  return ['wl-copy', 'wl-paste'].every(
    (name) => dirs.some((dir) => isExecutable(path.join(dir, name))));
}

async function latestWlClipboardUrl() {
  const listing = await new Promise((resolve, reject) => {
    https.get(WL_POOL, { headers: { 'User-Agent': 'Lightmorphic Text' }, timeout: 30000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
  });
  const names = [...new Set(listing.match(/wl-clipboard_[^"' ]+_amd64\.deb/g) || [])].sort();
  if (names.length === 0) throw new Error('Could not find wl-clipboard in the Debian archive.');
  return WL_POOL + names[names.length - 1];
}

async function ensureWaylandTools() {
  if (detectSession() !== 'wayland') return { ok: true };
  if (hasWlClipboard()) return { ok: true };
  const work = path.join(WORK_DIR, 'wl-clipboard');
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  const debPath = path.join(work, 'wl-clipboard.deb');
  await download(await latestWlClipboardUrl(), debPath);
  const dataArchive = await extractDebData(debPath, path.join(work, 'data'));
  const root = path.join(work, 'root');
  await fsp.mkdir(root, { recursive: true });
  const untar = await run('tar', ['-xf', dataArchive, '-C', root], { timeout: 120000 });
  const binDir = path.dirname(MANAGED_BIN);
  await fsp.mkdir(binDir, { recursive: true });
  for (const name of ['wl-copy', 'wl-paste']) {
    const from = path.join(root, 'usr', 'bin', name);
    if (!exists(from)) {
      throw new Error(`The clipboard tools could not be unpacked. ${untar.stderr}`.trim());
    }
    await fsp.copyFile(from, path.join(binDir, name));
    await fsp.chmod(path.join(binDir, name), 0o755);
  }
  await fsp.rm(work, { recursive: true, force: true });
  // The service unit must know to look in the managed bin directory.
  const found = findEspanso();
  if (found) await registerService(found.binary);
  return { ok: true };
}

async function install({ onProgress = () => {}, session = detectSession() } = {}) {
  const wantWayland = session === 'wayland';
  await fsp.rm(WORK_DIR, { recursive: true, force: true });
  await fsp.mkdir(WORK_DIR, { recursive: true });

  onProgress({ step: 'Looking up the latest Espanso release', fraction: 0.02 });
  const release = await pickRelease();
  if (wantWayland && !release.waylandUrl) {
    throw new Error(
      `Espanso ${release.version} does not publish a Wayland build. ` +
      'Lightmorphic Text cannot install it automatically on this session.'
    );
  }

  // The X11 AppImage is fetched either way: on X11 it is the program, and on
  // Wayland it is the only source of the wxWidgets libraries the .deb expects
  // the distribution to have provided.
  const appImagePath = path.join(WORK_DIR, 'espanso-x11.AppImage');
  onProgress({ step: 'Downloading Espanso', fraction: 0.05 });
  await download(release.x11Url, appImagePath, (f) => {
    onProgress({ step: 'Downloading Espanso', fraction: 0.05 + f * (wantWayland ? 0.45 : 0.75) });
  }, 0, 1);
  await fsp.chmod(appImagePath, 0o755);

  // --appimage-extract is handled by the AppImage's own embedded runtime and
  // needs no FUSE, so this works on FUSE3-only and FUSE-less systems alike.
  onProgress({ step: 'Unpacking', fraction: wantWayland ? 0.52 : 0.82 });
  const unpack = await run(appImagePath, ['--appimage-extract'], { cwd: WORK_DIR, timeout: 120000 });
  const bundleRoot = path.join(WORK_DIR, 'squashfs-root');
  if (!exists(path.join(bundleRoot, 'usr', 'bin', 'espanso'))) {
    throw new Error(`Espanso's download could not be unpacked. ${unpack.stderr}`.trim());
  }
  const bundleLib = path.join(bundleRoot, 'usr', 'lib');

  let sourceBinary = path.join(bundleRoot, 'usr', 'bin', 'espanso');
  if (wantWayland) {
    onProgress({ step: 'Downloading the Wayland build', fraction: 0.55 });
    const debPath = path.join(WORK_DIR, 'espanso-wayland.deb');
    await download(release.waylandUrl, debPath, (f) => {
      onProgress({ step: 'Downloading the Wayland build', fraction: 0.55 + f * 0.25 });
    });
    onProgress({ step: 'Unpacking the Wayland build', fraction: 0.82 });
    const dataArchive = await extractDebData(debPath, path.join(WORK_DIR, 'data'));
    const debRoot = path.join(WORK_DIR, 'deb');
    await fsp.mkdir(debRoot, { recursive: true });
    // tar is on every Linux desktop; xz is what Debian packages use.
    const untar = await run('tar', ['-xf', dataArchive, '-C', debRoot], { timeout: 120000 });
    sourceBinary = path.join(debRoot, 'usr', 'bin', 'espanso');
    if (!exists(sourceBinary)) {
      throw new Error(`The Wayland build could not be unpacked. ${untar.stderr}`.trim());
    }
  }

  onProgress({ step: 'Installing', fraction: 0.88 });
  await fsp.rm(MANAGED_ROOT, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(MANAGED_BIN), { recursive: true });
  await fsp.copyFile(sourceBinary, MANAGED_BIN);
  await fsp.chmod(MANAGED_BIN, 0o755);

  onProgress({ step: 'Checking Espanso can run here', fraction: 0.92 });
  await fillMissingLibraries(MANAGED_BIN, bundleLib, MANAGED_LIB);

  const version = await espansoVersion(MANAGED_BIN);
  if (!version) {
    throw new Error('Espanso installed, but will not start on this system.');
  }

  await writeShim();
  if (wantWayland) {
    onProgress({ step: 'Adding the clipboard tools', fraction: 0.96 });
    await ensureWaylandTools();
  }
  await fsp.writeFile(MANAGED_STAMP, JSON.stringify({
    version, session: wantWayland ? 'wayland' : 'x11', installedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  await fsp.rm(WORK_DIR, { recursive: true, force: true });

  onProgress({ step: 'Done', fraction: 1 });
  return { version, binary: MANAGED_BIN };
}

// A small wrapper on the user's PATH, so `espanso` works in a terminal too
// and behaves the same as the copy Lightmorphic Text drives.
async function writeShim() {
  await fsp.mkdir(path.dirname(SHIM), { recursive: true });
  const script = `#!/bin/sh
# Written by Lightmorphic Text. Runs the copy of Espanso that Lightmorphic Text installed,
# with the libraries it needed to borrow for this system.
LD_LIBRARY_PATH="${MANAGED_LIB}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH
exec "${MANAGED_BIN}" "$@"
`;
  // Never overwrite a real Espanso that happens to live at the same path.
  if (exists(SHIM)) {
    const current = await fsp.readFile(SHIM, 'utf8').catch(() => '');
    if (!/Written by (Textmorph|Lightmorphic Text)/.test(current)) return;
  }
  await fsp.writeFile(SHIM, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// The systemd user service
// ---------------------------------------------------------------------------

// Espanso's own `service register` writes a unit pointing at whichever binary
// invoked it, with no environment — which loses the borrowed library path for
// a managed install. Writing the unit ourselves keeps the same shape it uses
// and adds the one line it cannot know about.
// Bump this (and the unit text) together; ensureUnitCurrent rewrites any
// unit whose marker is older. v2 added the start limit: without one, an
// Espanso that dies on startup is relaunched every three seconds forever —
// on Wayland that flashes its broken helper window at the user endlessly.
// v3 put the managed bin directory on the service's PATH, so helper tools
// kept there (wl-copy, wl-paste) are found.
const UNIT_MARKER = '# lightmorphic-text-unit-v1';

async function registerService(binary) {
  await fsp.mkdir(UNIT_DIR, { recursive: true });
  const useLibs = binary === MANAGED_BIN && exists(MANAGED_LIB);
  const pathLine = binary === MANAGED_BIN
    ? `Environment=PATH=${path.dirname(MANAGED_BIN)}:/usr/local/bin:/usr/bin:/bin\n`
    : '';
  const unit = `${UNIT_MARKER}
[Unit]
Description=espanso
StartLimitIntervalSec=120
StartLimitBurst=4

[Service]
${useLibs ? `Environment=LD_LIBRARY_PATH=${MANAGED_LIB}\n` : ''}${pathLine}ExecStart=${binary} launcher
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
  await fsp.writeFile(UNIT_FILE, unit, 'utf8');
  await run('systemctl', ['--user', 'daemon-reload']);
  const enabled = await run('systemctl', ['--user', 'enable', 'espanso.service']);
  return enabled.ok;
}

// Upgrades a unit written by an older Lightmorphic Text. Returns true if it did.
async function ensureUnitCurrent(binary) {
  if (!exists(UNIT_FILE)) return false;
  const current = await fsp.readFile(UNIT_FILE, 'utf8').catch(() => '');
  if (current.includes(UNIT_MARKER)) return false;
  // Only touch units Lightmorphic Text wrote; leave a hand-made one alone.
  if (!current.includes('ExecStart') || !current.includes('espanso')) return false;
  await registerService(binary);
  return true;
}

async function startService(binary) {
  if (!exists(UNIT_FILE)) await registerService(binary);
  const result = await run('systemctl', ['--user', 'start', 'espanso.service']);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.stderr || 'Espanso would not start.' };
}

async function stopService() {
  const result = await run('systemctl', ['--user', 'stop', 'espanso.service']);
  return { ok: result.ok, error: result.ok ? null : result.stderr };
}

// Espanso caches match files in memory, so an edit does nothing until it is
// told to reload. This runs after every save.
async function restartService(binary) {
  if (!exists(UNIT_FILE)) {
    const started = await startService(binary);
    return started;
  }
  const result = await run('systemctl', ['--user', 'restart', 'espanso.service']);
  if (result.ok) return { ok: true };
  // Fall back to Espanso's own restart for a service someone registered by
  // hand outside systemd's user session.
  const direct = await run(binary, ['restart'], { env: envFor(binary) });
  return direct.ok ? { ok: true } : { ok: false, error: direct.stderr || result.stderr };
}

// ---------------------------------------------------------------------------
// The Wayland permission step
// ---------------------------------------------------------------------------

// On Wayland there is no way to read the keyboard through the display server,
// so Espanso reads the input devices directly — which needs group membership
// that only takes effect at the next login. pkexec puts the password prompt in
// the desktop's own dialog rather than a terminal.
// The desktop prompt can come from pkexec (polkit's classic tool) or run0
// (systemd 256+, same polkit agent underneath). Minimal immutable systems —
// openSUSE Aeon, for one — ship run0 but not pkexec, so both are tried.
function findPromptTool() {
  for (const name of ['pkexec', 'run0']) {
    for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
      const p = path.join(dir, name);
      if (isExecutable(p)) return { name, path: p };
    }
  }
  return null;
}

// Adds $1 to the input group with whichever tool the system has. Exit 3 is
// "there is no input group here", kept distinct from a plain failure.
const ADD_TO_GROUP =
  'getent group input >/dev/null || exit 3; '
  + 'usermod -aG input "$1" 2>/dev/null || gpasswd -a "$1" input';

async function addToInputGroup() {
  const user = os.userInfo().username;
  if (!user || !/^[a-z_][a-z0-9_-]*\$?$/i.test(user)) {
    return { ok: false, error: 'Could not work out your username.' };
  }
  const manual = {
    // Immutable distros still allow this: it edits /etc, which stays
    // writable everywhere — only /usr is sealed.
    error: 'This system has no graphical password prompt, so this one step '
      + 'needs a terminal. It works on immutable systems too — it only '
      + 'changes /etc, which stays writable.',
    command: `sudo usermod -aG input ${user}`,
  };
  const tool = findPromptTool();
  if (!tool) return { ok: false, ...manual };

  const result = await run(tool.path, ['/bin/sh', '-c', ADD_TO_GROUP, 'sh', user], { timeout: 120000 });
  if (result.ok) return { ok: true };
  if (result.code === 3) {
    return { ok: false, error: 'This system has no "input" group, so Espanso cannot read the keyboard on Wayland here.' };
  }
  // pkexec says "dismissed" with 126; run0 only says so in its stderr.
  const cancelled = result.code === 126
    || /authoriz|authenticat|dismiss|cancel/i.test(result.stderr || '');
  if (cancelled) return { ok: false, cancelled: true, error: 'Permission was not given.' };
  return { ok: false, error: result.stderr || 'Adding you to the input group did not work.', command: manual.command };
}

module.exports = {
  MANAGED_BIN,
  MANAGED_LIB,
  UNIT_FILE,
  detectSession,
  describeEnvironment,
  configDir,
  ensureConfigSkeleton,
  espansoVersion,
  serviceState,
  install,
  registerService,
  ensureUnitCurrent,
  ensureWaylandTools,
  serviceDiagnostics,
  calmService,
  startService,
  stopService,
  serviceEnabled,
  setServiceOn,
  restartService,
  addToInputGroup,
  inInputGroup,
  // exported for the tests
  _internals: { extractDebData, fillMissingLibraries, readOsRelease, isImmutable, classifyServiceLog, parseGnomeSources, parseLocalectl, splitXkbSource },
};
