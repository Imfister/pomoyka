'use strict';
// Кешируем только программные файлы, а не личные записи и вложения.
const CACHE = 'pomoyka-static-v6';
const ASSETS = ['./', './index.html', './style.css?v=6', './app.js?v=6', './manifest.webmanifest?v=5', './icon-180.png?v=5', './icon-192.png?v=5', './icon-512.png?v=5'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pomoyka-static-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL('./', self.location.href).pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(found => found || fetch(event.request)));
});
