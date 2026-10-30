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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === 'offscreen') return undefined;
  if (msg.type === 'ocr-warmup') {
    // Creating the document is enough: the engine starts loading as soon as it opens.
    ensureOffscreen().then(
      () => sendResponse({}),
      (err) => sendResponse({ error: String((err && err.message) || err) }),
    );
    return true;
  }
  // Content scripts send { type: 'ocr' }; this relays it with target 'offscreen'.
  if (msg.type !== 'ocr') return undefined;
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }))
    .then(
      sendResponse,
      (err) => sendResponse({ error: String((err && err.message) || err) }),
    );
  return true;
});
