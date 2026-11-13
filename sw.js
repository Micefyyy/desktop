// Serves stored audio to <audio>, which bypasses any fetch shim.
const DB_NAME = "riff-local";
const STORE = "files";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getRecord(id) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

const MIME = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg; codecs=opus",
  flac: "audio/flac",
  webm: "audio/webm",
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      // drop page caches left by a previous app on this origin (e.g. Liner's sw.js)
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.endsWith("/api/local-track") && !url.pathname.endsWith("/api/library-file")) return;

  event.respondWith(
    (async () => {
      const id = url.searchParams.get("id");
      const rec = id ? await getRecord(id.replace(/^local:/, "")) : null;
      if (!rec || !rec.blob) return new Response("not found", { status: 404 });

      const blob = rec.blob;
      const ext = String(rec.name || "").split(".").pop().toLowerCase();
      const type = rec.type || MIME[ext] || "audio/mpeg";
      const range = event.request.headers.get("range");

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : blob.size - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= blob.size) end = blob.size - 1;
        if (start > end) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
        }
        return new Response(blob.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Type": type,
            "Content-Range": `bytes ${start}-${end}/${blob.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
          },
        });
      }

      return new Response(blob, {
        status: 200,
        headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(blob.size) },
      });
    })(),
  );
});
