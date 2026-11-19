---
name: image
description: Generate an image from a text description with Gemini Nano Banana through the local Bananarama middleware on this Android phone, save it to Pictures/Nano (the Gallery) and show it. Use when the user types /image <description> or asks for a picture.
---

Generate the image now, without asking for confirmation:

1. If the `bananarama` MCP tool `image` is available in this session, call it with `description` set to the description below and any options the user wrote (aspect ratio like 16:9, size 1K/2K/4K, model pro/lite, reference image paths). Skip to step 3.
2. Otherwise run, with a 4-minute timeout:
   `"{{BIN}}" image <flags> "<description>"`
   - Pass the description as one quoted argument (escape embedded double quotes).
   - Map options the user wrote to flags instead of leaving them in the prompt: `--ar 16:9`, `--size 1K|2K|4K`, `--model pro|lite|flash|<id>`, `--image <path>` for a reference image (repeatable).
   - The middleware starts itself if it is not running. A notification with the picture also appears on the phone.
   - The last stdout line is `SAVED: <path>`. Read that image with the Read tool so the user sees it.
3. Reply with the saved path in one line. On `ERROR: ...` (or a tool error), report it exactly. Settings (API key, default model, aspect ratio, size, folder) are changed with `bananarama settings` and stored in `{{SETTINGS}}`.

If no description was given, ask for one.

Arguments: $ARGUMENTS
