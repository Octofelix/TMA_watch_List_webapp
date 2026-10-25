// Flights tab (active watches + new-watch form) and History tab.
import { $, $$, el, api, state, formData, avatar, fmtTime, fmtDateTime, fmtDay, storageGet, storageSet, renderMessages } from './core.js';

const LABELS = {
  scheduled: 'Waiting for aircraft',
  assigned: 'Aircraft assigned',
  departed: 'Departed',
  approaching: 'Approaching',
  landed: 'Landed',
  delayed: 'Delayed',
  cancelled: 'Cancelled',
  stopped: 'Stopped watching',
};
const NOTIFY_LABELS = {
  assigned: 'Aircraft assigned',
  departed: 'Departs',
  approaching: 'Approaching',
  landed: 'Lands',
  delayed: 'Delayed',
  cancelled: 'Cancelled',
};
const ORDER = ['assigned', 'departed', 'approaching', 'landed'];

let destinations = [];
const lists = {
  active: { cards: new Map(), container: () => $('#watchList'), empty: 'No flights being watched. Add one above. You can enter the tail code later, once TMA confirms the aircraft.' },
  history: { cards: new Map(), container: () => $('#historyList'), empty: 'Nothing here yet. Flights show up here once they land, get cancelled, or you stop watching them.' },
};
let historyFilter = 'all';
let historyRows = [];

// ---- Destinations & new watch form -----------------------------------------------------

async function loadDestinations(selectId) {
  destinations = await api('/api/destinations');
  const sel = $('#destSelect');
  const groups = new Map();
  for (const d of destinations) {
    const g = d.type === 'base' ? 'Malé' : d.type === 'island' ? 'Local islands & added places' : `${d.atoll} Atoll`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(d);
  }
  sel.replaceChildren(new Option('Choose a resort or island…', ''));
  for (const [g, list] of groups) {
    const og = el('optgroup', { label: g });
    for (const d of list) og.append(new Option(d.name, d.id));
    sel.append(og);
  }
  const lux = destinations.find((d) => d.name.startsWith('LUX* South Ari'));
  sel.value = selectId ?? storageGet('lastDest') ?? lux?.id ?? '';
}

function notifyChecks(container, selected, onChange) {
  container.replaceChildren(
    ...state.me.notifiable.map((s) => {
      const cb = el('input', { type: 'checkbox', value: s });
      cb.checked = selected.includes(s);
      if (onChange) cb.addEventListener('change', onChange);
      return el('label', {}, cb, NOTIFY_LABELS[s]);
    })
  );
}
const checkedValues = (container) => $$('input:checked', container).map((c) => c.value);

let formReady = false;
export async function initFlights() {
  await loadDestinations();
  const form = $('#watchForm');
  form.flight_date.value = state.me.today;
  notifyChecks($('#notifyChecks'), state.me.notifiable);
  if (formReady) return;
  formReady = true;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#watchError').textContent = '';
    try {
      const body = { ...formData(form), shared: form.shared.checked, notify: checkedValues($('#notifyChecks')) };
      const { id } = await api('/api/watches', { body });
      storageSet('lastDest', form.destination_id.value);
      form.label.value = '';
      form.expected_time.value = '';
      form.shared.checked = false;
      await refreshActive();
      lists.active.cards.get(id)?.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      $('#watchError').textContent = err.message;
    }
  });

  $('#outboxBox').addEventListener('toggle', async (e) => {
    if (e.target.open) renderMessages($('#outboxList'), await api('/api/outbox'));
  });

  $('#addPlaceBtn').addEventListener('click', () => {
    const box = $('#addPlace');
    box.hidden = !box.hidden;
    if (!box.hidden) initPlaceMap();
  });
  $('#placeSearchBtn').addEventListener('click', searchPlaces);
  $('#placeQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchPlaces(); }
  });
  $('#placeName').addEventListener('input', updatePlaceSave);
  $('#placeSaveBtn').addEventListener('click', savePlace);

  $$('#historyFilters .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      historyFilter = chip.dataset.f;
      $$('#historyFilters .chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderList('history', historyRows);
    })
  );
}

