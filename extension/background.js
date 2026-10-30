importScripts('shared.js');

const errorText = (err) => String((err && err.message) || err);

// The hotkey only flips the stored flag; every content script reacts to the storage change.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-reading') return;
  const { settings = {} } = await chrome.storage.sync.get('settings');
  const enabled = settings.enabled === false;
  await chrome.storage.sync.set({ settings: { ...settings, enabled } });
});

// OCR runs in an offscreen document, created on the first request and kept afterwards.
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run OCR on subtitles burned into the video picture',
    })
    .finally(() => { creating = null; });
  await creating;
}

// Speech engines run here, not in the page, so an API key never enters a page's process.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const TTS_TIMEOUT_MS = 15000;
const TTS_CACHE_SIZE = 100;
// Recent results keyed by engine, its settings and the text: a prefetched line and a
// repeated line are answered from here instead of a second request.
const ttsCache = new Map();

// The timer also covers reading the body, so a response that stalls halfway still ends.
async function fetchTimed(label, url, init, read) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal }).catch((err) => {
      // fetch rejects with a TypeError when nothing answers: no server, or a mistyped host.
      if (err.name === 'TypeError') throw new Error(`${label} is not reachable at ${new URL(url).host}`);
      throw err;
    });
    return await read(response);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${TTS_TIMEOUT_MS / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requestGemini({ model, voice, style, text, apiKey }) {
  return fetchTimed('Gemini TTS', GEMINI_URL, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [{
        type: 'user_input',
        content: [{
          type: 'text',
          text,
          annotations: [{ type: 'speech_metadata', style }],
        }],
      }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice }] },
    }),
  }, async (response) => {
    // A body that is not JSON still ends in one of the two errors below.
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body && body.error && body.error.message;
      throw new Error(`Gemini TTS ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const audio = ((body && body.steps) || [])
      .filter((step) => step.type === 'model_output')
      .flatMap((step) => step.content || [])
      .filter((part) => part.type === 'audio')
      .pop();
    if (!audio || !audio.data) throw new Error('Gemini TTS returned no audio');
    return { data: audio.data, mimeType: audio.mime_type || 'audio/wav' };
  });
}

// MP3 is a tenth the size of WAV, and every reply crosses two message hops as base64.
const AZURE_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
// Azure often answers an error with an empty body, so the status alone must say what to fix.
const AZURE_HINTS = {
  400: 'the request was rejected',
  401: 'wrong key, or the region is not the one of your Speech resource',
  429: 'too many requests; the free tier allows 20 a minute',
};

const xmlEscape = (s) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

function azureSsml(voice, text) {
  // Control characters are not allowed in XML and would turn the request into a 400.
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  const lang = voice.split('-').slice(0, 2).join('-');
  return `<speak version='1.0' xml:lang='${xmlEscape(lang)}'>`
    + `<voice name='${xmlEscape(voice)}'>${xmlEscape(clean)}</voice></speak>`;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function requestAzure({ region, voice, text, apiKey }) {
  // The region becomes part of the host name, so only a plain region name may pass.
  if (!/^[a-z0-9]+$/.test(region)) {
    throw new Error(`Azure region "${region}" is not valid; copy it from the Azure portal, e.g. southeastasia`);
  }
  return fetchTimed('Azure TTS', `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': AZURE_FORMAT,
    },
    body: azureSsml(voice, text),
  }, async (response) => {
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 200) || AZURE_HINTS[response.status];
      throw new Error(`Azure TTS ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Azure TTS returned no audio');
    return { data: toBase64(bytes), mimeType: 'audio/mpeg' };
  });
}

// VieNeu-TTS (github.com/pnnbao97/VieNeu-TTS) runs on this computer. Its server listens on
// loopback only and needs no key.
const VIENEU_URL = 'http://127.0.0.1:8000/v1/audio/speech';
const VIENEU_RATE = 24000;

// The server's own WAV streams with an unknown length in its header, and the page needs the
// duration to pace the line. So the reply is raw 16-bit PCM, wrapped here with its real length.
function wavFromPcm16(pcm, rate) {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const ascii = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

function requestVieneu({ voice, text }) {
  return fetchTimed('VieNeu', VIENEU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'vieneu-v3-turbo', input: text, voice, response_format: 'pcm', sample_rate: VIENEU_RATE,
    }),
  }, async (response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = body && body.error && body.error.message;
      throw new Error(`VieNeu ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const pcm = new Uint8Array(await response.arrayBuffer());
    if (!pcm.length) throw new Error('VieNeu returned no audio');
    return { data: toBase64(wavFromPcm16(pcm, VIENEU_RATE)), mimeType: 'audio/wav' };
  });
}

// Each engine: the storage.local entry holding its key (none for a local server), and the
// settings it reads.
const ENGINES = {
  gemini: {
    name: 'Gemini',
    keyName: 'geminiApiKey',
    params: (s) => ({ model: s.geminiModel, voice: s.geminiVoice, style: s.geminiStyle }),
    request: requestGemini,
  },
  azure: {
    name: 'Azure',
    keyName: 'azureApiKey',
    params: (s) => ({ region: s.azureRegion, voice: s.azureVoice }),
    request: requestAzure,
  },
  vieneu: {
    name: 'VieNeu',
    keyName: null,
    params: (s) => ({ voice: s.vieneuVoice }),
    request: requestVieneu,
  },
};

// fresh skips the cache read, so the popup's test shows a real round-trip time.
async function synthesize(text, { fresh = false } = {}) {
  const { settings = {} } = await chrome.storage.sync.get('settings');
  const current = { ...WVO.DEFAULTS, ...settings };
  const engine = ENGINES[current.engine];
  if (!engine) throw new Error(`the ${current.engine} engine does not use the background worker`);
  let apiKey;
  if (engine.keyName) {
    ({ [engine.keyName]: apiKey } = await chrome.storage.local.get(engine.keyName));
    if (!apiKey) throw new Error(`no ${engine.name} API key; add one in the popup`);
  }
  const params = engine.params(current);
  const key = JSON.stringify([current.engine, params, text]);
  let pending = fresh ? null : ttsCache.get(key);
  if (pending) {
    ttsCache.delete(key);
  } else {
    pending = engine.request({ ...params, text, apiKey });
    // A failure must not stay cached, or a fixed key or a refilled quota is never retried.
    pending.catch(() => { if (ttsCache.get(key) === pending) ttsCache.delete(key); });
  }
  ttsCache.set(key, pending);
  while (ttsCache.size > TTS_CACHE_SIZE) ttsCache.delete(ttsCache.keys().next().value);
  return pending;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === 'offscreen') return undefined;
  if (msg.type === 'tts') {
    const job = synthesize(msg.text, { fresh: Boolean(msg.fresh) });
    if (msg.prefetch) {
      // A prefetch only warms the cache; the real request for the line reports any failure.
      job.catch((err) => console.warn('Win Voice Over: TTS prefetch failed', err));
      sendResponse({});
      return undefined;
    }
    job.then(sendResponse, (err) => sendResponse({ error: errorText(err) }));
    return true;
  }
  if (msg.type === 'ocr-warmup') {
    // Creating the document is enough: the engine starts loading as soon as it opens.
    ensureOffscreen().then(() => sendResponse({}), (err) => sendResponse({ error: errorText(err) }));
    return true;
  }
  // Content scripts send { type: 'ocr' }; this relays it with target 'offscreen'.
  if (msg.type !== 'ocr') return undefined;
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }))
    .then(sendResponse, (err) => sendResponse({ error: errorText(err) }));
  return true;
});
