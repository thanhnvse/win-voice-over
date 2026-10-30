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

// Gemini TTS runs here, not in the page, so the API key never enters a page's process.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_TIMEOUT_MS = 15000;
const TTS_CACHE_SIZE = 100;
// Recent results keyed by model, voice, style and text: a prefetched line and a repeated
// line are answered from here instead of a second request.
const ttsCache = new Map();

async function requestGemini({ model, voice, style, text, apiKey }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(GEMINI_URL, {
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
      signal: controller.signal,
    });
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
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Gemini TTS timed out after ${GEMINI_TIMEOUT_MS / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// fresh skips the cache read, so the popup's test shows a real round-trip time.
async function synthesize(text, { fresh = false } = {}) {
  const [{ settings = {} }, { geminiApiKey }] = await Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.local.get('geminiApiKey'),
  ]);
  if (!geminiApiKey) throw new Error('no Gemini API key; add one in the popup');
  const { geminiModel: model, geminiVoice: voice, geminiStyle: style } = { ...WVO.DEFAULTS, ...settings };
  const key = JSON.stringify([model, voice, style, text]);
  let pending = fresh ? null : ttsCache.get(key);
  if (pending) {
    ttsCache.delete(key);
  } else {
    pending = requestGemini({ model, voice, style, text, apiKey: geminiApiKey });
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
      job.catch((err) => console.warn('Win Voice Over: Gemini prefetch failed', err));
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
