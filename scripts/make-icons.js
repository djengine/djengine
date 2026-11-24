'use strict';
// Uygulama ve menü çubuğu ikonlarını SVG'den PNG'ye çevirir (Playwright/Chromium ile).
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'build');

const appIcon = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#0f766e"/><stop offset="0.5" stop-color="#2563eb"/><stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>
  <path d="M512 270c-150 0-262 104-262 236 0 74 35 139 92 182v92l86-48c26 7 55 11 84 11 150 0 262-104 262-237S662 270 512 270z" fill="#fff"/>
  <circle cx="400" cy="506" r="40" fill="url(#g)"/><circle cx="512" cy="506" r="40" fill="url(#g)"/><circle cx="624" cy="506" r="40" fill="url(#g)"/>
</svg>`;

const trayIcon = (s) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 16 16">
  <path fill-rule="evenodd" fill="#000" d="M8 2C4.4 2 1.8 4.4 1.8 7.4c0 1.7.8 3.2 2.1 4.2V14l2.2-1.2c.6.2 1.2.2 1.9.2 3.6 0 6.2-2.5 6.2-5.6S11.6 2 8 2z M5 6.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8z M8 6.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8z M11 6.6a.9.9 0 1 0 0 1.8a.9.9 0 1 0 0-1.8z"/>
</svg>`;

async function render(page, svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.locator('svg').screenshot({ path: path.join(OUT, file), omitBackground: true });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await render(page, appIcon, 1024, 'icon.png');
  await render(page, trayIcon(16), 16, 'trayTemplate.png');
  await render(page, trayIcon(32), 32, 'trayTemplate@2x.png');
  await browser.close();
  console.log('İkonlar oluşturuldu:', fs.readdirSync(OUT).join(', '));
})();
