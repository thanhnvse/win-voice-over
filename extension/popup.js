const DEFAULTS = { enabled: true, voiceURI: '', rate: 1.1, duck: 0.3 };
// Keep in sync with OCR_DEFAULT_HOSTS in content.js.
const OCR_DEFAULT_HOSTS = /motchill/i;
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };

function save() {
  chrome.storage.sync.set({ settings });
}

function render() {
  $('enabled').checked = settings.enabled;
  $('rate').value = settings.rate;
  $('rateValue').textContent = Number(settings.rate).toFixed(1) + 'x';
  $('duck').value = settings.duck;
  $('duckValue').textContent = Math.round(settings.duck * 100) + '%';
}

function fillVoices() {
  const voices = speechSynthesis.getVoices();
  const vi = voices.filter((v) => v.lang.toLowerCase().startsWith('vi'));
  const others = voices.filter((v) => !vi.includes(v));
  const select = $('voice');
  select.innerHTML = '';
  select.add(new Option('Auto (best Vietnamese voice)', ''));
  for (const v of [...vi, ...others]) select.add(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  select.value = settings.voiceURI;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

$('enabled').addEventListener('change', (e) => { settings.enabled = e.target.checked; save(); });
$('voice').addEventListener('change', (e) => { settings.voiceURI = e.target.value; save(); });
$('rate').addEventListener('input', (e) => { settings.rate = Number(e.target.value); render(); save(); });
$('duck').addEventListener('input', (e) => { settings.duck = Number(e.target.value); render(); save(); });

$('test').addEventListener('click', () => {
  const u = new SpeechSynthesisUtterance('Xin chào, đây là giọng đọc phụ đề.');
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === settings.voiceURI);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'vi-VN';
  u.rate = settings.rate;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
});

$('pick').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'pick' });
    window.close();
  } catch {
    // No content script in the tab: it was open before the extension was installed.
    $('pick').textContent = 'Reload the page first, then try again';
  }
});

$('clear').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || !tab.url) return;
  const host = new URL(tab.url).hostname;
  const { selectors = {} } = await chrome.storage.sync.get('selectors');
  delete selectors[host];
  await chrome.storage.sync.set({ selectors });
  $('clear').textContent = 'Forgotten for ' + host;
});

async function siteHost() {
  const tab = await activeTab();
  return tab && /^https?:/.test(tab.url || '') ? new URL(tab.url).hostname : '';
}

$('ocr').addEventListener('change', async (e) => {
  const host = await siteHost();
  if (!host) return;
  const { ocrSites = {} } = await chrome.storage.sync.get('ocrSites');
  await chrome.storage.sync.set({ ocrSites: { ...ocrSites, [host]: e.target.checked } });
});

chrome.storage.sync.get(['settings', 'ocrSites']).then(async ({ settings: stored, ocrSites = {} }) => {
  settings = { ...DEFAULTS, ...stored };
  render();
  fillVoices();
  const host = await siteHost();
  $('ocr').disabled = !host;
  $('ocr').checked = host ? (ocrSites[host] ?? OCR_DEFAULT_HOSTS.test(host)) : false;
});
speechSynthesis.addEventListener('voiceschanged', fillVoices);
