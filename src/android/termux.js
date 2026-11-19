'use strict';
// Thin wrapper over the Termux:API command-line tools (termux-notification,
// termux-dialog, termux-toast, ...). Every call goes through `run`, which tests
// replace with a fake. Termux:API commands block forever when the Termux:API app
// is missing, so everything has a timeout.
const { execFile } = require('child_process');

const QUICK = 20000;          // notifications, toasts, media scan
const DIALOG = 10 * 60000;    // a person is typing

function defaultRun(cmd, args, timeout) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || (err && err.message) || '' });
    });
  });
}

class Termux {
  constructor(run = defaultRun) { this.run = run; }

  /** Is Termux:API installed and answering? */
  async available() {
    const r = await this.run('termux-api-start', [], 5000);
    if (r.ok) return true;
    const t = await this.run('termux-toast', ['-s', 'Bananarama'], 8000);
    return t.ok;
  }

  /**
   * Show or update a notification.
   * @param {{id:string, title:string, content?:string, ongoing?:boolean, alertOnce?:boolean, priority?:string,
   *          action?:string, image?:string, icon?:string, group?:string, buttons?:{text:string, action:string}[]}} n
   */
  notify(n) {
    const a = ['--id', n.id, '--title', n.title];
    if (n.content) a.push('--content', n.content);
    if (n.ongoing) a.push('--ongoing');
    if (n.alertOnce) a.push('--alert-once');
    if (n.priority) a.push('--priority', n.priority);
    if (n.icon) a.push('--icon', n.icon);
    if (n.group) a.push('--group', n.group);
    if (n.action) a.push('--action', n.action);
    if (n.image) a.push('--image-path', n.image);
    (n.buttons || []).slice(0, 3).forEach((b, i) => a.push(`--button${i + 1}`, b.text, `--button${i + 1}-action`, b.action));
    return this.run('termux-notification', a, QUICK);
  }

  removeNotification(id) { return this.run('termux-notification-remove', [id], QUICK); }

  toast(text, short = true) { return this.run('termux-toast', short ? ['-s', text] : [text], QUICK); }

  mediaScan(file) { return this.run('termux-media-scan', [file], QUICK); }

  open(file) { return this.run('termux-open', [file], QUICK); }

  share(file) { return this.run('termux-share', ['-a', 'send', file], QUICK); }

  wakeLock() { return this.run('termux-wake-lock', [], QUICK); }

  wakeUnlock() { return this.run('termux-wake-unlock', [], QUICK); }

  /** Run termux-dialog and parse its JSON. Returns {ok, text, index} - ok is false when cancelled. */
  async dialog(widget, { title, hint, values, password, multiline } = {}) {
    const a = [widget];
    if (title) a.push('-t', title);
    if (hint) a.push('-i', hint);
    if (values) a.push('-v', values.map(v => String(v).replace(/,/g, ' ')).join(','));
    if (password) a.push('-p');
    if (multiline) a.push('-m');
    const r = await this.run('termux-dialog', a, DIALOG);
    if (!r.ok) return { ok: false, text: '', error: r.stderr };
    let j;
    try { j = JSON.parse(r.stdout); } catch { return { ok: false, text: '', error: `unexpected dialog output: ${r.stdout.slice(0, 200)}` }; }
    return { ok: j.code === -1, text: (j.text || '').trim(), index: j.index };
  }

  text(title, opts = {}) { return this.dialog('text', { title, ...opts }); }

  /** Pick one of `values`; returns the chosen value or null. */
  async choose(title, values, widget = 'radio') {
    const r = await this.dialog(widget, { title, values });
    if (!r.ok) return null;
    if (typeof r.index === 'number' && values[r.index] !== undefined) return values[r.index];
    return values.find(v => String(v).replace(/,/g, ' ') === r.text) || null;
  }

  async confirm(title, hint) {
    const r = await this.dialog('confirm', { title, hint });
    return r.ok && r.text.toLowerCase() !== 'no';
  }
}

module.exports = { Termux, defaultRun };
