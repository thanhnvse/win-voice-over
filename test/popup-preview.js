const params = new URLSearchParams(location.search);
const TAB_HOST = 'motchilltu.com';
const syncStore = { settings: { engine: params.get('engine') || 'browser' } };
const localStore = {};
// ?key=saved starts with both engine keys stored; ?picked=1 with a picked element for the site.
if (params.get('key') === 'saved') Object.assign(localStore, { geminiApiKey: 'g-key', azureApiKey: 'a-key' });
if (params.get('picked')) syncStore.selectors = { [TAB_HOST]: { selector: 'div.sub-text > span', frame: TAB_HOST } };
window.__stores = { sync: syncStore, local: localStore };

const area = (store) => ({
  get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
  set: async (values) => { Object.assign(store, values); },
  remove: async (key) => { delete store[key]; },
});

// A fake VieNeu health check: ?vieneu=running starts with the server up.
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (url !== 'http://127.0.0.1:8000/health') return realFetch(url, init);
  if (params.get('vieneu') !== 'running') throw new TypeError('Failed to fetch');
  return new Response('{"status":"ok"}');
};

// One second of silence as 16-bit mono WAV, base64, the shape background.js answers with.
function silentWav(seconds = 1, rate = 8000) {
  const bytes = new Uint8Array(44 + seconds * rate * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  return btoa(String.fromCharCode(...bytes));
}

window.__ttsCalls = 0;
window.chrome = {
  storage: { sync: area(syncStore), local: area(localStore) },
  tabs: {
    // ?page=settings stands for a tab no content script runs in, such as chrome://settings.
    query: async () => [{ id: 1, url: params.get('page') === 'settings' ? 'chrome://settings/' : `https://${TAB_HOST}/xem-phim/x/` }],
    // ?pick=stale answers the way a tab opened before the extension loaded does.
    sendMessage: async () => {
      if (params.get('pick') === 'stale') throw new Error('Could not establish connection. Receiving end does not exist.');
      return undefined;
    },
    create: async ({ url }) => { window.__opened = url; },
  },
  commands: { getAll: async () => [{ name: 'toggle-reading', shortcut: params.get('shortcut') ?? '⌥⇧R' }] },
  runtime: {
    // Stands in for background.js: answers the popup's engine test the way a missing key
    // or a stopped VieNeu server would, or with a second of silence when ?tts=ok.
    sendMessage: async (msg) => {
      if (msg.type !== 'tts') return {};
      window.__ttsCalls += 1;
      await new Promise((r) => setTimeout(r, 300));
      if (params.get('tts') === 'ok') return { data: silentWav(), mimeType: 'audio/wav' };
      const { engine } = syncStore.settings;
      if (engine === 'vieneu') return { error: 'VieNeu is not reachable at 127.0.0.1:8000' };
      return { error: `no ${engine === 'azure' ? 'Azure' : 'Gemini'} API key; add one in the popup` };
    },
  },
};

// Copy the popup's markup and styles, then run its real scripts in the same order.
(async () => {
  const html = await (await fetch('../extension/popup.html')).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const style of doc.querySelectorAll('style')) document.head.append(style);
  for (const script of doc.querySelectorAll('script')) script.remove();
  // Paths in the popup are relative to extension/.
  for (const img of doc.querySelectorAll('img[src]')) img.setAttribute('src', `../extension/${img.getAttribute('src')}`);
  document.body.append(...doc.body.childNodes);
  for (const src of ['../extension/shared.js', '../extension/popup.js']) {
    await new Promise((resolve, reject) => {
      document.body.append(Object.assign(document.createElement('script'), { src, onload: resolve, onerror: reject }));
    });
  }
  document.body.dataset.ready = 'true';
})();
