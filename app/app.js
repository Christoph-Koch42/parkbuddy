// ParkBuddy — phone app for parkon visitor parking.
// Visitors and settings live only on this device (localStorage). Bookings run on the ParkBuddy Worker.

const APP_VERSION = '1.0.0';
const PORTAL_URL = 'https://portal.parkon.ch/a908bc69';
const CANTONS = ['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH','Ausland'];
const PORTAL_HOURS = [2, 4, 6, 8];
const SLOT_MAX_HOURS = 8;
const QUICK_HOURS = [2, 4, 8, 24, 48];
const MAX_HOURS = 168;
const HOUR_MS = 3600_000;

// ---------- storage ----------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`parkbuddy.${key}`); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`parkbuddy.${key}`, JSON.stringify(value)); } catch { /* private mode: keep in memory */ }
  },
};

// { workerUrl, accessKey, clientId, email, termsAccepted, testMode, lastVisitorId }
const settings = store.get('settings', {});
let visitors = store.get('visitors', []);
if (!settings.clientId) settings.clientId = crypto.randomUUID();
saveSettings();

function saveSettings() { store.set('settings', settings); }
function saveVisitors() { store.set('visitors', visitors); }

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(message, ms = 3500) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const b64urlEncode = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

// "ZH 123 456" with canton ZH -> "123456"; the portal takes only the number part.
function plateNumber(canton, plate) {
  let n = String(plate).toUpperCase().replace(/[\s.-]+/g, '');
  if (canton !== 'Ausland' && n.startsWith(canton)) n = n.slice(canton.length);
  return n;
}
const plateLabel = f => (f.canton === 'Ausland' ? f.plate : `${f.canton} ${f.plate}`);

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Date -> value for <input type="datetime-local"> in local time
function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 24 * HOUR_MS);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

// Same split as the Worker (worker/src/plan.js), for the preview.
function planSlots(startMs, hours) {
  if (hours <= SLOT_MAX_HOURS) return [{ due: startMs, hours: PORTAL_HOURS.find(h => h >= hours) }];
  const count = Math.ceil(hours / SLOT_MAX_HOURS);
  return Array.from({ length: count }, (_, i) => ({ due: startMs + i * SLOT_MAX_HOURS * HOUR_MS, hours: SLOT_MAX_HOURS }));
}

// ---------- API ----------

