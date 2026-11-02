import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

// Deterministic raster exports of the editable SVG; only regeneration needs a browser.
const source = await readFile('public/icons/app-icon.svg', 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128, 512]) {
    const png = await page.evaluate(async ({ source, size }) => {
      const img = new Image();
      img.src = `data:image/svg+xml;base64,${btoa(source)}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(img, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source, size });
    await writeFile(`public/icons/icon-${size}.png`, Buffer.from(png, 'base64'));
  }
} finally { await browser.close(); }
