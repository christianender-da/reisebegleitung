// Reisebegleitung – Service Worker: nur Web Push (keine Offline-Zwischenspeicherung)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    /* kein JSON */
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Reisebegleitung', {
      body: d.body || '',
      tag: d.tag,
      renotify: !!d.tag,
      icon: '/icon.svg',
      data: { url: d.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin));
      if (open) return open.focus().then((c) => (c && 'navigate' in c ? c.navigate(url) : c));
      return self.clients.openWindow(url);
    }),
  );
});
