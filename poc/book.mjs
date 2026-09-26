// Books one visitor parking slot on the parkon portal by driving the real page.
// Usage: node book.mjs <canton> <plate> <hours> [email] [--headed] [--dry]
//   --headed  show the browser window
//   --dry     fill everything but do NOT click "Absenden"
import { chromium } from 'playwright';

const URL = 'https://portal.parkon.ch/a908bc69';
const CANTONS = ['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH','Ausland'];
const HOURS = [2, 4, 6, 8];

const flags = process.argv.filter(a => a.startsWith('--'));
const [canton, plate, hoursArg, email] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const hours = Number(hoursArg);
const headed = flags.includes('--headed');
const dry = flags.includes('--dry');

if (!CANTONS.includes(canton) || !plate || !HOURS.includes(hours)) {
  console.error(`Usage: node book.mjs <canton: ${CANTONS.join('|')}> <plate> <hours: ${HOURS.join('|')}> [email] [--headed] [--dry]`);
  process.exit(1);
}

async function pickOption(page, selectLabel, optionText) {
  await page.locator('.mud-select', { hasText: selectLabel }).first().click();
  await page.locator('.mud-popover-open').getByText(optionText, { exact: true }).first().click();
  await page.waitForTimeout(300);
}

async function fillByLabel(page, labelText, value) {
  const control = page.locator('.mud-input-control', { has: page.locator('label', { hasText: labelText }) }).first();
  await control.locator('input').first().fill(value);
}

const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 400 : 0 });
const page = await browser.newPage({ locale: 'de-CH' });
try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  await pickOption(page, 'Kanton', canton);
  // The portal wants only the number part; the canton is chosen separately ("ZH 123456" -> "123456").
  let number = plate.toUpperCase().replace(/[\s.-]+/g, '');
  if (canton !== 'Ausland' && number.startsWith(canton)) number = number.slice(canton.length);
  await fillByLabel(page, 'Kennzeichen', number);
  await pickOption(page, 'Dauer', `${hours}h`);
  if (email) await fillByLabel(page, 'E-Mail', email);
  await page.locator('input.mud-checkbox-input').check();

  if (dry) {
    await page.screenshot({ path: 'dry-run.png', fullPage: true });
    console.log(JSON.stringify({ ok: true, dry: true, canton, plate, hours }));
  } else {
    const before = await page.locator('body').innerText();
    await page.getByRole('button', { name: 'Absenden' }).click();
    await page.waitForFunction(b => document.body.innerText !== b, before, { timeout: 15000 });
    await page.waitForTimeout(1500);
    const after = await page.locator('body').innerText();
    await page.screenshot({ path: 'result.png', fullPage: true });
    console.log(JSON.stringify({ ok: true, canton, plate, hours, pageText: after.slice(0, 800) }, null, 1));
  }
  if (headed) await page.waitForTimeout(4000);
} catch (err) {
  await page.screenshot({ path: 'error.png', fullPage: true }).catch(() => {});
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 2;
} finally {
  await browser.close();
}
