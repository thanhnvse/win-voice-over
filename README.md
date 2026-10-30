# Win Voice Over

A Chrome/Edge extension (Manifest V3) that reads subtitles aloud while you
watch, including subtitles burned into the picture (via OCR). It speaks with the
browser's own voices, with the more expressive Gemini TTS voices, or with Edge's
Vietnamese voices through Azure (in any browser), if you add an API key. With no key,
it can use VieNeu-TTS running on your own computer.

## How it works

![Win Voice Over: from subtitles to speech](docs/win-voice-over.svg)

Interactive version with guided views: [`docs/win-voice-over.html`](docs/win-voice-over.html).
The diagram is generated with Archify from `docs/win-voice-over.architecture.json`;
after editing that file, rebuild both outputs from the archify skill folder:

```bash
node bin/archify.mjs deliver architecture <repo>/docs/win-voice-over.architecture.json <repo>/docs/win-voice-over.html --quality showcase
```

```bash
node scripts/export-diagram-svg.mjs docs/win-voice-over.html docs/win-voice-over.svg
```

## Install

1. Open `edge://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the **`extension`** folder.
4. Reload any tab that was already open.

Only `extension/` is the extension. The npm tooling and tests live beside it so
`node_modules` never ends up inside what the browser loads (a file whose name
starts with `_` anywhere in it would make **Load unpacked** fail).

`extension/vendor/` already holds the OCR runtime. To rebuild it (for example
after bumping a version in `package.json`):

```bash
npm install --ignore-scripts
```

```bash
npm run vendor
```

The icons in `extension/icons/` (a white W on blue) are drawn by a script, which
needs Pillow and the Segoe UI Bold font:

```bash
python scripts/make-icons.py
```

Use **Edge** if you can: its `speechSynthesis` exposes the Microsoft
"Online (Natural)" Vietnamese voices (HoaiMy, NamMinh), which sound far better
than the default ones. Pick one in the popup, or leave it on *Auto*. In Chrome,
choose the **Azure TTS** engine to get the same two voices, or **VieNeu** for free
voices that run on your computer (see below).

## Gemini TTS (expressive voices)

The browser voices stay the default. To switch:

1. Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Popup → *Speech engine* → **Gemini TTS**, paste the key, then **Test voice**.
   The status line shows how long the round trip took.
3. Pick a model (*3.8 Flash TTS*, or the cheaper *3.8 Flash-Lite TTS*), one of
   the 30 Gemini voices, and a speaking style. The style is a direction such as
   "an expressive voice actor dubbing a TV drama"; Gemini follows it without
   reading it aloud.

How it behaves:

- The background worker calls `POST /v1beta/interactions` with a 15 s timeout and
  keeps the last 100 results, so a repeated line costs nothing.
- While one line plays, the next is already being generated (prefetch).
- Audio plays in the tab and is sped up without raising the pitch, up to 1.6×,
  when lines arrive faster than they can be said.
- If a request fails (no key, quota, network, a page that blocks the audio), that
  line is spoken with the browser voice instead, and a toast says why once per page.
- The key is kept in `chrome.storage.local`, so it is not synced to your other
  browsers. Subtitle text is sent to Google.

Cost and limits: these models have a free tier, but Google does not publish its
rate limits (see AI Studio for yours). Paid, 3.8 Flash TTS costs $9 per million
audio tokens through 2026, and one second of audio is 25 tokens, so an hour of
speech is about $0.81. Generation time per line has not been measured yet; use
**Test voice** to see it on your connection.


## Azure TTS (the Edge voices in Chrome)

Edge's "Online (Natural)" Vietnamese voices are Azure's `vi-VN-HoaiMyNeural` and
`vi-VN-NamMinhNeural`. Chrome does not offer them through `speechSynthesis`, so this
engine asks Azure for them directly.

1. In the [Azure portal](https://portal.azure.com), create a **Speech** resource.
   Pick the region *Southeast Asia* (the closest to Vietnam) and the *Free F0*
   pricing tier.
2. Open the resource, then **Keys and Endpoint**. Copy **KEY 1** and the
   **Location/Region** value (for example `southeastasia`).
3. Popup → *Speech engine* → **Azure TTS**. Paste the key, type the region, pick
   HoaiMy or NamMinh, then **Test voice**.

How it behaves:

- The background worker calls
  `POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1` with the key
  in `Ocp-Apim-Subscription-Key` and an SSML body, and asks for 24 kHz MP3
  (`audio-24khz-48kbitrate-mono-mp3`), a tenth the size of WAV.
- Timeout, cache, prefetch, speed-up and fallback work the same as for Gemini. A
  failed line is spoken with the browser voice, and a toast says why once per page.
  A 401 means a wrong key or a region that is not the resource's region.
- The key is kept in `chrome.storage.local`. Subtitle text is sent to Microsoft.

Limits, from Microsoft's quotas and pricing pages (read on 2026-10-30):

- **Free F0:** 0.5 million characters a month, and **20 requests per 60 seconds**.
  This rate cannot be raised. Fast dialogue can go over 20 lines a minute, and each
  line over the limit gets a 429 and is read by the browser voice.
- **Standard S0** (pay as you go): 30 requests per second. The quotas page uses
  $15 per million characters in its cost example. The pricing page did not show
  the price when it was read, so check it there.
- Generation time per line has not been measured yet; **Test voice** shows it.
## VieNeu (free, on this computer)

[VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) is an open-source Vietnamese TTS
model that runs on the CPU. Its server has 25 preset voices with Northern, Central and
Southern accents. It needs no key, and subtitle text never leaves the computer. (When
it starts, the server checks Hugging Face for model updates.)

Set it up once, inside this repo's folder (`.gitignore` keeps it out of this repo):

```bash
git clone https://github.com/pnnbao97/VieNeu-TTS.git
```

```bash
cd VieNeu-TTS && UV_PROJECT_ENVIRONMENT=.venv.nosync uv sync
```

The `.nosync` name keeps iCloud from syncing the virtualenv when the folder is under
`~/Documents`. The virtualenv installs VieNeu with absolute paths, so after moving the
checkout, run that `uv sync` again and rebuild the app below.

Start the server before watching with the **win-voice-over** menu bar app. Build and
install it once; it needs `swiftc`, which the Xcode command line tools provide:

```bash
python3 scripts/build_macos_app.py
```

Then open **win-voice-over** from Applications or Spotlight. A blue W with a small "vo"
appears in the menu bar. It stays dimmed while the model loads (10–15 s once it is
downloaded) and turns bright once VieNeu answers on `127.0.0.1:8000`; its tooltip says
which. The W's one menu item, **Stop VieNeu** (⌘Q), stops the server and quits.

- The app runs `python -m apps.openai_speech` from the VieNeu-TTS checkout in this
  repo's folder (`--vieneu` picks another), on loopback only. Its output goes to
  `~/Library/Logs/win-voice-over.log`.
- If VieNeu is already running when the app opens, the app takes it over, and
  **Stop VieNeu** stops that server too.
- If the server exits by itself, the app shows its exit code and quits.
- Quitting in any other way (Activity Monitor, logout, a SIGTERM) also stops the server
  first.
- The app draws its own icon, so the menu bar W and the app icon match.
- Moving the VieNeu-TTS checkout or renaming its virtualenv needs a rebuild; updating
  VieNeu-TTS does not.
- The popup's VieNeu section shows whether the server is running.

Then Popup → *Speech engine* → **VieNeu**, pick a voice, and **Test voice**.

How it behaves:

- The background worker calls `POST http://127.0.0.1:8000/v1/audio/speech` for raw
  24 kHz 16-bit PCM and wraps it in a WAV header. The server's own WAV streams with an
  unknown length, and the page needs the duration to pace a line.
