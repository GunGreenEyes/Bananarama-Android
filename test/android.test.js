'use strict';
// The Android layer: Termux:API wrapper, actions (notifications, dialogs, share sheet),
// the background service, the Termux wiring and the `bananarama` command - all with a
// fake Termux, so it runs on any machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { Termux } = require('../src/android/termux');
const actions = require('../src/android/actions');
const { Service, health, shq } = require('../src/android/service');
const install = require('../src/android/install');
const { setup, sseImage, httpError, PNG_B64 } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bananarama-android-'));

/** A fake Termux:API: records calls, answers dialogs from a script. */
function fakeTermux(dialogAnswers = []) {
  const calls = [];
  const answers = [...dialogAnswers];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'termux-dialog') {
      const a = answers.shift();
      if (a === undefined) return { ok: true, stdout: JSON.stringify({ code: -2, text: '' }), stderr: '' };
      return { ok: true, stdout: JSON.stringify(a), stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  const t = new Termux(run);
  t.calls = calls;
  t.notes = () => calls.filter(c => c.cmd === 'termux-notification').map(c => argMap(c.args));
  t.toasts = () => calls.filter(c => c.cmd === 'termux-toast').map(c => c.args[c.args.length - 1]);
  return t;
}

function argMap(args) {
  const m = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) m[args[i].slice(2)] = true;
      else { m[args[i].slice(2)] = next; i++; }
    }
  }
  return m;
}

function withSettings(values, fn) {
  const dir = tmp(); const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify(values));
  process.env.BANANARAMA_SETTINGS = f;
  return Promise.resolve().then(() => fn(f, dir)).finally(() => { delete process.env.BANANARAMA_SETTINGS; fs.rmSync(dir, { recursive: true, force: true }); });
}

// ---------- termux.js ----------

test('termux: notification arguments, max three buttons', async () => {
  const t = fakeTermux();
  await t.notify({ id: 'x', title: 'T', content: 'C', ongoing: true, alertOnce: true, image: '/p/a.png', action: 'do it',
    buttons: [1, 2, 3, 4].map(n => ({ text: `b${n}`, action: `a${n}` })) });
  const n = t.notes()[0];
  assert.equal(n.id, 'x'); assert.equal(n.title, 'T'); assert.equal(n.content, 'C');
  assert.equal(n.ongoing, true); assert.equal(n['alert-once'], true);
  assert.equal(n['image-path'], '/p/a.png'); assert.equal(n.action, 'do it');
  assert.equal(n.button3, 'b3'); assert.equal(n['button3-action'], 'a3');
  assert.equal(n.button4, undefined);
});

test('termux: dialog results - ok, cancel, radio index, garbage, command failure', async () => {
  let t = fakeTermux([{ code: -1, text: ' hello ' }, { code: -2, text: '' }]);
  assert.deepEqual(await t.text('Q'), { ok: true, text: 'hello', index: undefined });
  assert.equal((await t.text('Q')).ok, false);

  t = fakeTermux([{ code: -1, text: '16:9', index: 8 }, { code: -1, text: 'b c' }]);
  assert.equal(await t.choose('Pick', actions.RATIOS), '16:9');
  assert.equal(await t.choose('Pick', ['a', 'b,c']), 'b,c', 'commas are flattened for the dialog and matched back');
  assert.deepEqual(t.calls[1].args.slice(-2), ['-v', 'a,b c']);

  const bad = new Termux(async () => ({ ok: true, stdout: 'nope', stderr: '' }));
  assert.match((await bad.text('Q')).error, /unexpected dialog output/);
  const missing = new Termux(async () => ({ ok: false, stdout: '', stderr: 'termux-dialog: not found' }));
  assert.equal((await missing.text('Q')).ok, false);
});

test('termux: confirm treats "no" as false', async () => {
  const t = fakeTermux([{ code: -1, text: 'yes' }, { code: -1, text: 'no' }, { code: -2, text: '' }]);
  assert.equal(await t.confirm('?'), true);
  assert.equal(await t.confirm('?'), false);
  assert.equal(await t.confirm('?'), false);
});

