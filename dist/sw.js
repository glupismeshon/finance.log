"use strict";
const CACHE = "finance-log-v21";
const ASSETS = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "i18n.js",
  "themes.js",
  "boot.js",
  "datepicker.js",
  "core/money.js",
  "core/schema.js",
  "core/accounts.js",
  "core/categories.js",
  "core/journal.js",
  "core/suggest.js",
  "core/views.js",
  "core/analytics.js",
  "icon.svg",
  "manifest.webmanifest",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network-first: fresh content when online, cached copy when offline.
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(cached => {
          if (cached) return cached;
          if (request.mode === "navigate") return caches.match("index.html");
          return Response.error();
        })
      )
  );
});