- Timeout, cache, prefetch, speed-up and fallback work the same as for the cloud
  engines. If the server is not running, the toast says
  "VieNeu is not reachable at 127.0.0.1:8000" and the browser voice reads the line.
- On the CPU the server runs one line at a time and queues one more, which covers the
  line being read plus the prefetch of the next.

Measured on an Apple M4 (CPU, fp32, VieNeu 3.8.3, 2026-10-30), 18 requests one after
another: full audio for a 15, 61 or 92 character line in 160–215, 550–640 or 740–790 ms,
a real-time factor (generation time / audio length) of 0.19 at the median and 0.21 at
most. The first start downloads the model, which took 161 s here. Not measured yet: the
same with a video playing, which competes for the CPU.

## Where subtitles come from

| Source | Sites | How |
|---|---|---|
| `video.textTracks` | any HTML5 player that loads `.vtt` tracks | `cuechange` events |
| Built-in DOM adapters | YouTube, Netflix | `MutationObserver` on the caption container |
| Picked element | any other site | popup → *Pick subtitle element*, pause on a line, click it |
| OCR | sites with hard subtitles; on by default for `motchill` hosts | popup → *Read hard subtitles on this site* |

For soft subtitles, turn the site's own subtitles on first; the extension reads
what the player shows.

## OCR for hard subtitles

Every 300 ms the content script copies the bottom quarter of the playing video
into a canvas (scaled to 720p) and keeps the light blobs that a dark outline
walls in: that is how subtitles are drawn, and bright scenery is either too big
or not walled in. When that text changes and then holds still for one sample,
it is cropped, drawn dark-on-white and sent to Tesseract.js (Vietnamese model)
running in an offscreen document. Lines under 60 % confidence are dropped, and
a result too similar to the previous one is not read again.

Measured on the test harness: the time from a subtitle appearing to it being
queued for speech is about 0.3–0.4 s, OCR itself takes 100–200 ms, and the
per-frame mask costs about 10 ms.

Limits:

- Works for white, light grey or yellow text with a dark outline, a shadow on
  a dark scene, or a dark box behind it. Text with no outline over a bright
  scene is not found.