// ---------- actions.js ----------

test('parseInline: pulls ratio, size and model out of the description', () => {
  assert.deepEqual(actions.parseInline('a fox in a library, 16:9, 2k, pro'),
    { prompt: 'a fox in a library', aspectRatio: '16:9', imageSize: '2K', model: 'pro' });
  assert.deepEqual(actions.parseInline('red, green and blue'), { prompt: 'red, green and blue' });
  assert.deepEqual(actions.parseInline('  9:16 , poster '), { prompt: 'poster', aspectRatio: '9:16' });
});

test('shq: quotes for notification actions', () => {
  assert.equal(shq('/a b/c.png'), `'/a b/c.png'`);
  assert.equal(shq(`it's`), `'it'\\''s'`);
});

test('makeImage: progress, media scan, result notification with Share/Edit/New, remembers last image', async () => {
  await withSettings({ notify: true }, async (f, dir) => {
    const file = path.join(dir, 'image_1_a-cat.png');
    fs.writeFileSync(file, Buffer.from(PNG_B64, 'base64'));
    const t = fakeTermux();
    const gen = async (opts, onProgress) => { onProgress({ type: 'progress', percent: 50 }); onProgress({ type: 'progress', percent: 100 }); return { file, bytes: 10, mimeType: 'image/png', texts: [] }; };
    const r = await actions.makeImage(t, '/bin/bananarama', { prompt: 'a cat' }, { generate: gen });
    assert.equal(r.file, file);
    assert.ok(t.calls.some(c => c.cmd === 'termux-media-scan' && c.args[0] === file));
    assert.ok(t.calls.some(c => c.cmd === 'termux-notification-remove' && c.args[0] === actions.JOB_ID));
    const notes = t.notes();
    assert.equal(notes[0].id, actions.JOB_ID);
    assert.ok(notes.some(n => n.content === 'a cat · 50%'));
    const done = notes[notes.length - 1];
    assert.equal(done.title, 'Image saved');
    assert.equal(done['image-path'], file);
    assert.equal(done.action, `termux-open '${file}'`);
    assert.deepEqual([done.button1, done.button2, done.button3], ['Share', 'Edit', 'New']);
    assert.equal(done['button2-action'], `'/bin/bananarama' edit '${file}'`);
    assert.equal(actions.lastImage(), file);
  });
});

test('makeImage: failure notification offers Settings for key problems, Try again otherwise', async () => {
  await withSettings({ notify: true }, async () => {
    let t = fakeTermux();
    assert.equal(await actions.makeImage(t, 'b', { prompt: 'x' }, { generate: async () => { throw new Error('Gemini HTTP 400: API key not valid'); } }), null);
    let n = t.notes().pop();
    assert.equal(n.title, 'Image failed'); assert.equal(n.button1, 'Settings');
    t = fakeTermux();
    await actions.makeImage(t, 'b', { prompt: 'x' }, { generate: async () => { throw new Error('no image returned (finishReason: IMAGE_SAFETY)'); } });
    n = t.notes().pop();
    assert.equal(n.button1, 'Try again'); assert.match(n.content, /IMAGE_SAFETY/);
  });
});

test('makeImage: notifications off -> just a toast', async () => {
  await withSettings({ notify: false }, async () => {
    const t = fakeTermux();
    await actions.makeImage(t, 'b', { prompt: 'x' }, { generate: async () => ({ file: '/x/y.png' }) });
    assert.equal(t.notes().length, 0);
    assert.deepEqual(t.toasts(), ['Saved y.png']);
  });
});

