// Usage: node test/background.test.mjs
// Runs the real extension/background.js in a VM with fake chrome + fetch, and checks the
// Gemini, Azure and VieNeu request shapes, response parsing, caching, prefetch and every
// error path.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../extension/', import.meta.url));
let listener = null;
const local = {};
const sync = { settings: { engine: 'gemini', geminiVoice: 'Puck' } };
const calls = [];
let fetchImpl = null;

const sandbox = {
  console, setTimeout, clearTimeout, AbortController, Blob, URL, atob, btoa, Uint8Array, JSON, Promise, Error, String, Boolean,
  fetch: (...args) => { calls.push(args); return fetchImpl(...args); },
  chrome: {
    commands: { onCommand: { addListener() {} } },
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      getContexts: async () => [],
      sendMessage: async () => ({}),
    },
    offscreen: { createDocument: async () => {} },
    storage: {
      sync: { get: async (k) => ({ [k]: sync[k] }) },
      local: { get: async (k) => ({ [k]: local[k] }) },
    },
  },
};
sandbox.globalThis = sandbox;
sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(DIR + file, 'utf8'), ctx);
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(DIR + 'background.js', 'utf8'), ctx);

// Messages are serialised between extension contexts; do the same to the reply.
const send = (msg) => new Promise((resolve) => {
  const async = listener(msg, {}, (reply) => resolve(JSON.parse(JSON.stringify(reply))));
  if (async !== true) setTimeout(() => resolve('<sync>'), 0);
});
const ok = (data = 'UklGRg==') => async () => ({
  ok: true, status: 200,
  json: async () => ({ steps: [
    { type: 'user_input', content: [] },
    { type: 'model_output', content: [{ type: 'text', text: 'x' }, { type: 'audio', data, mime_type: 'audio/wav' }] },
  ] }),
});

// 1. No key: clear error, no request.
fetchImpl = ok();
let r = await send({ type: 'tts', text: 'Xin chào' });
assert.match(r.error, /no Gemini API key/);
assert.equal(calls.length, 0);
console.log('ok  missing key ->', r.error);

// 2. Request shape matches the documented REST example; audio parsed from model_output.
local.geminiApiKey = 'test-key';
r = await send({ type: 'tts', text: 'Xin chào' });
assert.deepEqual(r, { data: 'UklGRg==', mimeType: 'audio/wav' });
const [url, init] = calls[0];
assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
assert.equal(init.method, 'POST');
assert.equal(init.headers['x-goog-api-key'], 'test-key');
const body = JSON.parse(init.body);
assert.equal(body.model, 'gemini-3.8-flash-tts');
assert.equal(body.input[0].type, 'user_input');
assert.equal(body.input[0].content[0].text, 'Xin chào');
assert.equal(body.input[0].content[0].annotations[0].type, 'speech_metadata');
assert.match(body.input[0].content[0].annotations[0].style, /voice actor/);
assert.deepEqual(body.response_format, { type: 'audio', mime_type: 'audio/wav' });
assert.deepEqual(body.generation_config, { speech_config: [{ voice: 'Puck' }] });
console.log('ok  request shape + parsing', JSON.stringify(body).slice(0, 120) + '…');

// 3. Same line again is served from cache; fresh bypasses it.
await send({ type: 'tts', text: 'Xin chào' });
assert.equal(calls.length, 1);
await send({ type: 'tts', text: 'Xin chào', fresh: true });
assert.equal(calls.length, 2);
console.log('ok  cache hit, fresh bypass');

// 4. Prefetch answers at once, then the real request joins the in-flight one.
let release;
fetchImpl = () => new Promise((res) => { release = () => res(ok('QUJD')()); });
const pre = await send({ type: 'tts', text: 'Câu kế tiếp', prefetch: true });
assert.deepEqual(pre, {});
const real = send({ type: 'tts', text: 'Câu kế tiếp' });
while (!release) await new Promise((res) => setTimeout(res, 1));
release();
assert.deepEqual(await real, { data: 'QUJD', mimeType: 'audio/wav' });
assert.equal(calls.length, 3);
console.log('ok  prefetch shares one request');

