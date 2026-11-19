'use strict';
// What the notification buttons, the menu, the share sheet and the home-screen
// widgets do. Everything talks to the phone through a Termux instance so it can be
// tested with a fake one.
const fs = require('fs');
const path = require('path');
const settingsLib = require('../lib/settings');
const client = require('../lib/client');
const { hasSharedStorage } = require('../lib/pictures');
const { shq } = require('./service');

const JOB_ID = 'bananarama-job';
const MODELS = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'];
const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const SIZES = ['1K', '2K', '4K'];
const TEST_PROMPT = 'a banana doing a victory dance, confetti, cartoon';

const lastFile = () => path.join(path.dirname(settingsLib.settingsPath()), 'last.json');

/**
 * Pull options written inline ("…, 16:9, 2K, pro") out of a description, the way
 * the /image skill does in Claude.
 */
function parseInline(text) {
  const out = { prompt: '' };
  const keep = [];
  for (const raw of String(text).split(',')) {
    const t = raw.trim();
    const low = t.toLowerCase();
    if (RATIOS.includes(low) && !out.aspectRatio) out.aspectRatio = low;
    else if (/^(1k|2k|4k)$/.test(low) && !out.imageSize) out.imageSize = low.toUpperCase();
    else if (/^(pro|lite|flash|original)$/.test(low) && !out.model) out.model = low;
    else if (t) keep.push(t);
  }
  out.prompt = keep.join(', ');
  return out;
}

function remember(result) {
  try { fs.writeFileSync(lastFile(), JSON.stringify({ file: result.file, at: new Date().toISOString() })); } catch { /* not critical */ }
}

function lastImage() {
  try { const j = JSON.parse(fs.readFileSync(lastFile(), 'utf8')); return fs.existsSync(j.file) ? j.file : null; } catch { return null; }
}

/**
 * Generate an image with notifications for progress, the result and errors.
 * @returns {Promise<object|null>} the client result, or null on failure
 */
async function makeImage(t, bin, opts, { generate = client.generate, load = settingsLib.load } = {}) {
  const s = load();
  const b = shq(bin);
  const label = opts.prompt.length > 60 ? opts.prompt.slice(0, 57) + '…' : opts.prompt;
  const progress = content => t.notify({ id: JOB_ID, title: 'Making image…', content, ongoing: true, alertOnce: true, priority: 'low', icon: 'hourglass_empty' });
  if (s.notify) await progress(label);
  let shown = 0;
  try {
    const r = await generate(opts, ev => {
      if (s.notify && ev.type === 'progress' && ev.percent - shown >= 25) { shown = ev.percent; progress(`${label} · ${ev.percent}%`); }
    });
    await t.mediaScan(r.file);
    remember(r);
    if (s.notify) {
      await t.removeNotification(JOB_ID);
      const f = shq(r.file);
      await t.notify({
        id: `bananarama-${Date.now()}`, title: 'Image saved', content: path.basename(r.file), image: r.file,
        icon: 'image', group: 'bananarama-images', action: `termux-open ${f}`,
        buttons: [
          { text: 'Share', action: `termux-share -a send ${f}` },
          { text: 'Edit', action: `${b} edit ${f}` },
          { text: 'New', action: `${b} new` }
        ]
      });
    } else {
      await t.toast(`Saved ${path.basename(r.file)}`);
    }
    return r;
  } catch (e) {
    if (s.notify) await t.removeNotification(JOB_ID);
    const keyProblem = /API key|no API key|HTTP 40[03]/i.test(e.message);
    await t.notify({
      id: 'bananarama-error', title: 'Image failed', content: e.message, icon: 'error',
      buttons: keyProblem ? [{ text: 'Settings', action: `${b} settings` }] : [{ text: 'Try again', action: `${b} new` }]
    });
    return null;
  }
}

/** "New image" button: ask for a description, then make it. */
async function newImage(t, bin, deps) {
  const r = await t.text('New image', { hint: 'Describe it (add 16:9, 2K, pro…)', multiline: true });
  if (!r.ok || !r.text) return null;
  return makeImage(t, bin, parseInline(r.text), deps);
}

/** Text shared to Termux (termux-url-opener). */
async function shareText(t, bin, text, deps) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    await t.toast('Bananarama: share a description, not a link');
    return null;
  }
  return makeImage(t, bin, parseInline(trimmed), deps);
}

/** An image shared to Termux (termux-file-editor) or the notification's Edit button. */
async function editImage(t, bin, file, deps) {
  if (!file || !fs.existsSync(file)) { await t.toast('Bananarama: image not found'); return null; }
  const r = await t.text('Edit image', { hint: 'What should change?', multiline: true });
  if (!r.ok || !r.text) return null;
  return makeImage(t, bin, { ...parseInline(r.text), images: [file] }, deps);
}

