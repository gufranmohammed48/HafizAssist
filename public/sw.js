// Increment with every delivered change; keep index.html's badge in sync.
const VERSION = 'V50';
const PREFIX = `hafizassist-shell:${self.registration.scope}:`;
// Numbering restarted at the user's request. Keep this cache series distinct
// from the original V1 so an old open tab cannot receive a mixed app shell.
const SHELL = PREFIX + 'series2:' + VERSION;
const url = path => new URL(path, self.registration.scope).href;
const FILES = [
  'index.html', 'mobile.html', 'test.html', 'test2.html', 'src/book.js', 'src/book.css', 'src/entry.js', 'src/mobile-page-swipe.js', 'favicon.svg', 'src/app.js', 'src/alignment.js', 'src/recognition-boundary.js', 'src/teacher-mode.js', 'src/teacher-retry.js', 'src/teacher-voices.js', 'src/teacher-qua.js', 'data/teacher-qua/catalog.json', 'src/teacher-activity.js', 'src/teacher-voicing.js', 'src/madd.js', 'src/tajweed-timing.js', 'src/tajweed-log.js', 'src/vowel-feedback.js', 'src/debug.js', 'src/word-info.js',
  'src/ui-language.js', 'src/ui-language-core-ar.js', 'src/ui-language-teacher-ar.js', 'src/ui-language-word-ar.js', 'src/accounts.js', 'src/accounts.css', 'privacy.html',
  'src/offline.js', 'src/style.css', 'src/voice-search-worker.js', 'data/quran.json', 'data/HafsSmart.ttf', 'data/AmiriQuran-Regular.ttf',
  'data/mushaf-layout.json', 'data/tajweed-words.json', 'data/tajweed-colors.json', 'src/tajweed-colors.js', 'assets/bismillah.png',
  'recognizer-worker.js', 'audio-worklet.js', 'models/tokens.txt', 'model-config.json',
  'vendor/sherpa-onnx-asr.js', 'vendor/sherpa-onnx-wasm-main-asr.js',
  'vendor/sherpa-onnx-wasm-main-asr.wasm',
].map(url);
const fileSet = new Set(FILES);

function navigationResponse(response) {
  // Static hosts can redirect /index.html to /. A followed-redirect response
  // cannot be reused for a navigation whose redirect mode is manual.
  // Reconstruct the same HTML response without its internal redirect history.
  if (!response.redirected) return response;
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

self.addEventListener('install', event => {
  // A failed/incomplete download must not replace a usable offline version.
  // Do not skipWaiting: avoid swapping code during a live recitation session.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' })));
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== SHELL).map(name => caches.delete(name)));
    } catch (error) { console.warn('Old offline caches could not be removed.', error); }
    // Model cache and practice history are intentionally retained.
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const requested = new URL(request.url);
  // Identity and progress always go to the account Worker. Never put these
  // responses or OAuth redirects in a shared/offline application cache.
  if (requested.origin === self.location.origin &&
      (requested.pathname === '/api/account' || requested.pathname.startsWith('/api/account/'))) return;
  if (!requested.href.startsWith(self.registration.scope)) return;
  const path = requested.origin + requested.pathname;
  const isHome = request.mode === 'navigate' && [url(''), url('index.html'), url('recite/'), url('recite')].includes(path);
  const isMobile = request.mode === 'navigate' && [url('mobile.html'), url('mobile')].includes(path);
  const isBook = request.mode === 'navigate' && [url('test.html'), url('test')].includes(path);
  const isQua = request.mode === 'navigate' && [url('test2.html'), url('test2')].includes(path);
  if (isHome && [url('recite/'), url('recite')].includes(path)) {
    // Keep relative app URLs rooted correctly, including during offline visits.
    event.respondWith(Response.redirect(url(''), 302));
    return;
  }
  const key = isHome ? url('index.html') : isMobile ? url('mobile.html') : isBook ? url('test.html') : isQua ? url('test2.html') : path;
  if (!fileSet.has(key)) return; // The recognizer owns its separate model cache.
  event.respondWith((async () => {
    let cache;
    try {
      cache = await caches.open(SHELL);
      const saved = await cache.match(key);
      if (saved?.ok) return isHome || isMobile || isBook || isQua ? navigationResponse(saved) : saved;
    } catch (error) { console.warn('Offline cache unavailable; loading from network.', error); }
    const response = await fetch(new Request(isHome ? url('') : key, { cache: 'reload' }));
    if (response.ok && cache) {
      try { await cache.put(key, response.clone()); }
      catch (error) { console.warn('Could not save this response offline.', error); }
    }
    return isHome || isMobile || isBook || isQua ? navigationResponse(response) : response;
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'offline-status') return;
  event.waitUntil((async () => {
    try {
      const shell = await caches.open(SHELL);
      const entries = await Promise.all(FILES.map(file => shell.match(file)));
      const models = await caches.open('hafizassist-model-v1');
      const model = await models.match(url('models/zipformer_p_arabic_v3.int8.onnx'));
      event.ports[0]?.postMessage({ shell: entries.every(Boolean), model: Boolean(model?.ok && Number(model.headers.get('Content-Length')) === 72705392) });
    } catch { event.ports[0]?.postMessage({ shell: false, model: false }); }
  })());
});
