const {
  DEFAULTS, OCR_DEFAULT_HOSTS, AUDIO_ENGINES, GEMINI_MODELS, GEMINI_VOICES, AZURE_VOICES, VIENEU_VOICES,
} = WVO;
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
  $('azure').hidden = settings.engine !== 'azure';
  $('vieneu').hidden = settings.engine !== 'vieneu';
  const audioEngine = AUDIO_ENGINES[settings.engine];
  $('voiceRole').textContent = audioEngine ? `used if ${audioEngine} fails` : '';
  $('geminiModel').value = settings.geminiModel;
  $('geminiVoice').value = settings.geminiVoice;
  $('geminiStyle').value = settings.geminiStyle;
  $('azureRegion').value = settings.azureRegion;
  $('azureVoice').value = settings.azureVoice;
  $('vieneuVoice').value = settings.vieneuVoice;
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

function fillEngineVoices() {
  for (const m of GEMINI_MODELS) $('geminiModel').add(new Option(m.label, m.id));
  for (const [name, character] of GEMINI_VOICES) $('geminiVoice').add(new Option(`${name} (${character})`, name));
  for (const [id, label] of AZURE_VOICES) $('azureVoice').add(new Option(label, id));
  for (const [name, character] of VIENEU_VOICES) $('vieneuVoice').add(new Option(`${name} (${character})`, name));
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
// The portal shows the region as 'southeastasia', but a pasted 'Southeast Asia' means the same.
$('azureRegion').addEventListener('change', (e) => {
  settings.azureRegion = e.target.value.toLowerCase().replace(/\s+/g, '') || DEFAULTS.azureRegion;
  render();
  save();
});
$('azureVoice').addEventListener('change', (e) => { settings.azureVoice = e.target.value; save(); });
$('vieneuVoice').addEventListener('change', (e) => { settings.vieneuVoice = e.target.value; save(); });
$('voice').addEventListener('change', (e) => { settings.voiceURI = e.target.value; save(); });
$('rate').addEventListener('input', (e) => { settings.rate = Number(e.target.value); render(); save(); });
$('duck').addEventListener('input', (e) => { settings.duck = Number(e.target.value); render(); save(); });

// Keys live in storage.local: they are never synced to the user's other browsers.
function bindKey(inputId, statusId, keyName) {
  const showStatus = (saved) => { $(statusId).textContent = saved ? 'Key saved on this device.' : 'No key yet.'; };
  $(inputId).addEventListener('change', async (e) => {
    const value = e.target.value.trim();
    if (value) await chrome.storage.local.set({ [keyName]: value });
    else await chrome.storage.local.remove(keyName);
    e.target.value = '';
    showStatus(Boolean(value));
  });
  chrome.storage.local.get(keyName).then((stored) => showStatus(Boolean(stored[keyName])));
}

bindKey('geminiKey', 'keyStatus', 'geminiApiKey');
bindKey('azureKey', 'azureKeyStatus', 'azureApiKey');

function testBrowserVoice() {
  const u = new SpeechSynthesisUtterance(TEST_LINE);
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === settings.voiceURI);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'vi-VN';
  u.rate = settings.rate;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

async function testAudioEngine(name) {
  const status = $('testStatus');
  status.textContent = `Generating with ${name}…`;
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
    status.textContent = `${name} failed: ${err.message}`;
  }
}

$('test').addEventListener('click', () => {
  const audioEngine = AUDIO_ENGINES[settings.engine];
  if (audioEngine) testAudioEngine(audioEngine);
  else testBrowserVoice();
});

// VieNeu runs on this computer, started by the win-voice-over menu bar app (packaging/macos).
const VIENEU_HEALTH = 'http://127.0.0.1:8000/health';

async function vieneuReady() {
  try {
    const response = await fetch(VIENEU_HEALTH, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    // Refused or timed out: in either case there is no server to speak with.
    return false;
  }
}

async function showVieneuStatus() {
  $('vieneuStatus').textContent = (await vieneuReady())
    ? 'Server running on 127.0.0.1:8000.'
    : 'Server not running: open win-voice-over from Applications.';
}

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

fillEngineVoices();
showVieneuStatus();
chrome.storage.sync.get(['settings', 'ocrSites']).then(async ({ settings: stored, ocrSites = {} }) => {
  settings = { ...DEFAULTS, ...stored };
  render();
  fillVoices();
  const host = await siteHost();
  $('ocr').disabled = !host;
  $('ocr').checked = host ? (ocrSites[host] ?? OCR_DEFAULT_HOSTS.test(host)) : false;
});
speechSynthesis.addEventListener('voiceschanged', fillVoices);