test('newImage / shareText / editImage feed the right options to generate', async () => {
  await withSettings({ notify: false }, async (f, dir) => {
    const seen = [];
    const deps = { generate: async opts => { seen.push(opts); return { file: '/x/y.png' }; } };

    await actions.newImage(fakeTermux([{ code: -1, text: 'a robot, 21:9' }]), 'b', deps);
    assert.deepEqual(seen.pop(), { prompt: 'a robot', aspectRatio: '21:9' });
    assert.equal(await actions.newImage(fakeTermux([{ code: -2, text: '' }]), 'b', deps), null, 'cancel does nothing');

    const t = fakeTermux();
    assert.equal(await actions.shareText(t, 'b', 'https://example.com/page', deps), null);
    assert.match(t.toasts()[0], /not a link/);
    await actions.shareText(fakeTermux(), 'b', 'a lighthouse at dusk, 4k', deps);
    assert.deepEqual(seen.pop(), { prompt: 'a lighthouse at dusk', imageSize: '4K' });

    const img = path.join(dir, 'in.png'); fs.writeFileSync(img, 'x');
    await actions.editImage(fakeTermux([{ code: -1, text: 'add a hat' }]), 'b', img, deps);
    assert.deepEqual(seen.pop(), { prompt: 'add a hat', images: [img] });
    const t2 = fakeTermux();
    assert.equal(await actions.editImage(t2, 'b', path.join(dir, 'missing.png'), deps), null);
    assert.match(t2.toasts()[0], /not found/);
  });
});

test('settingsFlow: set key, model, ratio, toggle notifications, test key, done', async () => {
  await withSettings({}, async f => {
    const sheet = i => ({ code: -1, text: 'x', index: i });
    const t = fakeTermux([
      sheet(0), { code: -1, text: 'AIza-test' },            // API key
      sheet(1), { code: -1, text: 'gemini-3-pro-image', index: 1 }, // model
      sheet(2), { code: -1, text: '16:9', index: 8 },        // aspect ratio
      sheet(6),                                              // notifications off
      sheet(7),                                              // test key
      sheet(8)                                               // done
    ]);
    let checked = null;
    await actions.settingsFlow(t, { checkKey: async (key, base, model) => { checked = { key, model }; return { ok: true, message: 'Key works ✓' }; } });
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(s.apiKey, 'AIza-test');
    assert.equal(s.model, 'gemini-3-pro-image');
    assert.equal(s.aspectRatio, '16:9');
    assert.equal(s.notify, false);
    assert.deepEqual(checked, { key: 'AIza-test', model: 'gemini-3-pro-image' });
    assert.ok(t.toasts().includes('Key works ✓'));
    const keyDialog = t.calls.find(c => c.cmd === 'termux-dialog' && c.args[0] === 'text');
    assert.ok(keyDialog.args.includes('-p'), 'key is typed in a password field');
  });
});

