const CACHE_NAME = "ar-camera-offline-20261112-v9";

const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./sketch.js",
  "./mediapipe-tracker.js",
  "./manifest.webmanifest",
  "./app_icon.png.optimized.png",
  "./switch_icon.png",
  "./mimi.png",
  "./hat.png",
  "./museum-frame-9x16.png",
  "./museum-frame-3x4.png",
  "./museum-frame-4x3.png",
  "./museum-pottery-9x16.png",
  "./museum-pottery-3x4.png",
  "./museum-pottery-4x3.png",
  "./vendor/p5.min.js",
  "./vendor/ml5.min.js",
  "./vendor/mediapipe/vision_bundle.mjs",
  "./vendor/mediapipe/face_landmarker.task",
  "./vendor/mediapipe/wasm/vision_wasm_internal.js",
  "./vendor/mediapipe/wasm/vision_wasm_internal.wasm",
  "./vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js",
  "./vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 大きなWASMを同時取得せず、低メモリ端末でも順番に保存する。
    for (const path of APP_FILES) {
      try {
        await cache.add(new Request(path, { cache: "reload" }));
      } catch (error) {
        console.warn("オフライン保存をスキップしました", path, error);
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put("./index.html", response.clone());
        return response;
      } catch {
        return (await caches.match("./index.html")) || (await caches.match("./"));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});
