// Isla Nueva (new): the offline copy (16 Nov 2026). Tomáš: "I want to download it now and play offline", on an iPhone,
// where a page opened from a file cannot run. The page (ui/offline.js) registers this worker and sends it the list of
// its sound files, each with the hash the page asks for. The worker keeps the page and those files in the device's
// cache: with no network the page and its sounds come from there.
// - The page: fetched fresh whenever the network answers within PAGE_WAIT (so a new version arrives), else the kept copy.
// - A sound: the kept copy when there is one, else the network as it is. A kept file answers a Range request with the
//   bytes asked for (206): iOS plays an <audio> only that way.
// - Nothing outside this folder is touched (the old game beside it has its own worker and cache).
// build.sh copies this file to dist/sw.js; it is served beside index.html.
'use strict';
const CACHE = 'isla-nova-1';
const PAGE_WAIT = 4000;
const POOL = 4;

function pageKey() { return new URL('./', self.registration.scope).href; }

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => fetch(pageKey(), { cache: 'reload' }).then((r) => (r && r.ok && r.status === 200 ? c.put(pageKey(), r) : null)).catch(() => null))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// The page's list: keep exactly these files and the page; a sound file of an older version goes.
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type !== 'keep' || !Array.isArray(d.files)) return;
  e.waitUntil(keepFiles(d.files, e.source));
});

async function keepFiles(files, client) {
  const c = await caches.open(CACHE), scope = self.registration.scope, page = pageKey();
  const want = [];
  for (const f of files) { const u = new URL(String(f), scope).href; if (u.indexOf(scope + 'audio/') === 0 && !want.includes(u)) want.push(u); }
  const have = new Set((await c.keys()).map((r) => r.url));
  for (const u of have) if (u !== page && !want.includes(u)) await c.delete(u);
  let n = want.filter((u) => have.has(u)).length, failed = 0, pageOk = have.has(page);
  const tell = (done) => { try { if (client) client.postMessage({ type: 'kept', n, of: want.length, page: pageOk, failed, done }); } catch (err) { /* the page went away */ } };
  if (!pageOk) {
    try { const r = await fetch(page, { cache: 'reload' }); if (r && r.ok && r.status === 200) { await c.put(page, r); pageOk = true; } } catch (err) { /* no network now */ }
  }
  tell(false);
  const todo = want.filter((u) => !have.has(u));
  const work = async () => {
    while (todo.length) {
      const u = todo.shift();
      try {
        const r = await fetch(u);
        if (r && r.ok && r.status === 200) { await c.put(u, r); n++; } else failed++;
      } catch (err) { failed++; }
      tell(false);
    }
  };
  await Promise.all(Array.from({ length: POOL }, work));
  tell(true);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const scope = self.registration.scope;
  if (req.url.indexOf(scope) !== 0) return;
  const path = req.url.slice(scope.length).split(/[?#]/)[0];
  if (path === '' || path === 'index.html') { e.respondWith(pageServe(req)); return; }
  if (path.indexOf('audio/') === 0) e.respondWith(soundServe(req));
});

async function pageServe(req) {
  const c = await caches.open(CACHE), key = pageKey();
  const kept = await c.match(key, { ignoreVary: true });
  const net = fetch(req).then((r) => {
    if (r && r.ok && r.status === 200 && !r.redirected) c.put(key, r.clone()).catch(() => {});
    return r;
  });
  if (!kept) return net;
  const late = new Promise((done) => setTimeout(() => done(null), PAGE_WAIT));
  try {
    const r = await Promise.race([net, late]);
    if (r && r.ok) return r;
  } catch (err) { /* no network: the kept copy */ }
  net.catch(() => {});
  return kept;
}

async function soundServe(req) {
  const c = await caches.open(CACHE);
  const kept = await c.match(req.url, { ignoreVary: true });
  if (!kept) return fetch(req);
  const range = req.headers.get('range');
  return range ? rangeOf(range, kept) : kept;
}

// The bytes a Range header asks for, from a kept whole file.
async function rangeOf(range, kept) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m || (m[1] === '' && m[2] === '')) return kept;
  const buf = await kept.arrayBuffer(), size = buf.byteLength;
  let from, to;
  if (m[1] === '') { from = Math.max(0, size - Number(m[2])); to = size - 1; }
  else { from = Number(m[1]); to = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (from >= size || from > to) return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(buf.slice(from, to + 1), {
    status: 206, statusText: 'Partial Content',
    headers: {
      'Content-Type': kept.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': 'bytes ' + from + '-' + to + '/' + size,
      'Content-Length': String(to - from + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}
