'use strict';

// Reading and writing Espanso's match files.
//
// The whole point of this module is that a file you have hand-written stays
// recognisably yours after Lightmorphic Text has saved it. Every edit goes through
// the YAML document tree rather than re-serialising a plain object, so
// comments, key order, blank lines and quoting style all survive; only the
// values actually changed get rewritten.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const { configDir } = require('./espanso');

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const BACKUP_DIR = path.join(DATA_HOME, 'lightmorphic-text', 'backups');
const BACKUPS_KEPT = 20;

// Keys Lightmorphic Text's form can represent. A match using anything else is shown
// but not edited, because rewriting a snippet we don't fully understand is a
// good way to quietly break someone's setup.
const SIMPLE_KEYS = new Set([
  'trigger', 'triggers', 'replace', 'word', 'left_word', 'right_word',
  'propagate_case', 'uppercase_style', 'label',
]);

function matchDir() {
  return path.join(configDir(), 'match');
}

// Anything under match/packages is installed from the Espanso hub and gets
// replaced wholesale on update, so editing it there would only lose work.
function isReadOnly(relPath) {
  return relPath.split(path.sep)[0] === 'packages';
}

async function listMatchFiles() {
  const root = matchDir();
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.ya?ml$/i.test(entry.name)) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found;
}

function scalarValue(node) {
  if (node === null || node === undefined) return null;
  if (YAML.isScalar(node)) return node.value;
  return null;
}

function readTriggers(item) {
  const single = scalarValue(item.get('trigger', true));
  if (typeof single === 'string') return [single];
  const many = item.get('triggers', true);
  if (YAML.isSeq(many)) {
    return many.items.map(scalarValue).filter((v) => typeof v === 'string');
  }
  return [];
}

function describeItem(item) {
  if (!YAML.isMap(item)) {
    return { advanced: true, reason: 'This entry is not in a shape Lightmorphic Text recognises.' };
  }
  const keys = item.items.map((pair) => scalarValue(pair.key)).filter(Boolean);
  const unknown = keys.filter((key) => !SIMPLE_KEYS.has(key));
  if (unknown.length) {
    return {
      advanced: true,
      reason: `This snippet uses ${unknown.join(', ')}, which Lightmorphic Text shows but does not edit.`,
    };
  }
  const replace = scalarValue(item.get('replace', true));
  if (typeof replace !== 'string') {
    return { advanced: true, reason: 'This snippet has no plain text replacement.' };
  }
  return { advanced: false, reason: null };
}

async function readFile(filePath) {
  const relPath = path.relative(matchDir(), filePath);
  const text = await fsp.readFile(filePath, 'utf8');
  const doc = YAML.parseDocument(text, { keepSourceTokens: true });
  const file = {
    path: filePath,
    relPath,
    name: relPath,
    readOnly: isReadOnly(relPath),
    error: null,
    entries: [],
  };
  if (doc.errors.length) {
    file.error = doc.errors[0].message;
    return { file, doc };
  }
  const matches = doc.get('matches', true);
  if (!YAML.isSeq(matches)) {
    // A file of global_vars or imports with no matches of its own is fine,
    // just empty as far as this list is concerned.
    return { file, doc };
  }
  matches.items.forEach((item, index) => {
    const { advanced, reason } = describeItem(item);
    const triggers = advanced && !YAML.isMap(item) ? [] : readTriggers(item);
    file.entries.push({
      id: `${relPath}#${index}`,
      file: relPath,
      index,
      readOnly: file.readOnly,
      advanced,
      advancedReason: reason,
      triggers,
      label: YAML.isMap(item) ? (scalarValue(item.get('label', true)) || null) : null,
      replace: advanced ? null : scalarValue(item.get('replace', true)),
      word: YAML.isMap(item) ? scalarValue(item.get('word', true)) === true : false,
      propagateCase: YAML.isMap(item) ? scalarValue(item.get('propagate_case', true)) === true : false,
      raw: YAML.isDocument(doc) ? String(new YAML.Document(item)).trimEnd() : '',
    });
  });
  return { file, doc };
}

