// Books due slots. Used by the every-minute cron and right after a booking is created.
import { launch } from '@cloudflare/playwright';
import { bookSlot } from './parkon.js';

const MAX_ATTEMPTS = 3;
const STALE_MS = 5 * 60_000;   // a "running" slot older than this was interrupted
const LOOKAHEAD_MS = 60_000;   // cron runs every minute: book what is due within the next minute

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Slots interrupted mid-run (Worker killed, browser hung) go back to pending or fail for good.
async function recoverStale(db, now) {
  await db.batch([
    db.prepare(`UPDATE slots SET status = 'pending', last_error = 'interrupted'
                WHERE status = 'running' AND started_at < ? AND attempts < ?`).bind(now - STALE_MS, MAX_ATTEMPTS),
    db.prepare(`UPDATE slots SET status = 'failed', last_error = 'interrupted'
                WHERE status = 'running' AND started_at < ? AND attempts >= ?`).bind(now - STALE_MS, MAX_ATTEMPTS),
  ]);
}

// Books up to `limit` due slots, optionally only for one booking. Returns per-slot results.
export async function runDue(env, { bookingId, limit = 2, timeoutMs = 60_000 } = {}) {
  const db = env.DB;
  const now = Date.now();
  await recoverStale(db, now);

  const { results: due } = await db.prepare(
    `SELECT s.id, s.hours, b.canton, b.plate, b.email, b.dry
       FROM slots s JOIN bookings b ON b.id = s.booking_id
      WHERE s.status = 'pending' AND s.due_at <= ? AND b.status = 'active' AND (? IS NULL OR s.booking_id = ?)
      ORDER BY s.due_at LIMIT ?`
  ).bind(now + LOOKAHEAD_MS, bookingId ?? null, bookingId ?? null, limit).all();
  if (!due.length) return [];

  const outcomes = [];
  const browser = await launch(env.BROWSER);
  try {
    for (const slot of due) {
      // Claim atomically so an overlapping cron run can't book the same slot twice.
      const claim = await db.prepare(
        `UPDATE slots SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`
      ).bind(Date.now(), slot.id).run();
      if (claim.meta.changes !== 1) continue;

      let result;
      const page = await browser.newPage({ locale: 'de-CH' });
      try {
        page.setDefaultTimeout(15_000);
        result = await withTimeout(bookSlot(page, {
          canton: slot.canton, plate: slot.plate, hours: slot.hours, email: slot.email || undefined, dry: !!slot.dry,
        }), timeoutMs);
      } catch (err) {
        result = { ok: false, error: err.message };
      } finally {
        await page.close().catch(() => {});
      }

      if (result.ok) {
        await db.prepare(`UPDATE slots SET status = 'done', booked_from = ?, booked_to = ?, last_error = NULL WHERE id = ?`)
          .bind(result.from ?? 'dry', result.to ?? 'dry', slot.id).run();
      } else {
        // Retry on the next cron run until attempts are used up.
        await db.prepare(`UPDATE slots SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, last_error = ? WHERE id = ?`)
          .bind(MAX_ATTEMPTS, String(result.error).slice(0, 300), slot.id).run();
      }
      outcomes.push({ slotId: slot.id, ...result });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  await finishBookings(db);
  return outcomes;
}

// A booking is finished once none of its slots is still waiting: 'failed' if any slot failed, else 'done'.
export async function finishBookings(db) {
  await db.prepare(
    `UPDATE bookings SET status = CASE WHEN EXISTS (
        SELECT 1 FROM slots WHERE slots.booking_id = bookings.id AND slots.status = 'failed') THEN 'failed' ELSE 'done' END
      WHERE status = 'active' AND NOT EXISTS (
        SELECT 1 FROM slots WHERE slots.booking_id = bookings.id AND slots.status IN ('pending', 'running'))`
  ).run();
}

// Keep the database small: forget bookings older than 60 days.
export async function cleanup(db) {
  const cutoff = Date.now() - 60 * 24 * 3600_000;
  await db.batch([
    db.prepare(`DELETE FROM slots WHERE booking_id IN (SELECT id FROM bookings WHERE created_at < ?)`).bind(cutoff),
    db.prepare(`DELETE FROM bookings WHERE created_at < ?`).bind(cutoff),
  ]);
}
