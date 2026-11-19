#!/usr/bin/env node
'use strict';
// Registers Bananarama with Claude. Run by the installer (and the tray menu):
//
//   node src/setup.js install     add the MCP server to Claude Desktop + the /image and /bananarama skills to Claude Code
//   node src/setup.js uninstall   remove both again (settings and images are kept)
//   node src/setup.js status      print what is registered where (JSON)
//
// The node.exe running this script is the one Claude Desktop will launch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const settingsLib = require('./lib/settings');

const SERVER_NAME = 'bananarama';
const LEGACY_NAMES = ['banana-interop'];
const SKILLS = ['image', 'bananarama'];
const MARKER = '<!-- installed by Bananarama -->';
const SRC = __dirname;

/** Claude Desktop config files: the normal install, plus any Microsoft Store package that exists. */
function desktopConfigs(env = process.env) {
  const out = [];
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'));
  const pk = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Packages');
  if (pk && fs.existsSync(pk)) {
    for (const d of fs.readdirSync(pk)) {
      const dir = path.join(pk, d, 'LocalCache', 'Roaming', 'Claude');
      if (/^Claude_/i.test(d) && fs.existsSync(dir)) out.push(path.join(dir, 'claude_desktop_config.json'));
    }
  }
  return out;
}

function skillsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills');
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  return raw ? JSON.parse(raw) : {};
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Add/replace our MCP server entry, drop legacy names, keep everything else. Returns true if the file changed. */
function registerMcp(file, { node, mcp }) {
  const cfg = readJson(file);
  const before = JSON.stringify(cfg);
  cfg.mcpServers = cfg.mcpServers || {};
  for (const n of LEGACY_NAMES) delete cfg.mcpServers[n];
  cfg.mcpServers[SERVER_NAME] = { command: node, args: [mcp] };
  if (JSON.stringify(cfg) === before) return false;
  writeJson(file, cfg);
  return true;
}

function unregisterMcp(file) {
  if (!fs.existsSync(file)) return false;
  const cfg = readJson(file);
  if (!cfg.mcpServers) return false;
  let changed = false;
  for (const n of [SERVER_NAME, ...LEGACY_NAMES]) if (n in cfg.mcpServers) { delete cfg.mcpServers[n]; changed = true; }
  if (changed) writeJson(file, cfg);
  return changed;
}

function renderSkill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m)).trimEnd() + `\n\n${MARKER}\n`;
}

/** A skill folder is ours if we installed it or it is the v1 hand-copied one. */
function isOurs(file) {
  if (!fs.existsSync(file)) return true;
  const t = fs.readFileSync(file, 'utf8');
  return t.includes(MARKER) || /BananaInterop|Bananarama/.test(t);
}

function installSkills(dir, vars, templates = path.join(SRC, '..', 'skills')) {
  const done = [], skipped = [];
  for (const name of SKILLS) {
    const file = path.join(dir, name, 'SKILL.md');
    if (!isOurs(file)) { skipped.push(name); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderSkill(fs.readFileSync(path.join(templates, name, 'SKILL.md'), 'utf8'), vars));
    done.push(name);
  }
  return { done, skipped };
}

function uninstallSkills(dir) {
  const removed = [];
  for (const name of SKILLS) {
    const file = path.join(dir, name, 'SKILL.md');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARKER)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

function vars(node = process.execPath) {
  return {
    NODE: node,
    CLI: path.join(SRC, 'cli.js'),
    MCP: path.join(SRC, 'mcp.js'),
    SETTINGS: settingsLib.settingsPath(),
    LOG: settingsLib.logPath(),
    APP: path.resolve(SRC, '..'),
    BIN: path.resolve(SRC, '..', 'bin', 'bananarama')
  };
}

function install(env = process.env) {
  settingsLib.load(); // create (or migrate) settings.json
  const v = vars();
  const configs = desktopConfigs(env).map(f => ({ file: f, changed: registerMcp(f, { node: v.NODE, mcp: v.MCP }) }));
  return { configs, skills: installSkills(skillsDir(env), v), settings: v.SETTINGS };
}

function uninstall(env = process.env) {
  return { configs: desktopConfigs(env).map(f => ({ file: f, changed: unregisterMcp(f) })), skills: uninstallSkills(skillsDir(env)) };
}

function status(env = process.env) {
  return {
    configs: desktopConfigs(env).map(f => {
      let entry = null; try { entry = (readJson(f).mcpServers || {})[SERVER_NAME] || null; } catch { /* unreadable */ }
      return { file: f, registered: !!entry, entry };
    }),
    skills: SKILLS.map(n => ({ name: n, installed: fs.existsSync(path.join(skillsDir(env), n, 'SKILL.md')) })),
    settings: settingsLib.settingsPath()
  };
}

if (require.main === module) {
  const cmd = process.argv[2];
  const fn = { install, uninstall, status }[cmd];
  if (!fn) { console.error('usage: node setup.js install|uninstall|status'); process.exit(2); }
  try { console.log(JSON.stringify(fn(), null, 2)); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
}

module.exports = { desktopConfigs, skillsDir, registerMcp, unregisterMcp, renderSkill, installSkills, uninstallSkills, install, uninstall, status, vars, SERVER_NAME, MARKER };
