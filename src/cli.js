#!/usr/bin/env node
'use strict';
// Bananarama CLI: send a description through the middleware to Gemini and
// save the result in <Pictures>/Nano (the phone's Gallery).
//
//   node cli.js [--model M] [--ar 16:9] [--size 2K] [--image ref.jpg]... [--out DIR] <description...>
//
// Prints "SAVED: <path>" on success (exit 0); errors go to stderr (exit 1).
const { generate, outputDir } = require('./lib/client');
const settingsLib = require('./lib/settings');
const pkg = require('../package.json');

function parseArgs(argv) {
  const o = { images: [], words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--model' || a === '-m') o.model = next();
    else if (a === '--ar' || a === '--aspect') o.aspectRatio = next();
    else if (a === '--size') o.imageSize = next().toUpperCase();
    else if (a === '--image' || a === '-i') o.images.push(next());
    else if (a === '--out') o.out = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--where') o.where = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else o.words.push(a);
  }
  o.prompt = o.words.join(' ').trim();
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return console.log(`Bananarama v${pkg.version.split('.')[0]}`);
  if (args.where) return console.log(outputDir(settingsLib.load()));
  if (args.help || !args.prompt) {
    console.log('usage: bananarama [--where] [--version] [--model flash|pro|lite|<id>] [--ar 16:9] [--size 1K|2K|4K] [--image ref.png]... [--out DIR] <description>');
    process.exit(args.help ? 0 : 1);
  }
  let lastPct = -1;
  const r = await generate(args, ev => {
    if (ev.type === 'status') process.stderr.write(`… ${ev.message}\n`);
    else if (ev.type === 'text') process.stderr.write(`model: ${ev.text.trim()}\n`);
    else if (ev.type === 'progress' && ev.percent !== lastPct && (ev.percent === 100 || ev.percent - lastPct >= 25)) {
      lastPct = ev.percent; process.stderr.write(`… receiving ${ev.percent}%\n`);
    }
  });
  console.log(`SAVED: ${r.file}`);
}

if (require.main === module) main().catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
module.exports = { parseArgs };
