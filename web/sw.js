/* Service Worker：PWA 外壳离线缓存
 * - 静态资源缓存优先 + 后台更新（stale-while-revalidate）：本次秒开，下次刷新用新版
 * - /api/* 与 WebSocket 不缓存（数据实时性优先）
 * - 离线时数据层由 app.js 展示最后缓存列表（localStorage）
 * 改动静态资源后无需手动升级， bump 此版本号可强制全量刷新：
 */
const CACHE = 'otc-shell-v22';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api') || url.pathname === '/ws' || url.pathname === '/health') return;
  // 配置/工具页不走缓存：接口修复、令牌变更要立即生效（缓存旧版会引发难以排查的 401）
  if (url.pathname === '/remote.html' || url.pathname === '/setup.html') return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: url.pathname === '/' }).then((hit) => {
      // 后台更新：有缓存也拉取新版写入，下次刷新即生效
      const net = fetch(e.request)
        .then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit || caches.match('/index.html'));
      return hit || net;
    })
  );
});
