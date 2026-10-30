const mode = new URLSearchParams(location.search).get('mode') || 'dom';
const started = performance.now();
const log = [];
window.__log = log;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (event, extra) => {
  const entry = { t: Math.round(performance.now() - started), event, ...extra };
  log.push(entry);
  document.getElementById('log').textContent += JSON.stringify(entry) + '\n';
};

// Same engine and paths as offscreen.js; the base must be absolute because the worker
// resolves relative paths against its own script URL.
let engine = null;
const ocrEngine = () => (engine ??= createOcrEngine(new URL('../extension/', location.href).href));

const stored = {
  dom: { selectors: { [location.hostname]: '.caption-box' } },
  tracks: {},
  ocr: { ocrSites: { [location.hostname]: true } },
  gemini: { selectors: { [location.hostname]: '.caption-box' }, settings: { engine: 'gemini' } },
  'gemini-error': { selectors: { [location.hostname]: '.caption-box' }, settings: { engine: 'gemini' } },
  azure: { selectors: { [location.hostname]: '.caption-box' }, settings: { engine: 'azure' } },
  'azure-error': { selectors: { [location.hostname]: '.caption-box' }, settings: { engine: 'azure' } },
  vieneu: { selectors: { [location.hostname]: '.caption-box' }, settings: { engine: 'vieneu' } },
  'vieneu-error': { selectors: { [location.hostname]: '.caption-box' }, settings: { engine: 'vieneu' } },
}[mode];
const audioMode = ['gemini', 'azure', 'vieneu'].some((engine) => mode.startsWith(engine));

// A real 24 kHz mono 16-bit WAV, the format Gemini returns, so the page decodes real audio.
function wavBase64(seconds) {
  const rate = 24000;
  const n = Math.round(seconds * rate);
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const ascii = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 8000), true);
  const bytes = new Uint8Array(view.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Stands in for background.js answering { type: 'tts' }: 500 ms of network and generation,
// then audio as long as speech of that text would be. Every engine gets WAV here; the real
// Azure reply is MP3, which the page plays through the same Audio element.
async function fakeEngine(msg) {
  record('tts', { text: msg.text, prefetch: Boolean(msg.prefetch) });
  if (mode === 'vieneu-error') return msg.prefetch ? {} : { error: 'VieNeu is not reachable at 127.0.0.1:8000' };
  if (mode.endsWith('-error')) {
    const name = mode.startsWith('azure') ? 'Azure' : 'Gemini';
    return msg.prefetch ? {} : { error: `no ${name} API key; add one in the popup` };
  }
  if (msg.prefetch) return {};
  await sleep(500);
  return { data: wavBase64(Math.max(0.6, msg.text.length / 14)), mimeType: 'audio/wav' };
}

window.chrome = {
  storage: {
    sync: {
      get: async () => stored,
      set: async (value) => { window.__stored = value; },
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    id: 'harness',
    // Exposed so a test can send { type: 'pick' } the way the popup does.
    onMessage: { addListener(fn) { window.__onMessage = fn; } },
    // Stands in for background.js + offscreen.js.
    async sendMessage(msg) {
      if (msg.type === 'tts') return fakeEngine(msg);
      if (msg.type === 'ocr-warmup') {
        ocrEngine();
        record('warmup');
        return {};
      }
      if (msg.type !== 'ocr') return undefined;
      const t0 = performance.now();
      const result = await ocrEngine().recognize(msg.image);
      record('ocr', {
        ms: Math.round(performance.now() - t0),
        lines: result.lines.map((l) => `${Math.round(l.confidence)}: ${l.text}`),
      });
      (window.__images ??= []).push(msg.image);
      return result;
    },
  },
};

// A real <audio>, so the WAV really decodes and reports its duration; only play() and pause()
// are faked, because the harness has no user gesture and real autoplay would be refused.
const RealAudio = window.Audio;
window.Audio = function FakeAudio(src) {
  const audio = new RealAudio(src);
  const realPause = audio.pause.bind(audio);
  audio.play = () => {
    record('audio-play', {
      seconds: +audio.duration.toFixed(2),
      rate: +audio.playbackRate.toFixed(2),
      preservesPitch: audio.preservesPitch,
      volume: +video.volume.toFixed(2),
    });
    audio.fakeTimer = setTimeout(() => {
      record('audio-ended');
      audio.dispatchEvent(new Event('ended'));
    }, (audio.duration / audio.playbackRate) * 1000);
    return Promise.resolve();
  };
  audio.pause = () => {
    clearTimeout(audio.fakeTimer);
    record('audio-paused');
    realPause();
  };
  return audio;
};

// Records the extension's on-page toasts.
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.textContent && node.textContent.startsWith('Win Voice Over')) record('toast', { text: node.textContent });
    }
  }
}).observe(document.body, { childList: true });

