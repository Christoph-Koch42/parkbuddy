import { HOURS } from './parkon.js';

export const SLOT_MAX_HOURS = 8;
export const MAX_TOTAL_HOURS = 7 * 24;
const HOUR_MS = 3600_000;

// Splits a wished duration into parkon slots.
// <= 8h: one slot, rounded up to the next portal option (2/4/6/8).
// > 8h: back-to-back 8h slots (the last one may run past the wished end).
// intervalMinutes (dry test bookings only) replaces the 8h spacing so a chain can be tested quickly.
export function planSlots(startAt, totalHours, intervalMinutes) {
  if (totalHours <= SLOT_MAX_HOURS) {
    return [{ idx: 0, due_at: startAt, hours: HOURS.find(h => h >= totalHours) }];
  }
  const spacing = intervalMinutes ? intervalMinutes * 60_000 : SLOT_MAX_HOURS * HOUR_MS;
  const count = Math.ceil(totalHours / SLOT_MAX_HOURS);
  return Array.from({ length: count }, (_, idx) => ({ idx, due_at: startAt + idx * spacing, hours: SLOT_MAX_HOURS }));
}