// Custom place picker (search via OpenStreetMap or click the map)
let placeMap, placeMarker, placePoint = null;
function initPlaceMap() {
  if (placeMap) return setTimeout(() => placeMap.invalidateSize(), 0);
  placeMap = L.map('placeMap').setView([4.2, 73.2], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; OpenStreetMap contributors' }).addTo(placeMap);
  for (const d of destinations) {
    if (d.lat != null) L.circleMarker([d.lat, d.lon], { radius: 3, color: '#1592a5', weight: 1 }).bindTooltip(d.name).addTo(placeMap);
  }
  placeMap.on('click', (e) => setPlacePoint(e.latlng.lat, e.latlng.lng));
}
function setPlacePoint(lat, lon, name) {
  placePoint = { lat, lon };
  if (placeMarker) placeMarker.setLatLng([lat, lon]);
  else placeMarker = L.marker([lat, lon]).addTo(placeMap);
  if (name) $('#placeName').value = name;
  updatePlaceSave();
}
function updatePlaceSave() {
  $('#placeSaveBtn').disabled = !(placePoint && $('#placeName').value.trim());
}
async function searchPlaces() {
  const q = $('#placeQuery').value.trim();
  $('#placeError').textContent = '';
  if (q.length < 3) return;
  try {
    const hits = await api('/api/places/search?q=' + encodeURIComponent(q));
    $('#placeResults').replaceChildren(
      ...(hits.length
        ? hits.map((h) =>
            el('li', {}, el('button', {
              type: 'button',
              onclick: () => { setPlacePoint(h.lat, h.lon, h.name); placeMap.setView([h.lat, h.lon], 13); },
            }, h.label))
          )
        : [el('li', { class: 'hint' }, 'No matches. Click the map instead.')])
    );
  } catch (err) {
    $('#placeError').textContent = err.message;
  }
}
async function savePlace() {
  try {
    const { id } = await api('/api/destinations', { body: { name: $('#placeName').value.trim(), ...placePoint } });
    await loadDestinations(String(id));
    $('#addPlace').hidden = true;
    $('#placeResults').replaceChildren();
  } catch (err) {
    $('#placeError').textContent = err.message;
  }
}

// ---- Loading ---------------------------------------------------------------------------

export async function refreshActive() {
  try {
    renderList('active', await api('/api/watches'));
    $('#lastRefresh').textContent = 'Updated ' + fmtTime(Date.now());
    if ($('#outboxBox').open) renderMessages($('#outboxList'), await api('/api/outbox'));
  } catch (err) {
    $('#lastRefresh').textContent = err.message;
  }
}

export async function refreshHistory() {
  historyRows = await api('/api/watches?scope=history');
  renderList('history', historyRows);
}

function renderList(kind, watches) {
  const { cards, container, empty } = lists[kind];
  const list = container();
  if (kind === 'history') {
    watches = watches.filter((w) => historyFilter === 'all' || (historyFilter === 'mine' ? w.is_owner : w.shared));
  }
  const seen = new Set();
  for (const w of watches) {
    seen.add(w.id);
    let c = cards.get(w.id);
    if (!c) {
      c = createCard(w, kind);
      cards.set(w.id, c);
    }
    updateCard(c, w);
    list.append(c.el); // keeps server order
  }
  for (const [id, c] of cards) {
    if (!seen.has(id)) { c.el.remove(); cards.delete(id); }
  }
  $('.empty', list)?.remove();
  if (!watches.length) list.append(el('div', { class: 'card empty' }, empty));
}

// ---- Cards -----------------------------------------------------------------------------

function createCard(w, kind) {
  const node = $('#watchTpl').content.firstElementChild.cloneNode(true);
  const c = { el: node, w, kind, map: null, markers: {} };
  if (kind === 'history') node.classList.add('archived');

  // Tail code: step 1 checks it, step 2 (only for a verified TMA aircraft) saves it.
  const tailForm = $('.tailform', node);
  tailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    checkTailCode(c, tailForm.tail.value);
  });
  tailForm.tail.addEventListener('input', () => {
    c.checkedTail = null;
    $('.tailcheck', node).hidden = true;
  });
  $('.confirmbtn', node).addEventListener('click', async () => {
    if (!c.checkedTail) return;
    const btn = $('.confirmbtn', node);
    btn.disabled = true;
    await act(c, () => api(`/api/watches/${c.w.id}/tail`, { method: 'PATCH', body: { tail: c.checkedTail } }));
    btn.disabled = false;
    if (!$('.werror', node).textContent) {
      tailForm.tail.value = '';
      c.checkedTail = null;
      c.editingTail = false;
      $('.tailcheck', node).hidden = true;
      updateCard(c, c.w);
    }
  });

  // Status buttons. Delayed/Cancelled open a small note box first.
  const notebox = $('.notebox', node);
  $$('[data-set]', node).forEach((b) =>
    b.addEventListener('click', () => {
      const status = b.dataset.set;
      if (status === 'delayed' || status === 'cancelled') {
        notebox.dataset.status = status;
        notebox.hidden = false;
        $('button[type=submit]', notebox).textContent = status === 'cancelled' ? 'Send cancellation' : 'Send delay update';
        notebox.detail.focus();
        return;
      }
      act(c, () => api(`/api/watches/${c.w.id}/status`, { body: { status } }));
    })
  );
  notebox.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = { status: notebox.dataset.status, detail: notebox.detail.value };
    notebox.hidden = true;
    notebox.detail.value = '';
    act(c, () => api(`/api/watches/${c.w.id}/status`, { body }));
  });
  $('[data-cancel]', notebox).addEventListener('click', () => { notebox.hidden = true; });

  $('.mapbtn', node).addEventListener('click', () => toggleMap(c));
  confirmButton($('.stop', node), 'Tap again to stop', () => act(c, () => api(`/api/watches/${c.w.id}/stop`, { body: {} }), 'both'));
  $('.resume', node).addEventListener('click', () => act(c, () => api(`/api/watches/${c.w.id}/resume`, { body: {} }), 'both'));
  confirmButton($('.del', node), 'Tap again to delete', () => act(c, () => api(`/api/watches/${c.w.id}`, { method: 'DELETE' }), 'both'));

  notifyChecks($('.wnotify', node), w.notify.split(','), () =>
    act(c, () => api(`/api/watches/${c.w.id}/notify`, { method: 'PATCH', body: { notify: checkedValues($('.wnotify', node)) } }), false)
  );
  $('.wshare input', node).addEventListener('change', (e) =>
    act(c, () => api(`/api/watches/${c.w.id}/shared`, { method: 'PATCH', body: { shared: e.target.checked } }))
  );
  return c;
}

