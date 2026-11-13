// Browser stand-in for riff's Electron preload, built from the version that boots.
// Files live in IndexedDB and are served to <audio> by riff-sw.js.
(() => {
  const PORT = 38472;
  const storage = {};

  // riff's storage daemon clears localStorage and rebuilds it from this map, so the
  // map itself has to be persisted outside the keys it manages. Capture the native
  // accessors before app.js installs its overrides.
  const nativeGet = Storage.prototype.getItem;
  const nativeSet = Storage.prototype.setItem;
  const KV_KEY = "__riff_kv";
  const loadKV = () => {
    try {
      return JSON.parse(nativeGet.call(localStorage, KV_KEY) || "{}") || {};
    } catch {
      return {};
    }
  };
  const saveKV = (map) => {
    try {
      nativeSet.call(localStorage, KV_KEY, JSON.stringify(map));
    } catch {}
  };
  const DB_NAME = "riff-local";
  const STORE = "files";

  // ---- storage ------------------------------------------------------------
  let dbPromise = null;
  const db = () =>
    (dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  function run(mode, fn) {
    return db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const t = d.transaction(STORE, mode);
          const r = fn(t.objectStore(STORE));
          t.oncomplete = () => resolve(r && r.__req ? r.__req.result : r);
          t.onerror = () => reject(t.error);
        }),
    );
  }

  const req = (r) => ({ __req: r });
  const allFiles = () => run("readonly", (s) => req(s.getAll()));
  const getFile = (id) => run("readonly", (s) => req(s.get(id)));
  const putFile = (rec) => run("readwrite", (s) => { s.put(rec); });
  const delFile = (id) => run("readwrite", (s) => { s.delete(id); });
  const clearFiles = () => run("readwrite", (s) => { s.clear(); });

  const newId = () =>
    "local_" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

  const parseName = (name) => {
    const base = String(name || "").replace(/\.[^.]+$/, "").replace(/^\d+[.\s-]+/, "").trim() || "Untitled";
    const i = base.indexOf(" - ");
    return i > 0 ? { artist: base.slice(0, i).trim(), title: base.slice(i + 3).trim() } : { artist: "Unknown artist", title: base };
  };

  const readDuration = (file) =>
    new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      let done = false;
      const finish = (ms) => {
        if (done) return;
        done = true;
        URL.revokeObjectURL(url);
        resolve(Math.round(ms) || 0);
      };
      audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => finish(0);
      setTimeout(() => finish(0), 8000);
      audio.src = url;
    });

  const pickFiles = () =>
    new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = "audio/*,.mp3,.flac,.wav,.ogg,.m4a,.aac,.opus,.wma";
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      const finish = (files) => {
        input.remove();
        resolve(files);
      };
      input.addEventListener("change", () => finish([...input.files]));
      window.addEventListener(
        "focus",
        () => setTimeout(() => { if (!input.files || input.files.length === 0) finish([]); }, 800),
        { once: true },
      );
      input.click();
    });

  // same-origin so the service worker can serve the bytes
  const trackFrom = (rec) => ({
    id: rec.id,
    title: rec.title,
    artist: rec.artist,
    duration: rec.duration,
    thumbnail: "",
    platform: "local",
    path: "/Music/" + (rec.name || rec.id),
    filePath: "/Music/" + (rec.name || rec.id),
    // base-relative so this also works when the app is served from a subpath
    url: new URL(`api/local-track?id=${encodeURIComponent(rec.id)}`, document.baseURI).href,
  });

  async function pickLocalFiles() {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    const files = await pickFiles();
    const tracks = [];
    for (const file of files) {
      try {
        const { title, artist } = parseName(file.name);
        const duration = await readDuration(file);
        const rec = { id: newId(), title, artist, duration, name: file.name, type: file.type, size: file.size, addedAt: Date.now(), blob: file };
        await putFile(rec);
        tracks.push(trackFrom(rec));
      } catch (e) {
        console.warn("[riff] import failed", file && file.name, e);
      }
    }
    return tracks;
  }

  // riff keeps its file list here; write through so a reload still shows them
  const RIFF_KEYS = ["riff_local_files", "riff_local_tracks", "devsize_local_files", "devsize_local_tracks"];
  function rememberInRiff(tracks) {
    if (!tracks.length) return;
    for (const key of RIFF_KEYS) {
      try {
        const prev = JSON.parse(localStorage.getItem(key) || "[]");
        const map = new Map((Array.isArray(prev) ? prev : []).map((t) => [t && t.id, t]));
        let changed = false;
        for (const t of tracks) if (t && t.id && !map.has(t.id)) { map.set(t.id, t); changed = true; }
        if (changed) localStorage.setItem(key, JSON.stringify([...map.values()]));
      } catch {}
    }
    persistRiffMap();
  }

  // the daemon's live map is what survives a reload, so snapshot it right away
  function persistRiffMap() {
    try {
      saveKV(Object.assign({}, loadKV(), window.__RIFF_STORAGE_MAP__ || {}));
    } catch {}
  }

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  async function api(pathname, params, init) {
    if (pathname.includes("/api/tools-status") || pathname.includes("/api/tools/status")) {
      return json({ success: true, installed: true, ready: true, ytdlp: true, ytDlp: true, ffmpeg: true, tools: { ytdlp: true, ffmpeg: true } });
    }
    if (pathname.includes("/api/tools-install") || pathname.includes("/api/tools/install")) return json({ success: true, started: true });

    if (pathname.endsWith("/api/library")) {
      const rows = (await allFiles()) || [];
      rows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      return json(rows.map((r) => ({ id: r.id, platform: "local", title: r.title, artist: r.artist, duration: Number(r.duration) || 0, thumbnail: "" })));
    }
    if (pathname.endsWith("/api/library-add")) {
      const body = JSON.parse((init && init.body) || "{}");
      return json({ success: true, count: Array.isArray(body.items) ? body.items.length : 0 });
    }
    if (pathname.endsWith("/api/library-remove")) {
      const body = JSON.parse((init && init.body) || "{}");
      if (body.clearAll) {
        await clearFiles();
        for (const k of RIFF_KEYS) localStorage.removeItem(k);
      } else if (Array.isArray(body.ids)) {
        for (const id of body.ids) if (id) await delFile(id);
      }
      return json({ success: true });
    }
    if (pathname.endsWith("/api/search")) {
      const needle = String(params.get("q") || "").trim().toLowerCase();
      const limit = Math.max(1, parseInt(params.get("limit") || "12", 10));
      const rows = (await allFiles()) || [];
      rows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      const tracks = rows
        .filter((r) => !needle || `${r.title} ${r.artist}`.toLowerCase().includes(needle))
        .slice(0, limit)
        .map(trackFrom);
      return json({ success: true, tracks, hasMore: false });
    }
    if (pathname.endsWith("/api/stream-info")) {
      const rec = await getFile(String(params.get("id") || ""));
      if (!rec) return json({ success: false, error: "not a local track" }, 404);
      return json({ success: true, platform: "local", isLocal: true, url: trackFrom(rec).url });
    }
    if (pathname.endsWith("/api/check-cache")) {
      const rec = await getFile(String(params.get("id") || ""));
      return json(rec ? { cached: true, streamUrl: trackFrom(rec).url } : { cached: false, streamUrl: null });
    }
    if (pathname.endsWith("/api/state")) return json({ success: true });
    if (pathname.endsWith("/api/i18n-batch")) return json({ success: true, translations: {} });
    return json({ success: true, items: [], tracks: [], results: [], data: [] });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input && input.url;
    if (typeof url === "string" && url.includes("/api/")) {
      const parsed = new URL(url, location.origin);
      if (parsed.pathname.startsWith("/api/")) {
        return api(parsed.pathname, parsed.searchParams, init).catch(() => json({ success: false }, 500));
      }
    }
    return realFetch(input, init);
  };

  const noop = () => {};
  const nothing = async () => null;
  const ok = async () => ({ success: true });

  const base = {
    serverToken: "static",
    getServerPort: async () => PORT,
    storageInitSync: () => Object.assign(storage, loadKV()),
    storageSaveSync: (next) => {
      Object.assign(storage, next || {});
      saveKV(storage);
      return true;
    },
    storageSaveBatch: (next) => {
      Object.assign(storage, next || {});
      saveKV(storage);
    },
    pickLocalFiles: async () => {
      const tracks = await pickLocalFiles();
      rememberInRiff(tracks);
      return tracks;
    },
    pickLocalFolder: nothing,
    importAudioFiles: async () => {
      const tracks = await pickLocalFiles();
      rememberInRiff(tracks);
      return { success: tracks.length > 0, added: tracks.length, tracks, items: tracks };
    },
    rescanLocalMetadata: async (paths) => paths,
    pickMedia: nothing,
    readCacheFile: async () => null,
    writeCacheFile: noop,
    getAppVersion: async () => "0.7.0-web",
    getDataDir: async () => "browser",
    getDownloadDir: async () => "browser",
    getCacheSize: async () => 0,
    listThemes: async () => [],
    listPlugins: async () => [],
    getAppCss: async () => "",
    getDiagnostics: async () => ({}),
    getAudioOutputInfo: async () => ({}),
    getGpuCompositing: async () => false,
    getMultiInstance: async () => false,
    getGlobalShortcuts: async () => ({}),
    getZoomFactor: () => 1,
    isWindows: false,
    platform: "web",
  };

  window.electronAPI = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && /^on[A-Z]/.test(prop)) return noop;
      return ok;
    },
  });

  // riff's own "Add files" lives inside a panel it only reveals once it already has
  // files, so a fresh browser needs a visible way in.
  function mountAddButton() {
    if (document.getElementById("riff-web-add")) return;
    const btn = document.createElement("button");
    btn.id = "riff-web-add";
    btn.type = "button";
    btn.textContent = "+  Add music";
    btn.style.cssText = [
      "position:fixed", "left:16px", "bottom:16px", "z-index:2147483647",
      "padding:10px 16px", "border-radius:999px", "border:1px solid rgba(255,255,255,.18)",
      "background:#1f2026", "color:#f2f3f5", "font:500 13px/1 system-ui,sans-serif",
      "cursor:pointer", "box-shadow:0 6px 20px rgba(0,0,0,.45)",
    ].join(";");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Adding…";
      try {
        const tracks = await window.electronAPI.pickLocalFiles();
        if (tracks.length > 0) {
          location.reload();
          return;
        }
      } catch (e) {
        console.warn("[riff] add failed", e);
      }
      btn.disabled = false;
      btn.textContent = "+  Add music";
    });
    document.body.appendChild(btn);
  }

  // riff's own search calls a server-side catalog that cannot exist in a browser, so
  // point the box at the library instead: Enter filters the files and opens them.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const fmtTime = (s) => {
    const n = Math.max(0, Math.round(Number(s) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  };

  let remoteAudio = null;
  function stopRemote() {
    if (remoteAudio) { try { remoteAudio.pause(); } catch {} }
  }
  function playRemote(url) {
    if (!remoteAudio) {
      remoteAudio = new Audio();
      remoteAudio.preload = "auto";
    }
    stopRemote();
    remoteAudio.src = url;
    remoteAudio.play().catch(() => {});
    window.__riffRemoteAudio = remoteAudio;
    return remoteAudio;
  }

  // resolves true only when audio really started; a failure has to be visible, not silent
  function waitForPlayback(audio, ms) {
    if (!audio) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        audio.removeEventListener("timeupdate", onProgress);
        audio.removeEventListener("playing", onProgress);
        audio.removeEventListener("ended", onProgress);
        audio.removeEventListener("error", onError);
        resolve(value);
      };
      const onProgress = () => {
        if (audio.currentTime > 0 || (!audio.paused && audio.readyState >= 2)) finish(true);
      };
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(audio.currentTime > 0 && !audio.paused), ms || 8000);
      audio.addEventListener("timeupdate", onProgress);
      audio.addEventListener("playing", onProgress);
      audio.addEventListener("ended", onProgress);
      audio.addEventListener("error", onError);
      onProgress();
    });
  }

  // some archive items lead with a file the browser cannot decode; try the next one
  async function playFirstPlayable(urls) {
    for (const url of urls) {
      const ok = await new Promise((resolve) => {
        const probe = new Audio();
        probe.preload = "metadata";
        const finish = (value) => {
          clearTimeout(timer);
          probe.onloadedmetadata = null;
          probe.onerror = null;
          probe.src = "";
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), 6000);
        probe.onloadedmetadata = () => finish(true);
        probe.onerror = () => finish(false);
        probe.src = url;
      });
      if (ok) {
        playRemote(url);
        return true;
      }
    }
    return false;
  }

  async function playUrl(url, needsCors) {
    stopRemote();
    const audio = document.querySelector("audio");
    if (!audio) return false;
    try {
      if (needsCors) audio.crossOrigin = "anonymous";
      else audio.removeAttribute("crossorigin");
    } catch {}
    audio.src = url;
    audio.load();
    if (typeof window.playSmooth === "function") window.playSmooth();
    else audio.play().catch(() => {});
    return true;
  }

  function closeResults() {
    const panel = document.getElementById("riff-web-search");
    if (panel) panel.remove();
  }

  const withTimeout = async (fn, ms) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fn(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  // Internet Archive: full length audio, CORS open, no key needed
  async function archiveSearch(query) {
    const q = encodeURIComponent(
      `mediatype:(audio) AND collection:(audio_music) AND (title:("${query}") OR creator:("${query}") OR subject:("${query}"))`,
    );
    const url = `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=creator&rows=8&page=1&output=json`;
    let docs = [];
    try {
      docs = await withTimeout(async (signal) => {
        const res = await fetch(url, { signal });
        const data = await res.json();
        return (data.response && data.response.docs) || [];
      }, 9000);
    } catch {
      return [];
    }

    // only offer items that really contain a file the browser can decode
    const checked = await Promise.all(
      docs.slice(0, 8).map(async (d) => {
        if (!d || !d.identifier) return null;
        try {
          const meta = await (await fetch(`https://archive.org/metadata/${encodeURIComponent(d.identifier)}`)).json();
          // lending-library items keep their audio private, so nothing would ever play
          const md = meta.metadata || {};
          if (md["access-restricted-item"] === "true") return null;
          const files = (meta.files || []).filter((f) => f && f.private !== "true" && /.(mp3|wav)$/i.test(f.name || ""));
          if (!files.length) return null;
          const score = (f) => (/64kb/i.test(f.name) ? 0 : /.mp3$/i.test(f.name) ? 1 : 2);
          const urls = files
            .sort((a, b) => score(a) - score(b))
            .slice(0, 3)
            .map((f) => `https://archive.org/download/${encodeURIComponent(d.identifier)}/${String(f.name).split("/").map(encodeURIComponent).join("/")}`);
          return {
            identifier: d.identifier,
            title: Array.isArray(d.title) ? d.title[0] : d.title || d.identifier,
            artist: Array.isArray(d.creator) ? d.creator[0] : d.creator || "Internet Archive",
            urls,
          };
        } catch {
          return null;
        }
      }),
    );
    return checked.filter(Boolean);
  }

  const archiveUrlCache = new Map();
  async function archiveAudioUrl(identifier) {
    if (archiveUrlCache.has(identifier)) return archiveUrlCache.get(identifier);
    const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    const meta = await res.json();
    const files = (meta.files || []).filter((f) => f && /\.(mp3|ogg|m4a)$/i.test(f.name || ""));
    if (!files.length) return null;
    const pick = files.find((f) => /64kb/i.test(f.name)) || files.find((f) => /\.mp3$/i.test(f.name)) || files[0];
    const path = String(pick.name).split("/").map(encodeURIComponent).join("/");
    const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${path}`;
    archiveUrlCache.set(identifier, url);
    return url;
  }

  // Apple catalogue: cheap instant search, but only 30 second previews
  async function itunesSearch(query) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=25&country=US`;
    try {
      return await withTimeout(async (signal) => {
        const res = await fetch(url, { signal });
        const data = await res.json();
        return (data.results || [])
          .filter((r) => r && r.kind === "song" && r.previewUrl)
          .map((r) => ({
            title: r.trackName,
            artist: r.artistName,
            art: r.artworkUrl60,
            preview: r.previewUrl,
          }));
      }, 9000);
    } catch {
      return [];
    }
  }

  function makeRow(item) {
    const row = document.createElement("button");
    row.type = "button";
    row.style.cssText = [
      "display:flex", "align-items:center", "gap:10px", "width:100%", "text-align:left",
      "padding:8px 10px", "border:0", "border-radius:9px", "background:transparent",
      "color:inherit", "cursor:pointer", "font:inherit",
    ].join(";");
    row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,.07)"; });
    row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });

    const art = document.createElement("div");
    art.style.cssText = "width:34px;height:34px;flex:0 0 34px;border-radius:6px;overflow:hidden;background:#26282f";
    if (item.art) {
      const img = document.createElement("img");
      img.src = item.art;
      img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:cover";
      art.appendChild(img);
    }
    row.appendChild(art);

    const text = document.createElement("span");
    text.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const title = document.createElement("span");
    title.textContent = item.title;
    const sub = document.createElement("span");
    sub.textContent = ` · ${item.artist}`;
    sub.style.color = "#9aa0aa";
    text.append(title, sub);
    row.appendChild(text);

    const time = document.createElement("span");
    time.textContent = item.time || "";
    time.style.cssText = "color:#9aa0aa;font-variant-numeric:tabular-nums;font-size:12px";
    row.appendChild(time);

    row.addEventListener("click", async () => {
      if (item.closeOnPlay !== false) closeResults();
      try {
        await item.onPlay();
        if (item.closeOnPlay === false) {
          title.style.color = "#7ee2a8";
          row.style.background = "rgba(126,226,168,.12)";
        }
      } catch (e) {
        showNote(`Could not play “${item.title}” — ${e && e.message ? e.message : "unknown error"}.`);
      }
    });
    return row;
  }

  function showResults(query, groups, status) {
    closeResults();
    const panel = document.createElement("div");
    panel.id = "riff-web-search";
    panel.style.cssText = [
      "position:fixed", "left:50%", "transform:translateX(-50%)", "top:72px",
      "width:min(580px,92vw)", "max-height:64vh", "overflow:auto", "z-index:2147483646",
      "background:#17181d", "border:1px solid rgba(255,255,255,.12)", "border-radius:14px",
      "box-shadow:0 18px 50px rgba(0,0,0,.6)", "padding:8px",
      "font:13px/1.4 system-ui,sans-serif", "color:#eceef2",
    ].join(";");

    const head = document.createElement("div");
    head.style.cssText = "padding:8px 10px 6px;color:#9aa0aa;font-size:12px";
    head.textContent = status || `Results for “${query}”`;
    panel.appendChild(head);

    let total = 0;
    for (const group of groups) {
      if (!group.items.length) continue;
      const label = document.createElement("div");
      label.textContent = group.label;
      label.style.cssText = "padding:8px 10px 4px;color:#767c88;font-size:11px;letter-spacing:.04em;text-transform:uppercase";
      panel.appendChild(label);
      group.items.forEach((item) => panel.appendChild(makeRow(item)));
      total += group.items.length;
    }

    if (!total && !status) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:4px 10px 14px;color:#c8ccd4;font-size:12px";
      empty.textContent = "Nothing found anywhere. Try a different spelling, or use “+ Add music” for your own files.";
      panel.appendChild(empty);
    }

    document.body.appendChild(panel);
  }

  async function searchLibrary(query) {
    const rows = (await allFiles()) || [];
    rows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const needle = query.toLowerCase();
    const localRecs = rows.filter((r) => `${r.title} ${r.artist}`.toLowerCase().includes(needle));

    const localItems = localRecs.map((rec) => {
      const track = trackFrom(rec);
      return {
        title: rec.title,
        artist: rec.artist,
        time: fmtTime(rec.duration),
        art: "",
        onPlay: async () => {
          stopRemote();
          const el = document.querySelector("audio");
          if (!el) throw new Error("no player element");
          el.src = track.url;
          el.removeAttribute("crossorigin");
          el.load();
          if (typeof window.playSmooth === "function") window.playSmooth();
          const ok = await waitForPlayback(el, 8000);
          if (!ok) throw new Error("your file did not start");
        },
      };
    });

    showResults(query, [{ label: `Your files (${rows.length})`, items: localItems }], "Searching…");

    const [archive, apple] = await Promise.all([archiveSearch(query), itunesSearch(query)]);

    const archiveItems = archive.map((a) => ({
      title: a.title,
      artist: a.artist,
      time: "full",
      art: "",
      onPlay: async () => {
        const ok = await playFirstPlayable(a.urls || []);
        if (!ok) throw new Error("no playable file");
      },
      closeOnPlay: false,
    }));

    const appleItems = apple.map((a) => ({
      title: a.title,
      artist: a.artist,
      time: "0:30",
      art: a.art,
      onPlay: async () => {
        const audio = playRemote(a.preview);
        const ok = await waitForPlayback(audio, 12000);
        if (!ok) throw new Error("preview did not start");
      },
      closeOnPlay: false,
    }));

    showResults(
      query,
      [
        { label: `Your files (${rows.length})`, items: localItems },
        { label: "Full tracks · Internet Archive", items: archiveItems },
        { label: "Apple Music previews · 30s", items: appleItems },
      ],
      null,
    );
    return localItems.length + archiveItems.length + appleItems.length;
  }

  let noteTimer = null;
  function showNote(text) {
    let note = document.getElementById("riff-web-note");
    if (!note) {
      note = document.createElement("div");
      note.id = "riff-web-note";
      note.style.cssText = [
        "position:fixed", "left:16px", "bottom:64px", "z-index:2147483647",
        "max-width:min(420px,80vw)", "padding:10px 14px", "border-radius:10px",
        "background:#2a1120", "color:#ffd9e2", "border:1px solid rgba(255,120,150,.35)",
        "font:500 12px/1.45 system-ui,sans-serif", "box-shadow:0 8px 24px rgba(0,0,0,.5)",
      ].join(";");
      document.body.appendChild(note);
    }
    note.textContent = text;
    note.style.display = "block";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { note.style.display = "none"; }, 5000);
  }

  function wireSearchBox() {
    const input = document.getElementById("search-input");
    if (!input) return false;
    if (input.dataset.riffWebWired) return true;
    input.dataset.riffWebWired = "1";
    input.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter") return;
        const query = (input.value || "").trim();
        if (!query) return;
        // capture phase: riff's handler would fire a request that cannot work here
        e.preventDefault();
        e.stopImmediatePropagation();
        searchLibrary(query);
      },
      true,
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeResults();
    });
    document.addEventListener("pointerdown", (e) => {
      const panel = document.getElementById("riff-web-search");
      if (panel && !panel.contains(e.target) && e.target !== input) closeResults();
    });
    return true;
  }

  function mountHooks() {
    mountAddButton();
    // the search field can arrive after DOMContentLoaded on the hosted build
    if (wireSearchBox()) return;
    const timer = setInterval(() => {
      if (wireSearchBox()) clearInterval(timer);
    }, 400);
    setTimeout(() => clearInterval(timer), 20000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountHooks, { once: true });
  } else {
    mountHooks();
  }

  window.addEventListener("beforeunload", persistRiffMap);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("[riff] sw failed", e));
    });
  }
})();
