// Drives the parkon visitor portal (Blazor Server, no REST API) with a Playwright page.
// Shared logic: works with the local `playwright` package and with `@cloudflare/playwright`.

export const PORTAL_URL = 'https://portal.parkon.ch/a908bc69';
export const CANTONS = ['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH','Ausland'];
export const HOURS = [2, 4, 6, 8];

// "ZH 123 456" with canton ZH -> "123456"; the portal field only takes the number part.
export function plateNumber(canton, plate) {
  let n = String(plate).toUpperCase().replace(/[\s.-]+/g, '');
  if (canton !== 'Ausland' && n.startsWith(canton)) n = n.slice(canton.length);
  return n;
}

export function validate({ canton, plate, hours }) {
  if (!CANTONS.includes(canton)) return `invalid canton: ${canton}`;
  if (!plate || !plateNumber(canton, plate)) return 'missing plate';
  if (!HOURS.includes(Number(hours))) return `invalid hours: ${hours} (allowed ${HOURS.join('/')})`;
  return null;
}

// Clicking before the Blazor circuit is live does nothing, so retry until the list opens.
async function pickOption(page, selectLabel, optionText) {
  const select = page.locator('.mud-select', { hasText: selectLabel }).first();
  const option = page.locator('.mud-popover-open').getByText(optionText, { exact: true }).first();
  for (let attempt = 0; attempt < 8; attempt++) {
    await select.click();
    try {
      await option.waitFor({ state: 'visible', timeout: 2500 });
      await option.click();
      await page.waitForTimeout(300);
      return;
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  throw new Error(`option "${optionText}" did not appear`);
}

async function fillByLabel(page, labelText, value) {
  const control = page.locator('.mud-input-control', { has: page.locator('label', { hasText: labelText }) }).first();
  await control.locator('input').first().fill(value);
}

// "... von 26.09.2026 15:11 bis 26.09.2026 19:11 ..." -> { from, to }
export function parseConfirmation(text) {
  const m = text.match(/von (\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}) bis (\d{2}\.\d{2}\.\d{4} \d{2}:\d{2})/);
  return m ? { from: m[1], to: m[2] } : null;
}

// Books one slot. With dry=true the form is filled but not submitted.
export async function bookSlot(page, { canton, plate, hours, email, dry = false }) {
  const error = validate({ canton, plate, hours });
  if (error) return { ok: false, error };

  const t0 = Date.now();
  let step = 'load page';
  try {
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500); // let the Blazor circuit render

    const number = plateNumber(canton, plate);
    step = 'canton';
    await pickOption(page, 'Kanton', canton);
    step = 'plate';
    await fillByLabel(page, 'Kennzeichen', number);
    step = 'duration';
    await pickOption(page, 'Dauer', `${hours}h`);
    step = 'email';
    if (email) await fillByLabel(page, 'E-Mail', email);
    step = 'terms';
    await page.locator('input.mud-checkbox-input').check();

    if (dry) return { ok: true, dry: true, canton, plate: number, hours: Number(hours), ms: Date.now() - t0 };

    step = 'submit';
    const before = await page.locator('body').innerText();
    await page.getByRole('button', { name: 'Absenden' }).click();
    await page.waitForFunction(b => document.body.innerText !== b, before, { timeout: 15000 });
    await page.waitForTimeout(1500);
    const text = await page.locator('body').innerText();

    const period = text.includes('erfolgreich') ? parseConfirmation(text) : null;
    if (!period) return { ok: false, error: `no confirmation: ${text.slice(0, 300)}`, ms: Date.now() - t0 };
    return { ok: true, canton, plate: number, hours: Number(hours), ...period, message: text.split('\n')[0], ms: Date.now() - t0 };
  } catch (err) {
    throw new Error(`${step} (after ${Date.now() - t0} ms): ${err.message.split('\n')[0]}`);
  }
}
