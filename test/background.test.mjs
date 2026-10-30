// Usage: node test/background.test.mjs
// Runs the real extension/background.js in a VM with fake chrome + fetch, and checks the
// Gemini request shape, response parsing, caching, prefetch and every error path.
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
  console, setTimeout, clearTimeout, AbortController, Blob, atob, Uint8Array, JSON, Promise, Error, String, Boolean,
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

console.log('\nall background checks passed');