- The video must not be cross-origin without CORS (the canvas would be
  tainted). Players built on hls.js / MSE, like motchill's, are fine. DRM video
  (Netflix) captures as black, but Netflix has soft subtitles anyway.
- Expect the odd wrong tone mark when text crosses busy or bright scenery.
- Anything else drawn in the bottom quarter with an outline, such as a logo
  watermark, is read too.

## Behaviour

- Lowers the movie volume while speaking (*ducking*), restores it afterwards,
  and leaves it alone if you changed it in between.
- Speeds up to fit a cue into its on-screen time, and speeds up further when
  lines arrive faster than they can be read. The line being spoken always
  finishes; a line still waiting behind it is replaced by the newest one.
- YouTube auto-generated captions scroll word by word; only the new words are read.
- Skips `[music]`, `(laughs)`, `♪`, and lines with no letters or digits.
- Pausing or seeking stops speech immediately.
- **Alt+Shift+R** toggles reading (change it at `edge://extensions/shortcuts`).

## Manual test

After any code change: reload the extension on `edge://extensions` (↻ on its
card), then reload the video tab. A tab left open keeps the old content script,
which can no longer reach the extension.

| Check | How | Expected |
|---|---|---|
| Extension loads | `edge://extensions` | No **Errors** button on the card |
| Voice | Popup → pick *HoaiMy Online (Natural)* → **Test voice** | Vietnamese sentence is spoken |
| YouTube | Video with Vietnamese captions, CC on | Each line spoken; movie volume dips while speaking |
| Pause / seek | Pause, or jump in the timeline | Speech stops at once |
| Hotkey | Alt+Shift+R twice | Toasts "Win Voice Over: off", then "on" |
| Netflix | Vietnamese subtitles on | Lines spoken; if not, use *Pick subtitle element* |
| OCR | motchill episode, past the ad | OCR box ticked in the popup; lines spoken 0.5–2 s after they appear |
| OCR engine | `edge://extensions` → Win Voice Over → *Inspect views: offscreen.html* | Appears after the first play; "Parameter not found" warnings are harmless |
| Gemini | Popup → *Gemini TTS* → paste key → **Test voice** | "Generated in N s" and the sentence is spoken |
| Gemini in a video | Same video as above with Gemini selected | Gemini voice reads the lines; any failure falls back to the browser voice with a toast |
| Azure | Popup → *Azure TTS* → paste key, set region → **Test voice** | "Generated in N s" and HoaiMy (or NamMinh) says the sentence |
| Azure in a video | Same video as above with Azure selected | The Azure voice reads the lines; on the free tier, lines past 20 a minute fall back to the browser voice with a toast |
| VieNeu | Server running → popup → *VieNeu* → **Test voice** | "Generated in N s" and the chosen voice says the sentence |
| VieNeu app | Open *win-voice-over*, then the popup on *VieNeu*; later W → **Stop VieNeu** | The W is dimmed, then bright; the popup says "Server running on 127.0.0.1:8000."; after Stop the W is gone and the popup says "Server not running…" |
| VieNeu stopped | Stop the server, play a video with VieNeu selected | Toast "VieNeu failed (VieNeu is not reachable at 127.0.0.1:8000)"; lines read by the browser voice |

Where to look when something is wrong:

- Page DevTools console, filtered by `Win Voice Over`: content-script errors such as
  `OCR failed` or `cannot read frames from this video`.
- *Inspect views: service worker* on the extension card: the background relay.
- For bad OCR, a screenshot of a frame with the subtitle shows whether the text
  style (outline, colour) or a watermark is the cause.

## Test harness

`test/harness.html` runs the real `extension/content.js` and
`extension/ocr-engine.js` against a fake `chrome` API and a fake
`speechSynthesis` that takes as long as real speech would, and logs every OCR
result and every queued, spoken and cancelled line. `test/serve.py` serves this
folder with the CSP that extension pages get, so the OCR worker and WASM core
load under the same rules as in the extension.

```bash
python test/serve.py 5310
```

Then open `http://localhost:5310/test/harness.html` with `?mode=dom`,
`?mode=tracks`, `?mode=ocr`, `?mode=gemini` (fake API, real WAV decoding) or
`?mode=gemini-error` (the API fails, lines fall back to the browser voice), and
`?mode=azure` / `?mode=azure-error` and `?mode=vieneu` / `?mode=vieneu-error` (the same
two with the Azure and VieNeu engines).

`http://localhost:5310/test/popup-preview.html?engine=gemini` (or `azure`, `vieneu`)
renders the real popup against a fake `chrome` API (with `vieneu`, add `&vieneu=running`), and `test/voice-samples.html` plays six test
lines with the browser voices for comparing them with cloud voices.

The background worker's Gemini, Azure and VieNeu code (request shape, parsing, cache,
prefetch, HTTP errors, missing audio, bad region, unreachable host, timeout, the WAV
header) runs under Node with a fake `fetch`:

```bash
node test/background.test.mjs
```
