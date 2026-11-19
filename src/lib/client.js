'use strict';
// Shared client core: talk to the middleware, reassemble the streamed image and
// save it to <Pictures>/Nano. Never writes to stdout (the MCP server uses stdout
// for protocol traffic) - progress goes to onProgress.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const settingsLib = require('./settings');
const { resolvePictures } = require('./pictures');

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic' };

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MODEL_ALIASES = {
  pro: 'gemini-3-pro-image', flash: 'gemini-3.1-flash-image', '2': 'gemini-3.1-flash-image',
  lite: 'gemini-3.1-flash-lite-image', original: 'gemini-2.5-flash-image', '2.5': 'gemini-2.5-flash-image'
};

function request(s, method, urlPath, body, onLine) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: s.host, port: s.port, method, path: urlPath,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim() && onLine) onLine(line); }
      });
      res.on('end', () => { if (buf.trim() && onLine) onLine(buf); resolve({ status: res.statusCode, body: buf }); });
      res.on('error', reject);
    });
    req.setTimeout(s.requestTimeoutMs + 15000, () => req.destroy(new Error('middleware timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const healthy = s => request(s, 'GET', '/health').then(r => r.status === 200 && r.body.includes('Bananarama'), () => false);

async function ensureServer(s) {
  if (await healthy(s)) return;
  if (!s.autoStartServer) throw new Error(`middleware not running on ${s.host}:${s.port} (start Bananarama from the Start menu)`);
  fs.mkdirSync(path.dirname(settingsLib.logPath()), { recursive: true });
  const log = fs.openSync(settingsLib.logPath(), 'a');
  spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
    { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env }).unref();
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); if (await healthy(s)) return; }
  throw new Error(`middleware failed to start; see ${settingsLib.logPath()}`);
}

function isPng(buf) { return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG); }

/** File extension for the bytes we got: trust the PNG signature, else the mime type. Android has no converter, so the image is kept as sent. */
function extensionFor(buf, mimeType) {
  if (isPng(buf)) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  return EXT[String(mimeType).toLowerCase()] || '.png';
}

function outputDir(s, override) {
  if (override) return override;
  const base = s.outputDir || resolvePictures();
  return s.outputSubfolder ? path.join(base, s.outputSubfolder) : base;
}

function outPath(dir, prefix, prompt, now = new Date(), ext = '.png') {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'image';
  let f = path.join(dir, `${prefix}_${stamp}_${slug}${ext}`);
  for (let n = 2; fs.existsSync(f); n++) f = path.join(dir, `${prefix}_${stamp}_${slug}_${n}${ext}`);
  return f;
}

function resolveModel(m) { return m ? (MODEL_ALIASES[String(m).toLowerCase()] || m) : undefined; }

function loadImages(paths = []) {
  return paths.map(f => {
    const mimeType = MIME[path.extname(f).toLowerCase()];
    if (!mimeType) throw new Error(`unsupported reference image type: ${f}`);
    if (!fs.existsSync(f)) throw new Error(`reference image not found: ${f}`);
    return { mimeType, data: fs.readFileSync(f).toString('base64') };
  });
}

/**
 * Generate an image and save it (PNG unless the model sent another format).
 * @param {{prompt:string, model?:string, aspectRatio?:string, imageSize?:string, images?:string[], out?:string}} opts
 * @param {(ev:{type:string,message?:string,text?:string,percent?:number})=>void} [onProgress]
 * @returns {Promise<{file:string, bytes:number, mimeType:string, texts:string[], model:string, usage:object}>}
 */
async function generate(opts, onProgress = () => {}) {
  const prompt = (opts.prompt || '').trim();
  if (!prompt) throw new Error('a description is required');
  const s = settingsLib.load();
  const images = loadImages(opts.images);
  await ensureServer(s);

  const chunks = []; const texts = []; let mimeType = 'image/png'; let error = null;
  let received = 0, expected = 0, done = {};
  const body = JSON.stringify({ prompt, model: resolveModel(opts.model), aspectRatio: opts.aspectRatio,
    imageSize: opts.imageSize && String(opts.imageSize).toUpperCase(), images });
  await request(s, 'POST', '/imagine', body, line => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    switch (ev.type) {
      case 'status': onProgress({ type: 'status', message: ev.message }); break;
      case 'text': texts.push(ev.text); onProgress({ type: 'text', text: ev.text }); break;
      case 'image_start': chunks.length = 0; received = 0; mimeType = ev.mimeType; expected = ev.bytes; break;
      case 'image_chunk': chunks.push(ev.data); received += ev.data.length * 3 / 4;
        if (expected) onProgress({ type: 'progress', percent: Math.min(100, Math.round(received / expected * 100)) }); break;
      case 'error': error = ev.message; break;
      case 'done': done = ev; break;
    }
  });
  if (!chunks.length) throw new Error(error || 'no image received');

  const buf = Buffer.from(chunks.join(''), 'base64');
  const dir = outputDir(s, opts.out);
  fs.mkdirSync(dir, { recursive: true });
  const file = outPath(dir, s.filenamePrefix, prompt, new Date(), extensionFor(buf, mimeType));
  fs.writeFileSync(file, buf);
  if (s.openAfterSave) {
    try { spawn('termux-open', [file], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* not in Termux */ }
  }
  return { file, bytes: buf.length, mimeType, texts, model: done.model, usage: done.usage };
}

module.exports = { generate, outputDir, outPath, extensionFor, isPng, resolveModel, loadImages, MODEL_ALIASES };
