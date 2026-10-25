// Service worker: shows push notifications, opens the app when one is tapped,
// and keeps a copy of the app's files so it still opens without a connection.
const CACHE = 'seaplane-watch-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/js/main.js', '/js/core.js', '/js/flights.js', '/js/chat.js',
  '/js/profile.js', '/js/admin.js', '/js/push.js', '/icons/icon-192.png', '/icons/badge-96.png', '/brand/TMA.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show straight away), falling back to the saved copy when offline.
// API calls and other sites are never cached.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Seaplane Watch', body: e.data?.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Seaplane Watch', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag,              // a newer update for the same flight replaces the older one
      renotify: !!data.tag,       // …but still buzzes the phone
      timestamp: data.timestamp || Date.now(),
      data: { url: data.url || '/#flights' },
    })
  );
});

// Tapping a notification opens the app (or brings it to the front) on the right tab.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '/#flights', location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === location.origin) {
          c.navigate?.(target);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
