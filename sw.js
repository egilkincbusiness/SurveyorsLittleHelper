// Network only on purpose: the app always uses live data and has no offline mode.
// This file exists so Chrome offers "Install app".
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
