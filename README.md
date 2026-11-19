<p align="center"><img src="docs/banana.png" width="96" alt=""></p>

<h1 align="center">Bananarama for Android</h1>

<p align="center"><b>Gemini "Nano Banana" images on your phone: from a notification, the share sheet, a home-screen widget, or <code>/image</code> in Claude Code.</b><br>
The Android sibling of <a href="https://github.com/GunGreenEyes/Bananarama">Bananarama for Windows</a>. Same JavaScript middleware, running in the background in Termux. Built for the Galaxy S25, works on any Android 8+ phone.</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="https://gungreeneyes.github.io/Bananarama-Android/">Website</a> ·
  <a href="#use-it">Use it</a> ·
  <a href="#galaxy-s25-keep-it-running">Galaxy tips</a> ·
  <a href="#development">Development</a>
</p>

---

## Install

You need four free apps from **F-Droid** (or their GitHub releases). The Play Store build of Termux is outdated and
doesn't work with the add-ons:

| app | why |
|---|---|
| [Termux](https://f-droid.org/packages/com.termux/) | runs Node.js and the middleware |
| [Termux:API](https://f-droid.org/packages/com.termux.api/) | notifications, dialogs, Gallery scan, sharing |
| [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) | starts Bananarama when the phone boots (open it once after installing) |
| [Termux:Widget](https://f-droid.org/packages/com.termux.widget/) | optional: home-screen buttons |

Then open Termux and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/GunGreenEyes/Bananarama-Android/main/install.sh | bash
```

The installer does the following:
- installs Node.js and the Termux tools
- asks for storage access, so images land in **Pictures/Nano** and show up in the Gallery
- sets up start-at-boot, the widgets and the share sheet
- asks for your Gemini API key from [AI Studio](https://aistudio.google.com/apikey), in a dialog
- starts the background service

Image models need billing enabled on the key's Google Cloud project.

Run the same command again to **update**; it installs the latest release. `bananarama uninstall` removes everything
except your settings (`~/.config/Bananarama`) and your images.

## Use it

| where | what |
|---|---|
| **Notification** | *Bananarama · Ready* stays in the shade while the service runs: **New image**, **Settings**, **Stop**. Tap it for the full menu (test image, last image, health check, restart). |
| **Share sheet** | In any app, including the Claude app, select text and **Share → Termux** to turn it into an image. Share a **photo** to Termux, then type what to change, to edit it. |
| **Widget** | Termux:Widget → *Bananarama - New image / Test image / Menu / Settings*. |
| **Claude Code** | In Termux (`npm i -g @anthropic-ai/claude-code`): type `/image a fox in a library, 16:9` or `/bananarama` for a self-check. |
| **Terminal** | `bananarama image --ar 9:16 --size 2K "a neon banana poster"` |

Each finished image arrives as a notification with the picture in it. Tap it to open, or use **Share**, **Edit** or **New**.
Add `16:9`, `2K`, `4K`, `pro` or `lite` to any description (`a lighthouse at dusk, 21:9, pro`) to override the defaults
for that image.

> The Claude Android app can't call tools on your phone, so in the app use **Share → Termux** on the text you want drawn.
> Claude Code running inside Termux gets the full `/image` command.

### Commands

```
bananarama start | stop | restart | status    the background service
bananarama new                                 ask for a description, make the image
bananarama image [--ar 16:9] [--size 2K] [--model pro] [--image ref.jpg] <text>
bananarama test                                the test image
bananarama menu                                everything, as a list
bananarama settings                            API key, model, ratio, size, folder, notifications
bananarama last                                open the last image
bananarama doctor                              health check (✅ / ❌)
bananarama log                                 service and middleware logs
bananarama setup | uninstall                   boot script, widgets, share handlers, Claude Code skills
```

## Galaxy S25: keep it running

One UI is aggressive about background apps. After installing:

1. **Settings → Battery → Background usage limits → Never sleeping apps → +** → add **Termux** (and Termux:API, Termux:Boot).
2. **Settings → Apps → Termux → Battery → Unrestricted.**
3. Allow **notifications** for Termux and Termux:API (Android asks the first time).
4. Open **Termux:Boot** once so Android lets it run at boot.
5. Optional, for heavy use: Android 14+ can kill background child processes ("phantom process" limit). In
   **Developer options**, turn on **Disable child process restrictions**.

The service holds a Termux wake lock (setting `wakeLock`), and the notification shows *Ready* while it's healthy. If the
middleware crashes, the service restarts it.

## Settings

`bananarama settings`, or edit `~/.config/Bananarama/settings.json`:

| key | default | notes |
|---|---|---|
| `apiKey` | `""` | Gemini API key; falls back to `GEMINI_API_KEY` |
| `model` | `gemini-3.1-flash-image` | Nano Banana 2. Also `gemini-3-pro-image`, `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image` |
| `aspectRatio` | `1:1` | `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9` |
| `imageSize` | `1K` | `1K`, `2K`, `4K` |
| `outputDir` / `outputSubfolder` | `""` / `Nano` | empty = the phone's shared Pictures folder |
| `notify` | `true` | notification with the finished picture (off = a toast) |
| `openAfterSave` | `false` | open each image in the Gallery |
| `wakeLock` | `true` | keep running with the screen off |
| `host` / `port` | `127.0.0.1` / `7861` | the middleware; local only |

## How it works

```
 notification / widget / share sheet ─► bananarama (src/android/main.js) ─┐
 Claude Code in Termux ── /image ─────► bananarama image ────────────────┼─► src/lib/client.js ─HTTP─► src/server.js ─► Gemini API
                                                                         │                            (127.0.0.1:7861)
 Termux:Boot ─► bananarama start ─► service (src/android/service.js) ────┘ keeps server.js alive, wake lock, notification
                                                                             └─► Pictures/Nano/image_<time>_<slug>.png → Gallery
```

| piece | what it does |
|---|---|
| `src/server.js`, `src/lib/` | The middleware and client, shared with Bananarama for Windows. Streams from `streamGenerateContent`; local, non-browser requests only. |
| `src/android/service.js` | The stand-in for the Windows tray app: supervises the middleware, wake lock, persistent notification. |
| `src/android/actions.js` | New image, share and edit handling, notifications with the picture, Settings dialogs, health check. |
| `src/android/termux.js` | Wrapper over Termux:API (`termux-notification`, `termux-dialog`, …), with timeouts. |
| `src/android/install.js` | Boot script, widgets, `termux-url-opener` / `termux-file-editor`, Claude Code skills. Never overwrites files it didn't write. |
| `install.sh` | The one-line installer and updater. |

## Development

```sh
npm test     # 55 tests: middleware against a fake Gemini, plus the Android layer with a fake Termux
```

No npm dependencies. CI runs the tests on Linux with Node 22, 24 and 26.

Versions are whole numbers: **v1, v2, v3, …** `npm run release` bumps `package.json`, tags `vN` and pushes. The tag
publishes a GitHub release, and phones pick it up the next time they run the installer.

## License

MIT. Not affiliated with Google, Samsung or Anthropic.
