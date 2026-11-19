'use strict';
// The Android counterpart of the Windows tray app: a long-running process that
// keeps the middleware (src/server.js) alive, holds a wake lock so Android doesn't
// freeze it while the screen is off, and shows a persistent notification with
// buttons (New image / Menu / Stop) instead of a tray icon.
//
// Started by `bananarama start` (and by the Termux:Boot script at boot).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const settingsLib = require('../lib/settings');

const NOTIFY_ID = 'bananarama';
const POLL_MS = 10000;

const pidFile = () => path.join(path.dirname(settingsLib.settingsPath()), 'service.pid');
const serviceLog = () => path.join(path.dirname(settingsLib.settingsPath()), 'service.log');

/** GET /health; resolves the middleware's pid, or 0 when nothing (or something else) answers. */
function health(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/health', timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(j.name === 'Bananarama' ? Number(j.pid) || 0 : 0); }
        catch { resolve(0); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readPid() {
  try { return Number(fs.readFileSync(pidFile(), 'utf8').trim()) || 0; } catch { return 0; }
}

/** Shell-quote one argument for a notification action. */
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

class Service {
  /**
   * @param {{termux: import('./termux').Termux, bin: string, node?: string, serverScript?: string,
   *          settings?: () => object, pollMs?: number, log?: (line:string) => void}} o
   */
  constructor(o) {
    this.termux = o.termux;
    this.bin = o.bin;
    this.node = o.node || process.execPath;
    this.serverScript = o.serverScript || path.join(__dirname, '..', 'server.js');
    this.settings = o.settings || (() => settingsLib.load());
    this.pollMs = o.pollMs || POLL_MS;
    this.log = o.log || (() => {});
    this.child = null;
    this.state = 'stopped';
    this.error = null;
    this.restarts = [];
    this.timer = null;
    this.stopping = false;
    this.lastShown = null;
  }

  endpoint() { const s = this.settings(); return { host: s.host, port: s.port }; }

  async start() {
    this.stopping = false;
    const s = this.settings();
    if (s.wakeLock) await this.termux.wakeLock();
    await this.ensureServer();
    await this.show();
    this.timer = setInterval(() => { this.poll().catch(e => this.log(`[service] poll failed: ${e.message}`)); }, this.pollMs);
  }

  async ensureServer() {
    const { host, port } = this.endpoint();
    if (await health(host, port) > 0) { this.setState('running'); return; }
    this.restarts = this.restarts.filter(t => Date.now() - t < 60000);
    if (this.restarts.length >= 5) { this.setState('failed', 'middleware keeps crashing; run: bananarama log'); return; }
    this.restarts.push(Date.now());

    const child = spawn(this.node, [this.serverScript], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    this.child = child;
    child.stdout.on('data', d => this.log(String(d).trimEnd()));
    child.stderr.on('data', d => this.log(String(d).trimEnd()));
    child.on('exit', code => {
      if (this.child === child) this.child = null;
      if (!this.stopping) this.log(`[service] middleware exited (${code}); restarting`);
    });
    this.setState('starting');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (await health(host, port) > 0) { this.setState('running'); return; }
      if (!this.child) break;
    }
    if (this.state !== 'running') this.setState('failed', 'middleware did not start; run: bananarama log');
  }

  async poll() {
    if (this.stopping) return;
    const { host, port } = this.endpoint();
    if (await health(host, port) > 0) this.setState('running');
    else if (!(this.state === 'failed' && this.error && this.error.startsWith('middleware keeps'))) await this.ensureServer();
    await this.show();
  }

  setState(state, error = null) {
    if (error && error !== this.error) this.log(`[service] ${error}`);
    this.state = state; this.error = error;
  }

  statusText() {
    const { host, port } = this.endpoint();
    switch (this.state) {
      case 'running': return `Ready · ${host}:${port}`;
      case 'starting': return 'Starting…';
      case 'failed': return `Error: ${this.error}`;
      default: return 'Stopped';
    }
  }

  /** The persistent notification - re-posted only when its text changes. */
  async show() {
    const content = this.statusText();
    if (content === this.lastShown) return;
    this.lastShown = content;
    const b = shq(this.bin);
    await this.termux.notify({
      id: NOTIFY_ID, title: 'Bananarama', content, ongoing: true, alertOnce: true, priority: 'low', icon: 'image',
      action: `${b} menu`,
      buttons: [
        { text: 'New image', action: `${b} new` },
        { text: 'Settings', action: `${b} settings` },
        { text: 'Stop', action: `${b} stop` }
      ]
    });
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.child) {
      const c = this.child; this.child = null;
      await new Promise(resolve => { c.once('exit', resolve); c.kill('SIGTERM'); setTimeout(resolve, 3000); });
    }
    this.setState('stopped');
    await this.termux.removeNotification(NOTIFY_ID);
    await this.termux.wakeUnlock();
  }
}

/** Foreground entry point for the background process (`bananarama service`). */
async function run({ termux, bin }) {
  const dir = path.dirname(pidFile());
  fs.mkdirSync(dir, { recursive: true });
  const other = readPid();
  if (other && other !== process.pid && isAlive(other)) { console.error(`already running (pid ${other})`); process.exit(0); }
  fs.writeFileSync(pidFile(), String(process.pid));
  const logStream = fs.createWriteStream(serviceLog(), { flags: 'a' });
  const log = line => logStream.write(`${new Date().toISOString()} ${line}\n`);
  const svc = new Service({ termux, bin, log });
  let quitting = false;
  const quit = async () => {
    if (quitting) return; quitting = true;
    log('[service] stopping');
    await svc.stop().catch(() => {});
    try { if (readPid() === process.pid) fs.rmSync(pidFile(), { force: true }); } catch { /* gone */ }
    logStream.end(() => process.exit(0));
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  process.on('SIGHUP', () => {}); // survive the Termux session that started us closing
  log(`[service] started (pid ${process.pid})`);
  await svc.start();
  return svc;
}

module.exports = { Service, run, health, isAlive, readPid, pidFile, serviceLog, shq, NOTIFY_ID };