// Plays one utterance at a time, like the real engine, at roughly 14 chars per second.
const video = document.getElementById('video');
const fake = {
  queue: [],
  current: null,
  get speaking() { return !!this.current; },
  get pending() { return this.queue.length > 0; },
  getVoices: () => [],
  speak(u) {
    this.queue.push(u);
    record('queued', { text: u.text, rate: +u.rate.toFixed(2), volume: +video.volume.toFixed(2) });
    if (!this.current) this.next();
  },
  next() {
    const u = this.queue.shift();
    this.current = u || null;
    if (!u) return;
    const ms = (u.text.length / 14 / u.rate) * 1000;
    u.timer = setTimeout(() => {
      record('spoken', { text: u.text });
      this.current = null;
      if (u.onend) u.onend();
      this.next();
    }, ms);
  },
  cancel() {
    const dropped = [this.current, ...this.queue].filter(Boolean);
    this.queue = [];
    this.current = null;
    for (const u of dropped) {
      clearTimeout(u.timer);
      record('cancelled', { text: u.text });
      if (u.onerror) u.onerror();
    }
  },
};
Object.defineProperty(window, 'speechSynthesis', { value: fake });

// No media file needed: record a canvas into a webm blob. `draw` gets seconds since start.
async function makeVideo({ width, height, seconds, draw }) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const t0 = performance.now();
  const timer = setInterval(() => draw(ctx, (performance.now() - t0) / 1000), 50);
  rec.start();
  await sleep(seconds * 1000);
  rec.stop();
  await new Promise((r) => { rec.onstop = r; });
  clearInterval(timer);
  video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  await new Promise((r) => { video.onloadedmetadata = r; });
}

const plainScene = (ctx) => {
  ctx.fillStyle = `hsl(${Date.now() % 360},60%,40%)`;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
};

// Burned-in subtitles over a moving background, with a bright box crossing the subtitle
// area the whole time so scenery noise is exercised too.
const HARD_SUBS = [
  { from: 1.0, to: 3.5, color: '#ffffff', lines: ['Hôm nay trời đẹp quá, mình đi dạo nhé.'] },
  { from: 4.0, to: 6.5, color: '#ffe14d', lines: ['Anh có chắc là chuyện này sẽ ổn không?'] },
  { from: 7.0, to: 10.0, color: '#ffffff', lines: ['Ta sẽ không bao giờ quên', 'những gì người đã làm cho ta.'] },
];

const hardSubScene = (ctx, t) => {
  const { width: w, height: h } = ctx.canvas;
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${(t * 40) % 360},45%,30%)`);
  bg.addColorStop(1, `hsl(${(t * 40 + 120) % 360},35%,55%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(((t * 140) % (w + 200)) - 200, h - 110, 180, 90);
  ctx.fillStyle = '#151515';
  ctx.fillRect(((t * 90) % (w + 200)) - 200, h - 150, 120, 40);

  const sub = HARD_SUBS.find((s) => t >= s.from && t < s.to);
  if (!sub) return;
  ctx.font = 'bold 30px Arial';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = sub.color;
  sub.lines.forEach((line, i) => {
    const y = h - 30 - (sub.lines.length - 1 - i) * 38;
    ctx.strokeText(line, w / 2, y);
    ctx.fillText(line, w / 2, y);
  });
};

// Captured from a real YouTube auto-generated caption window, one update per second.
const DOM_LINES = [
  'Cerebral anemia causes',
  'Cerebral anemia causes vestibular disorders, dizziness',
  'vestibular disorders, dizziness , blurred vision,',
  'vestibular disorders, dizziness , blurred vision, loss of balance, lightheadedness',
  'loss of balance, lightheadedness , a spinning sensation',
  'where everything around you tilts, sways, or feels',
  'around you tilts, sways, or feels like you are floating, rising',
  '',
  '[music]',
  'Xin chào các bạn, hôm nay chúng ta học tiếng Việt.',
];

async function run() {
  if (mode === 'ocr') {
    await makeVideo({ width: 960, height: 540, seconds: 12, draw: hardSubScene });
  } else {
    await makeVideo({ width: 160, height: 90, seconds: 12, draw: plainScene });
  }
  video.volume = 0.8;
  if (mode === 'tracks') {
    const track = video.addTextTrack('subtitles', 'Vietnamese', 'vi');
    track.mode = 'hidden';
    track.addCue(new VTTCue(0.5, 2.5, '<i>Xin chào</i> các bạn.'));
    track.addCue(new VTTCue(3.0, 4.0, 'Câu này rất dài nên phải đọc nhanh hơn bình thường mới kịp.'));
    track.addCue(new VTTCue(4.5, 6.0, '♪ ♪'));
    track.addCue(new VTTCue(6.5, 9.0, '- Tạm biệt!'));
  }
  record('play');
  await video.play();
  if (mode === 'dom' || audioMode) {
    const box = document.querySelector('.caption-box');
    DOM_LINES.forEach((text, i) => setTimeout(() => { box.textContent = text; }, i * 1000));
  }
  // Pause near the end to check that pausing silences speech and restores the volume.
  setTimeout(() => { record('pause'); video.pause(); }, 10500);
  setTimeout(() => { record('done', { volume: +video.volume.toFixed(2) }); window.__done = true; }, 11500);
}

// Same order as the manifest's content_scripts list.
function load(src) {
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: reject });
    document.body.appendChild(script);
  });
}
load('../extension/shared.js').then(() => load('../extension/content.js')).then(run);
