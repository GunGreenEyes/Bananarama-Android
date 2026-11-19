#!/usr/bin/env node
'use strict';
// Whole-number releases: v2, v3, v4 ...
//
//   npm run release            release the next version (or the current one if it was never tagged)
//   npm run release -- --dry   show what would happen
//
// Sets package.json to "<N>.0.0", commits "Release vN", tags vN and pushes. The tag triggers
// .github/workflows/release.yml, which publishes the GitHub release that phones install.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');

/** Next whole-number version: the current major if it has no tag yet, otherwise one past the highest tag. */
function nextVersion(currentMajor, tags) {
  const released = tags.map(t => /^v(\d+)$/.exec(t.trim())).filter(Boolean).map(m => Number(m[1]));
  if (!released.includes(currentMajor) && released.every(n => n < currentMajor)) return currentMajor;
  return Math.max(currentMajor, ...released) + 1;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function main() {
  const dry = process.argv.includes('--dry');
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const current = Number(pkg.version.split('.')[0]);
  if (git('status', '--porcelain')) throw new Error('commit or stash your changes first');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Error(`release from main (you are on ${branch})`);
  try { git('fetch', '--tags', '--quiet'); } catch { /* offline: use local tags */ }
  const n = nextVersion(current, git('tag', '--list', 'v*').split('\n'));
  const tag = `v${n}`;
  console.log(`releasing Bananarama for Android ${tag}${dry ? ' (dry run)' : ''}`);
  if (dry) return;
  if (n !== current) {
    pkg.version = `${n}.0.0`;
    fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
    git('commit', '-am', `Release ${tag}`);
  }
  git('tag', '-a', tag, '-m', `Bananarama ${tag}`);
  git('push', 'origin', 'HEAD');
  git('push', 'origin', tag);
  console.log(`pushed ${tag}; GitHub Actions is publishing the release: https://github.com/GunGreenEyes/Bananarama-Android/actions`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
}
module.exports = { nextVersion };
