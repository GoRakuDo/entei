// Keep this lifecycle wrapper separate from WebTorrent's distributed worker.
// `waitUntil` guarantees the current Player tab receives controllerchange
// before BrowserServer starts issuing /webtorrent/ requests.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

importScripts('/sw.min.js');
