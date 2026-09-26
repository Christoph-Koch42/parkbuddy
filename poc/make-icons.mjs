// Renders app/icons/icon.svg to the PNG sizes needed for Android and iOS home screens.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../app/icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: new URL(`../app/icons/icon-${size}.png`, import.meta.url).pathname.slice(1) });
  await page.close();
}
await browser.close();
console.log('icons written');
