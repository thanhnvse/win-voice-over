const { DEFAULTS, OCR_DEFAULT_HOSTS, GEMINI_MODELS, GEMINI_VOICES } = WVO;
const TEST_LINE = 'Xin chào, đây là giọng đọc phụ đề.';
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };

function save() {
  chrome.storage.sync.set({ settings });
}

function render() {
  $('enabled').checked = settings.enabled;
  $('engine').value = settings.engine;
  $('gemini').hidden = settings.engine !== 'gemini';
  $('voiceRole').textContent = settings.engine === 'gemini' ? 'used if Gemini fails' : '';
  $('geminiModel').value = settings.geminiModel;
  $('geminiVoice').value = settings.geminiVoice;
  $('geminiStyle').value = settings.geminiStyle;
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

function fillGemini() {
  for (const m of GEMINI_MODELS) $('geminiModel').add(new Option(m.label, m.id));
  for (const [name, character] of GEMINI_VOICES) $('geminiVoice').add(new Option(`${name} (${character})`, name));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

$('enabled').addEventListener('change', (e) => { settings.enabled = e.target.checked; save(); });
$('engine').addEventListener('change', (e) => { settings.engine = e.target.value; render(); save(); });
$('geminiModel').addEventListener('change', (e) => { settings.geminiModel = e.target.value; save(); });
$('geminiVoice').addEventListener('change', (e) => { settings.geminiVoice = e.target.value; save(); });
$('geminiStyle').addEventListener('change', (e) => {
  settings.geminiStyle = e.target.value.trim() || DEFAULTS.geminiStyle;
  render();
  save();
});
$('voice').addEventListener('change', (e) => { settings.voiceURI = e.target.value; save(); });
$('rate').addEventListener('input', (e) => { settings.rate = Number(e.target.value); render(); save(); });
$('duck').addEventListener('input', (e) => { settings.duck = Number(e.target.value); render(); save(); });

// The key lives in storage.local: it is never synced to the user's other browsers.
function showKeyStatus(saved) {
  $('keyStatus').textContent = saved ? 'Key saved on this device.' : 'No key yet.';
}

$('geminiKey').addEventListener('change', async (e) => {
  const geminiApiKey = e.target.value.trim();
  if (geminiApiKey) await chrome.storage.local.set({ geminiApiKey });
  else await chrome.storage.local.remove('geminiApiKey');
  e.target.value = '';
  showKeyStatus(Boolean(geminiApiKey));
});

function testBrowserVoice() {
  const u = new SpeechSynthesisUtterance(TEST_LINE);
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === settings.voiceURI);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'vi-VN';
  u.rate = settings.rate;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

async function testGemini() {
  const status = $('testStatus');
  status.textContent = 'Generating with Gemini…';
  const started = performance.now();
  try {
    // fresh: skip the cache so the time shown is a real round trip.
    const result = await chrome.runtime.sendMessage({ type: 'tts', text: TEST_LINE, fresh: true });
    if (!result || result.error) throw new Error(result ? result.error : 'no reply from the background worker');
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const audio = new Audio(URL.createObjectURL(WVO.audioBlob(result)));
    audio.onended = () => URL.revokeObjectURL(audio.src);
    await audio.play();
    status.textContent = `Generated in ${seconds} s.`;
  } catch (err) {
    status.textContent = `Gemini failed: ${err.message}`;
  }
}

$('test').addEventListener('click', () => {
  if (settings.engine === 'gemini') testGemini();
  else testBrowserVoice();
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

fillGemini();
chrome.storage.local.get('geminiApiKey').then(({ geminiApiKey }) => showKeyStatus(Boolean(geminiApiKey)));
chrome.storage.sync.get(['settings', 'ocrSites']).then(async ({ settings: stored, ocrSites = {} }) => {
  settings = { ...DEFAULTS, ...stored };
  render();
  fillVoices();
  const host = await siteHost();
  $('ocr').disabled = !host;
  $('ocr').checked = host ? (ocrSites[host] ?? OCR_DEFAULT_HOSTS.test(host)) : false;
});
speechSynthesis.addEventListener('voiceschanged', fillVoices);
