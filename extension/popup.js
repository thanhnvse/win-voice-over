const {
  DEFAULTS, OCR_DEFAULT_HOSTS, AUDIO_ENGINES, MAX_AUDIO_RATE,
  GEMINI_MODELS, GEMINI_VOICES, AZURE_VOICES, VIENEU_VOICES,
} = WVO;
const TEST_LINE = 'Xin chào, đây là giọng đọc phụ đề.';
// A browser voice that never reports its end must not leave Test voice disabled for good.
const BROWSER_TEST_TIMEOUT_MS = 15000;
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };

function save() {
  chrome.storage.sync.set({ settings });
}

// kind is '', 'ok', 'error' or 'busy'; the element's role="status" announces the change.
function setStatus(id, text, kind = '') {
  $(id).textContent = text;
  $(id).dataset.kind = kind;
}

function setRange(id, value, text, spoken) {
  const input = $(id);
  input.value = value;
  input.style.setProperty('--p', (value - Number(input.min)) / (Number(input.max) - Number(input.min)));
  input.setAttribute('aria-valuetext', spoken);
  $(`${id}Value`).textContent = text;
}

function render() {
  $('enabled').checked = settings.enabled;
  $('readingState').textContent = settings.enabled ? 'Reads subtitles aloud' : 'Off';
  $('engine').value = settings.engine;
  for (const el of document.querySelectorAll('[data-engine]')) el.hidden = el.dataset.engine !== settings.engine;
  const audioEngine = AUDIO_ENGINES[settings.engine];
  // With an audio engine the browser voice only reads the lines that engine fails on.
  $('voiceLabel').textContent = audioEngine ? 'Fallback' : 'Voice';
  $('voiceRow').classList.toggle('secondary', Boolean(audioEngine));
  $('voiceRow').title = audioEngine ? `Reads a line when ${audioEngine} fails` : '';
  $('geminiModel').value = settings.geminiModel;
  $('geminiVoice').value = settings.geminiVoice;
  $('geminiStyle').value = settings.geminiStyle;
  $('azureRegion').value = settings.azureRegion;
  $('azureVoice').value = settings.azureVoice;
  $('vieneuVoice').value = settings.vieneuVoice;
  const rate = Number(settings.rate);
  setRange('rate', rate, `${rate.toFixed(1)}x`, `${rate.toFixed(1)} times normal speed`);
  const duck = Math.round(settings.duck * 100);
  setRange('duck', settings.duck, `${duck}%`, `${duck} percent of normal volume`);
  const capped = audioEngine && rate > MAX_AUDIO_RATE ? ` ${audioEngine} plays at ${MAX_AUDIO_RATE}x at most.` : '';
  $('playbackNote').textContent = `Movie at ${duck}% of normal volume while a line is read.${capped}`;
}

// Online voices (Google's in Chrome, the "Online (Natural)" ones in Edge) send the text out;
// the browser says which through localService.
function showBrowserPrivacy() {
  const voice = WVO.pickVoice(speechSynthesis.getVoices(), settings.voiceURI);
  $('browserPrivacy').textContent = !voice
    ? 'This browser has no Vietnamese voice; pick another one above.'
    : voice.localService
      ? `${voice.name} speaks on this device, so subtitle text stays here.`
      : `${voice.name} is an online voice: subtitle text is sent to its provider.`;
}

