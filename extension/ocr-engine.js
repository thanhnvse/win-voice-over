// OCR engine shared by offscreen.js (inside the extension) and test/harness.js.
// Needs vendor/tesseract/tesseract.min.js loaded first, which defines the global `Tesseract`.
function createOcrEngine(baseUrl, { workerBlobURL = false } = {}) {
  const LSTM_ONLY = 1;
  const ready = Tesseract.createWorker('vie', LSTM_ONLY, {
    workerPath: baseUrl + 'vendor/tesseract/worker.min.js',
    corePath: baseUrl + 'vendor/tesseract-core/',
    langPath: baseUrl + 'vendor/lang',
    // A blob: worker would break the extension CSP; load the worker file directly.
    workerBlobURL,
    cacheMethod: 'none',
  }).then(async (worker) => {
    await worker.setParameters({
      // One uniform block of text: a subtitle is one or two centred lines.
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });
    return worker;
  });

  return {
    async recognize(image) {
      const worker = await ready;
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
      const lines = (data.blocks || [])
        .flatMap((block) => block.paragraphs)
        .flatMap((paragraph) => paragraph.lines)
        .map((line) => ({ text: line.text.trim(), confidence: line.confidence }));
      return { text: data.text.trim(), confidence: data.confidence, lines };
    },
  };
}