// 5. HTTP error carries the API message, and the failure is not cached.
fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Resource has been exhausted' } }) });
r = await send({ type: 'tts', text: 'Hết quota' });
assert.equal(r.error, 'Gemini TTS 429: Resource has been exhausted');
fetchImpl = ok();
r = await send({ type: 'tts', text: 'Hết quota' });
assert.equal(r.data, 'UklGRg==');
console.log('ok  429 reported, then retried after recovery');

// 6. A 200 without audio is an error, not silence.
fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }] }) });
r = await send({ type: 'tts', text: 'Không có tiếng' });
assert.equal(r.error, 'Gemini TTS returned no audio');
console.log('ok  missing audio ->', r.error);

// 7. Timeout: the abort becomes a readable error (timer shortened through a fake setTimeout).
sandbox.setTimeout = (fn) => setTimeout(fn, 10);
fetchImpl = (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
r = await send({ type: 'tts', text: 'Chậm quá' });
assert.equal(r.error, 'Gemini TTS timed out after 15 s');
console.log('ok  timeout ->', r.error);

// ---------- Azure ----------
const audioReply = (bytes) => async () => ({
  ok: true, status: 200, text: async () => '', arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

// 8. Azure has its own key: the Gemini key does not count.
sync.settings = { engine: 'azure', azureVoice: 'vi-VN-NamMinhNeural' };
fetchImpl = audioReply([0x49, 0x44, 0x33]);
let before = calls.length;
r = await send({ type: 'tts', text: 'Tom & Jerry <3' });
assert.equal(r.error, 'no Azure API key; add one in the popup');
assert.equal(calls.length, before);
console.log('ok  azure missing key ->', r.error);

// 9. Request shape from the REST reference: regional host, key header, SSML with the text escaped.
local.azureApiKey = 'azure-key';
r = await send({ type: 'tts', text: 'Tom & Jerry <3' });
assert.deepEqual(r, { data: 'SUQz', mimeType: 'audio/mpeg' });
const [azureUrl, azureInit] = calls[before];
assert.equal(azureUrl, 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/v1');
assert.equal(azureInit.method, 'POST');
assert.equal(azureInit.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
assert.equal(azureInit.headers['Content-Type'], 'application/ssml+xml');
assert.equal(azureInit.headers['X-Microsoft-OutputFormat'], 'audio-24khz-48kbitrate-mono-mp3');
assert.equal(azureInit.body,
  "<speak version='1.0' xml:lang='vi-VN'><voice name='vi-VN-NamMinhNeural'>Tom &#38; Jerry &#60;3</voice></speak>");
console.log('ok  azure request shape ->', azureInit.body);

// 10. The cache key includes the engine: a line Gemini already said is a new request for Azure.
before = calls.length;
r = await send({ type: 'tts', text: 'Xin chào' });
assert.equal(r.mimeType, 'audio/mpeg');
assert.equal(calls.length, before + 1);
await send({ type: 'tts', text: 'Xin chào' });
assert.equal(calls.length, before + 1);
console.log('ok  azure cache is separate from gemini');

// 11. A long reply survives the chunked base64 encoding byte for byte.
const big = Array.from({ length: 100000 }, (_, i) => (i * 7) % 256);
fetchImpl = audioReply(big);
r = await send({ type: 'tts', text: 'Một câu rất dài' });
assert.deepEqual([...Buffer.from(r.data, 'base64')], big);
console.log('ok  azure 100 kB reply decodes to the same bytes');

// 12. 401 with an empty body still says what to fix, and is not cached.
fetchImpl = async () => ({ ok: false, status: 401, text: async () => '' });
r = await send({ type: 'tts', text: 'Sai khoá' });
assert.equal(r.error, 'Azure TTS 401: wrong key, or the region is not the one of your Speech resource');
fetchImpl = audioReply([1, 2, 3]);
r = await send({ type: 'tts', text: 'Sai khoá' });
assert.equal(r.data, 'AQID');
console.log('ok  azure 401 explained, then retried');

// 13. An empty 200 is an error, not silence.
fetchImpl = audioReply([]);
r = await send({ type: 'tts', text: 'Im lặng' });
assert.equal(r.error, 'Azure TTS returned no audio');
console.log('ok  azure empty audio ->', r.error);

// 14. A region that is not a plain name never reaches fetch, since it becomes the host name.
sync.settings = { engine: 'azure', azureRegion: 'evil.example.com/x' };
before = calls.length;
r = await send({ type: 'tts', text: 'Vùng lạ' });
assert.match(r.error, /^Azure region "evil\.example\.com\/x" is not valid/);
assert.equal(calls.length, before);
console.log('ok  azure bad region refused without a request');

// 15. Timeout uses the same 15 s budget and names the engine.
sync.settings = { engine: 'azure' };
fetchImpl = (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
r = await send({ type: 'tts', text: 'Chậm quá' });
assert.equal(r.error, 'Azure TTS timed out after 15 s');
console.log('ok  azure timeout ->', r.error);

// 16. A host that does not answer (here a mistyped region) names the host instead of "fetch failed".
fetchImpl = async () => { throw new TypeError('fetch failed'); };
r = await send({ type: 'tts', text: 'Không tới được' });
assert.equal(r.error, 'Azure TTS is not reachable at southeastasia.tts.speech.microsoft.com');
console.log('ok  azure unreachable ->', r.error);

// ---------- VieNeu ----------
// 17. No key at all: the request goes to the loopback server, asking for raw 24 kHz PCM.
sync.settings = { engine: 'vieneu', vieneuVoice: 'Hải Đăng' };
delete local.geminiApiKey;
delete local.azureApiKey;
const pcm = [0x10, 0x00, 0xf0, 0xff, 0x00, 0x7f];
fetchImpl = audioReply(pcm);
before = calls.length;
r = await send({ type: 'tts', text: 'Anh đi đâu vậy?' });
const [vnUrl, vnInit] = calls[before];
assert.equal(vnUrl, 'http://127.0.0.1:8000/v1/audio/speech');
assert.equal(vnInit.method, 'POST');
assert.equal(vnInit.headers['Content-Type'], 'application/json');
assert.deepEqual(JSON.parse(vnInit.body), {
  model: 'vieneu-v3-turbo', input: 'Anh đi đâu vậy?', voice: 'Hải Đăng', response_format: 'pcm', sample_rate: 24000,
});
console.log('ok  vieneu request shape ->', vnInit.body);

// 18. The PCM comes back inside a WAV header that states its real length and format.
assert.equal(r.mimeType, 'audio/wav');
const wav = Buffer.from(r.data, 'base64');
assert.equal(wav.length, 44 + pcm.length);
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
assert.deepEqual([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28),
  wav.readUInt16LE(32), wav.readUInt16LE(34)], [1, 1, 24000, 48000, 2, 16]);
assert.equal(wav.toString('ascii', 36, 40), 'data');
assert.equal(wav.readUInt32LE(40), pcm.length);
assert.deepEqual([...wav.subarray(44)], pcm);
console.log('ok  vieneu pcm wrapped as a 24 kHz mono 16-bit wav');

// 19. The server's JSON error message is passed on.
fetchImpl = async () => ({
  ok: false, status: 400,
  json: async () => ({ error: { message: "unknown voice 'X'; see GET /v1/voices", type: 'invalid_request_error', code: 400 } }),
});
r = await send({ type: 'tts', text: 'Giọng lạ' });
assert.equal(r.error, "VieNeu 400: unknown voice 'X'; see GET /v1/voices");
console.log('ok  vieneu 400 ->', r.error);

// 20. No server running: the message says where it was looked for.
fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
r = await send({ type: 'tts', text: 'Chưa bật' });
assert.equal(r.error, 'VieNeu is not reachable at 127.0.0.1:8000');
console.log('ok  vieneu not running ->', r.error);

// 21. An empty 200 is an error, not silence.
fetchImpl = audioReply([]);
r = await send({ type: 'tts', text: 'Rỗng' });
assert.equal(r.error, 'VieNeu returned no audio');
console.log('ok  vieneu empty audio ->', r.error);

console.log('\nall background checks passed');
