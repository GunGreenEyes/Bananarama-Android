/* Bananarama for Android - the app's screens (plain JavaScript, no libraries).
 *
 * Talks to the native side through window.Android (MainActivity.Bridge). In a normal browser a
 * mock bridge is used so the UI can be previewed and tested. The native side calls back into
 * window.bananarama: onIntent (something was shared/selected/tapped), onJob (image progress),
 * resolve (async answers), back (system back button), onResume.
 */
(function (root) {
  'use strict';

  // ---------- pure helpers (also exported for the Node tests) ----------

  var RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
  var SIZES = ['1K', '2K', '4K'];
  var MODELS = [
    { id: 'gemini-3.1-flash-image', label: 'Flash', hint: 'Fast, great all-round (Nano Banana 2)' },
    { id: 'gemini-3-pro-image', label: 'Pro', hint: 'Best quality and text in images' },
    { id: 'gemini-3.1-flash-lite-image', label: 'Lite', hint: 'Cheapest and quickest' },
    { id: 'gemini-2.5-flash-image', label: 'Original', hint: 'The first Nano Banana' }
  ];
  var CLAUDE_PKG = 'com.anthropic.claude';
  var KEY_URL = 'https://aistudio.google.com/apikey';
  var TEST_PROMPT = 'a banana doing a victory dance, confetti, cartoon';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** "a fox, 16:9, 2k, pro" -> {prompt:'a fox', aspectRatio:'16:9', imageSize:'2K', model:'pro'} (same rules as the app's Kotlin core). */
  function parseInline(text) {
    var out = { prompt: '' }, keep = [];
    String(text || '').split(',').forEach(function (raw) {
      var t = raw.trim(), low = t.toLowerCase();
      if (!out.aspectRatio && RATIOS.indexOf(low) >= 0) out.aspectRatio = low;
      else if (!out.imageSize && /^(1k|2k|4k)$/.test(low)) out.imageSize = low.toUpperCase();
      else if (!out.model && /^(pro|lite|flash|original)$/.test(low)) out.model = low;
      else if (t) keep.push(t);
    });
    out.prompt = keep.join(', ');
    return out;
  }

  /** Light sanity check before calling Google: real keys are long and have no spaces. */
  function keyProblem(key) {
    var k = String(key || '').trim();
    if (!k) return 'Paste your key first.';
    if (/\s/.test(k)) return 'Keys don’t contain spaces - check what you pasted.';
    if (k.length < 20) return 'That looks too short to be a Gemini API key.';
    return null;
  }

  function modelLabel(id) {
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i].label;
    return id;
  }

  /** Which setup steps this phone needs (notifications only on Android 13+, storage only on 8-9). */
  function setupSteps(state) {
    var steps = ['welcome', 'key'];
    if (state.notifications !== 'not-needed' || state.storage === 'ask') steps.push('permissions');
    steps.push('claude');
    return steps;
  }

  /** First screen for a launch: the setup wizard until a key is saved, else what the intent asks for. */
  function initialView(state, payload) {
    if (!state.settings.hasKey || !state.settings.setupDone) return { name: 'setup', step: state.settings.hasKey ? 'claude' : 'welcome' };
    if (payload && payload.mode === 'quick') return { name: 'quick' };
    if (payload && payload.mode === 'edit') return { name: 'edit' };
    if (payload && payload.mode === 'settings') return { name: 'settings' };
    return { name: 'home' };
  }

  var helpers = { RATIOS: RATIOS, SIZES: SIZES, MODELS: MODELS, esc: esc, parseInline: parseInline, keyProblem: keyProblem,
    modelLabel: modelLabel, setupSteps: setupSteps, initialView: initialView, TEST_PROMPT: TEST_PROMPT };

  if (typeof module !== 'undefined' && module.exports) { module.exports = helpers; }
  if (typeof document === 'undefined') return;

  // ---------- bridge (real or mock) ----------

  var A = root.Android || mockBridge();
  var callbacks = {}, nextCb = 1;
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve) {
      var id = 'cb' + (nextCb++);
      callbacks[id] = resolve;
      A[fn].apply(A, args.concat([id]));
    });
  }
  function getState() { return JSON.parse(A.state()); }

  // ---------- app state ----------

  var S = {
    state: getState(),
    view: { name: 'home' },
    payload: null,            // what the current intent brought (text / image)
    draft: { prompt: '', aspectRatio: '', imageSize: '', model: '', refUri: '', refThumb: '' },
    jobs: [],                 // newest first: {id, prompt, status, thumb, uri, error, done}
    recent: null,
    keyCheck: null,           // {kind, message} | {busy:true}
    keyDraft: '',
    showKey: false
  };
  S.view = initialView(S.state, null);

  var app = document.getElementById('app');

  var ICON = {
    banana: '<svg class="banana" viewBox="0 0 108 108" aria-hidden="true"><path fill="#FFD43B" stroke="#5A4100" stroke-width="2.6" stroke-linejoin="round" d="M36,32.4 C22.5,59.7 44.7,84.5 81.9,71.6 C71.6,66.4 50.9,71.6 45.8,35.4 Z"/><path stroke="#fff" stroke-opacity=".6" stroke-width="1.8" stroke-linecap="round" fill="none" d="M37,44.7 C32.9,62.3 45.8,74.7 64.9,76.2"/><path stroke="#6B4A1F" stroke-width="3.6" stroke-linecap="round" d="M37.5,24.6 L40.6,34.4"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>'
  };

  function header(title, withBack) {
    return '<header class="top">' +
      (withBack ? '<button class="icon-btn" data-act="home" aria-label="Back">' + ICON.back + '</button>' : '<div class="brand">' + ICON.banana + 'Bananarama</div>') +
      (title ? '<div class="brand" style="font-size:17px">' + esc(title) + '</div>' : '') +
      (withBack ? '<span style="width:44px"></span>' : '<button class="icon-btn" data-act="settings" aria-label="Settings">' + ICON.gear + '</button>') +
      '</header>';
  }

  // ---------- views ----------

  function vSetup() {
    var steps = setupSteps(S.state), i = Math.max(0, steps.indexOf(S.view.step)), step = steps[i];
    var bar = '<div class="steps" aria-label="Step ' + (i + 1) + ' of ' + steps.length + '">' + steps.map(function (_, n) { return '<i class="' + (n <= i ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    var body = '';
    if (step === 'welcome') {
      body = '<div class="hero-banana">' + ICON.banana.replace('class="banana"', 'class="hero-banana"') + '</div>' +
        '<h1>Make pictures from Claude</h1>' +
        '<p class="muted">Bananarama turns any text into an image with Google’s Nano Banana. Select text in Claude, tap <b>Make image</b>, and the picture lands in your Gallery.</p>' +
        '<p class="muted">Setup takes a minute. You’ll need a free Gemini API key from Google.</p>' +
        '<div class="sticky-bottom"><button class="btn primary block" data-act="next">Get started</button></div>';
    } else if (step === 'key') {
      var kc = S.keyCheck;
      body = '<h1>Your Gemini API key</h1>' +
        '<p class="muted">Bananarama talks to Google directly with your own key. It stays on this phone.</p>' +
        '<div class="card stack">' +
          '<button class="btn block" data-act="get-key">1. Get a free key from Google ↗</button>' +
          '<p class="muted small" style="margin:0">Sign in, tap <b>Create API key</b>, copy it, then come back here.</p>' +
          '<label class="field" style="margin:4px 0 0">2. Paste it here' +
            '<input id="key" class="key-input" type="' + (S.showKey ? 'text' : 'password') + '" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="AIza…" value="' + esc(S.keyDraft) + '">' +
          '</label>' +
          '<label class="row small"><input type="checkbox" id="showkey" ' + (S.showKey ? 'checked' : '') + '> Show key</label>' +
        '</div>' +
        (kc ? '<p class="msg ' + (kc.busy ? '' : (kc.kind === 'ok' || kc.kind === 'model' ? 'ok' : 'err')) + '">' + (kc.busy ? '<span class="status"><span class="spinner"></span>Checking with Google…</span>' : esc(kc.message)) + '</p>' : '') +
        (kc && kc.kind === 'model' ? '<p class="muted small">You can still continue; pick another model in Settings.</p>' : '') +
        '<p class="muted small">Making images needs billing turned on for the key’s Google Cloud project. Google charges a few cents per image.</p>' +
        '<div class="sticky-bottom"><button class="btn primary block" data-act="check-key" ' + (kc && kc.busy ? 'disabled' : '') + '>Check key and continue</button></div>';
    } else if (step === 'permissions') {
      var st = S.state;
      var need = st.notifications === 'ask' || st.storage === 'ask';
      body = '<h1>Get your pictures</h1>' +
        '<p class="muted">When an image is ready, Bananarama shows it in a notification with <b>Share</b> and <b>Edit</b> buttons, even if you’ve gone back to Claude.</p>' +
        '<div class="card"><div class="status">' + (need ? '🔔' : '<span class="ok">✓</span>') + '<div>' +
          (need ? 'Allow notifications' + (st.storage === 'ask' ? ' and saving to Pictures' : '') : 'All set') + '</div></div></div>' +
        '<div class="sticky-bottom stack">' +
          (need ? '<button class="btn primary block" data-act="allow">Allow</button><button class="btn block" data-act="next">Not now</button>'
                : '<button class="btn primary block" data-act="next">Continue</button>') +
        '</div>';
    } else {
      body = '<h1>Use it from Claude</h1>' +
        '<p class="muted">Bananarama plugs into Android, so it works from the Claude app (and anywhere else):</p>' + howTo(true) +
        '<div class="sticky-bottom stack">' +
          '<button class="btn primary block" data-act="finish-test">Make my first image</button>' +
          '<button class="btn block" data-act="finish">Done</button>' +
        '</div>';
    }
    return '<header class="top"><div class="brand">' + ICON.banana + 'Bananarama</div></header>' + bar + body;
  }

  function howTo(withButtons) {
    var st = S.state, hasClaude = A.isInstalled && A.isInstalled(CLAUDE_PKG);
    return '<div class="how">' +
      '<div class="card"><b class="t">✂️ Select text → Make image</b><span class="muted small">In Claude, long-press a reply, select the description, then tap <b>Make image</b> (or ⋮ → Make image).</span></div>' +
      '<div class="card"><b class="t">↗️ Share → Bananarama</b><span class="muted small">Share any text to Bananarama. Share a photo to edit it.</span></div>' +
      '<div class="card"><b class="t">⚡ Quick Settings tile</b><span class="muted small">Pull down twice and tap <b>New image</b>.</span>' +
        (withButtons && st.canAddTile ? '<div class="row" style="margin-top:10px"><button class="btn" data-act="add-tile">Add the tile</button></div>' : '') + '</div>' +
      '<div class="card"><b class="t">🏠 Home-screen shortcut</b><span class="muted small">Long-press the Bananarama icon → <b>New image</b>.</span>' +
        (withButtons && st.canPinShortcut ? '<div class="row" style="margin-top:10px"><button class="btn" data-act="pin">Add to home screen</button></div>' : '') + '</div>' +
      (withButtons ? '<div class="row"><button class="btn" data-act="open-claude">' + (hasClaude ? 'Open Claude' : 'Get the Claude app') + '</button></div>' : '') +
      '</div>';
  }

  function optionChips() {
    var d = S.draft, s = S.state.settings;
    var ratio = d.aspectRatio || s.aspectRatio, size = d.imageSize || s.imageSize, model = d.model || s.model;
    return '<div class="chips">' +
      '<select class="chip" id="ratio" aria-label="Aspect ratio">' + RATIOS.map(function (r) { return '<option ' + (r === ratio ? 'selected' : '') + '>' + r + '</option>'; }).join('') + '</select>' +
      '<select class="chip" id="size" aria-label="Size">' + SIZES.map(function (r) { return '<option ' + (r === size ? 'selected' : '') + '>' + r + '</option>'; }).join('') + '</select>' +
      MODELS.slice(0, 3).map(function (m) { return '<button class="chip" data-model="' + m.id + '" aria-pressed="' + (m.id === model) + '" title="' + esc(m.hint) + '">' + m.label + '</button>'; }).join('') +
      '</div>';
  }

  function refBlock() {
    var d = S.draft;
    if (d.refUri) return '<div class="ref card" style="margin:10px 0">' + (d.refThumb ? '<img src="' + esc(d.refThumb) + '" alt="Reference image">' : '') +
      '<div class="grow small">Editing this image</div><button class="btn" data-act="clear-ref" aria-label="Remove reference image">✕</button></div>';
    return '<button class="link small" data-act="pick-ref" style="margin:8px 0">+ Add a reference image</button>';
  }

  function jobCard(j) {
    var body;
    if (j.error) body = '<p class="err msg">' + esc(j.error) + '</p>';
    else if (j.done) body = (j.thumb ? '<img src="' + esc(j.thumb) + '" alt="' + esc(j.prompt) + '">' : '') +
      '<div class="row"><button class="btn" data-act="open" data-uri="' + esc(j.uri) + '">Open</button><button class="btn" data-act="share" data-uri="' + esc(j.uri) + '">Share</button>' +
      '<button class="btn" data-act="edit" data-uri="' + esc(j.uri) + '" data-thumb="' + esc(j.thumb || '') + '">Edit</button></div>';
    else body = '<div class="status"><span class="spinner"></span><span class="muted small">' + esc(j.status || 'Starting…') + '</span></div>';
    return '<div class="card job"><b>' + esc(j.prompt) + '</b>' + body + '</div>';
  }

  function vHome() {
    var d = S.draft;
    var recent = S.recent;
    return header() +
      '<label class="field">Describe your image<textarea id="prompt" placeholder="a banana-shaped hot air balloon at sunrise">' + esc(d.prompt) + '</textarea></label>' +
      optionChips() + refBlock() +
      '<button class="btn primary block" data-act="make">Make it</button>' +
      S.jobs.map(jobCard).join('') +
      '<h2>Recent</h2>' +
      (recent === null ? '<div class="status muted small"><span class="spinner"></span>Loading…</div>'
        : recent.length ? '<div class="grid">' + recent.map(function (r) {
            return '<button data-act="open" data-uri="' + esc(r.uri) + '" aria-label="' + esc(r.name) + '"><img data-thumb="' + esc(r.uri) + '" alt=""></button>';
          }).join('') + '</div>'
        : '<div class="card empty muted small">Your images will show up here and in Gallery → Pictures → ' + esc(S.state.settings.subfolder) + '.</div>');
  }

  function vQuick() {
    var d = S.draft, started = S.jobs[0] && S.view.started;
    if (started) {
      return '<header class="top"><div class="brand">' + ICON.banana + 'Bananarama</div></header>' +
        '<div class="card"><div class="status"><span class="spinner"></span><div><b>Making it…</b><div class="muted small">You’ll get a notification with the picture. You can go back to what you were doing.</div></div></div></div>' +
        '<button class="btn primary block" data-act="back-to-app">Back</button>';
    }
    return '<header class="top"><div class="brand">' + ICON.banana + 'Make image</div><button class="icon-btn" data-act="back-to-app" aria-label="Close">✕</button></header>' +
      '<label class="field">Description<textarea id="prompt">' + esc(d.prompt) + '</textarea></label>' +
      optionChips() +
      '<div class="sticky-bottom"><button class="btn primary block" data-act="make">Make it</button></div>';
  }

  function vEdit() {
    var d = S.draft;
    return header('Edit image', true) +
      (d.refThumb ? '<img src="' + esc(d.refThumb) + '" alt="The image to edit" style="width:100%;border-radius:14px;display:block;margin:6px 0">' : '') +
      '<label class="field">What should change?<textarea id="prompt" placeholder="add a tiny crown, make it sunset">' + esc(d.prompt) + '</textarea></label>' +
      optionChips() +
      '<button class="btn primary block" data-act="make">Make it</button>' + S.jobs.slice(0, 1).map(jobCard).join('');
  }

  function vSettings() {
    var s = S.state.settings, st = S.state, kc = S.keyCheck;
    var termuxCmd = 'curl -fsSL https://raw.githubusercontent.com/GunGreenEyes/Bananarama-Android/main/install.sh | bash';
    return header('Settings', true) +
      '<h2>Gemini API key</h2><div class="card stack">' +
        '<div class="row"><span class="grow kbd">' + esc(s.keyHint || 'not set') + '</span><button class="btn" data-act="get-key">Get a key ↗</button></div>' +
        '<input id="key" class="key-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste a new key to replace it" value="' + esc(S.keyDraft) + '">' +
        '<button class="btn" data-act="check-key">Check and save</button>' +
        (kc ? '<p class="msg ' + (kc.busy ? '' : (kc.kind === 'ok' || kc.kind === 'model' ? 'ok' : 'err')) + '">' + (kc.busy ? 'Checking…' : esc(kc.message)) + '</p>' : '') +
      '</div>' +
      '<h2>Defaults</h2><div class="card">' +
        '<label class="field">Model<select id="s-model">' + MODELS.map(function (m) { return '<option value="' + m.id + '" ' + (m.id === s.model ? 'selected' : '') + '>' + m.label + ' - ' + esc(m.hint) + '</option>'; }).join('') + '</select></label>' +
        '<div class="row"><label class="field grow">Aspect ratio<select id="s-ratio">' + RATIOS.map(function (r) { return '<option ' + (r === s.aspectRatio ? 'selected' : '') + '>' + r + '</option>'; }).join('') + '</select></label>' +
        '<label class="field grow">Size<select id="s-size">' + SIZES.map(function (r) { return '<option ' + (r === s.imageSize ? 'selected' : '') + '>' + r + '</option>'; }).join('') + '</select></label></div>' +
        '<label class="field">Folder in Pictures<input id="s-folder" type="text" value="' + esc(s.subfolder) + '"></label>' +
      '</div>' +
      '<h2>Notifications</h2><div class="card">' +
        toggle('s-notify', 'Show finished images in a notification', s.notify) +
        (st.notifications === 'ask' ? '<button class="btn" data-act="allow">Allow notifications</button>' : '') +
        '<hr class="divider">' + toggle('s-confirm', 'Confirm before making images from shared or selected text', s.confirmShares) +
      '</div>' +
      '<h2>Use with Claude</h2>' + howTo(true) +
      '<h2>Claude Code in Termux <span class="muted small">(optional)</span></h2><div class="card">' +
        '<p class="muted small">Turn this on to let <b>Claude Code</b> running in Termux use <span class="kbd">/image</span> through this app. It listens on 127.0.0.1 only.</p>' +
        toggle('s-api', 'Claude Code link' + (st.apiRunning ? ' (on, port ' + s.port + ')' : ''), s.localApi) +
        '<label class="field">Port<input id="s-port" type="number" min="1024" max="65535" value="' + esc(s.port) + '"></label>' +
        '<p class="muted small">Then, in Termux, install the /image command once:</p><p class="kbd">' + esc(termuxCmd) + '</p>' +
        '<button class="btn" data-act="copy" data-text="' + esc(termuxCmd) + '">Copy command</button>' +
        (st.batteryUnrestricted ? '' : '<p class="muted small" style="margin-top:12px">Galaxy phones may pause the link in the background:</p><button class="btn" data-act="battery">Let it run in the background</button>') +
      '</div>' +
      '<p class="muted small" style="margin-top:20px">Bananarama ' + esc(st.version) + ' · ' + esc(st.device || '') + ' · <a href="https://gungreeneyes.github.io/Bananarama-Android/">Website</a></p>';
  }

  function toggle(id, label, on) {
    return '<label class="switch"><span>' + esc(label) + '</span><input type="checkbox" role="switch" id="' + id + '" ' + (on ? 'checked' : '') + '></label>';
  }

  function render() {
    var v = S.view.name;
    var html = v === 'setup' ? vSetup() : v === 'quick' ? vQuick() : v === 'edit' ? vEdit() : v === 'settings' ? vSettings() : vHome();
    var active = document.activeElement && document.activeElement.id;
    app.innerHTML = html;
    if (active && document.getElementById(active)) document.getElementById(active).focus();
    if (v === 'home') loadThumbs();
  }

  function loadThumbs() {
    if (S.recent === null) {
      setTimeout(function () { S.recent = JSON.parse(A.recent(24)); render(); }, 0);
      return;
    }
    var imgs = app.querySelectorAll('img[data-thumb]');
    imgs.forEach(function (img) { var t = A.thumb(img.getAttribute('data-thumb')); if (t) img.src = t; });
  }

  // ---------- actions ----------

  function go(view) { S.view = view; S.keyCheck = null; window.scrollTo(0, 0); render(); }

  function readDraft() {
    var p = document.getElementById('prompt'); if (p) S.draft.prompt = p.value;
    var r = document.getElementById('ratio'); if (r) S.draft.aspectRatio = r.value;
    var z = document.getElementById('size'); if (z) S.draft.imageSize = z.value;
    var k = document.getElementById('key'); if (k) S.keyDraft = k.value;
  }

  /** @param {boolean} [useDraft] true when the prompt was set in code (test image, auto-share), not typed into the page */
  function make(useDraft) {
    if (useDraft !== true) readDraft();
    var d = S.draft;
    if (!d.prompt.trim()) { A.toast('Describe the image first'); return; }
    var r = JSON.parse(A.generate(JSON.stringify({ prompt: d.prompt, aspectRatio: d.aspectRatio, imageSize: d.imageSize, model: d.model, refUri: d.refUri })));
    if (r.error) { A.toast(r.error); return; }
    S.jobs.unshift({ id: r.id, prompt: r.prompt, status: 'Starting…' });
    if (S.view.name === 'quick') { S.view.started = true; render(); setTimeout(function () { A.close(); }, 1400); return; }
    S.draft.prompt = ''; S.draft.refUri = ''; S.draft.refThumb = '';
    render();
  }

  function checkKey(thenStep) {
    readDraft();
    var problem = keyProblem(S.keyDraft);
    if (problem) { S.keyCheck = { kind: 'invalid', message: problem }; render(); return; }
    S.keyCheck = { busy: true }; render();
    call('checkKey', S.keyDraft.trim(), S.state.settings.model).then(function (res) {
      res = typeof res === 'string' ? JSON.parse(res) : res;
      S.keyCheck = res;
      if (res.kind === 'ok' || res.kind === 'model') {
        A.setApiKey(S.keyDraft.trim());
        S.keyDraft = '';
        S.state = getState();
        if (thenStep) { setTimeout(function () { nextStep(); }, res.kind === 'ok' ? 600 : 1600); }
      }
      render();
    });
  }

  function nextStep() {
    var steps = setupSteps(S.state), i = steps.indexOf(S.view.step);
    if (i < steps.length - 1) go({ name: 'setup', step: steps[i + 1] });
  }

  function finishSetup(test) {
    A.saveSettings(JSON.stringify({ setupDone: true }));
    S.state = getState();
    go({ name: 'home' });
    if (test) { S.draft.prompt = TEST_PROMPT; make(true); }
  }

  function saveSetting(id, el) {
    var map = { 's-model': 'model', 's-ratio': 'aspectRatio', 's-size': 'imageSize', 's-folder': 'subfolder', 's-notify': 'notify', 's-confirm': 'confirmShares', 's-port': 'port' };
    if (id === 's-api') { S.state = JSON.parse(A.setLocalApi(el.checked, Number(document.getElementById('s-port').value) || 7861)); setTimeout(function () { S.state = getState(); render(); }, 800); return; }
    if (!map[id]) return;
    var o = {}; o[map[id]] = el.type === 'checkbox' ? el.checked : (id === 's-port' ? Number(el.value) : el.value);
    A.saveSettings(JSON.stringify(o));
    S.state = getState();
    if (id === 's-folder') S.recent = null;
  }

  app.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-model]');
    if (!t) return;
    if (t.hasAttribute('data-model')) { readDraft(); S.draft.model = t.getAttribute('data-model'); render(); return; }
    var act = t.getAttribute('data-act');
    switch (act) {
      case 'next': nextStep(); break;
      case 'get-key': A.openUrl(KEY_URL); break;
      case 'check-key': checkKey(S.view.name === 'setup'); break;
      case 'allow': call('requestNotifications').then(function (st) { S.state = typeof st === 'string' ? JSON.parse(st) : st; if (S.view.name === 'setup') nextStep(); else render(); }); break;
      case 'add-tile': call('addTile').then(function () { A.toast('Look for “New image” in Quick Settings'); }); break;
      case 'pin': A.pinShortcut(); break;
      case 'open-claude': A.openApp(CLAUDE_PKG); break;
      case 'finish': finishSetup(false); break;
      case 'finish-test': finishSetup(true); break;
      case 'settings': go({ name: 'settings' }); break;
      case 'home': go({ name: 'home' }); break;
      case 'make': make(false); break;
      case 'pick-ref': readDraft(); call('pickImage').then(function (r) { r = typeof r === 'string' ? JSON.parse(r) : r; if (r) { S.draft.refUri = r.uri; S.draft.refThumb = r.thumb || ''; } render(); }); break;
      case 'clear-ref': readDraft(); S.draft.refUri = ''; S.draft.refThumb = ''; render(); break;
      case 'open': A.open(t.getAttribute('data-uri')); break;
      case 'share': A.share(t.getAttribute('data-uri')); break;
      case 'edit': S.draft = { prompt: '', aspectRatio: '', imageSize: '', model: '', refUri: t.getAttribute('data-uri'), refThumb: t.getAttribute('data-thumb') }; go({ name: 'edit' }); break;
      case 'back-to-app': A.close(); go({ name: 'home' }); break;
      case 'battery': A.requestBatteryUnrestricted(); break;
      case 'copy': A.copy(t.getAttribute('data-text')); break;
    }
  });

  app.addEventListener('change', function (e) {
    var el = e.target;
    if (el.id === 'showkey') { readDraft(); S.showKey = el.checked; render(); return; }
    if (el.id && el.id.indexOf('s-') === 0) { saveSetting(el.id, el); if (el.id !== 's-folder' && el.id !== 's-port') render(); }
  });

  // ---------- called by the native side ----------

  root.bananarama = {
    onIntent: function (p) {
      S.payload = p;
      S.state = getState();
      if (p.mode === 'quick' || p.mode === 'new') {
        var parsed = parseInline(p.text || '');
        S.draft = { prompt: parsed.prompt || p.text || '', aspectRatio: parsed.aspectRatio || '', imageSize: parsed.imageSize || '',
          model: parsed.model ? ({ pro: 'gemini-3-pro-image', lite: 'gemini-3.1-flash-lite-image', flash: 'gemini-3.1-flash-image', original: 'gemini-2.5-flash-image' })[parsed.model] : '', refUri: '', refThumb: '' };
      } else if (p.mode === 'edit') {
        S.draft = { prompt: '', aspectRatio: '', imageSize: '', model: '', refUri: p.uri, refThumb: p.thumb || '' };
      }
      var v = initialView(S.state, p);
      if (v.name !== 'setup' && p.mode === 'quick' && !S.state.settings.confirmShares && S.draft.prompt) { S.view = { name: 'quick' }; make(true); return; }
      if (v.name === 'quick') v.started = false;
      go(v);
      var ta = document.getElementById('prompt');
      if (ta && (p.mode === 'new' || p.mode === 'edit')) ta.focus();
    },
    onJob: function (ev) {
      var j = S.jobs.filter(function (x) { return x.id === ev.id; })[0];
      if (!j) { j = { id: ev.id, prompt: ev.prompt || 'Image' }; S.jobs.unshift(j); }
      if (ev.type === 'status') j.status = /thinking/.test(ev.message) ? 'Thinking…' : 'Asking Google…';
      else if (ev.type === 'bytes') j.status = 'Receiving ' + (ev.received / 1048576).toFixed(1) + ' MB…';
      else if (ev.type === 'done') { j.done = true; j.uri = ev.uri; j.thumb = ev.thumb; S.recent = null; if (S.state.settings.openAfterSave) A.open(ev.uri); }
      else if (ev.type === 'error') j.error = ev.message;
      if (S.view.name !== 'setup' && S.view.name !== 'settings' && !(S.view.name === 'quick' && S.view.started)) render();
    },
    resolve: function (id, value) { var cb = callbacks[id]; delete callbacks[id]; if (cb) cb(value); },
    back: function () {
      if (S.view.name === 'setup') { var steps = setupSteps(S.state), i = steps.indexOf(S.view.step); if (i > 0) { go({ name: 'setup', step: steps[i - 1] }); return true; } return false; }
      if (S.view.name === 'quick') { A.close(); return true; }
      if (S.view.name !== 'home') { go({ name: 'home' }); return true; }
      return false;
    },
    onResume: function () { S.state = getState(); if (S.view.name === 'home') { S.recent = null; } if (S.view.name !== 'setup' || S.view.step === 'permissions') render(); }
  };

  render();

  // ---------- browser preview: a fake phone ----------

  function mockBridge() {
    var store = { hasKey: false, keyHint: '', model: 'gemini-3.1-flash-image', aspectRatio: '1:1', imageSize: '1K', subfolder: 'Nano',
      notify: true, openAfterSave: false, confirmShares: true, localApi: false, port: 7861, setupDone: false };
    if (/[?&]ready/.test(location.search)) { store.hasKey = true; store.keyHint = 'AIza••••Xk3Q'; store.setupDone = true; }
    var MOCK_IMG = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20108%20108%22%3E%3Crect%20width%3D%22108%22%20height%3D%22108%22%20fill%3D%22%232b2a24%22%2F%3E%3Cpath%20fill%3D%22%23FFD43B%22%20stroke%3D%22%235A4100%22%20stroke-width%3D%222.6%22%20d%3D%22M36%2C32.4%20C22.5%2C59.7%2044.7%2C84.5%2081.9%2C71.6%20C71.6%2C66.4%2050.9%2C71.6%2045.8%2C35.4%20Z%22%2F%3E%3C%2Fsvg%3E';
    var images = [];
    var notifications = 'ask';
    var self = {
      state: function () { return JSON.stringify({ settings: store, version: 'v2', sdk: 35, device: 'Browser preview', notifications: notifications, storage: 'ok',
        batteryUnrestricted: false, apiRunning: store.localApi, canAddTile: true, canPinShortcut: true }); },
      saveSettings: function (j) { Object.assign(store, JSON.parse(j)); return JSON.stringify(store); },
      setApiKey: function (k) { store.hasKey = !!k; store.keyHint = k.slice(0, 4) + '••••' + k.slice(-4); return JSON.stringify(store); },
      checkKey: function (k, m, cb) { setTimeout(function () { root.bananarama.resolve(cb, JSON.stringify(k.indexOf('bad') >= 0 ? { kind: 'invalid', message: 'That key isn’t valid.' } : { kind: 'ok', message: 'Key works ✓' })); }, 700); },
      generate: function (j) {
        var o = JSON.parse(j), id = String(Date.now()).slice(-6), p = parseInline(o.prompt).prompt;
        setTimeout(function () { root.bananarama.onJob({ type: 'status', id: id, message: 'requesting' }); }, 300);
        setTimeout(function () { root.bananarama.onJob({ type: 'bytes', id: id, received: 1400000 }); }, 900);
        setTimeout(function () { images.unshift({ uri: 'mock://' + id, name: 'image_' + id + '.png', date: Date.now() }); root.bananarama.onJob({ type: 'done', id: id, uri: 'mock://' + id, thumb: MOCK_IMG }); }, 1700);
        return JSON.stringify({ id: id, prompt: p });
      },
      recent: function () { return JSON.stringify(images); },
      thumb: function () { return MOCK_IMG; },
      pickImage: function (cb) { setTimeout(function () { root.bananarama.resolve(cb, JSON.stringify({ uri: 'mock://ref', thumb: MOCK_IMG })); }, 200); },
      open: function () {}, share: function () {}, openUrl: function (u) { window.open(u, '_blank'); }, openApp: function () {},
      isInstalled: function () { return true; },
      requestNotifications: function (cb) { notifications = 'granted'; setTimeout(function () { root.bananarama.resolve(cb, self.state()); }, 200); },
      requestBatteryUnrestricted: function () {}, addTile: function (cb) { root.bananarama.resolve(cb, '"added"'); }, pinShortcut: function () {},
      setLocalApi: function (on, port) { store.localApi = on; store.port = port; return self.state(); },
      copy: function () {}, toast: function (t) { console.log('toast:', t); }, close: function () { console.log('close'); }
    };
    return self;
  }
})(typeof window !== 'undefined' ? window : this);
