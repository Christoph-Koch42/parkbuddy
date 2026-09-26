// End-to-end smoke test of the phone app against the live Worker, in TEST MODE (nothing submitted to parkon).
// Serves ../app locally, opens it at phone size, goes through setup, visitors, booking, bookings, backup.
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url));
const KEY = readFileSync(new URL('../worker/.dev.vars', import.meta.url), 'utf8').match(/ACCESS_KEY=(.+)/)[1].trim();
const WORKER = 'https://parkbuddy.explorador.workers.dev';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer((req, res) => {
  const path = join(APP_DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!path.startsWith(APP_DIR) || !existsSync(path)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
}).listen(8765);

const shot = async (page, name) => page.screenshot({ path: `app-${name}.png`, fullPage: true });
const step = msg => console.log(`- ${msg}`);

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

try {
  const invite = Buffer.from(JSON.stringify({ u: WORKER, k: KEY })).toString('base64url');
  await page.goto(`http://localhost:8765/#setup=${invite}`);
  await page.getByText('Almost done').waitFor();
  step('invite link accepted, setup screen shown');
  if (page.url().includes('#setup')) throw new Error('invite key still in URL');
  await shot(page, '1-setup');

  await page.fill('#setup-email', 'test@example.com');
  await page.check('#setup-terms');
  await page.click('text=Start');
  await page.locator('#f-nick').waitFor();
  if (await page.locator('#test-badge').isVisible()) throw new Error('test badge visible although test mode is off');
  step('e-mail saved once, add-visitor form opened directly');

  await page.fill('#f-nick', 'Chris Test');
  await page.selectOption('#f-canton', 'ZH');
  await page.fill('#f-plate', 'ZH 123456');
  await page.click('button:has-text("Save")');
  await page.getByText('ZH 123456').waitFor();
  step('visitor added, plate normalised to "ZH 123456"');
  await shot(page, '2-visitors');

  // Test mode on
  await page.click('[data-tab="settings"]');
  await page.check('#s-test');
  step('test mode on');

  await page.click('[data-tab="book"]');
  if (await page.inputValue('#book-email') !== 'test@example.com') throw new Error('saved e-mail not prefilled');
  step('saved e-mail prefilled in booking form');
  await page.click('#quick button[data-h="24"]');
  const preview = await page.textContent('#preview');
  if (!preview.includes('3 registrations of 8h')) throw new Error(`unexpected preview: ${preview}`);
  step(`preview: ${preview.replace(/\s+/g, ' ').trim()}`);
  await page.click('#dur-mode button[data-v="until"]');
  step(`"until" preview: ${(await page.textContent('#preview')).replace(/\s+/g, ' ').trim().slice(0, 80)}`);
  await page.click('#dur-mode button[data-v="hours"]');
  await shot(page, '3-book');

  const [bookingRequest] = await Promise.all([
    page.waitForRequest(r => r.url().endsWith('/bookings') && r.method() === 'POST'),
    page.click('#book-btn'),
  ]);
  const sent = bookingRequest.postDataJSON();
  if ('nickname' in sent) throw new Error('nickname was sent to the server');
  step(`privacy: sent to server = ${Object.keys(sent).join(', ')}`);
  await page.getByText('Bookings', { exact: true }).first().waitFor();
  await page.locator('.card .badge-ok').first().waitFor({ timeout: 90_000 });
  step(`booked (test): ${(await page.locator('#toast').textContent()).trim()}`);
  const shownName = (await page.locator('.booking-head strong').first().textContent()).trim();
  if (shownName !== 'Chris Test') throw new Error(`bookings list shows "${shownName}" instead of the local nickname`);
  step('bookings list shows the nickname from the local visitor list');
  await shot(page, '4-bookings');

  // Cancel the rest of the chain
  page.once('dialog', d => d.accept());
  await page.click('[data-cancel]');
  await page.locator('.booking-head .badge-muted').first().waitFor();
  step('remaining slots cancelled');
  await shot(page, '5-cancelled');

  // Backup export + import round trip
  await page.click('[data-tab="settings"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
  const backupPath = await download.path();
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  step(`backup exported: ${download.suggestedFilename()} with ${backup.visitors.length} visitor(s)`);
  await page.evaluate(() => localStorage.setItem('parkbuddy.visitors', '[]'));
  await page.setInputFiles('#import-file', backupPath);
  await page.getByText('Backup imported').waitFor();
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('parkbuddy.visitors')).map(f => f.nickname));
  step(`visitors cleared and restored from backup: ${restored.join(', ')}`);
  await shot(page, '6-settings');

  console.log(errors.length ? `\nBrowser errors:\n${errors.join('\n')}` : '\nNo browser errors.');
} catch (err) {
  await shot(page, 'error');
  console.log(`FAILED: ${err.message}`);
  if (errors.length) console.log(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
