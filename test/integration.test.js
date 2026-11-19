'use strict';
// End to end against a fake Gemini: client -> middleware -> fake API -> PNG on disk; plus the MCP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setup, sseImage, httpError, PNG_B64 } = require('./helpers');
const { generate } = require('../src/lib/client');

test('integration', async t => {
  const ctx = await setup();
  t.after(() => ctx.close());

  await t.test('saves PNG into <outputDir>\\Nano with the streamed bytes', async () => {
    ctx.gem.behaviour = sseImage({ crlf: true });
    const progress = [];
    const r = await generate({ prompt: 'a banana in sunglasses' }, ev => progress.push(ev));
    assert.equal(path.dirname(r.file), ctx.nanoDir);
    assert.match(path.basename(r.file), /^image_\d{8}-\d{6}_a-banana-in-sunglasses\.png$/);
    assert.deepEqual(fs.readFileSync(r.file), Buffer.from(PNG_B64, 'base64'));
    assert.deepEqual(r.texts, ['Here you go.']);
    assert.equal(r.usage.totalTokenCount, 42);
    assert.ok(progress.some(e => e.type === 'progress' && e.percent === 100));
  });

  await t.test('sends key header, defaults and SSE streaming endpoint to Gemini', async () => {
    ctx.gem.behaviour = sseImage();
    await generate({ prompt: 'defaults' });
    const req = ctx.gem.requests.at(-1);
    assert.equal(req.url, '/v1beta/models/gemini-3.1-flash-image:streamGenerateContent?alt=sse');
    assert.equal(req.headers['x-goog-api-key'], 'test-key');
    assert.deepEqual(req.body.generationConfig.imageConfig, { aspectRatio: '1:1', imageSize: '1K' });
    assert.deepEqual(req.body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    assert.equal(req.body.contents[0].parts[0].text, 'defaults');
  });

  await t.test('per-request options and model aliases override settings', async () => {
    ctx.gem.behaviour = sseImage();
    await generate({ prompt: 'wide', model: 'pro', aspectRatio: '16:9', imageSize: '4k' });
    const req = ctx.gem.requests.at(-1);
    assert.match(req.url, /models\/gemini-3-pro-image:/);
    assert.deepEqual(req.body.generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '4K' });
  });

  await t.test('gemini-2.5 model gets no imageSize', async () => {
    ctx.gem.behaviour = sseImage();
    await generate({ prompt: 'old', model: 'original' });
    assert.deepEqual(ctx.gem.requests.at(-1).body.generationConfig.imageConfig, { aspectRatio: '1:1' });
  });

  await t.test('reference images are sent inline', async () => {
    ctx.gem.behaviour = sseImage();
    const ref = path.join(ctx.dir, 'ref.png'); fs.writeFileSync(ref, Buffer.from(PNG_B64, 'base64'));
    await generate({ prompt: 'edit this', images: [ref] });
    assert.deepEqual(ctx.gem.requests.at(-1).body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: PNG_B64 } });
  });

  await t.test('thought images are skipped, final image saved', async () => {
    ctx.gem.behaviour = sseImage({ thought: true, text: '' });
    const r = await generate({ prompt: 'thinky' });
    assert.deepEqual(fs.readFileSync(r.file), Buffer.from(PNG_B64, 'base64'));
  });

  await t.test('Gemini HTTP errors surface with their message', async () => {
    ctx.gem.behaviour = httpError(400, 'API key not valid.');
    await assert.rejects(generate({ prompt: 'x' }), /Gemini HTTP 400: API key not valid\./);
  });

  await t.test('response without an image is an error', async () => {
    ctx.gem.behaviour = (req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] }, finishReason: 'IMAGE_SAFETY' }] })}\n\n`);
    };
    await assert.rejects(generate({ prompt: 'x' }), /no image returned \(finishReason: IMAGE_SAFETY\)/);
  });

  await t.test('empty prompt is rejected before any request', async () => {
    const n = ctx.gem.requests.length;
    await assert.rejects(generate({ prompt: '   ' }), /description is required/);
    assert.equal(ctx.gem.requests.length, n);
  });

  await t.test('JPEG output is kept as .jpg (no converter on Android)', async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
    ctx.gem.behaviour = sseImage({ b64: jpg.toString('base64'), mimeType: 'image/jpeg' });
    const r = await generate({ prompt: 'jpeg' });
    assert.match(r.file, /.jpg$/);
    assert.equal(r.mimeType, 'image/jpeg');
    assert.deepEqual(fs.readFileSync(r.file), jpg);
  });

  await t.test('CLI prints SAVED path', async () => {
    ctx.gem.behaviour = sseImage();
    const out = await run(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), '--ar', '3:2', 'cli', 'test']);
    assert.equal(out.code, 0, out.stderr);
    const m = out.stdout.match(/^SAVED: (.+)$/m);
    assert.ok(m && fs.existsSync(m[1].trim()));
    assert.equal(path.dirname(m[1].trim()), ctx.nanoDir);
  });

  await t.test('MCP server: initialize, list, call, prompt', async () => {
    ctx.gem.behaviour = sseImage();
    const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp.js')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map(); let buf = '';
    mcp.stdout.on('data', c => {
      buf += c; let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    let next = 1;
    const rpc = (method, params) => new Promise(res => { const id = next++; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      assert.equal(init.result.protocolVersion, '2025-06-18');
      assert.equal(init.result.serverInfo.name, 'bananarama');
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const tools = await rpc('tools/list', {});
      assert.deepEqual(tools.result.tools.map(x => x.name), ['image']);

      const call = await rpc('tools/call', { name: 'image', arguments: { description: 'mcp banana', aspectRatio: '9:16' } });
      assert.ok(!call.result.isError, JSON.stringify(call.result));
      const file = call.result.structuredContent.file;
      assert.equal(path.dirname(file), ctx.nanoDir);
      assert.ok(fs.existsSync(file));
      assert.match(call.result.content[0].text, /^Saved: /);
      assert.equal(call.result.content.find(c => c.type === 'image').data, PNG_B64);
      assert.equal(ctx.gem.requests.at(-1).body.generationConfig.imageConfig.aspectRatio, '9:16');

      const bad = await rpc('tools/call', { name: 'image', arguments: {} });
      assert.equal(bad.result.isError, true);

      const prompts = await rpc('prompts/list', {});
      assert.deepEqual(prompts.result.prompts.map(x => x.name), ['image', 'bananarama']);
      const p = await rpc('prompts/get', { name: 'image', arguments: { description: 'a fox' } });
      assert.match(p.result.messages[0].content.text, /a fox/);
      const check = await rpc('prompts/get', { name: 'bananarama', arguments: {} });
      assert.match(check.result.messages[0].content.text, /Bananarama/);

      const unknown = await rpc('nope', {});
      assert.equal(unknown.error.code, -32601);
    } finally { mcp.kill(); }
  });
});

function run(cmd, args) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { env: process.env });
    let stdout = '', stderr = '';
    p.stdout.on('data', c => stdout += c); p.stderr.on('data', c => stderr += c);
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}