test('testKey: valid, invalid, model missing', async () => {
  const srv = http.createServer((req, res) => {
    if (req.headers['x-goog-api-key'] !== 'good') { res.writeHead(400); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'models/gemini-3.1-flash-image' }] }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/v1beta`;
  try {
    assert.deepEqual(await actions.testKey('good', base, 'gemini-3.1-flash-image'), { ok: true, message: 'Key works ✓' });
    assert.equal((await actions.testKey('bad', base, 'gemini-3.1-flash-image')).ok, false);
    assert.match((await actions.testKey('good', base, 'gemini-3-pro-image')).message, /not available/);
  } finally { await new Promise(r => srv.close(r)); }
});

test('doctor: reports each check', async () => {
  await withSettings({ apiKey: 'k' }, async () => {
    const lines = await actions.doctor(fakeTermux(), {
      health: async () => 123, isServiceRunning: () => true,
      fetchKey: async () => ({ ok: true, message: 'Key works ✓' }), exists: () => true, home: '/h'
    });
    const text = lines.join('\n');
    for (const label of ['Settings', 'Node.js', 'Termux:API app', 'Gemini API key', 'Key test', 'Background service', 'Middleware', 'Start at boot', 'Claude Code /image skill']) {
      assert.match(text, new RegExp(`✅ ${label.replace(/[/:]/g, m => '\\' + m)}`), label);
    }
  });
  await withSettings({ apiKey: '' }, async () => {
    const old = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
    try {
      const lines = await actions.doctor(fakeTermux(), { exists: () => false });
      assert.ok(lines.some(l => l.startsWith('❌ Gemini API key') && l.includes('bananarama settings')));
    } finally { if (old !== undefined) process.env.GEMINI_API_KEY = old; }
  });
});

// ---------- service.js (real middleware, fake Termux) ----------

test('service: starts the middleware, shows the notification, restarts after a crash, cleans up on stop', async () => {
  const ctx = await setup();          // fake Gemini + an in-process middleware on ctx.settings.port
  await ctx.close();                  // ...but we want the service to own the middleware: free the port
  const dir = tmp(); const f = path.join(dir, 'settings.json');
  const port = ctx.settings.port;
  fs.writeFileSync(f, JSON.stringify({ ...ctx.settings, outputDir: dir, autoStartServer: false }));
  process.env.BANANARAMA_SETTINGS = f;
  const t = fakeTermux();
  const svc = new Service({ termux: t, bin: '/b/bananarama', pollMs: 60000 });
  try {
    await svc.start();
    assert.equal(svc.state, 'running');
    const firstPid = await health('127.0.0.1', port);
    assert.ok(firstPid > 0);
    assert.ok(t.calls.some(c => c.cmd === 'termux-wake-lock'));
    let n = t.notes().pop();
    assert.equal(n.content, `Ready · 127.0.0.1:${port}`);
    assert.equal(n.ongoing, true);
    assert.deepEqual([n.button1, n.button2, n.button3], ['New image', 'Settings', 'Stop']);
    assert.equal(n.action, `'/b/bananarama' menu`);

    process.kill(firstPid);           // crash it
    for (let i = 0; i < 40 && await health('127.0.0.1', port) > 0; i++) await new Promise(r => setTimeout(r, 50));
    await svc.poll();
    const second = await health('127.0.0.1', port);
    assert.ok(second > 0 && second !== firstPid, 'restarted with a new process');

    await svc.stop();
    assert.equal(await health('127.0.0.1', port), 0);
    assert.ok(t.calls.some(c => c.cmd === 'termux-notification-remove' && c.args[0] === 'bananarama'));
    assert.ok(t.calls.some(c => c.cmd === 'termux-wake-unlock'));
  } finally {
    await svc.stop().catch(() => {});
    delete process.env.BANANARAMA_SETTINGS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('service: notification only re-posted when the text changes', async () => {
  await withSettings({ port: 1 }, async () => {
    const t = fakeTermux();
    const svc = new Service({ termux: t, bin: 'b' });
    svc.state = 'running';
    await svc.show(); await svc.show();
    svc.setState('failed', 'boom'); await svc.show();
    assert.deepEqual(t.notes().map(n => n.content), ['Ready · 127.0.0.1:1', 'Error: boom']);
  });
});

// ---------- install.js ----------

test('install: boot script, widgets, share handlers, PATH link, skills; never clobbers foreign files', () => {
  const home = tmp(); const prefix = path.join(home, 'usr');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin', 'termux-file-editor'), '#!/bin/sh\nvim "$1"\n');
  const env = { PREFIX: prefix, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  const bin = path.join(home, 'bananarama', 'bin', 'bananarama');
  const log = [];
  try {
    const r = install.install({ bin, home, env, log: l => log.push(l) });
    const boot = fs.readFileSync(path.join(home, '.termux', 'boot', 'bananarama'), 'utf8');
    assert.equal(boot, `#!${path.posix.join(prefix, 'bin', 'sh')}\n${install.MARKER}\ntermux-wake-lock\nexec "${bin.replace(/\\/g, '\\\\')}" start\n`);
    assert.ok(!boot.includes('\r'), 'LF line endings');
    for (const w of ['New image', 'Test image', 'Menu', 'Settings']) assert.ok(fs.existsSync(path.join(home, '.shortcuts', 'tasks', `Bananarama - ${w}`)), w);
    assert.match(fs.readFileSync(path.join(home, 'bin', 'termux-url-opener'), 'utf8'), /share "\$1"/);
    assert.equal(fs.readFileSync(path.join(home, 'bin', 'termux-file-editor'), 'utf8'), '#!/bin/sh\nvim "$1"\n', 'foreign handler kept');
    assert.match(fs.readFileSync(path.join(home, 'bin', 'termux-file-editor.bananarama'), 'utf8'), /edit "\$1"/);
    assert.deepEqual(r.skipped, [path.join(home, 'bin', 'termux-file-editor')]);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'image', 'SKILL.md')));
    assert.match(fs.readFileSync(path.join(home, '.claude', 'skills', 'bananarama', 'SKILL.md'), 'utf8'), /bananarama" doctor/);
    if (r.linked) assert.equal(fs.readlinkSync(r.linked), bin);

    const removed = install.uninstall({ home, env });
    assert.ok(!fs.existsSync(path.join(home, '.termux', 'boot', 'bananarama')));
    assert.ok(!fs.existsSync(path.join(home, 'bin', 'termux-file-editor.bananarama')));
    assert.ok(fs.existsSync(path.join(home, 'bin', 'termux-file-editor')), 'foreign handler still there');
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'image')));
    assert.ok(removed.length >= 8);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---------- the bananarama command, end to end ----------