function fillVoices() {
  const voices = speechSynthesis.getVoices();
  const vi = voices.filter((v) => v.lang.toLowerCase().startsWith('vi'));
  const others = voices.filter((v) => !vi.includes(v));
  const select = $('voice');
  select.innerHTML = '';
  select.add(new Option('Auto (best Vietnamese)', ''));
  for (const v of [...vi, ...others]) select.add(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  select.value = settings.voiceURI;
  showBrowserPrivacy();
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

$('enabled').addEventListener('change', (e) => { settings.enabled = e.target.checked; render(); save(); });
$('engine').addEventListener('change', (e) => {
  settings.engine = e.target.value;
  // A result from the previous engine would read as if it came from this one.
  setStatus('testStatus', '');
  render();
  save();
  if (settings.engine === 'vieneu') showVieneuStatus();
});
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
$('voice').addEventListener('change', (e) => { settings.voiceURI = e.target.value; showBrowserPrivacy(); save(); });
$('rate').addEventListener('input', (e) => { settings.rate = Number(e.target.value); render(); save(); });
$('duck').addEventListener('input', (e) => { settings.duck = Number(e.target.value); render(); save(); });

// Keys live in storage.local: they are never synced to the user's other browsers. The field
// never shows a stored key; it only takes a new one.
const keySaved = {};

function bindKey(engine, keyName) {
  const input = $(`${engine}Key`);
  const statusId = `${engine}KeyStatus`;
  const show = (saved) => {
    keySaved[engine] = saved;
    input.placeholder = saved ? 'Paste a new key to replace it' : 'Paste your key';
    setStatus(statusId, saved ? '✓ Saved on this device' : 'No key yet', saved ? 'ok' : '');
    $(`${engine}KeyRemove`).hidden = !saved;
  };
  const store = async (write, saved) => {
    try {
      await write();
      show(saved);
    } catch (err) {
      setStatus(statusId, `Could not save: ${err.message}`, 'error');
    }
  };
  input.addEventListener('change', () => {
    const value = input.value.trim();
    input.value = '';
    // An emptied field keeps the stored key; Remove is the one way to delete it.
    if (value) store(() => chrome.storage.local.set({ [keyName]: value }), true);
  });
  $(`${engine}KeyRemove`).addEventListener('click', () => {
    store(() => chrome.storage.local.remove(keyName), false);
    setStatus('testStatus', '');
    input.focus();
  });
  chrome.storage.local.get(keyName).then((stored) => show(Boolean(stored[keyName])));
}

bindKey('gemini', 'geminiApiKey');
bindKey('azure', 'azureApiKey');

function testBrowserVoice() {
  const voice = WVO.pickVoice(speechSynthesis.getVoices(), settings.voiceURI);
  const name = voice ? voice.name : 'the browser default voice';
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(TEST_LINE);
    if (voice) u.voice = voice;
    u.lang = voice ? voice.lang : 'vi-VN';
    u.rate = settings.rate;
    let done = false;
    // Only the first outcome counts: cancel() after the timeout also fires onerror.
    const end = (text, kind) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setStatus('testStatus', text, kind);
      resolve();
    };
    const timer = setTimeout(() => {
      end(`${name} did not finish within ${BROWSER_TEST_TIMEOUT_MS / 1000} s.`, 'error');
      speechSynthesis.cancel();
    }, BROWSER_TEST_TIMEOUT_MS);
    u.onend = () => end(voice
      ? `✓ Spoken by ${name}`
      : 'No Vietnamese voice is installed, so the default voice read it.', voice ? 'ok' : 'error');
    u.onerror = (e) => end(`${name} failed: ${e.error}`, 'error');
    setStatus('testStatus', voice ? `Speaking with ${name}…` : 'No Vietnamese voice here; trying the default…', 'busy');
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

function play(audio) {
  return new Promise((resolve, reject) => {
    audio.onended = resolve;
    audio.onerror = () => reject(new Error('the audio could not be played'));
    audio.play().catch(reject);
  });
}

async function testAudioEngine(name) {
  if (settings.engine in keySaved && !keySaved[settings.engine]) {
    setStatus('testStatus', `Paste your ${name} key first.`, 'error');
    return;
  }
  setStatus('testStatus', `Generating with ${name}…`, 'busy');
  const started = performance.now();
  try {
    // fresh: skip the cache so the time shown is a real round trip.
    const result = await chrome.runtime.sendMessage({ type: 'tts', text: TEST_LINE, fresh: true });
    if (!result || result.error) throw new Error(result ? result.error : 'no reply from the background worker');
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const audio = new Audio(URL.createObjectURL(WVO.audioBlob(result)));
    // The same speed a subtitle line starts from; loading resets playbackRate to the default.
    audio.defaultPlaybackRate = audio.playbackRate = Math.min(settings.rate, MAX_AUDIO_RATE);
    setStatus('testStatus', `Generated in ${seconds} s, playing…`, 'busy');
    try {
      await play(audio);
    } finally {
      URL.revokeObjectURL(audio.src);
    }
    setStatus('testStatus', `✓ Generated in ${seconds} s`, 'ok');
  } catch (err) {
    setStatus('testStatus', `${name} failed: ${err.message}`, 'error');
  }
}

// Disabled until the clip ends, so a second click cannot start a second clip over it.
$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  try {
    const audioEngine = AUDIO_ENGINES[settings.engine];
    await (audioEngine ? testAudioEngine(audioEngine) : testBrowserVoice());
  } finally {
    $('test').disabled = false;
  }
});

