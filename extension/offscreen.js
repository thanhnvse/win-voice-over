const engine = createOcrEngine(chrome.runtime.getURL('/'));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.type !== 'ocr') return undefined;
  engine.recognize(msg.image).then(
    sendResponse,
    (err) => sendResponse({ error: String((err && err.message) || err) }),
  );
  return true;
});
