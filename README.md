# Win Voice Over

A Chrome/Edge extension (Manifest V3) that reads subtitles aloud while you
watch, including subtitles burned into the picture (via OCR). It speaks with the
browser's own voices, with Gemini TTS or Azure TTS if you add an API key, or with
VieNeu-TTS running on your own computer, which needs no key. It works on macOS and
Windows.

## How it works

![Win Voice Over: from subtitles to speech](docs/win-voice-over.svg)

Interactive version with guided views: [`docs/win-voice-over.html`](docs/win-voice-over.html).
The diagram is generated with Archify from `docs/win-voice-over.architecture.json`.
After editing that file, rebuild the HTML from the archify skill folder:

```bash
node bin/archify.mjs deliver architecture <repo>/docs/win-voice-over.architecture.json <repo>/docs/win-voice-over.html --quality showcase
```

Then export the SVG from this repo. The script uses Archify's headless Chrome
helper; `ARCHIFY_HOME` tells it where the archify skill folder is (its default is a
Windows path):

```bash
ARCHIFY_HOME=/path/to/archify/skills/archify node scripts/export-diagram-svg.mjs docs/win-voice-over.html docs/win-voice-over.svg
```

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
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

The icons in `extension/icons/` (a white W on blue) are drawn by a script that needs
Pillow and the Segoe UI Bold font. It reads the font from `C:\Windows\Fonts`, so run
it on Windows:

```bash
python scripts/make-icons.py
```

## Choosing a speech engine

Pick one in the popup under *Speech engine*. Whatever you pick, a line that fails is
read by the browser voice instead.

| Engine | Needs | Cost | Subtitle text goes to | Notes |
|---|---|---|---|---|
| Browser voice (default) | nothing | free | the browser's voice; Edge's "Online (Natural)" voices are Microsoft's servers | Edge has HoaiMy and NamMinh; Chrome uses the system's voices (on macOS, Linh) |
| Gemini TTS | a Google AI Studio key (a Google account is enough) | free tier, then paid | Google | expressive; 30 voices and a speaking style |
| Azure TTS | an Azure Speech key (an Azure account, which asks for a card) | free tier: 0.5 M characters a month, 20 requests a minute | Microsoft | the Edge voices, in any browser |
| VieNeu | the VieNeu-TTS server running on this computer | free | nowhere: it stays on this computer | 25 Vietnamese voices; speed depends on the CPU |

In Chrome, **Azure TTS** gives the same two voices as Edge, and **VieNeu** gives free
voices with no account at all.

## Gemini TTS (expressive voices)

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
- Timeout, cache, prefetch, speed-up and fallback work the same as for Gemini.
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
model. Its server has 25 preset voices with Northern, Central and Southern accents.
It needs no key, and subtitle text never leaves the computer. (When it starts, the
server checks Hugging Face for model updates; the first start downloads the model.)

### Set it up once

Clone it inside this repo's folder; `.gitignore` keeps it out of this repo:

```bash
git clone https://github.com/pnnbao97/VieNeu-TTS.git
```

On **macOS**, create its virtualenv as `.venv.nosync`, a name iCloud does not sync
when the folder is under `~/Documents`:

```bash
cd VieNeu-TTS && UV_PROJECT_ENVIRONMENT=.venv.nosync uv sync
```