// VieNeu runs on this computer: win-voice-over.app starts it on macOS, start-vieneu.cmd on Windows.
const VIENEU_HEALTH = 'http://127.0.0.1:8000/health';
const PLATFORM = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform;
const VIENEU_START = /^mac/i.test(PLATFORM)
  ? 'To start it, open win-voice-over from Applications.'
  : /^win/i.test(PLATFORM)
    ? 'To start it, double-click start-vieneu.cmd in the win-voice-over folder.'
    : 'To start it, open win-voice-over.app (macOS) or start-vieneu.cmd (Windows).';

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
  $('vieneuCheck').disabled = true;
  $('vieneuDot').dataset.state = '';
  $('vieneuState').textContent = 'Checking…';
  const up = await vieneuReady();
  $('vieneuDot').dataset.state = up ? 'on' : 'off';
  $('vieneuState').textContent = up ? 'Running' : 'Not running';
  $('vieneuStart').textContent = up ? '' : VIENEU_START;
  $('vieneuCheck').disabled = false;
}

$('vieneuCheck').addEventListener('click', showVieneuStatus);

// ---------- this site ----------

let host = '';

function showPicked(entry) {
  // A pick is { selector, frame }; before 0.6 it was the bare selector.
  const selector = entry && (entry.selector || entry);
  $('clear').disabled = !selector;
  setStatus('siteStatus', selector
    ? `Reads the picked element: ${selector}`
    : 'No pick yet. YouTube and Netflix need none.');
}

async function showSite() {
  const tab = await activeTab();
  host = tab && /^https?:/.test(tab.url || '') ? new URL(tab.url).hostname : '';
  $('host').textContent = host || 'not a web page';
  for (const id of ['ocr', 'pick', 'clear']) $(id).disabled = !host;
  $('siteGroup').classList.toggle('off', !host);
  if (!host) {
    $('ocr').checked = false;
    setStatus('siteStatus', 'Win Voice Over works on web pages only; open the page with the video.');
    return;
  }
  const { ocrSites = {}, selectors = {} } = await chrome.storage.sync.get(['ocrSites', 'selectors']);
  $('ocr').checked = ocrSites[host] ?? OCR_DEFAULT_HOSTS.test(host);
  showPicked(selectors[host]);
}

$('ocr').addEventListener('change', async (e) => {
  const { ocrSites = {} } = await chrome.storage.sync.get('ocrSites');
  await chrome.storage.sync.set({ ocrSites: { ...ocrSites, [host]: e.target.checked } });
});

$('pick').addEventListener('click', async () => {
  const tab = await activeTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'pick' });
    window.close();
  } catch (err) {
    // No content script in the tab: it was open before the extension was installed or reloaded.
    setStatus('siteStatus', /Receiving end does not exist/.test(err.message)
      ? 'This page opened before Win Voice Over loaded. Reload it, then pick again.'
      : `Could not start picking: ${err.message}`, 'error');
  }
});

$('clear').addEventListener('click', async () => {
  const { selectors = {} } = await chrome.storage.sync.get('selectors');
  delete selectors[host];
  await chrome.storage.sync.set({ selectors });
  showPicked(null);
  setStatus('siteStatus', `Forgot the picked element for ${host}.`, 'ok');
});

$('helpButton').addEventListener('click', () => {
  const open = $('help').hidden;
  $('help').hidden = !open;
  $('helpButton').setAttribute('aria-expanded', String(open));
  if (open) $('help').scrollIntoView({ block: 'nearest' });
});

// The shortcut is the user's to change, so show the one Chrome has, not the manifest's.
chrome.commands.getAll().then((commands) => {
  const command = commands.find((c) => c.name === 'toggle-reading');
  $('hotkey').textContent = (command && command.shortcut) || 'Set shortcut';
});
$('hotkey').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

fillEngineVoices();
chrome.storage.sync.get('settings').then(({ settings: stored }) => {
  settings = { ...DEFAULTS, ...stored };
  render();
  fillVoices();
  if (settings.engine === 'vieneu') showVieneuStatus();
});
showSite();
speechSynthesis.addEventListener('voiceschanged', fillVoices);
