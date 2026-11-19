---
name: bananarama
description: Self-check for Bananarama on this Android phone (background service, middleware, Termux:API, storage, Gemini key, /image). Use when the user types /bananarama or says "bananarama".
---

Run the Bananarama health check now, without asking:

1. Run `"{{BIN}}" doctor` and show its ✅ / ❌ lines as they are (never print the API key).
2. Generate the test image with `"{{BIN}}" test` (4-minute timeout). The last stdout line is `SAVED: <path>`; show that image with the Read tool.
3. **Tests** (only if the user wrote `full` after the command) — `npm test` in `{{APP}}`.

End with `🍌 Bananarama: all good` or `🍌 Bananarama: N problem(s)` plus the fix for each (the doctor output names the command to run). Logs: `"{{BIN}}" log`.

Arguments: $ARGUMENTS