async function checkTailCode(c, value) {
  const node = c.el;
  const panel = $('.tailcheck', node);
  const btn = $('.checkbtn', node);
  $('.werror', node).textContent = '';
  c.checkedTail = null;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const r = await api('/api/aircraft/check?tail=' + encodeURIComponent(value));
    const a = r.aircraft || {};
    panel.className = 'tailcheck ' + (r.ok ? 'good' : 'badcheck');
    $('.tctitle', panel).textContent = r.ok ? `✓ ${r.tail} is a verified TMA aircraft` : `✗ ${r.tail} can't be used`;
    $('.tcdetail', panel).textContent = r.ok
      ? [a.type, a.owner || (r.operator_unverified ? 'Maldives registration (operator not listed)' : null)].filter(Boolean).join(' · ')
      : r.problem;
    $('.tclive', panel).textContent = !r.ok ? '' : r.live
      ? `🟢 Live now: ${r.live.on_ground || r.live.alt === 0 ? 'on the water' : `flying at ${r.live.alt.toLocaleString()} ft, ${Math.round(r.live.gs)} kt`} (seen ${r.live.seconds_ago}s ago)`
      : "⚪ Not on live tracking right now. That's normal before take-off; tracking picks it up once it's flying.";
    const photo = $('.tcphoto', panel);
    photo.hidden = !(r.ok && a.photo);
    if (r.ok && a.photo) photo.src = a.photo;
    $('.tcactions', panel).hidden = !r.ok;
    panel.hidden = false;
    if (r.ok) c.checkedTail = r.tail;
  } catch (err) {
    $('.werror', node).textContent = err.message;
    panel.hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check aircraft';
  }
}

