// Profile tab: photo, name/username, password. (The Notifications card is handled in push.js.)
import { $, api, state, formData, avatar, resizeImage } from './core.js';
import { disablePush } from './push.js';

let ready = false;
let onChange = () => {};

function flash(id, text) {
  const e = $(id);
  e.textContent = text;
  setTimeout(() => (e.textContent = ''), 3000);
}

export function renderProfile() {
  const u = state.user;
  $('#profileAvatar').replaceWith(Object.assign(avatar(u, 'xl'), { id: 'profileAvatar' }));
  $('#profileTitle').textContent = u.name;
  $('#profileSub').textContent = `@${u.username}${u.isAdmin ? ' · Admin' : ''}`;
  $('#avatarRemove').hidden = !u.avatar;
  const f = $('#profileForm');
  f.name.value = u.name;
  f.username.value = u.username;
  f.shared_alerts.checked = !!u.shared_alerts;
}

export function initProfile(refreshUser) {
  onChange = refreshUser;
  renderProfile();
  if (ready) return;
  ready = true;

  $('#avatarInput').addEventListener('change', async (e) => {
    $('#avatarError').textContent = '';
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await api('/api/profile/avatar', { body: { image: await resizeImage(file) } });
      await onChange();
    } catch (err) {
      $('#avatarError').textContent = err.message;
    }
  });
  $('#avatarRemove').addEventListener('click', async () => {
    await api('/api/profile/avatar', { method: 'DELETE' });
    await onChange();
  });

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#profileError').textContent = '';
    try {
      const f = e.target;
      await api('/api/profile', { method: 'PATCH', body: { name: f.name.value, username: f.username.value, shared_alerts: f.shared_alerts.checked } });
      await onChange();
      flash('#profileOk', 'Saved ✓');
    } catch (err) {
      $('#profileError').textContent = err.message;
    }
  });

  $('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#passwordError').textContent = '';
    const f = formData(e.target);
    if (f.next !== f.repeat) return ($('#passwordError').textContent = "The new passwords don't match.");
    try {
      await api('/api/profile/password', { body: { current: f.current, next: f.next } });
      e.target.reset();
      flash('#passwordOk', 'Password changed ✓');
    } catch (err) {
      $('#passwordError').textContent = err.message;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await disablePush().catch(() => {}); // stop this device getting this account's notifications
    await api('/api/logout', { body: {} });
    location.hash = '';
    location.reload();
  });
}
