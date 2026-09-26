// ParkBuddy Worker: REST API for the phone app + every-minute cron that books due slots.
//
// All requests need headers X-Access-Key (shared secret) and X-Client-Id (random id per phone).
//   POST   /bookings       {canton, plate, email?, start?, hours, dry?, intervalMinutes?}  (nicknames stay on the phone)
//   GET    /bookings       own bookings (active + last 14 days) with their slots
//   DELETE /bookings/:id   cancel all slots not yet booked
import { validate, plateNumber } from './parkon.js';
import { planSlots, MAX_TOTAL_HOURS } from './plan.js';
import { runDue, cleanup } from './runner.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Access-Key, X-Client-Id',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });

async function createBooking(request, env, clientId) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid JSON' }, 400);

  const now = Date.now();
  const hours = Number(body.hours);
  const startAt = body.start ? new Date(body.start).getTime() : now;
  const dry = body.dry === true;
  const intervalMinutes = dry && body.intervalMinutes ? Number(body.intervalMinutes) : undefined;

  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_TOTAL_HOURS) return json({ ok: false, error: `hours must be 1–${MAX_TOTAL_HOURS}` }, 400);
  if (Number.isNaN(startAt) || startAt < now - 5 * 60_000 || startAt > now + 30 * 24 * 3600_000) return json({ ok: false, error: 'start must be between now and 30 days ahead' }, 400);
  const error = validate({ canton: body.canton, plate: body.plate, hours: 2 });
  if (error) return json({ ok: false, error }, 400);

  const id = crypto.randomUUID();
  const slots = planSlots(Math.max(startAt, now), hours, intervalMinutes);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bookings (id, client_id, canton, plate, email, start_at, total_hours, dry, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, clientId, body.canton, plateNumber(body.canton, body.plate), body.email || null,
            Math.max(startAt, now), hours, dry ? 1 : 0, now),
    ...slots.map(s => env.DB.prepare(`INSERT INTO slots (booking_id, idx, due_at, hours) VALUES (?, ?, ?, ?)`)
      .bind(id, s.idx, s.due_at, s.hours)),
  ]);

  // Book the first slot right away if it starts now, so the app shows the confirmation immediately.
  const outcomes = await runDue(env, { bookingId: id, limit: 1, timeoutMs: 60_000 });
  return json({ ok: true, booking: await getBooking(env, clientId, id), firstSlot: outcomes[0] ?? null }, 201);
}

function groupBookings(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) {
      byId.set(r.id, {
        id: r.id, canton: r.canton, plate: r.plate, email: r.email, start_at: r.start_at,
        total_hours: r.total_hours, dry: !!r.dry, status: r.status, created_at: r.created_at, slots: [],
      });
    }
    if (r.slot_id != null) {
      byId.get(r.id).slots.push({
        id: r.slot_id, idx: r.idx, due_at: r.due_at, hours: r.hours, status: r.slot_status, attempts: r.attempts,
        booked_from: r.booked_from, booked_to: r.booked_to, last_error: r.last_error,
      });
    }
  }
  return [...byId.values()];
}

const BOOKING_SELECT = `
  SELECT b.*, s.id AS slot_id, s.idx, s.due_at, s.hours, s.status AS slot_status, s.attempts,
         s.booked_from, s.booked_to, s.last_error
    FROM bookings b LEFT JOIN slots s ON s.booking_id = b.id`;

async function getBooking(env, clientId, id) {
  const { results } = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ? AND b.client_id = ? ORDER BY s.idx`)
    .bind(id, clientId).all();
  return groupBookings(results)[0] ?? null;
}

async function listBookings(env, clientId) {
  const since = Date.now() - 14 * 24 * 3600_000;
  const { results } = await env.DB.prepare(
    `${BOOKING_SELECT} WHERE b.client_id = ? AND (b.status = 'active' OR b.created_at > ?) ORDER BY b.start_at DESC, s.idx`
  ).bind(clientId, since).all();
  return json({ ok: true, bookings: groupBookings(results) });
}

async function cancelBooking(env, clientId, id) {
  const res = await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ? AND client_id = ? AND status = 'active'`)
    .bind(id, clientId).run();
  if (res.meta.changes !== 1) return json({ ok: false, error: 'not found or not active' }, 404);
  await env.DB.prepare(`UPDATE slots SET status = 'cancelled' WHERE booking_id = ? AND status = 'pending'`).bind(id).run();
  return json({ ok: true, booking: await getBooking(env, clientId, id) });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.headers.get('X-Access-Key') !== env.ACCESS_KEY) return json({ ok: false, error: 'unauthorized' }, 401);

    const clientId = request.headers.get('X-Client-Id') ?? '';
    if (!/^[\w-]{8,64}$/.test(clientId)) return json({ ok: false, error: 'missing X-Client-Id' }, 400);

    const { pathname } = new URL(request.url);
    const match = pathname.match(/^\/bookings(?:\/([\w-]+))?$/);
    if (!match) return json({ ok: false, error: 'not found' }, 404);

    try {
      if (!match[1] && request.method === 'POST') return await createBooking(request, env, clientId);
      if (!match[1] && request.method === 'GET') return await listBookings(env, clientId);
      if (match[1] && request.method === 'DELETE') return await cancelBooking(env, clientId, match[1]);
      return json({ ok: false, error: 'method not allowed' }, 405);
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const outcomes = await runDue(env);
      if (outcomes.length) {
        // Which Cloudflare location ran this (helps when parkon reacts slowly from far away).
        const colo = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r => r.text())
          .then(t => t.match(/colo=(\w+)/)?.[1]).catch(() => '?');
        console.log(JSON.stringify({ colo, outcomes }));
      }
      if (new Date(controller.scheduledTime).getUTCMinutes() === 0) await cleanup(env.DB);
    })());
  },
};