// Two-tap confirm instead of a pop-up dialog.
function confirmButton(btn, confirmText, onConfirm) {
  const original = btn.textContent;
  btn.addEventListener('click', () => {
    if (btn.dataset.armed) return onConfirm();
    btn.dataset.armed = '1';
    btn.textContent = confirmText;
    btn.classList.add('armed');
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = original; btn.classList.remove('armed'); }, 4000);
  });
}

async function act(c, fn, reload = true) {
  $('.werror', c.el).textContent = '';
  try {
    await fn();
    if (reload === 'both') await Promise.all([refreshActive(), refreshHistory()]);
    else if (reload) await (c.kind === 'history' ? refreshHistory() : refreshActive());
  } catch (err) {
    $('.werror', c.el).textContent = err.message;
  }
}

function updateCard(c, w) {
  c.w = w;
  const node = c.el;
  const archived = !!w.archived_at;
  const canEdit = w.can_edit && !archived;

  $('.wdest', node).textContent = w.dest_name;
  $('.wmeta', node).textContent = [fmtDay(w.flight_date), w.expected_time && `expected ${w.expected_time}`, w.label, w.tail && archived && w.tail]
    .filter(Boolean).join(' · ');

  // Who it belongs to / whether it's shared
  const owner = $('.wowner', node);
  owner.replaceChildren();
  if (!w.is_owner) {
    owner.append(avatar({ id: w.user_id, name: w.owner_name, avatar: w.owner_avatar }, 'sm'),
      w.shared ? `Shared by ${w.owner_name}` : `${w.owner_name}'s flight (admin view)`);
  } else if (w.shared) {
    owner.append(el('span', { class: 'sharetag' }, '📢 Shared with everyone'));
  }

  const pill = $('.pill', node);
  const shown = archived ? w.archived_reason || w.status : w.status;
  pill.className = 'pill ' + shown;
  pill.textContent = LABELS[shown] || shown;

  // Progress steps
  const reached = w.events.map((e) => e.status);
  const idx = ORDER.indexOf(w.status);
  $$('.steps li', node).forEach((li, i) => {
    const s = li.dataset.s;
    li.classList.toggle('done', (idx >= 0 && i <= idx) || reached.includes(s));
    li.classList.toggle('current', s === w.status);
  });

  // Tail code: input when missing, chip with "Change" once set
  const box = $('.tailbox', node);
  box.hidden = archived;
  let chip = $('.tailchip', box);
  if (w.tail && !c.editingTail) {
    $('.tailform', box).hidden = true;
    $('.tailhint', box).hidden = true;
    if (!chip) {
      chip = el('div', { class: 'tailchip' }, el('span', {}, '✈ ', el('span', { class: 't' })), el('span', { class: 'ty muted' }),
        el('button', { type: 'button', class: 'link', onclick: () => {
          c.editingTail = true;
          updateCard(c, c.w);
          $('.tailform input', box).focus();
        } }, 'Change'));
      box.prepend(chip);
    }
    $('.t', chip).textContent = w.tail;
    $('.ty', chip).textContent = w.aircraft_type || '';
    $('button', chip).hidden = !canEdit;
    $('.tailcheck', box).hidden = true;
    chip.hidden = false;
  } else {
    if (chip) chip.hidden = true;
    $('.tailform', box).hidden = !canEdit;
    $('.tailhint', box).hidden = !canEdit || !!w.tail;
    if (!canEdit && !w.tail) box.hidden = true;
  }

  // Live data
  const live = $('.live', node);
  const stats = [];
  if (!archived) {
    if (w.distance_km != null) stats.push([`${w.distance_km.toFixed(1)} km`, 'to destination']);
    if (w.eta_min != null) stats.push([`${w.eta_min} min`, 'estimated']);
    if (w.last_alt != null && w.last_seen_at) stats.push([w.last_alt ? `${w.last_alt.toLocaleString()} ft` : 'On water', 'altitude']);
    if (w.last_gs != null && w.last_seen_at) stats.push([`${Math.round(w.last_gs)} kt`, 'speed']);
  }
  live.replaceChildren(...stats.map(([v, l]) => el('div', { class: 'stat' }, el('b', {}, v), el('span', {}, l))));
  if (!archived && w.tail && ['assigned', 'departed', 'approaching', 'delayed'].includes(w.status)) {
    const isToday = w.flight_date === state.me.today;
    live.append(el('p', { class: 'note' }, !isToday
      ? 'Live tracking starts on the day of the flight.'
      : w.last_seen_at
        ? `Last live position ${fmtTime(w.last_seen_at)}. Tracking checks every 30 seconds.`
        : `Looking for ${w.tail} on live flight data… Seaplanes aren't always visible, so you can also update the status by hand.`));
  }
  if (archived) {
    live.append(el('p', { class: 'note' }, `${LABELS[w.archived_reason] || 'Finished'} · ${fmtDateTime(w.archived_at)}`));
  }

  // Manual buttons: only for the owner/admin, and hide steps already passed
  $$('[data-set]', node).forEach((b) => {
    const s = b.dataset.set;
    const passed = ORDER.indexOf(s) >= 0 && idx >= ORDER.indexOf(s);
    b.hidden = !canEdit || !w.tail || passed || s === w.status;
  });
  $('.small-label', node).hidden = !canEdit || !w.tail;
  $('.mapbtn', node).hidden = w.dest_lat == null;
  $('.actions', node).hidden = w.dest_lat == null && (!canEdit || !w.tail);

  // Notifications & sharing (owner/admin only)
  const sel = w.notify.split(',');
  $('.wnotify', node).hidden = !canEdit;
  $$('.wnotify input', node).forEach((cb) => (cb.checked = sel.includes(cb.value)));
  $('.wshare', node).hidden = !canEdit;
  $('.wshare input', node).checked = !!w.shared;

  // Footer: stop (active) / watch again + delete (history)
  $('.stop', node).hidden = archived || !w.can_edit;
  $('.resume', node).hidden = !archived || !w.can_edit || w.archived_reason !== 'stopped';
  $('.del', node).hidden = !archived || !w.can_edit;
  $('.footer-actions', node).hidden = !w.can_edit;

  // History timeline
  $('.timeline', node).replaceChildren(
    ...(w.events.length
      ? w.events.map((e) =>
          el('li', {}, el('time', {}, fmtDateTime(e.created_at)),
            el('span', {}, `${LABELS[e.status] || e.status}${e.source === 'auto' ? ' (live tracking)' : e.by_name ? ` by ${e.by_name}` : ''}${e.detail ? ' · ' + e.detail : ''}`))
        )
      : [el('li', { class: 'muted' }, 'No updates yet.')])
  );

  if (c.map) updateMap(c);
}

