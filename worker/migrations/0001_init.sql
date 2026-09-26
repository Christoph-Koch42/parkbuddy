-- A booking is what the user asked for (e.g. 20h from 18:00); it is split into slots of max 8h.
CREATE TABLE bookings (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,              -- random id of the phone that created it
  nickname    TEXT,
  canton      TEXT NOT NULL,
  plate       TEXT NOT NULL,
  email       TEXT,
  start_at    INTEGER NOT NULL,           -- epoch ms
  total_hours INTEGER NOT NULL,
  dry         INTEGER NOT NULL DEFAULT 0, -- 1 = test booking, form is never submitted
  status      TEXT NOT NULL DEFAULT 'active', -- active | done | failed | cancelled
  created_at  INTEGER NOT NULL
);
CREATE INDEX bookings_client ON bookings(client_id, created_at);

CREATE TABLE slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  due_at      INTEGER NOT NULL,           -- epoch ms when this slot must be submitted
  hours       INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | cancelled
  attempts    INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER,
  booked_from TEXT,                       -- as confirmed by parkon, e.g. "26.09.2026 20:35"
  booked_to   TEXT,
  last_error  TEXT
);
CREATE INDEX slots_due ON slots(status, due_at);
CREATE INDEX slots_booking ON slots(booking_id);
