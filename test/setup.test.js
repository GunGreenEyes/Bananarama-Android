'use strict';
// setup.js (Claude registration), the middleware's request guard, and v2 settings behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const setup = require('../src/setup');
const settingsLib = require('../src/lib/settings');
const { allowed, createServer } = require('../src/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bananarama-setup-'));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('registerMcp: adds entry, keeps other servers and keys, drops legacy name', () => {
  const dir = tmp(); const f = path.join(dir, 'claude_desktop_config.json');
  fs.writeFileSync(f, '\uFEFF' + JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' }, 'banana-interop': { command: 'old' } } }));
  assert.equal(setup.registerMcp(f, { node: 'C:\\n\\node.exe', mcp: 'C:\\a\\mcp.js' }), true);
  const cfg = read(f);
  assert.equal(cfg.theme, 'dark');
  assert.deepEqual(cfg.mcpServers.other, { command: 'x' });
  assert.equal(cfg.mcpServers['banana-interop'], undefined);
  assert.deepEqual(cfg.mcpServers.bananarama, { command: 'C:\\n\\node.exe', args: ['C:\\a\\mcp.js'] });
  assert.equal(setup.registerMcp(f, { node: 'C:\\n\\node.exe', mcp: 'C:\\a\\mcp.js' }), false, 'second run is a no-op');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registerMcp: creates a missing config (and folder)', () => {
  const dir = tmp(); const f = path.join(dir, 'Claude', 'claude_desktop_config.json');
  setup.registerMcp(f, { node: 'n', mcp: 'm' });
  assert.deepEqual(read(f), { mcpServers: { bananarama: { command: 'n', args: ['m'] } } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registerMcp: refuses to overwrite a config that is not valid JSON', () => {
  const dir = tmp(); const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, '{ broken');
  assert.throws(() => setup.registerMcp(f, { node: 'n', mcp: 'm' }));
  assert.equal(fs.readFileSync(f, 'utf8'), '{ broken');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unregisterMcp: removes ours and legacy, leaves the rest', () => {
  const dir = tmp(); const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { bananarama: {}, 'banana-interop': {}, other: { command: 'x' } } }));
  assert.equal(setup.unregisterMcp(f), true);
  assert.deepEqual(read(f), { mcpServers: { other: { command: 'x' } } });
  assert.equal(setup.unregisterMcp(f), false);
  assert.equal(setup.unregisterMcp(path.join(dir, 'missing.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('desktopConfigs: APPDATA config plus Microsoft Store package folders', () => {
  const dir = tmp();
  const store = path.join(dir, 'local', 'Packages', 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(path.join(dir, 'local', 'Packages', 'SomethingElse_1', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
  const list = setup.desktopConfigs({ APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local') });
  assert.deepEqual(list, [path.join(dir, 'roaming', 'Claude', 'claude_desktop_config.json'), path.join(store, 'claude_desktop_config.json')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderSkill: fills placeholders, keeps unknown ones, adds marker', () => {
  const out = setup.renderSkill('run "{{NODE}}" "{{CLI}}" {{NOPE}}\n', { NODE: 'C:\\n.exe', CLI: 'C:\\cli.js' });
  assert.equal(out, `run "C:\\n.exe" "C:\\cli.js" {{NOPE}}\n\n${setup.MARKER}\n`);
});

test('install/uninstall skills: writes rendered skills, skips foreign ones, removes only ours', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'image'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'image', 'SKILL.md'), 'someone else\'s image skill');
  let r = setup.installSkills(dir, setup.vars('C:\\node.exe'));
  assert.deepEqual(r, { done: ['bananarama'], skipped: ['image'] });
  const text = fs.readFileSync(path.join(dir, 'bananarama', 'SKILL.md'), 'utf8');
  assert.match(text, /".+bananarama" doctor/);
  assert.doesNotMatch(text, /\{\{\w+\}\}/);

  fs.writeFileSync(path.join(dir, 'image', 'SKILL.md'), 'old copy: node F:\\x\\BananaInterop\\image.js');
  r = setup.installSkills(dir, setup.vars('C:\\node.exe'));
  assert.deepEqual(r.done, ['image', 'bananarama'], 'v1 hand-copied skill gets replaced');

  assert.deepEqual(setup.uninstallSkills(dir), ['image', 'bananarama']);
  assert.ok(!fs.existsSync(path.join(dir, 'image')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shipped skill templates only use known placeholders', () => {
  const known = Object.keys(setup.vars());
  for (const name of ['image', 'bananarama']) {
    const t = fs.readFileSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md'), 'utf8');
    for (const [, k] of t.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(known.includes(k), `${name}: unknown {{${k}}}`);
    assert.match(t, /^---\r?\nname: /);
  }
});

test('install + status + uninstall end to end in a fake profile', () => {
  const dir = tmp();
  const env = { APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
  process.env.BANANARAMA_SETTINGS = path.join(dir, 'settings.json');
  try {
    const r = setup.install(env);
    assert.equal(r.configs.length, 1);
    assert.ok(fs.existsSync(process.env.BANANARAMA_SETTINGS), 'settings created');
    const st = setup.status(env);
    assert.equal(st.configs[0].registered, true);
    assert.equal(st.configs[0].entry.command, process.execPath);
    assert.ok(st.skills.every(s => s.installed));
    setup.uninstall(env);
    const after = setup.status(env);
    assert.equal(after.configs[0].registered, false);
    assert.ok(after.skills.every(s => !s.installed));
  } finally { delete process.env.BANANARAMA_SETTINGS; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings: default location is %APPDATA%\\Bananarama, log sits next to it', () => {
  const old = process.env.APPDATA; process.env.APPDATA = 'Z:\\roam';
  try {
    assert.equal(settingsLib.settingsPath(), path.join('Z:\\roam', 'Bananarama', 'settings.json'));
    assert.equal(settingsLib.logPath(), path.join('Z:\\roam', 'Bananarama', 'server.log'));
  } finally { process.env.APPDATA = old; }
});

test('settings: save is atomic and round-trips', () => {
  const dir = tmp(); const f = path.join(dir, 'sub', 'settings.json');
  settingsLib.save({ a: 1, b: 'x' }, f);
  assert.deepEqual(read(f), { a: 1, b: 'x' });
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['settings.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server guard: only local Host headers, never browser Origins', () => {
  const req = (host, origin) => ({ headers: origin ? { host, origin } : { host } });
  assert.ok(allowed(req('127.0.0.1:7861')));
  assert.ok(allowed(req('localhost:7861')));
  assert.ok(allowed(req('[::1]:7861')));
  assert.ok(!allowed(req('evil.example:7861')), 'DNS rebinding');
  assert.ok(!allowed(req('127.0.0.1:7861', 'https://evil.example')), 'cross-site request');
  assert.ok(!allowed(req('127.0.0.1:7861', 'null')));
  assert.ok(!allowed(req(undefined)));
});

test('server guard: browser-style requests get 403 over HTTP', async () => {
  const srv = createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = headers => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  try {
    assert.equal(await get({}), 200);
    assert.equal(await get({ Origin: 'https://evil.example' }), 403);
    assert.equal(await get({ Host: 'evil.example' }), 403);
  } finally { await new Promise(r => srv.close(r)); }
});
