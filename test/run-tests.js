'use strict';

// Plain Node tests, no framework. Run with: npm test
//
// Everything here works on a throwaway config directory pointed at by
// XDG_CONFIG_HOME, so running the tests can never touch a real Espanso setup.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'lightmorphic-text-test-'));
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, 'config');
process.env.XDG_DATA_HOME = path.join(SANDBOX, 'data');

const matches = require('../src/main/matches');
const espanso = require('../src/main/espanso');

const MATCH_DIR = path.join(process.env.XDG_CONFIG_HOME, 'espanso', 'match');

let passed = 0;
let failed = 0;
const only = process.argv[2];

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

function writeMatchFile(relPath, text) {
  const full = path.join(MATCH_DIR, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return full;
}

function readMatchFile(relPath) {
  return fs.readFileSync(path.join(MATCH_DIR, relPath), 'utf8');
}

function reset() {
  fs.rmSync(MATCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(MATCH_DIR, { recursive: true });
}

const SAMPLE = `# Snippets I actually use.
# Grouped by how often.

matches:
  # The signature block
  - trigger: ":sig"
    replace: "Charlie"

  - triggers: [":em", ":mail"]
    replace: "me@example.com"
    word: true

  # Uses a variable, so Textmorph must not rewrite it
  - trigger: ":today"
    replace: "It is {{d}}"
    vars:
      - name: d
        type: date
        params:
          format: "%d/%m/%Y"
`;

(async () => {
  console.log('\nReading match files\n');

  await test('reads simple and advanced entries out of one file', async () => {
    reset();
    writeMatchFile('base.yml', SAMPLE);
    const { entries } = await matches.readAll();
    assert.strictEqual(entries.length, 3, 'expected three entries');
    assert.deepStrictEqual(entries[0].triggers, [':sig']);
    assert.strictEqual(entries[0].replace, 'Charlie');
    assert.strictEqual(entries[0].advanced, false);
    assert.deepStrictEqual(entries[1].triggers, [':em', ':mail']);
    assert.strictEqual(entries[1].word, true);
    assert.strictEqual(entries[2].advanced, true, 'the vars entry must be flagged advanced');
    assert.match(entries[2].advancedReason, /vars/);
  });

  await test('a snippet from an installed package is read-only', async () => {
    reset();
    writeMatchFile('packages/hub-thing/package.yml', 'matches:\n  - trigger: ":x"\n    replace: "y"\n');
    const { entries } = await matches.readAll();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].readOnly, true);
    const result = await matches.updateEntry(entries[0].id, {
      triggers: [':x'], replace: 'z', word: false, propagateCase: false,
    });
    assert.match(result.error, /read-only/);
  });

  await test('a file that is not valid YAML is reported, not thrown', async () => {
    reset();
    writeMatchFile('broken.yml', 'matches:\n  - trigger: ":a\n   replace: [[[\n');
    const { files } = await matches.readAll();
    assert.ok(files[0].error, 'expected the broken file to carry an error');
  });

  await test('a file with no matches key is simply empty', async () => {
    reset();
    writeMatchFile('vars.yml', 'global_vars:\n  - name: x\n    type: echo\n');
    const { entries, files } = await matches.readAll();
    assert.strictEqual(entries.length, 0);
    assert.strictEqual(files[0].error, null);
  });

  console.log('\nWriting match files\n');

  await test('editing one snippet leaves comments and other entries alone', async () => {
    reset();
    writeMatchFile('base.yml', SAMPLE);
    const result = await matches.updateEntry('base.yml#0', {
      triggers: [':sig'], replace: 'Charlie Lark', word: false, propagateCase: false,
    });
    assert.ok(result.ok, result.error);
    const text = readMatchFile('base.yml');
    assert.match(text, /# Snippets I actually use\./);
    assert.match(text, /# The signature block/);
    assert.match(text, /# Uses a variable/);
    assert.match(text, /replace: "Charlie Lark"/);
    assert.match(text, /format: "%d\/%m\/%Y"/, 'the advanced entry must survive untouched');
  });

  await test('a multi-line replacement is written as a block scalar', async () => {
    reset();
    writeMatchFile('base.yml', SAMPLE);
    await matches.updateEntry('base.yml#0', {
      triggers: [':sig'], replace: 'Charlie Lark\nLightmorphic', word: false, propagateCase: false,
    });
    const text = readMatchFile('base.yml');
    assert.match(text, /replace: \|-\n\s+Charlie Lark\n\s+Lightmorphic/);
  });

  await test('a new trigger is always quoted, so a leading colon stays a string', async () => {
    reset();
    writeMatchFile('base.yml', 'matches: []\n');
    await matches.createEntry('base.yml', {
      triggers: [':tel'], replace: '01234 567890', word: false, propagateCase: false,
    });
    const text = readMatchFile('base.yml');
    assert.match(text, /trigger: ":tel"/);
    assert.match(text, /replace: "01234 567890"/);
  });

  await test('several triggers are written as a triggers list, one as trigger', async () => {
    reset();
    writeMatchFile('base.yml', 'matches: []\n');
    await matches.createEntry('base.yml', {
      triggers: [':a', ':b'], replace: 'x', word: false, propagateCase: false,
    });
    let text = readMatchFile('base.yml');
    assert.match(text, /triggers:/);
    assert.ok(!/^\s+trigger:/m.test(text), 'must not carry both keys');

    const { entries } = await matches.readAll();
    await matches.updateEntry(entries[0].id, {
      triggers: [':a'], replace: 'x', word: false, propagateCase: false,
    });
    text = readMatchFile('base.yml');
    assert.match(text, /trigger: ":a"/);
    assert.ok(!/triggers:/.test(text), 'the plural key must be removed when one trigger is left');
  });

  await test('the options are added and removed rather than left as false', async () => {
    reset();
    writeMatchFile('base.yml', 'matches: []\n');
    await matches.createEntry('base.yml', {
      triggers: [':a'], replace: 'x', word: true, propagateCase: true,
    });
    let text = readMatchFile('base.yml');
    assert.match(text, /word: true/);
    assert.match(text, /propagate_case: true/);

    await matches.updateEntry('base.yml#0', {
      triggers: [':a'], replace: 'x', word: false, propagateCase: false,
    });
    text = readMatchFile('base.yml');
    assert.ok(!/word:/.test(text), 'word should be dropped, not written as false');
    assert.ok(!/propagate_case:/.test(text));
  });

  await test('deleting removes only the chosen entry', async () => {
    reset();
    writeMatchFile('base.yml', SAMPLE);
    const result = await matches.deleteEntry('base.yml#1');
    assert.ok(result.ok, result.error);
    const { entries } = await matches.readAll();
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries.map((e) => e.triggers[0]), [':sig', ':today']);
    assert.match(readMatchFile('base.yml'), /# The signature block/);
  });

  await test('an advanced snippet is never overwritten', async () => {
    reset();
    writeMatchFile('base.yml', SAMPLE);
    const result = await matches.updateEntry('base.yml#2', {
      triggers: [':today'], replace: 'plain text now', word: false, propagateCase: false,
    });
    assert.match(result.error, /cannot show/);
    assert.match(readMatchFile('base.yml'), /type: date/);
  });

  await test('every write leaves a backup behind', async () => {
    reset();
    writeMatchFile('base.yml', SAMPLE);
    await matches.updateEntry('base.yml#0', {
      triggers: [':sig'], replace: 'changed', word: false, propagateCase: false,
    });
    const backups = fs.readdirSync(path.join(process.env.XDG_DATA_HOME, 'lightmorphic-text', 'backups'));
    assert.ok(backups.length >= 1, 'expected at least one backup');
    const restored = fs.readFileSync(
      path.join(process.env.XDG_DATA_HOME, 'lightmorphic-text', 'backups', backups[0]), 'utf8');
    assert.match(restored, /replace: "Charlie"/, 'the backup must hold the pre-edit text');
  });

  console.log('\nRefusing bad input\n');

  const { validate, resolveInMatchDir, parseId } = matches._internals;

  await test('a snippet needs a trigger and something to expand into', async () => {
    assert.match(validate({ triggers: [], replace: 'x' }).error, /at least one trigger/);
    assert.match(validate({ triggers: ['  '], replace: 'x' }).error, /at least one trigger/);
    assert.match(validate({ triggers: [':a'], replace: '' }).error, /expand into/);
  });

  await test('a trigger with a space in it is rejected', async () => {
    assert.match(validate({ triggers: ['my thing'], replace: 'x' }).error, /cannot contain spaces/);
  });

  await test('triggers are trimmed and blanks dropped', async () => {
    const { fields } = validate({ triggers: [' :a ', '', ':b'], replace: 'x' });
    assert.deepStrictEqual(fields.triggers, [':a', ':b']);
  });

  await test('a path cannot escape the match directory', async () => {
    assert.strictEqual(resolveInMatchDir('../../evil.yml'), null);
    assert.strictEqual(resolveInMatchDir('/etc/passwd'), null);
    assert.strictEqual(resolveInMatchDir('notes.txt'), null);
    assert.strictEqual(resolveInMatchDir(''), null);
    assert.ok(resolveInMatchDir('sub/ok.yml'));
  });

  await test('a malformed entry id is refused', async () => {
    assert.strictEqual(parseId('base.yml'), null);
    assert.strictEqual(parseId('base.yml#-1'), null);
    assert.strictEqual(parseId('base.yml#x'), null);
    assert.deepStrictEqual(parseId('a/b.yml#3'), { relPath: 'a/b.yml', index: 3 });
  });

  await test('new match files get a sensible name or a clear refusal', async () => {
    reset();
    const bad = await matches.createFile('../escape');
    assert.ok(bad.error);
    const good = await matches.createFile('Work Email');
    assert.strictEqual(good.relPath, 'work-email.yml');
    assert.match(readMatchFile('work-email.yml'), /matches: \[\]/);
    const again = await matches.createFile('Work Email');
    assert.match(again.error, /already/);
  });

  console.log('\nWorking out the environment\n');

  await test('the display server is read from the session, then the sockets', async () => {
    const saved = { ...process.env };
    process.env.XDG_SESSION_TYPE = 'wayland';
    assert.strictEqual(espanso.detectSession(), 'wayland');
    process.env.XDG_SESSION_TYPE = 'x11';
    assert.strictEqual(espanso.detectSession(), 'x11');
    delete process.env.XDG_SESSION_TYPE;
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    assert.strictEqual(espanso.detectSession(), 'wayland');
    delete process.env.WAYLAND_DISPLAY;
    process.env.DISPLAY = ':0';
    assert.strictEqual(espanso.detectSession(), 'x11');
    delete process.env.DISPLAY;
    assert.strictEqual(espanso.detectSession(), 'unknown');
    Object.assign(process.env, saved);
  });

  await test('the data archive is pulled out of a Debian package', async () => {
    // A minimal ar archive with a decoy member ahead of the real one.
    const header = (name, size) =>
      Buffer.from(
        name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6)
        + '100644'.padEnd(8) + String(size).padEnd(10) + '`\n', 'ascii');
    const debianBinary = Buffer.from('2.0\n');
    const control = Buffer.from('control payload');
    const data = Buffer.from('data payload!!');
    const deb = Buffer.concat([
      Buffer.from('!<arch>\n'),
      header('debian-binary', debianBinary.length), debianBinary,
      header('control.tar.xz', control.length), control, Buffer.from([0x0a]),
      header('data.tar.xz', data.length), data,
    ]);
    const debPath = path.join(SANDBOX, 'sample.deb');
    fs.writeFileSync(debPath, deb);
    const out = await espanso._internals.extractDebData(debPath, path.join(SANDBOX, 'out'));
    assert.strictEqual(path.basename(out), 'out.xz');
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'data payload!!');
  });

  await test('something that is not a Debian package is rejected', async () => {
    const notADeb = path.join(SANDBOX, 'nope.deb');
    fs.writeFileSync(notADeb, 'this is not an archive');
    await assert.rejects(
      () => espanso._internals.extractDebData(notADeb, path.join(SANDBOX, 'out2')),
      /does not look like a Debian package/);
  });

  await test('a crash log about EVDEV points at the input group', async () => {
    const { classifyServiceLog } = espanso._internals;
    assert.strictEqual(
      classifyServiceLog('[ERROR] Unable to open EVDEV devices, this usually has to do with permissions.'),
      'input');
    assert.strictEqual(
      classifyServiceLog("You can either add the current user to the 'input' group or run espanso as root"),
      'input');
    assert.strictEqual(
      classifyServiceLog('unable to determine keyboard layout automatically, please explicitly specify it in the configuration.'),
      'layout');
    // A real crash log carries layout warnings above the fatal clipboard
    // panic; the panic must win.
    assert.strictEqual(
      classifyServiceLog('please explicitly specify the keyboard layout\n'
        + "panicked at 'failed to initialize clipboard module: wl-clipboard binaries are missing'"),
      'clipboard');
    assert.strictEqual(
      classifyServiceLog("unable to call 'wl-paste' binary, please install the wl-clipboard package."),
      'clipboard');
    assert.strictEqual(classifyServiceLog('something else entirely'), null);
    assert.strictEqual(classifyServiceLog(''), null);
  });

  await test('the desktop keyboard layout is read correctly', async () => {
    const { parseGnomeSources, parseLocalectl, splitXkbSource } = espanso._internals;
    assert.strictEqual(parseGnomeSources("[('xkb', 'gb')]"), 'gb');
    assert.strictEqual(parseGnomeSources("[('xkb', 'gb+extd'), ('xkb', 'us')]"), 'gb+extd');
    assert.strictEqual(parseGnomeSources('nothing useful'), null);
    assert.strictEqual(parseLocalectl('   X11 Layout: gb,us\n   X11 Model: pc105'), 'gb');
    assert.strictEqual(parseLocalectl(''), null);
    assert.deepStrictEqual(splitXkbSource('gb'), { layout: 'gb', variant: null });
    assert.deepStrictEqual(splitXkbSource('gb+extd'), { layout: 'gb', variant: 'extd' });
  });

  await test('a fresh Wayland config records the keyboard layout block shape', async () => {
    // The block appended to default.yml must be valid YAML espanso accepts.
    const YAML = require('yaml');
    const doc = YAML.parse('keyboard_layout:\n  layout: "gb"\n  variant: "extd"\n');
    assert.strictEqual(doc.keyboard_layout.layout, 'gb');
    assert.strictEqual(doc.keyboard_layout.variant, 'extd');
  });

  await test('the config directory follows XDG', async () => {
    assert.strictEqual(
      espanso.configDir(),
      path.join(process.env.XDG_CONFIG_HOME, 'espanso'));
  });

  await test('a fresh config directory gets a config and a match file', async () => {
    fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 'espanso'), { recursive: true, force: true });
    const root = await espanso.ensureConfigSkeleton();
    assert.ok(fs.existsSync(path.join(root, 'config', 'default.yml')));
    assert.ok(fs.existsSync(path.join(root, 'match', 'base.yml')));
    const { entries } = await matches.readAll();
    assert.ok(entries.length >= 1, 'the starter file should hold one example snippet');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})();
