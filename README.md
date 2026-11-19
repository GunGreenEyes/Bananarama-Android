<p align="center"><img src="docs/banana.png" width="96" alt=""></p>

<h1 align="center">Bananarama for Android</h1>

<p align="center"><b>Select text in Claude → <i>Make image</i>. Get a Gemini "Nano Banana" picture in your Gallery.</b><br>
The Android sibling of <a href="https://github.com/GunGreenEyes/Bananarama">Bananarama for Windows</a>. One-tap install, built for the Galaxy S25, works on Android 8+.</p>

<p align="center">
  <a href="https://github.com/GunGreenEyes/Bananarama-Android/releases/latest/download/Bananarama.apk"><b>⬇ Download Bananarama.apk</b></a> ·
  <a href="https://gungreeneyes.github.io/Bananarama-Android/">Website</a> ·
  <a href="#use-it-with-claude">Use it with Claude</a> ·
  <a href="#development">Development</a>
</p>

---

## Install (one tap)

1. On your phone, open **[Bananarama.apk](https://github.com/GunGreenEyes/Bananarama-Android/releases/latest/download/Bananarama.apk)** and tap **Install**.
   The first time, Android asks you to allow installs from your browser (Settings → *Install unknown apps*). Allow it once.
2. Open **Bananarama**. A short setup asks for the one thing it needs, a **Gemini API key**.
   Tap **Get a free key from Google**, copy the key, paste it, and Bananarama checks it with Google.
3. Allow **notifications**, so finished pictures show up even when you've gone back to Claude.

That's it. Images are saved to **Pictures/Nano** and appear in the Gallery. Making images needs billing turned on
for the key's Google Cloud project; Google charges a few cents per image.

**Update:** install a newer `Bananarama.apk` over the old one; your settings stay.
**Uninstall:** long-press the icon → Uninstall. Your images stay in Pictures/Nano.

## Use it with Claude

Bananarama hooks into Android's own features, so it works from the **Claude app** and everywhere else:

| how | what happens |
|---|---|
| **Select text → Make image** | In Claude, long-press a reply, select the description, tap **Make image** (or ⋮ → Make image). Confirm, and you're back in Claude while it draws. |
| **Share → Bananarama** | Share any text to Bananarama to draw it. Share a **photo** to edit it ("add a tiny crown"). |
| **Quick Settings tile** | Pull down twice → **New image**. Setup offers to add the tile. |
| **Home-screen shortcut** | Long-press the Bananarama icon → **New image**, or add it to the home screen. |
| **Claude Code in Termux** *(optional)* | Turn on **Settings → Claude Code link**, then run the Termux installer below to get `/image` and `/bananarama` in Claude Code. |

Add `16:9`, `2K`, `4K`, `pro` or `lite` to any description (`a lighthouse at dusk, 21:9, pro`) to override the defaults
for that image. Each finished image arrives as a notification with the picture and **Share**, **Edit** and **New** buttons.

> The Claude app can't call tools on your phone directly, so Bananarama plugs into Android instead: the
> text-selection menu and the share sheet work in Claude and in every other app.

## Settings

In the app (⚙): API key (masked, re-checked when you change it), default model (Flash, Pro, Lite, Original), aspect
ratio, size, the folder inside Pictures, notifications, confirming shared text, and the Claude Code link (port
7861 on 127.0.0.1 only).

## Claude Code in Termux (optional)

For Claude Code running in [Termux](https://f-droid.org/packages/com.termux/) on the phone:

1. In Bananarama: **Settings → Claude Code link → on**. It speaks the same local API as the Windows middleware.
2. In Termux:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/GunGreenEyes/Bananarama-Android/main/install.sh | bash
   ```
   This adds the `bananarama` command and the `/image` and `/bananarama` skills. It uses the app's link when it's
   on; otherwise it can run its own middleware in Termux ([details](docs/termux.md)).

On Galaxy phones, let the link run in the background: Bananarama → Settings → *Let it run in the background*.

## How it works

```
 Claude app ── select text / share ──► MainActivity (WebView, JavaScript UI) ─┐
 Quick Settings tile / shortcut ─────► MainActivity ───────────────────────────┼─► GenerateService (foreground) ─► Gemini API
 Notification "Edit" / "New" ────────► MainActivity ───────────────────────────┘          │ streamGenerateContent (SSE)
                                                                                           └─► Pictures/Nano → Gallery + notification
 Claude Code in Termux ── HTTP 127.0.0.1:7861 ──► ApiService (/health, /imagine NDJSON, same as Windows)
```

| piece | what it does |
|---|---|
| `android/app/src/main/assets/www/` | The app's screens in **JavaScript**: setup wizard, prompt, edit, settings. |
| `android/app/…/MainActivity.kt` | Hosts the page and handles intents (text selection, share, tile, shortcut, notification actions). |
| `android/app/…/Services.kt` | `GenerateService` keeps going after you switch back to Claude. `ApiService` is the Claude Code link. |
| `android/core/` | Plain Kotlin: Gemini streaming client, the `16:9, 2K, pro` parsing, file naming, and the local API. No Android dependencies, so it's unit-tested on any JVM. |
| `src/`, `bin/`, `install.sh` | The Termux command line (Node.js), for Claude Code in Termux. |

## Development

```sh
npm test                                          # 60 Node tests (Termux tools, app UI helpers, middleware)
cd android && ./gradlew :core:test                # Kotlin core (no Android SDK needed: BANANARAMA_CORE_ONLY=1)
cd android && ./gradlew :app:assembleDebug        # the APK (needs the Android SDK)
cd android && ./gradlew :app:connectedDebugAndroidTest   # on an emulator or phone
```

CI ([android.yml](.github/workflows/android.yml)) builds the APK, runs the unit tests, and runs the app on an
Android 14 emulator against a fake Gemini. The UI can be previewed in a desktop browser by opening
`android/app/src/main/assets/www/index.html`; it falls back to a fake phone bridge (add `?ready` to skip setup).

### Releases

Versions are whole numbers: **v2, v3, …** `npm run release` bumps `package.json`, tags `vN` and pushes. The
[release workflow](.github/workflows/release.yml) builds `Bananarama.apk`, signed with the `ANDROID_SIGNING_KEY`
repository secret (base64 of the release keystore), and publishes it. Keep the keystore safe: Android only installs
updates signed with the same key.

## License

MIT. Not affiliated with Google, Samsung or Anthropic.
