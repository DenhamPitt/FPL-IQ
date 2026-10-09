const CACHE = 'fpl-iq-shell-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => { const req=e.request; if(req.method!=='GET'||req.url.includes('/api/')) return; const u = new URL(req.url); if(u.origin !== self.location.origin) return; e.respondWith(fetch(req).then(res => { if(res.ok && ASSETS.includes(u.pathname)) { const copy=res.clone(); caches.open(CACHE).then(c=>c.put(u.pathname,copy)); } return res; }).catch(() => caches.match(req).then(x=>x || caches.match('/')))); });
