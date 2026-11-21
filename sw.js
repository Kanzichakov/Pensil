// VIP Lounge Service Worker
// Статика: «сеть в приоритете» с коротким таймаутом и откатом в кэш (обновления приходят сразу, офлайн запускается мгновенно).
// Любые внешние запросы (Groq, OpenRouter, TTS-воркер) и не-GET запросы SW не трогает.
// При выкладке новой версии достаточно поменять номер в CACHE_VERSION (необязательно: статика и так обновляется при каждой загрузке с сетью).

const CACHE_VERSION = "v1";
const CACHE_PREFIX = "vip-lounge-static-";
const CACHE = CACHE_PREFIX + CACHE_VERSION;
const NET_TIMEOUT = 3500;   // сколько ждём сеть, прежде чем отдать копию из кэша (медленный/«зависший» интернет), мс

const CORE = ["./", "./index.html", "./style.css", "./game.js", "./manifest.json"];
const ICONS = ["./icon-180.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

const SCOPE_PATH = new URL("./", self.location).pathname;
const INDEX_URL = new URL("./index.html", self.location).href;
const ROOT_URL = new URL("./", self.location).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // cache: "reload" — мимо HTTP-кэша браузера, чтобы в SW попали свежие файлы
      await cache.addAll(CORE.map((u) => new Request(u, { cache: "reload" })));
      // иконки не критичны: их сбой не должен ломать установку
      await Promise.all(ICONS.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (req.headers.has("range")) return;   // медиа-запросы по диапазону не трогаем

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // внешние API/TTS идут мимо SW
  if (!url.pathname.startsWith(SCOPE_PATH)) return;

  const isNav = req.mode === "navigate";
  let key;
  if (isNav) {
    key = INDEX_URL;
  } else {
    const k = new URL(req.url);
    k.search = "";
    k.hash = "";
    key = k.href;
  }
  event.respondWith(networkFirst(event, req, key, isNav));
});

function networkFirst(event, req, key, isNav) {
  const net = fetch(req).then((res) => {
    // редиректы в кэш не кладём: Safari не отдаёт их как ответ на навигацию
    if (res && res.ok && res.type === "basic" && !res.redirected) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}));
    }
    return res;
  });
  event.waitUntil(net.catch(() => {}));   // не даём SW уснуть, пока обновление кэша не завершилось

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NET_TIMEOUT));

  return Promise.race([net.catch(() => null), timeout]).then(async (res) => {
    if (res && (res.ok || res.status < 500)) return res;
    const cached = await fromCache(req, key, isNav);
    if (cached) return cached;
    if (res) return res;
    // кэша нет — дожидаемся сети до конца (если она есть, но медленная)
    return net.catch(() => new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  });
}

async function fromCache(req, key, isNav) {
  const cache = await caches.open(CACHE);
  let hit = await cache.match(key, { ignoreSearch: true });
  if (!hit && isNav) hit = (await cache.match(ROOT_URL)) || null;
  return hit || null;
}