function toggleMap(c) {
  const box = $('.wmap', c.el);
  box.hidden = !box.hidden;
  $('.mapbtn', c.el).textContent = box.hidden ? 'Show map' : 'Hide map';
  if (box.hidden) return;
  if (!c.map) {
    c.map = L.map(box, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; OpenStreetMap' }).addTo(c.map);
    c.map.setView([c.w.dest_lat, c.w.dest_lon], 9);
  }
  setTimeout(() => { c.map.invalidateSize(); updateMap(c, true); }, 0);
}

function updateMap(c, fit = false) {
  const w = c.w;
  if (!c.markers.dest) c.markers.dest = L.marker([w.dest_lat, w.dest_lon]).bindTooltip(w.dest_name).addTo(c.map);
  if (w.last_lat != null) {
    const icon = L.divIcon({ className: 'plane-icon', html: '✈', iconSize: [22, 22] });
    if (!c.markers.plane) c.markers.plane = L.marker([w.last_lat, w.last_lon], { icon }).addTo(c.map);
    else c.markers.plane.setLatLng([w.last_lat, w.last_lon]);
    c.markers.plane.bindTooltip(`${w.tail} · ${fmtTime(w.last_seen_at)}`);
    if (fit) c.map.fitBounds([[w.dest_lat, w.dest_lon], [w.last_lat, w.last_lon]], { padding: [30, 30], maxZoom: 12 });
  }
}