async function testKey(key, apiBase, model) {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (res.status === 400 || res.status === 403) return { ok: false, message: 'That key is not valid.' };
  if (!res.ok) return { ok: false, message: `Could not check (HTTP ${res.status}).` };
  const names = ((await res.json()).models || []).map(m => m.name.replace('models/', ''));
  return names.includes(model) ? { ok: true, message: 'Key works ✓' } : { ok: true, message: `Key works, but ${model} is not available to it.` };
}

/** Settings as a list of dialogs (the Android stand-in for the Windows Settings window). */
async function settingsFlow(t, { checkKey = testKey } = {}) {
  for (;;) {
    const s = settingsLib.load();
    const items = [
      `API key: ${s.apiKey ? 'set' : 'NOT SET'}`,
      `Model: ${s.model}`,
      `Aspect ratio: ${s.aspectRatio}`,
      `Image size: ${s.imageSize}`,
      `Save to: ${s.outputDir || 'Pictures'}/${s.outputSubfolder}`,
      `Open in Gallery after saving: ${s.openAfterSave ? 'on' : 'off'}`,
      `Notifications: ${s.notify ? 'on' : 'off'}`,
      'Test key',
      'Done'
    ];
    const pick = await t.choose('Bananarama settings', items, 'sheet');
    if (pick === null || pick === 'Done') return;
    const raw = readRaw();
    const i = items.indexOf(pick);
    if (i === 0) {
      const r = await t.text('Gemini API key', { hint: 'Paste the key from aistudio.google.com/apikey', password: true });
      if (r.ok && r.text) raw.apiKey = r.text.trim();
    } else if (i === 1) {
      const v = await t.choose('Model', MODELS); if (v) raw.model = v;
    } else if (i === 2) {
      const v = await t.choose('Aspect ratio', RATIOS); if (v) raw.aspectRatio = v;
    } else if (i === 3) {
      const v = await t.choose('Image size', SIZES); if (v) raw.imageSize = v;
    } else if (i === 4) {
      const r = await t.text('Subfolder inside Pictures', { hint: s.outputSubfolder || 'Nano' });
      if (r.ok && r.text) raw.outputSubfolder = r.text.replace(/[\\/:*?"<>|]/g, '').trim() || 'Nano';
    } else if (i === 5) {
      raw.openAfterSave = !s.openAfterSave;
    } else if (i === 6) {
      raw.notify = !s.notify;
    } else if (i === 7) {
      if (!s.apiKey) { await t.toast('Set the API key first'); continue; }
      await t.toast('Checking key…');
      try { await t.toast((await checkKey(s.apiKey, s.apiBase, s.model)).message, false); }
      catch (e) { await t.toast(`Could not check: ${e.message}`, false); }
      continue;
    }
    settingsLib.save({ ...settingsLib.DEFAULTS, ...raw });
  }
}

function readRaw() {
  try { return JSON.parse(fs.readFileSync(settingsLib.settingsPath(), 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

/** Health check, printed as ✅/❌ lines (also what the /bananarama skill runs on the phone). */
async function doctor(t, { health, isServiceRunning, fetchKey = testKey, exists = fs.existsSync, home = require('os').homedir() } = {}) {
  const lines = [];
  const check = (ok, label, detail) => lines.push(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  let s;
  try { s = settingsLib.load(); check(true, 'Settings', settingsLib.settingsPath()); }
  catch (e) { check(false, 'Settings', e.message); return lines; }
  check(Number(process.versions.node.split('.')[0]) >= 18, 'Node.js', process.version);
  check(await t.available(), 'Termux:API app', 'needed for notifications and dialogs');
  check(hasSharedStorage(), 'Storage access', hasSharedStorage() ? client.outputDir(s) : 'run: termux-setup-storage');
  check(!!s.apiKey, 'Gemini API key', s.apiKey ? 'set' : 'run: bananarama settings');
  if (s.apiKey) {
    try { const k = await fetchKey(s.apiKey, s.apiBase, s.model); check(k.ok, 'Key test', k.message); }
    catch (e) { check(false, 'Key test', e.message); }
  }
  if (isServiceRunning) check(isServiceRunning(), 'Background service', isServiceRunning() ? 'running' : 'run: bananarama start');
  if (health) { const pid = await health(s.host, s.port); check(pid > 0, 'Middleware', pid > 0 ? `${s.host}:${s.port}` : 'not answering'); }
  check(exists(path.join(home, '.termux', 'boot', 'bananarama')), 'Start at boot', 'Termux:Boot script');
  check(exists(path.join(home, '.claude', 'skills', 'image', 'SKILL.md')), 'Claude Code /image skill', 'optional');
  return lines;
}

module.exports = { parseInline, makeImage, newImage, shareText, editImage, settingsFlow, doctor, testKey, lastImage, remember, lastFile, TEST_PROMPT, JOB_ID, MODELS, RATIOS, SIZES };
