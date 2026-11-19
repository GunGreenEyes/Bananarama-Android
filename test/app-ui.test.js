'use strict';
// The Android app's JavaScript (android/app/src/main/assets/www/app.js): the pure helpers that
// decide what the app shows. The screens themselves are exercised on the emulator in CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../android/app/src/main/assets/www/app.js');
const termux = require('../src/android/actions');

test('app parseInline matches the Termux / Kotlin rules', () => {
  for (const s of ['a fox in a library, 16:9, 2k, pro', 'red, green and blue', '  9:16 , poster ', 'lite, 4K, 21:9, a city', 'Original, 1:1, x']) {
    assert.deepEqual(ui.parseInline(s), termux.parseInline(s), s);
  }
});

test('keyProblem: catches empty, spaced and too-short keys before calling Google', () => {
  assert.match(ui.keyProblem(''), /Paste/);
  assert.match(ui.keyProblem('AIza abc def ghi jkl mno pqr'), /spaces/);
  assert.match(ui.keyProblem('AIza123'), /too short/);
  assert.equal(ui.keyProblem('AIzaSyD-1234567890abcdefghij'), null);
});

test('setupSteps: permission step only where Android needs it', () => {
  assert.deepEqual(ui.setupSteps({ notifications: 'ask', storage: 'ok' }), ['welcome', 'key', 'permissions', 'claude']);
  assert.deepEqual(ui.setupSteps({ notifications: 'granted', storage: 'ok' }), ['welcome', 'key', 'permissions', 'claude']);
  assert.deepEqual(ui.setupSteps({ notifications: 'not-needed', storage: 'ok' }), ['welcome', 'key', 'claude'], 'Android 12 and older');
  assert.deepEqual(ui.setupSteps({ notifications: 'not-needed', storage: 'ask' }), ['welcome', 'key', 'permissions', 'claude'], 'Android 8-9 storage');
});

test('initialView: setup until a key is saved, then what the intent asked for', () => {
  const fresh = { settings: { hasKey: false, setupDone: false } };
  const keyOnly = { settings: { hasKey: true, setupDone: false } };
  const ready = { settings: { hasKey: true, setupDone: true } };
  assert.deepEqual(ui.initialView(fresh, { mode: 'quick', text: 'x' }), { name: 'setup', step: 'welcome' }, 'shared text before setup still goes to setup');
  assert.deepEqual(ui.initialView(keyOnly, null), { name: 'setup', step: 'claude' });
  assert.deepEqual(ui.initialView(ready, null), { name: 'home' });
  assert.deepEqual(ui.initialView(ready, { mode: 'quick' }), { name: 'quick' });
  assert.deepEqual(ui.initialView(ready, { mode: 'edit' }), { name: 'edit' });
  assert.deepEqual(ui.initialView(ready, { mode: 'settings' }), { name: 'settings' });
  assert.deepEqual(ui.initialView(ready, { mode: 'new' }), { name: 'home' });
});

test('esc and model labels', () => {
  assert.equal(ui.esc('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  assert.equal(ui.modelLabel('gemini-3-pro-image'), 'Pro');
  assert.equal(ui.modelLabel('custom-model'), 'custom-model');
  assert.deepEqual(ui.MODELS.map(m => m.id), ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image']);
});
