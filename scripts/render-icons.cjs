// Renders the source images for the app icons and splash screens from icons/icon.svg:
// `node scripts/render-icons.cjs` (needs Playwright). `npm run native:assets` runs this, then
// makes every iOS and Android size from the files in assets/.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const full = fs.readFileSync(path.join(root, 'icons', 'icon.svg'), 'utf8');
// The icon without its lilac rounded square, for Android's adaptive icon foreground and the splash.
const mark = full.replace(/<rect width="512" height="512"[^>]*\/>/, '');
const BG = '#EEE7FF';
// [file, size, svg, padding as a share of the size, background]
const images = [
  ['assets/icon-only.png', 1024, full, 0, BG],
  ['assets/icon-foreground.png', 1024, mark, 0.17, 'transparent'],
  ['assets/icon-background.png', 1024, null, 0, BG],
  ['assets/splash.png', 2732, mark, 0.36, BG],
  ['assets/splash-dark.png', 2732, mark, 0.36, BG],
];

(async () => {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [file, size, svg, pad, bg] of images) {
    const inner = size * (1 - 2 * pad);
    const body = svg ? svg.replace('<svg ', '<svg width="100%" height="100%" ') : '';
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0;background:${bg};width:${size}px;height:${size}px;display:grid;place-items:center">` +
        `<div style="width:${inner}px;height:${inner}px">${body}</div></body>`,
    );
    await page.screenshot({ path: path.join(root, file), omitBackground: bg === 'transparent' });
  }
  await browser.close();
})();
