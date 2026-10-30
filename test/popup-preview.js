const params = new URLSearchParams(location.search);
const syncStore = { settings: { engine: params.get('engine') || 'browser' } };
const localStore = {};
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

window.chrome = {
  storage: { sync: area(syncStore), local: area(localStore) },
  tabs: { query: async () => [{ id: 1, url: 'https://motchilltu.com/xem-phim/x/' }], sendMessage: async () => ({}) },
  runtime: {
    // Stands in for background.js: answers the popup's engine test the way a missing key
    // or a stopped VieNeu server would.
    sendMessage: async (msg) => {
      if (msg.type !== 'tts') return {};
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
  document.body.append(...doc.body.childNodes);
  for (const src of ['../extension/shared.js', '../extension/popup.js']) {
    await new Promise((resolve, reject) => {
      document.body.append(Object.assign(document.createElement('script'), { src, onload: resolve, onerror: reject }));
    });
  }
  document.body.dataset.ready = 'true';
})();
