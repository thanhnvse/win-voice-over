// Exports an Archify HTML diagram to SVG through the viewer's own Export -> SVG button
// (autoTheme: follows light/dark via prefers-color-scheme), without clicking by hand.
// Archify has no CLI command for this, so drive its bundled headless Chrome helper.
//
// Usage: node scripts/export-diagram-svg.mjs docs/win-voice-over.html docs/win-voice-over.svg
// ARCHIFY_HOME overrides where the archify skill lives.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const archifyHome = process.env.ARCHIFY_HOME
  || 'C:/win/source/gui/win-agent/plugins/archify/skills/archify';
const { ChromeVisualBrowser, findChrome } = await import(
  pathToFileURL(path.join(archifyHome, 'bin', 'visual-check.mjs')).href
);

const [htmlPath, outPath] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!htmlPath || !outPath) throw new Error('usage: export-diagram-svg.mjs <diagram.html> <out.svg>');
const chrome = findChrome();
if (!chrome) throw new Error('Chrome not found; set ARCHIFY_CHROME to its executable');

const browser = new ChromeVisualBrowser(chrome);
try {
  const sessionId = await browser.sessionPromise;
  const { cdp } = browser;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  const loaded = cdp.waitFor('Page.loadEventFired', sessionId);
  const nav = await cdp.send('Page.navigate', { url: pathToFileURL(htmlPath).href }, sessionId);
  if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
  await loaded;

  // The export hands its result to URL.createObjectURL before downloading; read it there.
  const expression = `(async () => {
    await (document.fonts ? document.fonts.ready : Promise.resolve());
    if (window.Archify && Archify.readerLayout && Archify.readerLayout.whenStable) {
      await Archify.readerLayout.whenStable();
    }
    const captured = new Promise((resolve, reject) => {
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        if (blob && /svg/.test(blob.type)) blob.text().then(resolve, reject);
        return original(blob);
      };
      setTimeout(() => reject(new Error('no SVG blob within 15 s')), 15000);
    });
    const button = document.querySelector('button[data-format="svg"]');
    if (!button) throw new Error('SVG export button not found');
    button.click();
    return captured;
  })()`;
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId, 30000);
  if (result.exceptionDetails) {
    throw new Error(`export failed in the page: ${JSON.stringify(result.exceptionDetails).slice(0, 800)}`);
  }
  const svg = result.result.value;
  if (typeof svg !== 'string' || !svg.includes('<svg')) throw new Error('export did not return SVG text');
  fs.writeFileSync(outPath, svg);
  console.log(`wrote ${outPath} (${svg.length} bytes)`);
} finally {
  await browser.close();
}
