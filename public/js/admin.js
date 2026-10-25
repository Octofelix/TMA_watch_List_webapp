// Admin tab: overview numbers, every user account, every notification sent.
import { $, el, api, state, avatar, fmtDateTime, resizeImage, renderMessages } from './core.js';

let users = [];
let editing = null;
let ready = false;
let onSelfChange = () => {};

export async function openAdmin(refreshUser) {
  onSelfChange = refreshUser;
  if (!ready) setup();
  await load();
}

async function load() {
  const data = await api('/api/admin/overview');
  users = data.users;
  const s = data.stats;
  $('#adminStats').replaceChildren(
    ...[
      [s.users, 'users'],
      [s.activeWatches, 'flights being watched'],
      [s.sharedWatches, 'shared flights'],
      [s.totalWatches, 'flights in total'],
      [s.devices, 'phones with notifications on'],
      [s.messages, 'notifications sent'],
      [s.chat, 'chat messages'],
    ].map(([n, l]) => el('div', { class: 'stat card' }, el('b', {}, String(n)), el('span', {}, l)))
  );
  renderUsers();
  if ($('#adminOutboxBox').open) loadOutbox();
}

async function loadOutbox() {
  renderMessages($('#adminOutbox'), await api('/api/admin/outbox'), { showWho: true });
}

function renderUsers() {
  const q = $('#userSearch').value.trim().toLowerCase();
  const rows = users.filter((u) => !q || [u.name, u.username].some((v) => (v || '').toLowerCase().includes(q)));
  $('#usersTable').replaceChildren(
    el('thead', {}, el('tr', {}, ...['User', 'Notifications', 'Status', 'Flights', 'Joined', ''].map((h) => el('th', {}, h)))),
    el('tbody', {},
      ...rows.map((u) =>
        el('tr', { class: u.disabled ? 'disabled' : '' },
          el('td', {}, el('div', { class: 'usercell' }, avatar(u, 'sm'),
            el('div', {}, el('b', {}, u.name), el('div', { class: 'muted' }, `@${u.username}`)))),
          el('td', {}, u.devices ? `🔔 ${u.devices} device${u.devices > 1 ? 's' : ''}` : el('span', { class: 'muted' }, 'off')),
          el('td', {}, ...[
            u.role === 'admin' && el('span', { class: 'tag admin' }, 'Admin'),
            u.disabled ? el('span', { class: 'tag off' }, 'Disabled') : null,
            !u.disabled && u.role !== 'admin' && el('span', { class: 'tag ok' }, 'Active'),
          ]),
          el('td', {}, `${u.active_watches} active / ${u.total_watches}`),
          el('td', { class: 'muted' }, fmtDateTime(u.created_at)),
          el('td', {}, el('button', { class: 'small', type: 'button', onclick: () => openEditor(u) }, 'Manage'))
        )
      ),
      rows.length ? null : el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No users match.'))
    )
  );
}

function openEditor(u) {
  editing = u;
  const f = $('#userEditForm');
  $('#editError').textContent = '';
  $('#editTitle').textContent = `${u.name} (@${u.username})`;
  $('#editAvatar').replaceWith(Object.assign(avatar(u, 'lg'), { id: 'editAvatar' }));
  $('#editAvatarRemove').hidden = !u.avatar;
  f.name.value = u.name;
  f.username.value = u.username;
  $('#editDevices').textContent = u.devices ? `Notifications on for ${u.devices} device${u.devices > 1 ? 's' : ''}` : 'Notifications not switched on yet';
  $('#editTestPush').hidden = !u.devices;
  $('#editTestResult').textContent = '';
  f.shared_alerts.checked = !!u.shared_alerts;
  f.admin.checked = u.role === 'admin';
  f.disabled.checked = !!u.disabled;
  f.password.value = '';
  const self = u.id === state.user.id;
  f.admin.disabled = self;
  f.disabled.disabled = self;
  $('#editDelete').hidden = self;
  resetDelete();
  $('#userDialog').showModal();
}

function resetDelete() {
  const b = $('#editDelete');
  delete b.dataset.armed;
  b.textContent = 'Delete account';
}

function setup() {
  ready = true;
  $('#userSearch').addEventListener('input', renderUsers);
  $('#editTestPush').addEventListener('click', async () => {
    const out = $('#editTestResult');
    out.className = 'hint';
    out.textContent = 'Sending…';
    try {
      const r = await api(`/api/admin/users/${editing.id}/test-push`, { body: {} });
      out.className = r.status === 'sent' ? 'ok' : 'error';
      out.textContent = r.status === 'sent' ? `✓ Sent to ${r.sent} device${r.sent > 1 ? 's' : ''}.`
        : r.status === 'no-device' ? 'This user has no devices with notifications on.' : `✗ Not sent: ${r.error}`;
    } catch (err) {
      out.className = 'error';
      out.textContent = err.message;
    }
  });
  $('#adminOutboxBox').addEventListener('toggle', (e) => e.target.open && loadOutbox());
  $('#editCancel').addEventListener('click', () => $('#userDialog').close());

  $('#userEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#editError').textContent = '';
    try {
      await api(`/api/admin/users/${editing.id}`, {
        method: 'PATCH',
        body: {
          name: f.name.value, username: f.username.value, shared_alerts: f.shared_alerts.checked,
          role: f.admin.checked ? 'admin' : 'user', disabled: f.disabled.checked,
        },
      });
      if (f.password.value) await api(`/api/admin/users/${editing.id}/password`, { body: { password: f.password.value } });
      $('#userDialog').close();
      await load();
      if (editing.id === state.user.id) await onSelfChange();
    } catch (err) {
      $('#editError').textContent = err.message;
    }
  });

  $('#editDelete').addEventListener('click', async () => {
    const b = $('#editDelete');
    if (!b.dataset.armed) {
      b.dataset.armed = '1';
      b.textContent = `Tap again to delete ${editing.username} and all their data`;
      return;
    }
    try {
      await api(`/api/admin/users/${editing.id}`, { method: 'DELETE' });
      $('#userDialog').close();
      await load();
    } catch (err) {
      $('#editError').textContent = err.message;
    }
  });

  $('#editAvatarInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { avatar: url } = await api(`/api/admin/users/${editing.id}/avatar`, { body: { image: await resizeImage(file) } });
      editing.avatar = url;
      $('#editAvatar').replaceWith(Object.assign(avatar(editing, 'lg'), { id: 'editAvatar' }));
      $('#editAvatarRemove').hidden = false;
      await load();
    } catch (err) {
      $('#editError').textContent = err.message;
    }
  });
  $('#editAvatarRemove').addEventListener('click', async () => {
    await api(`/api/admin/users/${editing.id}/avatar`, { method: 'DELETE' });
    editing.avatar = null;
    $('#editAvatar').replaceWith(Object.assign(avatar(editing, 'lg'), { id: 'editAvatar' }));
    $('#editAvatarRemove').hidden = true;
    await load();
  });
}