async function readAll() {
  const root = configDir();
  const files = [];
  const entries = [];
  for (const filePath of await listMatchFiles()) {
    try {
      const { file } = await readFile(filePath);
      files.push({
        path: file.path,
        relPath: file.relPath,
        name: file.name,
        readOnly: file.readOnly,
        error: file.error,
        count: file.entries.length,
      });
      entries.push(...file.entries);
    } catch (err) {
      files.push({
        path: filePath,
        relPath: path.relative(matchDir(), filePath),
        name: path.relative(matchDir(), filePath),
        readOnly: true,
        error: err.message,
        count: 0,
      });
    }
  }
  return { configDir: root, matchDir: matchDir(), files, entries };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Every write keeps a timestamped copy of what the file looked like first.
// Backups live outside the match directory so Espanso never tries to load one.
async function backup(filePath) {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = path.relative(matchDir(), filePath).replace(/[\\/]/g, '_');
  await fsp.copyFile(filePath, path.join(BACKUP_DIR, `${stamp}__${safeName}`)).catch(() => {});
  const kept = (await fsp.readdir(BACKUP_DIR).catch(() => [])).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) {
    await fsp.rm(path.join(BACKUP_DIR, old), { force: true }).catch(() => {});
  }
}

// Written to a neighbouring temporary file and renamed into place, so a
// crash mid-write can never leave a half-written match file that Espanso
// would refuse to load.
async function writeAtomic(filePath, text) {
  const tmp = `${filePath}.lightmorphic-text-tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, filePath);
}

function serialise(doc) {
  // lineWidth 0 turns off re-wrapping, so a long line you wrote stays one
  // long line instead of being folded somewhere new.
  return doc.toString({ lineWidth: 0 });
}

// New strings are written quoted, and multi-line ones as block scalars —
// which is how a person would write them, and it keeps a trigger like :sig
// from ever being handed to Espanso's parser as a bare colon-led scalar.
// Nodes read from an existing file keep whatever style they already had.
function stringNode(doc, value) {
  const node = doc.createNode(value);
  node.type = value.includes('\n') ? YAML.Scalar.BLOCK_LITERAL : YAML.Scalar.QUOTE_DOUBLE;
  return node;
}

function applyFields(doc, item, fields) {
  const { triggers, replace, word, propagateCase } = fields;

  if (triggers.length === 1) {
    item.delete('triggers');
    item.set('trigger', stringNode(doc, triggers[0]));
  } else {
    item.delete('trigger');
    item.set('triggers', doc.createNode(triggers.map((t) => stringNode(doc, t))));
  }

  item.set('replace', stringNode(doc, replace));

  if (word) item.set('word', true); else item.delete('word');
  if (propagateCase) item.set('propagate_case', true); else item.delete('propagate_case');
}

function validate(fields) {
  const triggers = (fields.triggers || [])
    .map((t) => (typeof t === 'string' ? t : ''))
    .map((t) => t.trim())
    .filter(Boolean);
  if (triggers.length === 0) {
    return { error: 'Give the snippet at least one trigger — the short text you will type.' };
  }
  if (triggers.some((t) => /\s/.test(t))) {
    return { error: 'A trigger cannot contain spaces. Try something like :addr instead.' };
  }
  if (triggers.some((t) => t.length > 100)) {
    return { error: 'That trigger is far too long to be worth typing.' };
  }
  if (typeof fields.replace !== 'string' || fields.replace.length === 0) {
    return { error: 'Give the snippet something to expand into.' };
  }
  if (fields.replace.length > 200000) {
    return { error: 'That replacement is too large for a text expansion.' };
  }
  return {
    fields: {
      triggers,
      replace: fields.replace,
      word: fields.word === true,
      propagateCase: fields.propagateCase === true,
    },
  };
}

// Keeps a caller from being talked into writing outside the match directory
// by a crafted relative path.
function resolveInMatchDir(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  const root = matchDir();
  const full = path.resolve(root, relPath);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (!/\.ya?ml$/i.test(full)) return null;
  return full;
}

function parseId(id) {
  if (typeof id !== 'string') return null;
  const hash = id.lastIndexOf('#');
  if (hash < 1) return null;
  const index = Number(id.slice(hash + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { relPath: id.slice(0, hash), index };
}

async function loadForWrite(relPath) {
  const full = resolveInMatchDir(relPath);
  if (!full) throw new Error('That is not a file Lightmorphic Text can write to.');
  if (isReadOnly(relPath)) {
    throw new Error('This snippet came from an installed Espanso package, so it is read-only here.');
  }
  const text = await fsp.readFile(full, 'utf8');
  const doc = YAML.parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) {
    throw new Error(`Lightmorphic Text could not read ${relPath}: ${doc.errors[0].message}`);
  }
  return { full, doc };
}

function matchesSeq(doc) {
  let seq = doc.get('matches', true);
  if (!YAML.isSeq(seq)) {
    seq = doc.createNode([]);
    doc.set('matches', seq);
  }
  return seq;
}

async function createEntry(relPath, rawFields) {
  const checked = validate(rawFields);
  if (checked.error) return { error: checked.error };
  const { full, doc } = await loadForWrite(relPath);
  const seq = matchesSeq(doc);
  const item = doc.createNode({});
  applyFields(doc, item, checked.fields);
  // Sit the new snippet off from the one above it, matching how these files
  // are normally laid out by hand.
  if (seq.items.length > 0) item.spaceBefore = true;
  seq.add(item);
  await backup(full);
  await writeAtomic(full, serialise(doc));
  return { ok: true, id: `${relPath}#${seq.items.length - 1}` };
}

