'use strict';

// Rasterises assets/icon.svg to the PNG sizes freedesktop asks for, plus
// the 512px assets/icon.png that electron-builder packs into the AppImage.
// Run with: npx electron scripts/make-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZES = [16, 32, 48, 64, 128, 256, 512];
const ASSETS = path.join(__dirname, '..', 'assets');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 100, height: 100 });
  await win.loadURL('data:text/html,<title>icon</title>');

  const iconsDir = path.join(ASSETS, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });

  for (const size of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = ${size}; c.height = ${size};
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, ${size}, ${size});
          resolve(c.toDataURL('image/png'));
        };
        img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
      })
    `);
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(iconsDir, `${size}.png`), png);
    if (size === 512) fs.writeFileSync(path.join(ASSETS, 'icon.png'), png);
    console.log(`wrote ${size}x${size} (${png.length} bytes)`);
  }
  app.quit();
});
