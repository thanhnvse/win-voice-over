(() => {
  if (window.__winVoiceOverLoaded) return;
  window.__winVoiceOverLoaded = true;

  const { DEFAULTS, OCR_DEFAULT_HOSTS } = globalThis.WVO;
  // Rough speaking speed at rate 1.0; used to fit a cue into its on-screen time.
  const CHARS_PER_SEC = 14;
  const MAX_RATE = 2.5;
  // Gemini audio is sped up without changing pitch, but past this it sounds rushed.
  const MAX_GEMINI_RATE = 1.6;

  // Sites that draw captions into the DOM instead of video.textTracks.
  const SITE_SOURCES = [
    { host: /(^|\.)youtube\.com$/, container: '.ytp-caption-window-container', line: '.ytp-caption-segment' },
    { host: /(^|\.)netflix\.com$/, container: '.player-timedtext', line: '.player-timedtext-text-container' },
  ];

  let settings = { ...DEFAULTS };
  let selectors = {};

  // ---------- text cleanup and de-duplication ----------

  function clean(raw) {
    const text = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]/g, ' ')
      .replace(/^\s*-\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    return /[\p{L}\p{N}]/u.test(text) ? text : '';
  }

  let lastSpoken = '';
  let lastSpokenAt = 0;

  function emit(raw, seconds) {
    if (!settings.enabled) return;
    const text = clean(raw);
    if (!text) return;
    const now = Date.now();
    // The same line can arrive from both textTracks and the player's own caption DOM.
    if (text === lastSpoken && now - lastSpokenAt < 3000) return;
    lastSpoken = text;
    lastSpokenAt = now;
    say(text, seconds);
  }

  // ---------- speech ----------

  let generation = 0;
  let speaking = false;
  let waiting = null;
  let pressure = 0;
  let restoreTimer = null;
  let duckState = null;
  let currentAudio = null;
  let geminiErrorShown = false;

  function activeVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && v.readyState > 0) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function duck(on) {
    if (on) {
      clearTimeout(restoreTimer);
      if (duckState) return;
      const v = activeVideo();
      if (!v) return;
      duckState = { v, volume: v.volume, set: v.volume * settings.duck };
      v.volume = duckState.set;
    } else if (duckState) {
      const { v, volume, set } = duckState;
      // Leave the volume alone if the user changed it while we were speaking.
      if (Math.abs(v.volume - set) < 0.01) v.volume = volume;
      duckState = null;
    }
  }

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    if (settings.voiceURI) {
      const chosen = voices.find((v) => v.voiceURI === settings.voiceURI);
      if (chosen) return chosen;
    }
    const vi = voices.filter((v) => v.lang.toLowerCase().startsWith('vi'));
    return vi.find((v) => /natural|online/i.test(v.name)) || vi[0] || null;
  }

  function say(text, seconds) {
    const v = activeVideo();
    if (v && v.paused) return;

    if (speaking) {
      // A new line while the old one is still playing means we are falling behind: speed up.
      // The current line always finishes; only the line waiting behind it is replaced,
      // because by the time it would play it is already stale.
      pressure = Math.min(pressure + 1, 4);
      waiting = { text, seconds, at: Date.now() };
      if (settings.engine === 'gemini') {
        // Synthesise now so the audio is ready when the current line ends.
        sendToExtension({ type: 'tts', text, prefetch: true })
          .catch((err) => console.warn('Win Voice Over: Gemini prefetch failed', err));
      }
      return;
    }
    speakNow(text, seconds);
  }

  function speakNow(text, seconds) {
    const mine = generation;
    speaking = true;
    const finish = () => {
      if (mine !== generation) return;
      speaking = false;
      pressure = Math.max(0, pressure - 1);
      if (waiting) {
        const next = waiting;
        waiting = null;
        speakNow(next.text, next.seconds - (Date.now() - next.at) / 1000);
      } else {
        // Short delay so back-to-back lines do not pump the volume up and down.
        restoreTimer = setTimeout(() => duck(false), 400);
      }
    };

    duck(true);
    if (settings.engine === 'gemini') speakGemini(text, seconds, mine, finish);
    else speakBrowser(text, seconds, finish);
  }

  function speakBrowser(text, seconds, finish) {
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = 'vi-VN';
    }
    let rate = settings.rate * (1 + 0.2 * pressure);
    if (seconds > 0.3) rate = Math.max(rate, text.length / CHARS_PER_SEC / seconds);
    u.rate = Math.min(rate, MAX_RATE);
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);
  }

  // Gemini answers with base64 WAV; play it from a blob so the browser decodes it.
  function loadAudio(result) {
    const audio = new Audio(URL.createObjectURL(globalThis.WVO.audioBlob(result)));
    // Speeding up to catch up with the subtitles must not raise the pitch.
    audio.preservesPitch = true;
    return new Promise((resolve, reject) => {
      audio.onloadedmetadata = () => resolve(audio);
      audio.onerror = () => {
        URL.revokeObjectURL(audio.src);
        reject(new Error('the page could not play the Gemini audio'));
      };
    });
  }

  async function speakGemini(text, seconds, mine, finish) {
    const requested = Date.now();
    try {
      const result = await sendToExtension({ type: 'tts', text });
      if (result.error) throw new Error(result.error);
      if (mine !== generation) return; // paused, seeked or switched off while waiting
      const audio = await loadAudio(result);
      if (mine !== generation) {
        URL.revokeObjectURL(audio.src);
        return;
      }
      const left = seconds - (Date.now() - requested) / 1000;
      let rate = settings.rate * (1 + 0.15 * pressure);
      if (left > 0.3) rate = Math.max(rate, audio.duration / left);
      audio.playbackRate = Math.min(rate, MAX_GEMINI_RATE);
      const done = () => {
        URL.revokeObjectURL(audio.src);
        if (currentAudio === audio) currentAudio = null;
        finish();
      };
      audio.onended = done;
      audio.onerror = done;
      currentAudio = audio;
      try {
        await audio.play();
      } catch (err) {
        currentAudio = null;
        URL.revokeObjectURL(audio.src);
        throw err;
      }
    } catch (err) {
      reportGeminiError(err);
      // Say the line with the browser voice rather than skip it.
      if (mine === generation) speakBrowser(text, seconds, finish);
    }
  }

  function reportGeminiError(err) {
    console.error('Win Voice Over: Gemini TTS failed, using the browser voice', err);
    if (geminiErrorShown) return;
    geminiErrorShown = true;
    toast(`Win Voice Over: Gemini TTS failed (${err.message}), using the browser voice`, 5000);
  }

  function cancelAll() {
    generation++;
    speaking = false;
    waiting = null;
    speechSynthesis.cancel();
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
      currentAudio = null;
    }
  }

  function stopSpeaking() {
    cancelAll();
    duck(false);
  }

  document.addEventListener('pause', (e) => { if (e.target instanceof HTMLVideoElement) stopSpeaking(); }, true);
  document.addEventListener('seeking', (e) => { if (e.target instanceof HTMLVideoElement) stopSpeaking(); }, true);

  // ---------- source 1: standard HTML5 text tracks ----------

  const hooked = new WeakSet();

  function hookTrack(video, track) {
    if (hooked.has(track) || (track.kind !== 'subtitles' && track.kind !== 'captions')) return;
    hooked.add(track);
    track.addEventListener('cuechange', () => {
      if (track.mode === 'disabled' || !track.activeCues) return;
      const cues = [...track.activeCues];
      if (!cues.length) return;
      const end = Math.max(...cues.map((c) => c.endTime));
      emit(cues.map((c) => c.text).join(' '), end - video.currentTime);
    });
  }

  function hookVideo(video) {
    if (hooked.has(video)) return;
    hooked.add(video);
    for (const t of video.textTracks) hookTrack(video, t);
    video.textTracks.addEventListener('addtrack', (e) => hookTrack(video, e.track));
  }

  document.addEventListener('play', (e) => { if (e.target instanceof HTMLVideoElement) hookVideo(e.target); }, true);
  document.querySelectorAll('video').forEach(hookVideo);

  // ---------- source 2: captions rendered into the DOM ----------

  let domSource = null;

  function readDom({ container, line }) {
    let parts;
    if (line) {
      const root = document.querySelector(container);
      parts = root ? [...root.querySelectorAll(line)] : [];
    } else {
      // A picked selector may match one element per subtitle line.
      parts = [...document.querySelectorAll(container)];
    }
    return parts.map((el) => el.innerText).join(' ').replace(/\s+/g, ' ').trim();
  }

  // Rolling captions (YouTube auto-generated) grow word by word and scroll old lines away,
  // so the new text often starts with the tail of the old one. Return only the words after
  // that overlap. A single shared word is not trusted unless it is the whole previous text.
  function newWords(prev, next) {
    const a = prev.split(' ').filter(Boolean);
    const b = next.split(' ').filter(Boolean);
    for (let k = Math.min(a.length, b.length); k >= 1; k--) {
      if (k < 2 && k !== a.length) break;
      if (a.slice(a.length - k).join(' ') === b.slice(0, k).join(' ')) return b.slice(k).join(' ');
    }
    return next;
  }

  function startDomSource(spec) {
    stopDomSource();
    let seen = '';
    let timer = null;
    const check = () => {
      const text = readDom(spec);
      if (text === seen) return;
      const delta = text ? newWords(seen, text) : '';
      seen = text;
      if (delta) emit(delta, 0);
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      // Wait for the line to settle so we do not read half-rendered text.
      timer = setTimeout(check, 250);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    domSource = { observer, cancel: () => clearTimeout(timer) };
  }

  function stopDomSource() {
    if (!domSource) return;
    domSource.observer.disconnect();
    domSource.cancel();
    domSource = null;
  }

  function refreshDomSource() {
    const picked = selectors[location.hostname];
    const site = SITE_SOURCES.find((s) => s.host.test(location.hostname));
    if (picked) startDomSource({ container: picked });
    else if (site) startDomSource(site);
    else stopDomSource();
  }

  // ---------- source 3: OCR for subtitles burned into the picture ----------

  // Hard subtitles exist only as pixels. Sample the bottom of the frame and keep the light
  // glyphs that a dark outline walls in, which is how subtitles are drawn and bright scenery
  // is not. OCR the text found there once it has changed and then held still.
  const OCR_INTERVAL_MS = 300;
  const OCR_REGION = 0.25; // bottom share of the frame that holds subtitles
  const OCR_HEIGHT = 720; // frames are scaled to this height so glyph sizes are predictable
  const MAX_GLYPH_HEIGHT = 70; // px at OCR_HEIGHT; a taller light blob is scenery
  const MAX_GLYPH_WIDTH = 200; // px at OCR_HEIGHT; wide enough for letters that touch
  const DARK_EDGE = 110; // luminance below which a pixel counts as outline
  const OUTLINE_REACH = 3; // px past a glyph's border to look for its outline
  const MIN_ENCLOSED = 0.6; // share of a glyph's border that must be outline
  const MIN_BLOB = 4; // px; smaller light specks are compression noise, not even a diacritic
  const MIN_TEXT_PIXELS = 300; // fewer than this means no subtitle on screen
  const MIN_LINE_CONFIDENCE = 60;
  const CELL = 8; // change detection compares masks in CELL x CELL blocks

  let ocrSites = {};
  let ocrTimer = null;
  let ocr = null;
  let frameCtx = null;
  const ocrBlocked = new WeakSet();

  function siteHost() {
    // Inside a player iframe, the setting belongs to the page the user is on.
    const origins = location.ancestorOrigins;
    return window !== window.top && origins && origins.length
      ? new URL(origins[origins.length - 1]).hostname
      : location.hostname;
  }

  function ocrEnabled() {
    const choice = ocrSites[siteHost()];
    return choice === undefined ? OCR_DEFAULT_HOSTS.test(siteHost()) : choice;
  }

  function captureStrip(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = OCR_HEIGHT / vh;
    const sy = Math.floor(vh * (1 - OCR_REGION));
    const w = Math.round(vw * scale);
    const h = Math.round((vh - sy) * scale);
    frameCtx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const canvas = frameCtx.canvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    frameCtx.drawImage(video, 0, sy, vw, vh - sy, 0, 0, w, h);
    // Throws a SecurityError when a cross-origin video without CORS has tainted the canvas.
    return frameCtx.getImageData(0, 0, w, h);
  }

  const DX = [-1, 1, 0, 0];
  const DY = [0, 0, -1, 1];

  // A glyph is a small blob of light pixels walled in by its dark outline. Bright scenery is
  // either too big to be a glyph or not walled in by dark pixels, so it is dropped.
  function textMask({ width: w, height: h, data }) {
    const n = w * h;
    const lum = new Uint8Array(n);
    const light = new Uint8Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      lum[p] = 0.299 * r + 0.587 * g + 0.114 * b;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      // White or light grey glyphs, or the yellow some fansub groups use. The bar is low
      // enough for thin diacritics, which video compression dims, and high enough that the
      // blurred middle of an outline does not bridge a glyph to bright scenery behind it.
      light[p] = (lum[p] > 150 && spread < 80) || (r > 170 && g > 150 && b < 120) ? 1 : 0;
    }

    // Across a glyph's border there is first a soft rim and then the outline, so look a few
    // pixels outwards for the dark.
    const outlineBeyond = (x, y, k) => {
      for (let step = 1; step <= OUTLINE_REACH; step++) {
        const nx = x + DX[k] * step;
        const ny = y + DY[k] * step;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) return false;
        if (lum[ny * w + nx] < DARK_EDGE) return true;
      }
      return false;
    };

    const keep = new Uint8Array(n);
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const blob = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (!light[start] || seen[start]) continue;
      seen[start] = 1;
      stack[0] = start;
      let top = 1;
      let size = 0;
      let edges = 0;
      let darkEdges = 0;
      let x0 = w;
      let x1 = -1;
      let y0 = h;
      let y1 = -1;
      while (top) {
        const p = stack[--top];
        blob[size++] = p;
        const x = p % w;
        const y = (p - x) / w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (let k = 0; k < 4; k++) {
          const nx = x + DX[k];
          const ny = y + DY[k];
          // The strip border counts as an edge that is not dark.
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            edges++;
            continue;
          }
          const q = ny * w + nx;
          if (light[q]) {
            if (!seen[q]) {
              seen[q] = 1;
              stack[top++] = q;
            }
          } else {
            edges++;
            if (outlineBeyond(x, y, k)) darkEdges++;
          }
        }
      }
      const glyph = size >= MIN_BLOB
        && y1 - y0 < MAX_GLYPH_HEIGHT
        && x1 - x0 < MAX_GLYPH_WIDTH
        && darkEdges >= edges * MIN_ENCLOSED;
      if (glyph) for (let i = 0; i < size; i++) keep[blob[i]] = 1;
    }

    // Ink is the darkness to draw on white for Tesseract: white text becomes black, the
    // anti-aliased rim stays grey so glyph shapes survive. 0 means background.
    const ink = new Uint8Array(n);
    const gw = Math.ceil(w / CELL);
    const grid = new Uint16Array(gw * Math.ceil(h / CELL));
    const box = { x0: w, y0: h, x1: -1, y1: -1 };
    let count = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!keep[p]) continue;
        ink[p] = Math.max(1, Math.min(255, Math.round((lum[p] - 120) * 2.55)));
        count++;
        grid[Math.floor(y / CELL) * gw + Math.floor(x / CELL)]++;
        if (x < box.x0) box.x0 = x;
        if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y;
        if (y > box.y1) box.y1 = y;
      }
    }
    return { ink, w, count, grid, box };
  }

  // 0 when two masks are identical, 1 when they share nothing.
  function maskDiff(a, b) {
    if (a.length !== b.length) return 1;
    let diff = 0;
    let total = 0;
    for (let i = 0; i < a.length; i++) {
      diff += Math.abs(a[i] - b[i]);
      total += a[i] + b[i];
    }
    return total ? diff / total : 0;
  }

  // Dark glyphs on white, cropped to the text: the input Tesseract reads best.
  function maskToDataUrl({ ink, w, box }) {
    const pad = 16;
    const cw = box.x1 - box.x0 + 1 + pad * 2;
    const ch = box.y1 - box.y0 + 1 + pad * 2;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(cw, ch);
    out.data.fill(255);
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        const v = ink[y * w + x];
        if (!v) continue;
        const o = ((y - box.y0 + pad) * cw + (x - box.x0 + pad)) * 4;
        out.data[o] = 255 - v;
        out.data[o + 1] = 255 - v;
        out.data[o + 2] = 255 - v;
      }
    }
    ctx.putImageData(out, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // Dual-language hard subs put a line Tesseract cannot read next to the Vietnamese one;
  // it comes back as low-confidence noise, so keep only lines it is sure about.
  function ocrText(result) {
    return result.lines
      .filter((line) => line.confidence >= MIN_LINE_CONFIDENCE && /\p{L}{2}/u.test(line.text))
      .map((line) => line.text)
      .join(' ');
  }

  // Normalised edit similarity: OCR of the same subtitle differs by a character or two
  // between frames, and that must not be read twice.
  function similarity(a, b) {
    if (!a || !b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  function sendToExtension(msg) {
    // After the extension is reloaded, this old content script can no longer reach it.
    if (!chrome.runtime.id) {
      stopOcr();
      return Promise.reject(new Error('extension was reloaded; refresh the page'));
    }
    return chrome.runtime.sendMessage(msg);
  }

  function reportOcrError(state, err) {
    console.error('Win Voice Over: OCR failed', err);
    if (state.errorShown) return;
    state.errorShown = true;
    toast('Win Voice Over: OCR failed, see the console');
  }

  function ocrTick() {
    const state = ocr;
    const video = activeVideo();
    if (!video || video.paused || video.readyState < 2 || ocrBlocked.has(video)) return;
    // JW Player flags its container while an ad plays; ads are not worth reading.
    if (video.closest('.jw-flag-ads')) return;

    if (!state.warmed) {
      // Start the OCR engine now: it takes a moment to load and the first line should not wait.
      state.warmed = true;
      sendToExtension({ type: 'ocr-warmup' })
        .then((result) => { if (result && result.error) throw new Error(result.error); })
        .catch((err) => reportOcrError(state, err));
    }

    let frame;
    try {
      const strip = captureStrip(video);
      if (!strip) return;
      frame = textMask(strip);
    } catch (err) {
      ocrBlocked.add(video);
      console.error('Win Voice Over: cannot read frames from this video', err);
      toast('Win Voice Over: this video blocks frame capture, OCR is off for it');
      return;
    }

    if (frame.count < MIN_TEXT_PIXELS) {
      // The subtitle is gone: the next one is new even if it repeats the same words.
      state.prev = null;
      state.read = null;
      state.lastText = '';
      return;
    }
    const steady = state.prev && maskDiff(frame.grid, state.prev) < 0.15;
    state.prev = frame.grid;
    if (!steady || state.busy) return;
    if (state.read && maskDiff(frame.grid, state.read) < 0.3) return;

    state.read = frame.grid;
    state.busy = true;
    sendToExtension({ type: 'ocr', image: maskToDataUrl(frame) })
      .then((result) => {
        if (result.error) throw new Error(result.error);
        const text = ocrText(result);
        if (!text || similarity(text, state.lastText) >= 0.8) return;
        state.lastText = text;
        emit(text, 0);
      })
      .catch((err) => reportOcrError(state, err))
      .finally(() => { state.busy = false; });
  }

  function stopOcr() {
    clearInterval(ocrTimer);
    ocrTimer = null;
  }

  function refreshOcr() {
    stopOcr();
    ocr = { prev: null, read: null, lastText: '', busy: false, warmed: false, errorShown: false };
    if (settings.enabled && ocrEnabled()) ocrTimer = setInterval(ocrTick, OCR_INTERVAL_MS);
  }

  // ---------- on-page toast ----------

  function toast(message, ms = 1500) {
    if (window !== window.top) return;
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;'
      + 'background:rgba(20,20,20,.88);color:#fff;font:14px/1.4 system-ui,sans-serif;padding:8px 14px;'
      + 'border-radius:8px;pointer-events:none';
    (document.fullscreenElement || document.body).appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ---------- picker: let the user click the subtitle element once per site ----------

  let picking = null;

  function buildSelector(el) {
    const stable = (c) => !/\d{3,}/.test(c);
    const parts = [];
    for (let node = el; node && node !== document.body && parts.length < 3; node = node.parentElement) {
      const classes = [...node.classList].filter(stable).map((c) => '.' + CSS.escape(c)).join('');
      parts.unshift(node.tagName.toLowerCase() + classes);
      if (classes) break;
    }
    return parts.join(' > ');
  }

  function startPicker() {
    if (picking) return;
    let hovered = null;
    const outline = (el) => {
      if (hovered) hovered.style.outline = hovered.dataset.winVoiceOverOutline || '';
      hovered = el;
      if (el) {
        el.dataset.winVoiceOverOutline = el.style.outline;
        el.style.outline = '2px solid #f5a623';
      }
    };
    const onOver = (e) => outline(e.target);
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const selector = buildSelector(e.target);
      stopPicker();
      chrome.storage.sync.set({ selectors: { ...selectors, [location.hostname]: selector } });
      toast('Win Voice Over: subtitle element saved for ' + location.hostname);
    };
    const onKey = (e) => { if (e.key === 'Escape') stopPicker(); };
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    picking = () => {
      outline(null);
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
    toast('Win Voice Over: pause on a subtitle line, then click it (Esc to cancel)');
  }

  function stopPicker() {
    if (!picking) return;
    picking();
    picking = null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'pick') startPicker();
  });

  // ---------- settings ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.settings) {
      const wasEnabled = settings.enabled;
      settings = { ...DEFAULTS, ...changes.settings.newValue };
      // A changed voice, model or engine deserves a fresh error report if it fails too.
      geminiErrorShown = false;
      if (!settings.enabled) stopSpeaking();
      if (wasEnabled !== settings.enabled) {
        refreshOcr();
        if (document.querySelector('video')) toast(settings.enabled ? 'Win Voice Over: on' : 'Win Voice Over: off');
      }
    }
    if (changes.selectors) {
      selectors = changes.selectors.newValue || {};
      stopPicker();
      refreshDomSource();
    }
    if (changes.ocrSites) {
      ocrSites = changes.ocrSites.newValue || {};
      refreshOcr();
    }
  });

  chrome.storage.sync.get(['settings', 'selectors', 'ocrSites']).then((stored) => {
    settings = { ...DEFAULTS, ...stored.settings };
    selectors = stored.selectors || {};
    ocrSites = stored.ocrSites || {};
    refreshDomSource();
    refreshOcr();
  });
})();
