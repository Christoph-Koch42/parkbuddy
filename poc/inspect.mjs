// Read-only: loads the parkon portal and dumps the form controls. Never submits.
import { chromium } from 'playwright';

const URL = 'https://portal.parkon.ch/a908bc69';

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'de-CH' });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000); // let the Blazor circuit render

const controls = await page.$$eval(
  'input, select, textarea, button, label, .mud-select, .mud-checkbox',
  els => els.map(e => ({
    tag: e.tagName.toLowerCase(),
    type: e.getAttribute('type'),
    id: e.id || null,
    name: e.getAttribute('name'),
    cls: (e.className && typeof e.className === 'string') ? e.className.slice(0, 80) : null,
    text: (e.innerText || e.value || '').trim().slice(0, 60),
    aria: e.getAttribute('aria-label'),
  }))
);
console.log(JSON.stringify(controls, null, 1));
await page.screenshot({ path: 'form.png', fullPage: true });
await browser.close();
