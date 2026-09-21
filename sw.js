/* sw.js — keeps the app usable with no coverage, without pinning it to an
 * old build.
 *
 * Code and markup are fetched network-first: online you always run the current
 * deploy, and the cache is only reached for when there is no signal. Photos and
 * icons are cache-first, because they do not change and they are the expensive
 * ones to refetch. An earlier version of this file was cache-first for
 * everything under a fixed cache name, which served stale JavaScript after
 * every deploy and never purged it.
 */
var CACHE = 'asm-shell-v4';
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
  'js/pdf.js',
  'js/print.js',
  'js/app.js',
  'sample/site-aerial.jpg',
  'manifest.webmanifest',
  'icon.svg'
];

var MEDIA = /\.(?:jpe?g|png|webp|gif|svg|ttf|woff2?)$/i;

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

function store(req, res) {
  if (res && res.ok) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (MEDIA.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) { return store(req, res); });
      })
    );
    return;
  }

  // Everything else is code or markup: the network wins whenever it answers.
  e.respondWith(
    fetch(req)
      .then(function (res) { return store(req, res); })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          return req.mode === 'navigate' ? caches.match('index.html') : Promise.reject(new Error('offline'));
        });
      })
  );
});
