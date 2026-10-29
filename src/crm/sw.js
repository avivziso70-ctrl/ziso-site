// Service worker for zisoceramics.com/crm: makes the page installable on the phone's home screen and
// receives push alerts (stage 5). Nothing is cached: customer data always comes live from Supabase.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'זיסו צוות', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'זיסו צוות', {
    body: d.body || '', icon: '../img/logo.jpg', badge: '../img/logo.jpg', dir: 'rtl', lang: 'he',
    tag: d.tag || 'ziso', renotify: !!d.renotify, data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if (list[i].url.indexOf('/crm') >= 0 && 'focus' in list[i]) { list[i].navigate(url); return list[i].focus(); } }
    return self.clients.openWindow(url);
  }));
});