async function updateEntry(id, rawFields) {
  const parsed = parseId(id);
  if (!parsed) return { error: 'That snippet could not be found any more. Try refreshing.' };
  const checked = validate(rawFields);
  if (checked.error) return { error: checked.error };
  const { full, doc } = await loadForWrite(parsed.relPath);
  const seq = matchesSeq(doc);
  const item = seq.items[parsed.index];
  if (!YAML.isMap(item)) {
    return { error: 'That snippet has changed on disk since it was listed. Refresh and try again.' };
  }
  if (describeItem(item).advanced) {
    return { error: 'Lightmorphic Text will not overwrite a snippet that uses features it cannot show.' };
  }
  applyFields(doc, item, checked.fields);
  await backup(full);
  await writeAtomic(full, serialise(doc));
  return { ok: true, id };
}

async function deleteEntry(id) {
  const parsed = parseId(id);
  if (!parsed) return { error: 'That snippet could not be found any more. Try refreshing.' };
  const { full, doc } = await loadForWrite(parsed.relPath);
  const seq = matchesSeq(doc);
  if (!seq.items[parsed.index]) {
    return { error: 'That snippet has already gone. Refresh to see the current list.' };
  }
  seq.delete(parsed.index);
  await backup(full);
  await writeAtomic(full, serialise(doc));
  return { ok: true };
}

// A new file starts with a comment saying where it came from, so somebody
// reading the directory later knows why it exists.
async function createFile(name) {
  const cleaned = String(name || '').trim().replace(/\.ya?ml$/i, '');
  if (!/^[A-Za-z0-9 _-]{1,60}$/.test(cleaned)) {
    return { error: 'Use letters, numbers, spaces, dashes or underscores for the file name.' };
  }
  const relPath = `${cleaned.replace(/\s+/g, '-').toLowerCase()}.yml`;
  const full = resolveInMatchDir(relPath);
  if (!full) return { error: 'That name cannot be used for a match file.' };
  if (fs.existsSync(full)) return { error: 'There is already a match file with that name.' };
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await writeAtomic(full, `# ${cleaned}\n# Created by Lightmorphic Text.\n\nmatches: []\n`);
  return { ok: true, relPath };
}

// Callers get { ok } or { error: <something a person can act on> }, never a
// thrown exception — the renderer has nowhere useful to put one.
function reported(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { error: err && err.message ? err.message : 'That change could not be saved.' };
    }
  };
}

module.exports = {
  matchDir,
  readAll,
  createEntry: reported(createEntry),
  updateEntry: reported(updateEntry),
  deleteEntry: reported(deleteEntry),
  createFile: reported(createFile),
  // exported for the tests
  _internals: { validate, describeItem, resolveInMatchDir, parseId, applyFields, serialise },
};
