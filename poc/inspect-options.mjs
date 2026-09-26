// Read-only: opens the Kanton and Dauer dropdowns and prints their options. Never submits.
import { chromium } from 'playwright';

const URL = 'https://portal.parkon.ch/a908bc69';

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'de-CH' });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

for (const label of ['Kanton', 'Dauer']) {
  await page.locator('.mud-select', { hasText: label }).first().click();
  const items = page.locator('.mud-popover-open .mud-list-item');
  await items.first().waitFor();
  console.log(label, '→', JSON.stringify(await items.allInnerTexts()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}
await browser.close();
