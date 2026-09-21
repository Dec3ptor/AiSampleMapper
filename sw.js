/* sw.js — keeps the app usable with no coverage.
 *
 * A stockpile site is exactly where the signal is not. The shell is cached on
 * install and served cache-first, with a background refresh so a later visit
 * picks up a new deploy. Only same-origin GETs are touched: the Google Fonts
 * stylesheet is cross-origin and simply falls back to the local stack offline.
 */
var CACHE = 'asm-shell-v1';
var SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/geo.js',
  'js/geometry.js',
  'js/plan.js',
  'js/store.js',
  'js/render.js',
  'js/export.js',
  'js/field.js',
  'js/app.js',
  'sample/site-aerial.jpg',
  'manifest.webmanifest',
  'icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // One bad entry must not fail the whole install.
      .then(function (c) { return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      var live = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || live;
    })
  );
});
