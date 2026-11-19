'use strict';
// Wires Bananarama into Termux / Android (run by install.sh, or `bananarama setup`):
//   ~/.termux/boot/bananarama          Termux:Boot: start the service when the phone boots
//   ~/.shortcuts/tasks/Bananarama …    Termux:Widget: home-screen buttons (run without a terminal)
//   ~/bin/termux-url-opener            Share text  → Termux → make an image
//   ~/bin/termux-file-editor           Share image → Termux → edit it
//   $PREFIX/bin/bananarama             the command on PATH
//   ~/.claude/skills/{image,bananarama}  /image and /bananarama for Claude Code in Termux
// Files someone else wrote are never overwritten; ours carry MARKER.
const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('../setup');

const MARKER = '# installed by Bananarama';

function prefix(env = process.env) { return env.PREFIX || '/data/data/com.termux/files/usr'; }

const q = s => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

function script(shell, body) { return `#!${shell}\n${MARKER}\n${body}\n`; }

/** Every file we manage: [path, contents]. */
function plan({ bin, home = os.homedir(), env = process.env }) {
  const sh = path.posix.join(prefix(env), 'bin', 'sh');
  const b = q(bin);
  const task = name => path.join(home, '.shortcuts', 'tasks', name);
  return [
    [path.join(home, '.termux', 'boot', 'bananarama'), script(sh, `termux-wake-lock\nexec ${b} start`)],
    [task('Bananarama - New image'), script(sh, `exec ${b} new`)],
    [task('Bananarama - Test image'), script(sh, `exec ${b} test`)],
    [task('Bananarama - Menu'), script(sh, `exec ${b} menu`)],
    [task('Bananarama - Settings'), script(sh, `exec ${b} settings`)],
    [path.join(home, 'bin', 'termux-url-opener'), script(sh, `exec ${b} share "$1"`)],
    [path.join(home, 'bin', 'termux-file-editor'), script(sh, `exec ${b} edit "$1"`)]
  ];
}

const ours = file => !fs.existsSync(file) || fs.readFileSync(file, 'utf8').includes(MARKER);

function install({ bin, home = os.homedir(), env = process.env, log = () => {}, skills = true }) {
  const written = [], skipped = [];
  for (const [file, body] of plan({ bin, home, env })) {
    if (!ours(file)) {
      fs.writeFileSync(`${file}.bananarama`, body, { mode: 0o755 });
      skipped.push(file);
      log(`! ${file} belongs to something else; left it alone (ours is ${path.basename(file)}.bananarama)`);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
    written.push(file);
  }
  // the command on PATH (only inside Termux)
  let linked = null;
  if (env.PREFIX && fs.existsSync(path.join(env.PREFIX, 'bin'))) {
    linked = path.join(env.PREFIX, 'bin', 'bananarama');
    try { fs.rmSync(linked, { force: true }); fs.symlinkSync(bin, linked); } catch (e) { log(`! could not link ${linked}: ${e.message}`); linked = null; }
  }
  let claude = null;
  if (skills) {
    try { claude = setup.installSkills(setup.skillsDir(env), { ...setup.vars(), BIN: bin }); }
    catch (e) { log(`! Claude Code skills: ${e.message}`); }
  }
  written.forEach(f => log(`✓ ${f}`));
  if (linked) log(`✓ ${linked}`);
  if (claude && claude.done.length) log(`✓ Claude Code skills: ${claude.done.map(n => '/' + n).join(', ')}`);
  return { written, skipped, linked, claude };
}

function uninstall({ home = os.homedir(), env = process.env, log = () => {} } = {}) {
  const removed = [];
  for (const [file] of plan({ bin: 'x', home, env })) {
    for (const f of [file, `${file}.bananarama`]) {
      if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(MARKER)) { fs.rmSync(f); removed.push(f); }
    }
  }
  if (env.PREFIX) {
    const link = path.join(env.PREFIX, 'bin', 'bananarama');
    try { if (fs.lstatSync(link).isSymbolicLink()) { fs.rmSync(link); removed.push(link); } } catch { /* not there */ }
  }
  try { setup.uninstallSkills(setup.skillsDir(env)).forEach(n => removed.push(`skill ${n}`)); } catch { /* fine */ }
  removed.forEach(f => log(`✗ ${f}`));
  log('Settings and images are kept (~/.config/Bananarama, Pictures/Nano).');
  return removed;
}

module.exports = { install, uninstall, plan, MARKER };
