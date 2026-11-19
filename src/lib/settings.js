'use strict';
// Settings live in ~/.config/Bananarama/settings.json in Termux (they hold your
// API key). Missing file -> created from defaults. Missing keys -> filled from defaults.
// BANANARAMA_SETTINGS overrides the file location (used by the tests).
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'Bananarama';
const ROOT = path.resolve(__dirname, '..', '..'); // folder holding package.json

function dataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, APP_NAME);
}

const settingsPath = () => process.env.BANANARAMA_SETTINGS || path.join(dataDir(), 'settings.json');
const logPath = () => path.join(path.dirname(settingsPath()), 'server.log');
const legacyPath = () => path.join(ROOT, 'settings.json'); // v1 kept settings next to the code

const DEFAULTS = {
  apiKey: '',                       // or set env GEMINI_API_KEY
  model: 'gemini-3.1-flash-image',  // gemini-3-pro-image | gemini-3.1-flash-lite-image | gemini-2.5-flash-image
  aspectRatio: '1:1',               // 1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9
  imageSize: '1K',                  // 1K | 2K | 4K
  host: '127.0.0.1',
  port: 7861,
  outputDir: '',                    // empty = the phone's shared Pictures folder
  outputSubfolder: 'Nano',          // created inside outputDir; empty = save directly in it
  filenamePrefix: 'image',
  requestTimeoutMs: 180000,
  autoStartServer: true,
  openAfterSave: false,             // open each image in the Gallery after saving
  notify: true,                     // Android notification with the finished image
  wakeLock: true,                   // keep the service alive while the screen is off
  apiBase: 'https://generativelanguage.googleapis.com/v1beta'
};

function parse(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
}

function save(values, file = settingsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function load() {
  const file = settingsPath();
  let user = {};
  if (fs.existsSync(file)) {
    user = parse(file);
  } else {
    const legacy = !process.env.BANANARAMA_SETTINGS && legacyPath();
    user = legacy && fs.existsSync(legacy) ? parse(legacy) : {};
    save({ ...DEFAULTS, ...user }, file);
  }
  const s = { ...DEFAULTS, ...user };
  if (!s.apiKey) s.apiKey = process.env.GEMINI_API_KEY || '';
  return s;
}

module.exports = { load, save, DEFAULTS, settingsPath, logPath, legacyPath, dataDir, ROOT, APP_NAME };
