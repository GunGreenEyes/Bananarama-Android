#!/usr/bin/env node
'use strict';
// `bananarama` command for Termux on Android.
//
//   bananarama start | stop | restart | status    the background service (notification + middleware)
//   bananarama new                                 ask for a description and make an image
//   bananarama image [--ar 16:9 ...] <text>        make an image from the command line (same flags as cli.js)
//   bananarama test                                make the test image
//   bananarama menu                                everything, as a list (the notification's tap action)
//   bananarama settings                            settings dialogs
//   bananarama share <text> | edit <file>          used by the Android share sheet
//   bananarama last                                open the last image
//   bananarama doctor                              health check
//   bananarama log                                 show the service log
//   bananarama setup | uninstall                   boot script, widgets, share handlers, Claude Code skills
//   bananarama version
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Termux } = require('./termux');
const service = require('./service');
const actions = require('./actions');
const settingsLib = require('../lib/settings');
const pkg = require('../../package.json');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = process.env.BANANARAMA_BIN || path.join(ROOT, 'bin', 'bananarama');

const termux = new Termux();
const out = s => process.stdout.write(s + '\n');

function serviceRunning() { return service.isAlive(service.readPid()); }

async function start() {
  if (serviceRunning()) { out(`Bananarama is already running (pid ${service.readPid()}).`); return; }
  fs.mkdirSync(path.dirname(service.pidFile()), { recursive: true });
  const log = fs.openSync(service.serviceLog(), 'a');
  spawn(process.execPath, [__filename, 'service'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
  const s = settingsLib.load();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (serviceRunning() && await service.health(s.host, s.port) > 0) { out(`Bananarama is running on ${s.host}:${s.port}.`); return; }
  }
  out(`Bananarama did not come up; see ${service.serviceLog()}`);
  process.exitCode = 1;
}

async function stop() {
  const pid = service.readPid();
  if (!service.isAlive(pid)) {
    out('Bananarama is not running.');
    await termux.removeNotification(service.NOTIFY_ID); // a leftover notification from a crash
    return;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 40 && service.isAlive(pid); i++) await new Promise(r => setTimeout(r, 150));
  out(service.isAlive(pid) ? `Bananarama (pid ${pid}) did not stop.` : 'Bananarama stopped.');
}

async function status() {
  const s = settingsLib.load();
  const pid = await service.health(s.host, s.port);
  out(`Bananarama v${pkg.version.split('.')[0]}`);
  out(`service:    ${serviceRunning() ? `running (pid ${service.readPid()})` : 'stopped'}`);
  out(`middleware: ${pid ? `running on ${s.host}:${s.port} (pid ${pid})` : 'not running'}`);
  out(`settings:   ${settingsLib.settingsPath()}`);
  out(`api key:    ${s.apiKey ? 'set' : 'not set (bananarama settings)'}`);
  out(`images:     ${require('../lib/client').outputDir(s)}`);
}

async function menu() {
  const items = ['New image', 'Make a test image', 'Open last image', 'Settings', 'Health check', 'Restart', 'Stop'];
  const pick = await termux.choose('Bananarama', items, 'sheet');
  switch (pick) {
    case 'New image': return actions.newImage(termux, BIN);
    case 'Make a test image': return actions.makeImage(termux, BIN, { prompt: actions.TEST_PROMPT });
    case 'Open last image': return openLast();
    case 'Settings': return actions.settingsFlow(termux);
    case 'Health check': {
      const lines = await actions.doctor(termux, { health: service.health, isServiceRunning: serviceRunning });
      const bad = lines.filter(l => l.startsWith('❌')).length;
      return termux.toast(bad ? `${bad} problem(s): ${lines.filter(l => l.startsWith('❌')).map(l => l.slice(2).split(' — ')[0]).join(', ')}` : '🍌 Bananarama: all good', false);
    }
    case 'Restart': await stop(); return start();
    case 'Stop': return stop();
    default: return null;
  }
}

async function openLast() {
  const f = actions.lastImage();
  if (f) await termux.open(f); else await termux.toast('No image yet');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'service': return service.run({ termux, bin: BIN });
    case 'start': return start();
    case 'stop': return stop();
    case 'restart': await stop(); return start();
    case 'status': return status();
    case 'new': return actions.newImage(termux, BIN);
    case 'test': {
      const r = await actions.makeImage(termux, BIN, { prompt: actions.TEST_PROMPT });
      if (r) out(`SAVED: ${r.file}`); else process.exitCode = 1;
      return r;
    }
    case 'image': {
      const { parseArgs } = require('../cli');
      const a = parseArgs(rest);
      if (!a.prompt) { out('usage: bananarama image [--ar 16:9] [--size 2K] [--model pro] [--image ref.png] <description>'); process.exitCode = 1; return null; }
      const r = await actions.makeImage(termux, BIN, a);
      if (r) out(`SAVED: ${r.file}`); else process.exitCode = 1;
      return r;
    }
    case 'share': return actions.shareText(termux, BIN, rest.join(' '));
    case 'edit': return actions.editImage(termux, BIN, rest[0]);
    case 'menu': return menu();
    case 'settings': return actions.settingsFlow(termux);
    case 'last': return openLast();
    case 'doctor': {
      const lines = await actions.doctor(termux, { health: service.health, isServiceRunning: serviceRunning });
      lines.forEach(out);
      const bad = lines.filter(l => l.startsWith('❌')).length;
      out(bad ? `🍌 Bananarama: ${bad} problem(s)` : '🍌 Bananarama: all good');
      return lines;
    }
    case 'log': {
      for (const f of [service.serviceLog(), settingsLib.logPath()]) {
        if (fs.existsSync(f)) { out(`== ${f}`); out(fs.readFileSync(f, 'utf8').split('\n').slice(-40).join('\n')); }
      }
      return null;
    }
    case 'setup': return require('./install').install({ bin: BIN, root: ROOT, node: process.execPath, log: out });
    case 'uninstall': await stop(); return require('./install').uninstall({ log: out });
    case 'version': case '--version': case '-v': return out(`Bananarama for Android v${pkg.version.split('.')[0]}`);
    default:
      out(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//   ')).map(l => l.slice(5)).join('\n'));
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
      return null;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}
module.exports = { main };
