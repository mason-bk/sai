// 앱 화면만 캐시한다. 거래 데이터는 기기 localStorage와 구글 시트에만 있다.
const CACHE = 'sai-shell-v14';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 같은 출처 GET만: 네트워크 우선, 실패하면 캐시 (오프라인에서도 앱이 열림)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 화면 파일은 서버에 바뀌었는지 매번 확인한다(GitHub Pages 10분 캐시 우회)
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status); // 오류 응답은 캐시하지 않고 기존 캐시 사용
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