async function api(method, path, body) {
  const res = await fetch(settings.workerUrl.replace(/\/+$/, '') + path, {
    method,
    headers: {
      'X-Access-Key': settings.accessKey,
      'X-Client-Id': settings.clientId,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- invite link ----------

function inviteLink() {
  const payload = b64urlEncode(JSON.stringify({ u: settings.workerUrl, k: settings.accessKey }));
  return `${location.origin}${location.pathname}#setup=${payload}`;
}

// The key sits after "#", which browsers never send to any server.
function readInviteFromUrl() {
  const m = location.hash.match(/^#setup=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const { u, k } = JSON.parse(b64urlDecode(m[1]));
    if (!u || !k) throw new Error();
    settings.workerUrl = u;
    settings.accessKey = k;
    saveSettings();
    toast('Invite accepted, you are connected.');
  } catch {
    toast('This invite link is not valid.');
  }
}

// ---------- navigation ----------

let currentTab = 'book';
let refreshTimer;

function isConnected() { return settings.workerUrl && settings.accessKey; }
function isSetUp() { return isConnected() && settings.termsAccepted; }

function show(tab) {
  clearInterval(refreshTimer);
  if (!isSetUp()) {
    $('#tabs').hidden = true;
    return renderSetup();
  }
  currentTab = tab;
  $('#tabs').hidden = false;
  $('#test-badge').hidden = !settings.testMode;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ({ book: renderBook, bookings: renderBookings, visitors: renderVisitors, settings: renderSettings })[tab]();
  window.scrollTo(0, 0);
}

$$('#tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

// ---------- setup (first start) ----------

function renderSetup() {
  const view = $('#view');
  if (!isConnected()) {
    view.innerHTML = `
      <div class="card">
        <h2>Welcome to ParkBuddy</h2>
        <p>Register parking for family, friends and tradespeople in a few taps. Long stays are re-registered automatically every 8 hours.</p>
        <p class="muted small">To connect, open the <strong>invite link</strong> you received. Or enter the details by hand:</p>
        <form id="connect-form">
          <label for="worker-url">Server address</label>
          <input id="worker-url" type="url" placeholder="https://parkbuddy.example.workers.dev" required>
          <label for="access-key">Access key</label>
          <input id="access-key" type="text" autocomplete="off" required>
          <div style="margin-top:16px"><button class="btn-primary" type="submit">Connect</button></div>
        </form>
      </div>`;
    $('#connect-form').addEventListener('submit', async e => {
      e.preventDefault();
      settings.workerUrl = $('#worker-url').value.trim();
      settings.accessKey = $('#access-key').value.trim();
      try {
        await api('GET', '/bookings');
        saveSettings();
        toast('Connected.');
        show('book');
      } catch (err) {
        settings.workerUrl = settings.accessKey = '';
        toast(`Could not connect: ${err.message}`);
      }
    });
    return;
  }

  // Connected: ask once for the confirmation e-mail and the parkon terms.
  view.innerHTML = `
    <div class="card">
      <h2>Almost done</h2>
      <form id="setup-form">
        <label for="setup-email">Your e-mail for booking confirmations</label>
        <input id="setup-email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" value="${esc(settings.email)}">
        <div class="hint">parkon sends a confirmation for every registration. Saved on this phone and used for all future bookings; you can change it any time in Settings. Leave empty for no e-mails.</div>

        <label class="check" style="margin-top:18px">
          <input id="setup-terms" type="checkbox" required>
          <span>I accept the parkon terms and privacy policy (see the <a href="${PORTAL_URL}" target="_blank" rel="noopener">parkon portal</a>) and will inform the owners of the vehicles I register about them.</span>
        </label>
        <div style="margin-top:18px"><button class="btn-primary" type="submit">Start</button></div>
      </form>
    </div>`;
  $('#setup-form').addEventListener('submit', e => {
    e.preventDefault();
    const email = $('#setup-email').value.trim();
    if (email && !isEmail(email)) return toast('Please check the e-mail address.');
    settings.email = email;
    settings.termsAccepted = true;
    saveSettings();
    if (visitors.length) return show('book');
    editingVisitorId = 'new';
    show('visitors');
    toast('Add your first visitor to start booking.');
  });
}

// ---------- Book ----------

const bookForm = { startMode: 'now', durMode: 'hours', hours: 4 };

function renderBook() {
  const view = $('#view');
  if (!visitors.length) {
    view.innerHTML = `
      <div class="card empty">
        <p>No visitors saved yet.</p>
        <button id="go-visitors">Add a visitor</button>
      </div>`;
    $('#go-visitors').addEventListener('click', () => { show('visitors'); openVisitorForm(); });
    return;
  }

  const now = new Date();
  const selectedId = visitors.some(f => f.id === settings.lastVisitorId) ? settings.lastVisitorId : visitors[0].id;
  view.innerHTML = `
    <form id="book-form" class="card">
      <label for="visitor">Who is visiting?</label>
      <select id="visitor">
        ${visitors.map(f => `<option value="${esc(f.id)}" ${f.id === selectedId ? 'selected' : ''}>${esc(f.nickname)} — ${esc(plateLabel(f))}</option>`).join('')}
      </select>

      <label>Start</label>
      <div class="segmented" id="start-mode">
        <button type="button" data-v="now">Now</button>
        <button type="button" data-v="later">Later</button>
      </div>
      <input id="start-at" type="datetime-local" style="margin-top:8px" min="${toLocalInput(now)}" value="${toLocalInput(new Date(now.getTime() + HOUR_MS))}">

      <label>Duration</label>
      <div class="segmented" id="dur-mode">
        <button type="button" data-v="hours">Hours</button>
        <button type="button" data-v="until">Until</button>
      </div>
      <div id="dur-hours" style="margin-top:8px">
        <div class="chips" id="quick">
          ${QUICK_HOURS.map(h => `<button type="button" data-h="${h}">${h}h</button>`).join('')}
        </div>
        <div class="row" style="margin-top:8px;align-items:center">
          <input id="hours" type="number" inputmode="numeric" min="1" max="${MAX_HOURS}" step="1" value="${bookForm.hours}" aria-label="Hours">
          <span class="muted small" style="flex:0 0 auto">hours (max ${MAX_HOURS})</span>
        </div>
      </div>
      <input id="until" type="datetime-local" style="margin-top:8px" value="${toLocalInput(new Date(now.getTime() + 24 * HOUR_MS))}">

      <label for="book-email">Confirmation e-mail</label>
      <input id="book-email" type="email" inputmode="email" autocomplete="email" placeholder="no confirmation e-mail" value="${esc(settings.email)}">
      <div class="hint">Your saved address. Changing it here applies to this booking only.</div>

      <div id="preview" class="preview"></div>

      <div style="margin-top:16px"><button id="book-btn" class="btn-primary" type="submit">Book</button></div>
    </form>`;

  const form = $('#book-form');
  const setSegment = (id, value) => $$(`#${id} button`).forEach(b => b.classList.toggle('active', b.dataset.v === value));

  function computed() {
    const start = bookForm.startMode === 'now' ? Date.now() : new Date($('#start-at').value).getTime();
    let hours;
    if (bookForm.durMode === 'hours') hours = Number($('#hours').value);
    else hours = Math.ceil((new Date($('#until').value).getTime() - start) / HOUR_MS);
    return { start, hours };
  }

  function update() {
    setSegment('start-mode', bookForm.startMode);
    setSegment('dur-mode', bookForm.durMode);
    $('#start-at').hidden = bookForm.startMode !== 'later';
    $('#dur-hours').hidden = bookForm.durMode !== 'hours';
    $('#until').hidden = bookForm.durMode !== 'until';
    $$('#quick button').forEach(b => b.classList.toggle('active', Number(b.dataset.h) === Number($('#hours').value)));

    const { start, hours } = computed();
    const preview = $('#preview');
    const btn = $('#book-btn');
    let error = '';
    if (Number.isNaN(start)) error = 'Please choose a start time.';
    else if (bookForm.startMode === 'later' && start < Date.now() - 60_000) error = 'The start time is in the past.';
    else if (!Number.isInteger(hours) || hours < 1) error = bookForm.durMode === 'until' ? 'The end must be after the start.' : 'Enter at least 1 hour.';
    else if (hours > MAX_HOURS) error = `Maximum is ${MAX_HOURS} hours (7 days).`;

    preview.classList.toggle('error', !!error);
    btn.disabled = !!error;
    if (error) { preview.textContent = error; return; }

    const slots = planSlots(start, hours);
    const end = slots.at(-1).due + slots.at(-1).hours * HOUR_MS;
    const visitor = visitors.find(f => f.id === $('#visitor').value);
    preview.innerHTML = slots.length === 1
      ? `<strong>${esc(plateLabel(visitor))}</strong>: one registration of ${slots[0].hours}h, ${fmtTime(start)} – ${fmtTime(end)}.`
      : `<strong>${esc(plateLabel(visitor))}</strong>: ${slots.length} registrations of 8h, covered until <strong>${fmtTime(end)}</strong>.
         <ol>${slots.map(s => `<li>${fmtTime(s.due)}</li>`).join('')}</ol>`;
    btn.textContent = bookForm.startMode === 'now' ? (slots.length > 1 ? 'Book and re-book automatically' : 'Book now') : 'Schedule';
  }

  $$('#start-mode button').forEach(b => b.addEventListener('click', () => { bookForm.startMode = b.dataset.v; update(); }));
  $$('#dur-mode button').forEach(b => b.addEventListener('click', () => { bookForm.durMode = b.dataset.v; update(); }));
  $$('#quick button').forEach(b => b.addEventListener('click', () => { $('#hours').value = b.dataset.h; bookForm.hours = Number(b.dataset.h); update(); }));
  form.addEventListener('input', () => { bookForm.hours = Number($('#hours').value) || bookForm.hours; update(); });
  update();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const visitor = visitors.find(f => f.id === $('#visitor').value);
    const email = $('#book-email').value.trim();
    if (email && !isEmail(email)) return toast('Please check the e-mail address.');
    const { start, hours } = computed();

    settings.lastVisitorId = visitor.id;
    saveSettings();

    const btn = $('#book-btn');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${bookForm.startMode === 'now' ? 'Registering… (about 15 s)' : 'Scheduling…'}`;
    try {
      const { booking, firstSlot } = await api('POST', '/bookings', {
        nickname: visitor.nickname,
        canton: visitor.canton,
        plate: visitor.plate,
        email: email || undefined,
        start: bookForm.startMode === 'now' ? undefined : new Date(start).toISOString(),
        hours,
        dry: settings.testMode || undefined,
      });
      if (!firstSlot) toast(`Scheduled: first registration ${fmtTime(booking.slots[0].due_at)}.`, 5000);
      else if (firstSlot.ok && firstSlot.dry) toast('Test booking done (not submitted to parkon).', 5000);
      else if (firstSlot.ok) toast(`Registered ${plateLabel(visitor)}: ${firstSlot.from} – ${firstSlot.to.slice(11)}.`, 6000);
      else toast('Saved, but the first registration failed. It will be retried automatically.', 6000);
      show('bookings');
    } catch (err) {
      toast(`Booking failed: ${err.message}`, 6000);
      update();
    }
  });
}

// ---------- Bookings ----------

const SLOT_STATUS = {
  pending: ['Scheduled', 'badge-info'],
  running: ['Registering…', 'badge-warn'],
  done: ['Registered', 'badge-ok'],
  failed: ['Failed', 'badge-err'],
  cancelled: ['Cancelled', 'badge-muted'],
};
const BOOKING_STATUS = {
  active: ['Active', 'badge-info'],
  done: ['Completed', 'badge-ok'],
  failed: ['Problem', 'badge-err'],
  cancelled: ['Cancelled', 'badge-muted'],
};

// "26.09.2026 20:35" -> "26.09. 20:35"
const shortParkon = s => `${s.slice(0, 6)} ${s.slice(11)}`;

function slotLine(slot, dry) {
  const [label, cls] = SLOT_STATUS[slot.status] ?? [slot.status, 'badge-muted'];
  let when = `${fmtTime(slot.due_at)} · ${slot.hours}h`;
  if (slot.status === 'done' && !dry && slot.booked_from) when = `${shortParkon(slot.booked_from)} – ${slot.booked_to.slice(11)}`;
  const retry = slot.status === 'pending' && slot.attempts > 0 ? ` (retry ${slot.attempts + 1}/3)` : '';
  const error = (slot.status === 'failed' || retry) && slot.last_error
    ? `<div class="slot-error">${esc(slot.last_error.split('\n')[0])}</div>` : '';
  return `<li><div>${when}${error}</div><span class="badge ${cls}">${label}${retry}${dry && slot.status === 'done' ? ' (test)' : ''}</span></li>`;
}

async function renderBookings() {
  const view = $('#view');
  view.innerHTML = `
    <div class="row" style="align-items:center;margin-bottom:12px">
      <h2 style="margin:0">Bookings</h2>
      <button id="refresh" class="btn-small" style="flex:0 0 auto">Refresh</button>
    </div>
    <div id="list"><div class="empty"><span class="spinner" style="display:inline-block"></span></div></div>`;
  $('#refresh').addEventListener('click', load);

  async function load() {
    try {
      const { bookings } = await api('GET', '/bookings');
      if (currentTab !== 'bookings') return;
      const list = $('#list');
      if (!bookings.length) {
        list.innerHTML = `<div class="card empty">No bookings in the last 14 days.</div>`;
        return;
      }
      list.innerHTML = bookings.map(b => {
        const [label, cls] = BOOKING_STATUS[b.status] ?? [b.status, 'badge-muted'];
        const last = b.slots.at(-1);
        const end = last ? last.due_at + last.hours * HOUR_MS : b.start_at;
        const canCancel = b.status === 'active' && b.slots.some(s => s.status === 'pending');
        return `
          <div class="card">
            <div class="booking-head">
              <div>
                <strong>${esc(b.nickname || 'Visitor')}</strong>
                <div class="plate">${esc(b.canton === 'Ausland' ? b.plate : `${b.canton} ${b.plate}`)}</div>
              </div>
              <span class="badge ${cls}">${label}${b.dry ? ' · test' : ''}</span>
            </div>
            <div class="muted small" style="margin-top:6px">${fmtTime(b.start_at)} → ${fmtTime(end)} · ${b.total_hours}h wanted</div>
            <ul class="slots">${b.slots.map(s => slotLine(s, b.dry)).join('')}</ul>
            ${canCancel ? `<button class="btn-danger btn-small" data-cancel="${esc(b.id)}" style="margin-top:10px">Cancel remaining</button>` : ''}
          </div>`;
      }).join('');
      $$('[data-cancel]', list).forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm('Cancel all registrations of this booking that have not happened yet?')) return;
        btn.disabled = true;
        try { await api('DELETE', `/bookings/${btn.dataset.cancel}`); toast('Cancelled.'); load(); }
        catch (err) { toast(`Cancel failed: ${err.message}`); btn.disabled = false; }
      }));
    } catch (err) {
      $('#list').innerHTML = `<div class="card preview error">Could not load bookings: ${esc(err.message)}</div>`;
    }
  }

  await load();
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30_000);
}

// ---------- Visitors ----------

let editingVisitorId = null;

function openVisitorForm(id = 'new') { editingVisitorId = id; renderVisitors(); }

function renderVisitors() {
  const view = $('#view');
  const editing = editingVisitorId === 'new' ? { canton: settings.lastCanton || 'SO' } : visitors.find(f => f.id === editingVisitorId);
  const sorted = [...visitors].sort((a, b) => a.nickname.localeCompare(b.nickname));

  view.innerHTML = `
    ${editing ? `
      <form id="visitor-form" class="card">
        <h2>${editingVisitorId === 'new' ? 'Add visitor' : 'Edit visitor'}</h2>
        <label for="f-nick">Nickname</label>
        <input id="f-nick" required maxlength="40" value="${esc(editing.nickname)}" placeholder="e.g. Anna">
        <div class="row">
          <div>
            <label for="f-canton">Canton</label>
            <select id="f-canton">${CANTONS.map(c => `<option ${c === editing.canton ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
          <div>
            <label for="f-plate">Plate number</label>
            <input id="f-plate" required maxlength="12" value="${esc(editing.plate)}" placeholder="12345" autocapitalize="characters">
          </div>
        </div>
        <div class="row" style="margin-top:16px">
          <button type="button" id="f-cancel">Cancel</button>
          <button type="submit" class="btn-primary" style="font-size:1rem">Save</button>
        </div>
        ${editingVisitorId !== 'new' ? `<button type="button" id="f-delete" class="btn-link" style="margin-top:12px;color:var(--err)">Delete ${esc(editing.nickname)}</button>` : ''}
      </form>` : `<button id="add-visitor" class="btn-block" style="margin-bottom:12px">+ Add visitor</button>`}

    <div class="card">
      ${sorted.length ? sorted.map(f => `
        <div class="visitor">
          <div><strong>${esc(f.nickname)}</strong><div class="plate">${esc(plateLabel(f))}</div></div>
          <div class="row" style="flex:0 0 auto">
            <button class="btn-small" data-edit="${esc(f.id)}">Edit</button>
            <button class="btn-small" data-book="${esc(f.id)}">Book</button>
          </div>
        </div>`).join('') : `<div class="empty">No visitors saved yet.</div>`}
    </div>`;

  $('#add-visitor')?.addEventListener('click', () => openVisitorForm());
  $$('[data-edit]').forEach(b => b.addEventListener('click', () => openVisitorForm(b.dataset.edit)));
  $$('[data-book]').forEach(b => b.addEventListener('click', () => { settings.lastVisitorId = b.dataset.book; saveSettings(); show('book'); }));

  if (!editing) return;
  $('#f-nick').focus();
  $('#f-cancel').addEventListener('click', () => openVisitorForm(null));
  $('#f-delete')?.addEventListener('click', () => {
    if (!confirm(`Delete ${editing.nickname}?`)) return;
    visitors = visitors.filter(f => f.id !== editingVisitorId);
    saveVisitors();
    openVisitorForm(null);
  });
  $('#visitor-form').addEventListener('submit', e => {
    e.preventDefault();
    const nickname = $('#f-nick').value.trim();
    const canton = $('#f-canton').value;
    const plate = plateNumber(canton, $('#f-plate').value);
    if (!nickname || !plate) return toast('Please enter nickname and plate number.');
    if (canton !== 'Ausland' && !/^\d{1,6}$/.test(plate)) return toast('Swiss plate numbers have only digits (max 6), e.g. 12345.');
    if (visitors.some(f => f.nickname.toLowerCase() === nickname.toLowerCase() && f.id !== editingVisitorId)) return toast('This nickname already exists.');

    if (editingVisitorId === 'new') visitors.push({ id: crypto.randomUUID(), nickname, canton, plate });
    else Object.assign(visitors.find(f => f.id === editingVisitorId), { nickname, canton, plate });
    settings.lastCanton = canton;
    saveSettings();
    saveVisitors();
    toast(`${nickname} saved.`);
    openVisitorForm(null);
  });
}

// ---------- Settings, backup ----------

function backupData() {
  return {
    app: 'parkbuddy',
    version: 1,
    exportedAt: new Date().toISOString(),
    visitors,
    settings: { email: settings.email, workerUrl: settings.workerUrl, accessKey: settings.accessKey, clientId: settings.clientId },
  };
}

async function exportBackup(preferShare) {
  const name = `parkbuddy-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(backupData(), null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (preferShare && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'ParkBuddy backup' }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('This is not a ParkBuddy backup file.'); }
  if (data?.app !== 'parkbuddy' || !Array.isArray(data.visitors)) return toast('This is not a ParkBuddy backup file.');

  // Visitors are merged by nickname; imported entries win.
  let added = 0, updated = 0;
  for (const f of data.visitors) {
    if (!f?.nickname || !CANTONS.includes(f.canton) || !f.plate) continue;
    const existing = visitors.find(x => x.nickname.toLowerCase() === f.nickname.toLowerCase());
    if (existing) { Object.assign(existing, { canton: f.canton, plate: f.plate }); updated++; }
    else { visitors.push({ id: crypto.randomUUID(), nickname: f.nickname, canton: f.canton, plate: f.plate }); added++; }
  }
  saveVisitors();

  const s = data.settings ?? {};
  if (!settings.email && s.email) settings.email = s.email;
  if (!isConnected() && s.workerUrl && s.accessKey) {
    // Restoring onto a fresh phone: take over the connection and the booking history.
    Object.assign(settings, { workerUrl: s.workerUrl, accessKey: s.accessKey, clientId: s.clientId || settings.clientId });
  }
  saveSettings();
  toast(`Backup imported: ${added} visitors added, ${updated} updated.`, 5000);
  show(currentTab);
}

function renderSettings() {
  const view = $('#view');
  view.innerHTML = `
    <div class="card">
      <h2>Confirmation e-mail</h2>
      <form id="email-form">
        <input id="s-email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" value="${esc(settings.email)}">
        <div class="hint">Used for every booking. Leave empty to get no confirmation e-mails.</div>
        <button type="submit" class="btn-small" style="margin-top:10px">Save e-mail</button>
      </form>
    </div>

    <div class="card">
      <h2>Share ParkBuddy</h2>
      <p class="small muted">Neighbours or family open this link on their phone and are connected immediately. Anyone with the link can make bookings, so share it only with people you trust.</p>
      <div class="stack">
        <button id="share-invite" class="btn-block">Share invite link</button>
        <button id="copy-invite" class="btn-block">Copy invite link</button>
      </div>
    </div>

    <div class="card">
      <h2>Backup</h2>
      <p class="small muted">Your visitors are stored only on this phone. Save a backup to Google Drive, iCloud, e-mail or anywhere else, and import it on a new phone.</p>
      <div class="stack">
        <button id="export-share" class="btn-block">Export backup…</button>
        <button id="export-download" class="btn-block">Download backup file</button>
        <label class="btn btn-block" style="margin:10px 0 0;font-size:1rem">Import backup<input id="import-file" type="file" accept="application/json,.json" hidden></label>
      </div>
      <p class="hint">The backup file includes the access key. Keep it private.</p>
    </div>

    <div class="card">
      <h2>Test mode</h2>
      <label class="check"><input id="s-test" type="checkbox" ${settings.testMode ? 'checked' : ''}>
        <span>Fill in the parkon form but do <strong>not</strong> submit it. For trying out the app.</span></label>
    </div>

    <div class="card">
      <h2>Connection</h2>
      <p class="small muted" style="word-break:break-all">${esc(settings.workerUrl)}</p>
      <button id="disconnect" class="btn-danger btn-small">Disconnect this phone</button>
    </div>

    <p class="small muted" style="text-align:center">ParkBuddy ${APP_VERSION} · <a href="${PORTAL_URL}" target="_blank" rel="noopener">parkon portal</a></p>`;

  $('#email-form').addEventListener('submit', e => {
    e.preventDefault();
    const email = $('#s-email').value.trim();
    if (email && !isEmail(email)) return toast('Please check the e-mail address.');
    settings.email = email;
    saveSettings();
    toast(email ? 'E-mail saved.' : 'Confirmation e-mails turned off.');
  });

  $('#share-invite').addEventListener('click', async () => {
    const data = { title: 'ParkBuddy', text: 'Register visitor parking with ParkBuddy:', url: inviteLink() };
    if (navigator.share) { try { await navigator.share(data); } catch { /* cancelled */ } }
    else { await navigator.clipboard.writeText(data.url); toast('Invite link copied.'); }
  });
  $('#copy-invite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied.'); }
    catch { prompt('Copy this invite link:', inviteLink()); }
  });

  $('#export-share').addEventListener('click', () => exportBackup(true));
  $('#export-download').addEventListener('click', () => exportBackup(false));
  $('#import-file').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

  $('#s-test').addEventListener('change', e => {
    settings.testMode = e.target.checked;
    saveSettings();
    $('#test-badge').hidden = !settings.testMode;
    toast(settings.testMode ? 'Test mode on: nothing is submitted to parkon.' : 'Test mode off: bookings are real.');
  });

  $('#disconnect').addEventListener('click', () => {
    if (!confirm('Disconnect this phone? Your visitors stay saved; you need the invite link to connect again.')) return;
    settings.workerUrl = settings.accessKey = '';
    saveSettings();
    show('book');
  });
}

// ---------- start ----------

readInviteFromUrl();
window.addEventListener('hashchange', () => { readInviteFromUrl(); show(currentTab); });
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
show('book');
