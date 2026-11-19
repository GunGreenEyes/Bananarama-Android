'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsLib = require('../src/lib/settings');
const { resolvePictures, hasSharedStorage, candidates } = require('../src/lib/pictures');
const { outPath, outputDir, resolveModel, isPng, loadImages, extensionFor } = require('../src/lib/client');
const { parseArgs } = require('../src/cli');
const { sseEvents } = require('../src/server');
const { PNG_B64 } = require('./helpers');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'banana-unit-')); }

test('settings: creates file with defaults when missing', () => {
  const dir = tmp(); const f = path.join(dir, 'settings.json');
  process.env.BANANARAMA_SETTINGS = f;
  try {
    const s = settingsLib.load();
    assert.ok(fs.existsSync(f));
    assert.equal(s.outputSubfolder, 'Nano');
    assert.equal(s.port, 7861);
  } finally { delete process.env.BANANARAMA_SETTINGS; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings: user values override defaults, missing keys filled, BOM tolerated', () => {
  const dir = tmp(); const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, '\uFEFF' + JSON.stringify({ model: 'gemini-3-pro-image', port: 9999 }));
  process.env.BANANARAMA_SETTINGS = f;
  try {
    const s = settingsLib.load();
    assert.equal(s.model, 'gemini-3-pro-image');
    assert.equal(s.port, 9999);
    assert.equal(s.imageSize, '1K');
  } finally { delete process.env.BANANARAMA_SETTINGS; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings: falls back to GEMINI_API_KEY env', () => {
  const dir = tmp(); const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ apiKey: '' }));
  process.env.BANANARAMA_SETTINGS = f; const old = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'from-env';
  try { assert.equal(settingsLib.load().apiKey, 'from-env'); }
  finally {
    delete process.env.BANANARAMA_SETTINGS;
    if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: invalid JSON gives a clear error', () => {
  const dir = tmp(); const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, '{ nope');
  process.env.BANANARAMA_SETTINGS = f;
  try { assert.throws(() => settingsLib.load(), /not valid JSON/); }
  finally { delete process.env.BANANARAMA_SETTINGS; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pictures: Termux storage link first, then shared storage, then ~/Pictures', () => {
  const home = '/data/data/com.termux/files/home';
  const has = set => p => set.includes(p);
  assert.equal(resolvePictures(home, has([`${home}/storage/pictures`, '/sdcard/Pictures'].map(p => path.normalize(p)))), path.join(home, 'storage', 'pictures'));
  assert.equal(resolvePictures(home, has(['/storage/emulated/0/Pictures'])), '/storage/emulated/0/Pictures');
  assert.equal(resolvePictures(home, () => false), path.join(home, 'Pictures'), 'falls back when nothing exists');
  assert.equal(hasSharedStorage(home, () => false), false);
  assert.equal(hasSharedStorage(home, has(['/sdcard/Pictures'])), true);
  assert.equal(candidates(home).length, 4);
});

test('extensionFor: keeps the format the model sent', () => {
  assert.equal(extensionFor(Buffer.from(PNG_B64, 'base64'), 'image/jpeg'), '.png', 'PNG signature wins');
  assert.equal(extensionFor(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/png'), '.jpg', 'JPEG signature wins');
  assert.equal(extensionFor(Buffer.from('RIFFxxxxWEBP'), 'image/webp'), '.webp');
  assert.equal(extensionFor(Buffer.from('????'), 'application/x-unknown'), '.png');
});

test('outputDir: Pictures + Nano subfolder, explicit override wins', () => {
  assert.equal(outputDir({ outputDir: 'X:\\dl', outputSubfolder: 'Nano' }), path.join('X:\\dl', 'Nano'));
  assert.equal(outputDir({ outputDir: 'X:\\dl', outputSubfolder: '' }), 'X:\\dl');
  assert.equal(outputDir({ outputDir: 'X:\\dl', outputSubfolder: 'Nano' }, 'Y:\\o'), 'Y:\\o');
  assert.ok(outputDir({ outputDir: '', outputSubfolder: 'Nano' }).endsWith(`${path.sep}Nano`));
});

test('outPath: timestamp + slug, collisions get a suffix', () => {
  const dir = tmp();
  try {
    const now = new Date(2026, 10, 18, 9, 5, 7);
    const a = outPath(dir, 'image', 'A Cat, in SPACE!!', now);
    assert.equal(path.basename(a), 'image_20261118-090507_a-cat-in-space.png');
    fs.writeFileSync(a, 'x');
    assert.equal(path.basename(outPath(dir, 'image', 'A Cat, in SPACE!!', now)), 'image_20261118-090507_a-cat-in-space_2.png');
    assert.match(path.basename(outPath(dir, 'p', '!!!', now)), /_image\.png$/);
    assert.ok(path.basename(outPath(dir, 'p', 'x'.repeat(200), now)).length < 80);
    assert.equal(path.basename(outPath(dir, 'image', 'jpeg one', now, '.jpg')), 'image_20261118-090507_jpeg-one.jpg');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveModel: aliases map to ids, ids pass through', () => {
  assert.equal(resolveModel('pro'), 'gemini-3-pro-image');
  assert.equal(resolveModel('LITE'), 'gemini-3.1-flash-lite-image');
  assert.equal(resolveModel('gemini-2.5-flash-image'), 'gemini-2.5-flash-image');
  assert.equal(resolveModel(undefined), undefined);
});

test('isPng / loadImages', () => {
  assert.ok(isPng(Buffer.from(PNG_B64, 'base64')));
  assert.ok(!isPng(Buffer.from([0xff, 0xd8, 0xff])));
  const dir = tmp();
  try {
    const f = path.join(dir, 'r.png'); fs.writeFileSync(f, Buffer.from(PNG_B64, 'base64'));
    assert.deepEqual(loadImages([f]), [{ mimeType: 'image/png', data: PNG_B64 }]);
    assert.throws(() => loadImages([path.join(dir, 'x.bmp')]), /unsupported/);
    assert.throws(() => loadImages([path.join(dir, 'missing.png')]), /not found/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI parseArgs: flags and multi-word prompt', () => {
  const a = parseArgs(['--ar', '16:9', '--size', '4k', '-m', 'pro', '-i', 'a.png', 'a', 'red', 'fox']);
  assert.equal(a.aspectRatio, '16:9'); assert.equal(a.imageSize, '4K'); assert.equal(a.model, 'pro');
  assert.deepEqual(a.images, ['a.png']); assert.equal(a.prompt, 'a red fox');
  assert.throws(() => parseArgs(['--ar']), /needs a value/);
});

test('sseEvents: parses LF and CRLF events split across chunks', async () => {
  const text = 'data: {"a":1}\r\n\r\ndata: {"b":2}\n\ndata: {"c":3}';
  const enc = new TextEncoder().encode(text);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < enc.length; i += 5) c.enqueue(enc.slice(i, i + 5)); c.close(); } });
  const out = [];
  for await (const ev of sseEvents(stream)) out.push(ev);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('release: whole-number versions', () => {
  const { nextVersion } = require('../scripts/release');
  assert.equal(nextVersion(2, ['']), 2, 'first release of v2');
  assert.equal(nextVersion(2, ['v2']), 3);
  assert.equal(nextVersion(3, ['v2', 'v3', 'v10']), 11);
  assert.equal(nextVersion(2, ['v2.1', 'nightly']), 2, 'non-whole tags ignored');
  assert.equal(nextVersion(2, ['v5']), 6, 'never goes backwards');
});