On **Windows**, install [uv](https://docs.astral.sh/uv/) first, then create the usual
`.venv`. VieNeu-TTS guarantees Windows on x64; its lock file also resolves Windows on
ARM, but nobody has tried that here.

```bash
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

```bash
cd VieNeu-TTS && uv sync
```

With an NVIDIA GPU, `uv sync --extra cuda` instead uses it; VieNeu-TTS's README puts
that at about 25× the CPU speed. On Windows, avoid a folder that OneDrive syncs (it
can sync Documents and Desktop): a synced virtualenv breaks the same way.

The virtualenv installs VieNeu with absolute paths, so after moving the checkout, run
the same `uv sync` again (and on macOS rebuild the app below).

### Start and stop: macOS

Use the **win-voice-over** menu bar app. Build and install it once; it needs `swiftc`,
which the Xcode command line tools provide:

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

### Start and stop: Windows

Double-click **`start-vieneu.cmd`** in this repo's folder. It opens a console window
and runs VieNeu there, on `127.0.0.1:8000` (loopback only). Keep the window open while
you watch; close it or press Ctrl+C to stop the server.

- It looks for VieNeu-TTS in this repo's folder. For another checkout, run
  `set VIENEU_DIR=C:\path\to\VieNeu-TTS` in a console, then `start-vieneu.cmd`.
- If VieNeu is already running, it says so and stops there.
- If the server stops by itself, the window stays open so its last messages can be read.
- `start-vieneu.cmd` was written and checked on a Mac; it has not been run on Windows
  yet.

### Using it

Popup → *Speech engine* → **VieNeu**, pick a voice, then **Test voice**. The popup's
VieNeu section shows whether the server is running.

How it behaves:

- The background worker calls `POST http://127.0.0.1:8000/v1/audio/speech` for raw
  24 kHz 16-bit PCM and wraps it in a WAV header. The server's own WAV streams with an
  unknown length, and the page needs the duration to pace a line.
- Timeout, cache, prefetch, speed-up and fallback work the same as for the cloud
  engines. If the server is not running, the toast says
  "VieNeu is not reachable at 127.0.0.1:8000" and the browser voice reads the line.
- On the CPU the server runs one line at a time and queues one more, which covers the
  line being read plus the prefetch of the next.

Speed. Measured on an Apple M4 (CPU, fp32, VieNeu 3.8.3, 2026-10-30), 18 requests one
after another: full audio for a 15, 61 or 92 character line in 160–215, 550–640 or
740–790 ms, a real-time factor (generation time / audio length) of 0.19 at the median
and 0.21 at most. The first start downloaded the model in 161 s. VieNeu-TTS's own
numbers for Windows 11 on a 12th-gen Core i5 are 0.55–0.62, so a 4 s line takes about
2.5 s and speech can trail the subtitle; `set VIENEU_PRECISION=int8` before starting
brings that to about 0.35 on CPUs with VNNI (on older CPUs int8 can garble the audio).
Not measured yet: any of this with a video playing, which competes for the CPU.

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
- **Alt+Shift+R** toggles reading (change it at `chrome://extensions/shortcuts` or
  `edge://extensions/shortcuts`).

## Manual test

After any code change: reload the extension on `chrome://extensions` or
`edge://extensions` (↻ on its card), then reload the video tab. A tab left open keeps
the old content script, which can no longer reach the extension. A change to
`manifest.json`, such as a new permission or host, only takes effect after that
reload; the popup's own files are read fresh each time it opens.

| Check | How | Expected |
|---|---|---|
| Extension loads | `chrome://extensions` | No **Errors** button on the card |
| Browser voice | Popup → pick a Vietnamese voice (Edge: *HoaiMy Online (Natural)*; Chrome on macOS: *Linh*) → **Test voice** | Vietnamese sentence is spoken |
| YouTube | Video with Vietnamese captions, CC on | Each line spoken; movie volume dips while speaking |
| Pause / seek | Pause, or jump in the timeline | Speech stops at once |
| Hotkey | Alt+Shift+R twice | Toasts "Win Voice Over: off", then "on" |
| Netflix | Vietnamese subtitles on | Lines spoken; if not, use *Pick subtitle element* |
| OCR | motchill episode, past the ad | OCR box ticked in the popup; lines spoken 0.5–2 s after they appear |
| OCR engine | Extensions page → Win Voice Over → *Inspect views: offscreen.html* | Appears after the first play; "Parameter not found" warnings are harmless |
| Gemini | Popup → *Gemini TTS* → paste key → **Test voice** | "Generated in N s" and the sentence is spoken |
| Gemini in a video | Same video as above with Gemini selected | Gemini voice reads the lines; any failure falls back to the browser voice with a toast |
| Azure | Popup → *Azure TTS* → paste key, set region → **Test voice** | "Generated in N s" and HoaiMy (or NamMinh) says the sentence |
| Azure in a video | Same video as above with Azure selected | The Azure voice reads the lines; on the free tier, lines past 20 a minute fall back to the browser voice with a toast |
| VieNeu | Server running → popup → *VieNeu* → **Test voice** | "Generated in N s" and the chosen voice says the sentence |
| VieNeu on macOS | Open *win-voice-over*, then the popup on *VieNeu*; later W → **Stop VieNeu** | The W is dimmed, then bright; the popup says "Server running on 127.0.0.1:8000."; after Stop the W is gone and the popup says "Server not running…" |
| VieNeu on Windows | Double-click `start-vieneu.cmd`, then the popup on *VieNeu*; later close the window | The popup says "Server running on 127.0.0.1:8000.", then "Server not running…" |
| VieNeu stopped | Stop the server, play a video with VieNeu selected | Toast "VieNeu failed (VieNeu is not reachable at 127.0.0.1:8000)"; lines read by the browser voice |

Where to look when something is wrong:

- Page DevTools console, filtered by `Win Voice Over`: content-script errors such as
  `OCR failed` or `cannot read frames from this video`.
- *Inspect views: service worker* on the extension card: the background worker, which
  relays OCR and calls Gemini, Azure and VieNeu.
- VieNeu's own output: `~/Library/Logs/win-voice-over.log` on macOS, the
  `start-vieneu.cmd` window on Windows.
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

Then open `http://localhost:5310/test/harness.html` with one of these modes:

- `?mode=dom`, `?mode=tracks` or `?mode=ocr`: the three subtitle sources;
- `?mode=gemini`, `?mode=azure` or `?mode=vieneu`: DOM captions read by that engine
  (the engine is faked, the WAV decoding is real);
- `?mode=gemini-error`, `?mode=azure-error` or `?mode=vieneu-error`: the engine fails,
  so lines fall back to the browser voice.

`http://localhost:5310/test/popup-preview.html?engine=gemini` (or `azure`, `vieneu`)
renders the real popup against a fake `chrome` API; with `vieneu`, add
`&vieneu=running` to show a running server. `test/voice-samples.html` plays six test
lines with the browser voices for comparing them with the other engines.

The background worker's Gemini, Azure and VieNeu code (request shape, parsing, cache,
prefetch, HTTP errors, missing audio, bad region, unreachable host, timeout, the WAV
header) runs under Node with a fake `fetch`:

```bash
node test/background.test.mjs
```