function cli(args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'android', 'main.js'), ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', c => { stdout += c; }); p.stderr.on('data', c => { stderr += c; });
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('bananarama command: start, status, image, test, doctor, stop (Termux tools absent = no-ops)', async () => {
  const ctx = await setup();
  await ctx.close(); // the service will run the middleware itself
  const dir = tmp(); const f = path.join(dir, 'settings.json');
  const fakeGem = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      if (req.method === 'GET') { // doctor's key test lists models
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ name: 'models/gemini-3.1-flash-image' }] }));
      }
      sseImage()(req, b ? JSON.parse(b) : {}, res);
    });
  });
  await new Promise(r => fakeGem.listen(0, '127.0.0.1', r));
  fs.writeFileSync(f, JSON.stringify({ ...ctx.settings, apiKey: 'k', outputDir: dir, apiBase: `http://127.0.0.1:${fakeGem.address().port}/v1beta`, notify: false }));
  const env = { BANANARAMA_SETTINGS: f, PATH: path.dirname(process.execPath) }; // no termux-* tools on PATH
  try {
    let r = await cli(['start'], env);
    assert.match(r.stdout, /running on 127\.0\.0\.1/, r.stdout + r.stderr);
    r = await cli(['start'], env);
    assert.match(r.stdout, /already running/);
    r = await cli(['status'], env);
    assert.match(r.stdout, /service: +running/); assert.match(r.stdout, /middleware: running/); assert.match(r.stdout, /api key: +set/);

    r = await cli(['image', '--ar', '3:2', 'a', 'test', 'banana'], env);
    assert.equal(r.code, 0, r.stderr);
    const saved = r.stdout.match(/SAVED: (.+)/)[1].trim();
    assert.equal(path.dirname(saved), path.join(dir, 'Nano'));
    assert.deepEqual(fs.readFileSync(saved), Buffer.from(PNG_B64, 'base64'));

    r = await cli(['doctor'], env);
    assert.match(r.stdout, /✅ Background service/);
    assert.match(r.stdout, /✅ Middleware/);
    assert.match(r.stdout, /❌ Termux:API app/, 'no Termux here');

    r = await cli(['version'], env);
    assert.match(r.stdout, /^Bananarama for Android v1$/m);

    r = await cli(['stop'], env);
    assert.match(r.stdout, /stopped/);
    assert.equal(await health('127.0.0.1', ctx.settings.port), 0);
    r = await cli(['stop'], env);
    assert.match(r.stdout, /not running/);
  } finally {
    await cli(['stop'], env);
    // belt and braces: never leave a background service behind
    try { const pid = Number(fs.readFileSync(path.join(dir, 'service.pid'), 'utf8')); if (pid) process.kill(pid); } catch { /* gone */ }
    const mw = await health('127.0.0.1', ctx.settings.port); if (mw) { try { process.kill(mw); } catch { /* gone */ } }
    await new Promise(r => fakeGem.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
