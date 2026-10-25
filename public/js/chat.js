// Group chat for all users. Polls for new messages every few seconds while open.
import { $, el, api, state, avatar, fmtChatTime, storageGet, storageSet } from './core.js';

let lastId = 0;
let firstId = 0;
let loaded = false;
let open = false;
const nodes = new Map();

function messageNode(m) {
  const del = m.can_delete
    ? el('button', { class: 'link small danger msgdel', type: 'button', title: 'Delete message', onclick: () => removeMessage(m.id, del) }, 'Delete')
    : null;
  return el('div', { class: `chatmsg${m.mine ? ' mine' : ''}`, 'data-id': m.id },
    m.mine ? null : avatar(m, 'sm'),
    el('div', { class: 'bubble' },
      el('div', { class: 'who' }, m.mine ? 'You' : m.name, m.role === 'admin' ? el('span', { class: 'admintag' }, 'Admin') : null,
        el('span', { class: 'muted' }, ` @${m.username} · ${fmtChatTime(m.created_at)}`)),
      el('div', { class: 'text' }, m.body),
      del
    )
  );
}

async function removeMessage(id, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to delete';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 4000);
    return;
  }
  try {
    await api(`/api/chat/${id}`, { method: 'DELETE' });
    nodes.get(id)?.remove();
    nodes.delete(id);
  } catch (err) {
    $('#chatError').textContent = err.message;
  }
}

function append(messages) {
  const list = $('#chatList');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  for (const m of messages) {
    if (nodes.has(m.id)) continue;
    const n = messageNode(m);
    nodes.set(m.id, n);
    list.append(n);
    lastId = Math.max(lastId, m.id);
    if (!firstId) firstId = m.id;
  }
  $('.chatempty', list)?.remove();
  if (!nodes.size) list.append(el('p', { class: 'muted chatempty' }, 'No messages yet. Say hello 👋'));
  if (nearBottom || messages.some((m) => m.mine)) list.scrollTop = list.scrollHeight;
  $('#chatCount').textContent = `${nodes.size} message${nodes.size === 1 ? '' : 's'}`;
}

async function poll() {
  const data = await api(loaded ? `/api/chat?after=${lastId}&from=${firstId}` : '/api/chat');
  if (!loaded) {
    loaded = true;
    firstId = data.messages[0]?.id || 0;
  }
  if (data.ids) {
    const alive = new Set(data.ids);
    for (const [id, n] of nodes) if (id <= lastId && !alive.has(id)) { n.remove(); nodes.delete(id); }
  }
  append(data.messages);
  if (open) markRead();
}

function markRead() {
  storageSet('chatRead', String(lastId));
  $('#chatBadge').hidden = true;
}

// Unread badge on the Chat tab, checked in the background.
export async function checkUnread() {
  if (open || !state.user?.verified) return;
  try {
    const { id } = await api('/api/chat/latest');
    const read = Number(storageGet('chatRead') || 0);
    const badge = $('#chatBadge');
    badge.hidden = !(id > read);
    badge.textContent = id > read ? '•' : '';
  } catch { /* ignore */ }
}

let timer = null;
let ready = false;
export async function openChat() {
  open = true;
  if (!ready) {
    ready = true;
    const form = $('#chatForm');
    const box = form.body;
    box.addEventListener('input', () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 140) + 'px'; });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#chatError').textContent = '';
      const body = box.value.trim();
      if (!body) return;
      box.value = '';
      box.style.height = 'auto';
      try {
        append([await api('/api/chat', { body: { body } })]);
        markRead();
      } catch (err) {
        box.value = body;
        $('#chatError').textContent = err.message;
      }
    });
  }
  await poll().catch((err) => ($('#chatError').textContent = err.message));
  $('#chatList').scrollTop = $('#chatList').scrollHeight;
  markRead();
  clearInterval(timer);
  timer = setInterval(() => document.visibilityState === 'visible' && poll().catch(() => {}), 3000);
  $('#chatForm').body.focus();
}

export function closeChat() {
  open = false;
  clearInterval(timer);
}
