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

  // OpenTune / BitChord HTTP add-ons: <base>/manifest.json, /search?q=…, /stream/{id}
  const ADDON_KEY = "riff-addon-root";
  const DEFAULT_ADDON = "https://opentune-lossless-addon.create-a-new-site-with-sites.workers.dev/monochrome";

  function addonBase() {
    let raw = DEFAULT_ADDON;
    try { raw = localStorage.getItem(ADDON_KEY) || DEFAULT_ADDON; } catch {}
    return raw.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
  }

  async function addonJson(url) {
    const res = await withTimeout(async (signal) => fetch(url, { signal, headers: { Accept: "application/json" } }), 9000);
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) throw new Error((body && body.error) || `add-on returned ${res.status}`);
    if (!body) throw new Error("add-on did not send JSON");
    return body;
  }

  async function addonSearch(query) {
    const body = await addonJson(`${addonBase()}/search?q=${encodeURIComponent(query)}`);
    return Array.isArray(body.tracks) ? body.tracks : [];
  }

  async function addonStream(trackId) {
    const body = await addonJson(`${addonBase()}/stream/${encodeURIComponent(trackId)}`);
    if (!body.url) throw new Error("add-on sent no audio url");
    return body.url;
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
    // more than one panel can be left behind by overlapping searches
    document.querySelectorAll("#riff-web-search").forEach((p) => p.remove());
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

  // Audius: free public catalog, no key, full-length streams that a media element can play
  const AUDIUS = "https://api.audius.co/v1";
  const AUDIUS_APP = "riff";

  async function audiusSearch(query) {
    const url = `${AUDIUS}/tracks/search?query=${encodeURIComponent(query)}&limit=10&app_name=${AUDIUS_APP}`;
    const data = await withTimeout(async (signal) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`Audius returned ${res.status}`);
      return res.json();
    }, 9000);
    return ((data && data.data) || []).filter((t) => t && t.id && t.is_streamable !== false);
  }

  const audiusStreamUrl = (id) => `${AUDIUS}/tracks/${encodeURIComponent(id)}/stream?app_name=${AUDIUS_APP}`;

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
      if (isNarrowScreen() && row.__group) {
        closeResults();
        mSetQueue(row.__group, item);
        mPlayIndex(M.index);
        return;
      }
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
    hideMobileEmpty();
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
      if (!group.items.length && !group.note) continue;
      const label = document.createElement("div");
      label.textContent = group.label;
      label.style.cssText = "padding:8px 10px 4px;color:#767c88;font-size:11px;letter-spacing:.04em;text-transform:uppercase";
      panel.appendChild(label);
      group.items.forEach((item) => {
        const row = makeRow(item);
        row.__group = group;
        row.__item = item;
        panel.appendChild(row);
      });
      if (group.note) {
        const note = document.createElement("div");
        note.textContent = group.note;
        note.style.cssText = "padding:2px 10px 8px;color:#c89aa8;font-size:12px" + (group.onNoteClick ? ";cursor:pointer;text-decoration:underline" : "");
        if (group.onNoteClick) note.addEventListener("click", group.onNoteClick);
        panel.appendChild(note);
      }
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
        kind: "local",
        track: { type: "local", fileId: rec.id, title: rec.title, artist: rec.artist, duration: rec.duration },
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

    const addonHost = (() => { try { return new URL(addonBase()).host; } catch { return addonBase(); } })();
    let addonNote = null;

    let audiusNote = null;
    // only talk to an add-on when the user has actually configured one
    const addonConfigured = (() => { try { return Boolean(localStorage.getItem(ADDON_KEY)); } catch { return false; } })();
    const [archive, apple, addon, audius] = await Promise.all([
      archiveSearch(query),
      itunesSearch(query),
      (addonConfigured
        ? addonSearch(query)
        : Promise.resolve([])
      ).catch((e) => {
        addonNote = `OpenTune add-on (${addonHost}): ${e && e.message ? e.message : "unavailable"}`;
        return [];
      }),
      audiusSearch(query).catch((e) => {
        audiusNote = `Audius: ${e && e.message ? e.message : "unavailable"}`;
        return [];
      }),
    ]);

    const archiveItems = archive.map((a) => ({
      title: a.title,
      artist: a.artist,
      time: "full",
      art: "",
      track: { type: "archive", urls: a.urls, title: a.title, artist: a.artist },
      onPlay: async () => {
        const ok = await playFirstPlayable(a.urls || []);
        if (!ok) throw new Error("no playable file");
      },
      closeOnPlay: false,
    }));

    const audiusItems = (audius || []).slice(0, 8).map((t) => ({
      title: t.title || "Untitled",
      artist: (t.user && t.user.name) || "Audius",
      time: t.duration ? fmtTime(t.duration) : "full",
      art: t.artwork && t.artwork["150x150"] ? t.artwork["150x150"] : "",
      track: {
        type: "audius",
        id: t.id,
        title: t.title || "Untitled",
        artist: (t.user && t.user.name) || "Audius",
        art: t.artwork && t.artwork["150x150"] ? t.artwork["150x150"] : "",
        duration: t.duration,
      },
      onPlay: async () => {
        const ok = await playFirstPlayable([audiusStreamUrl(t.id)]);
        if (!ok) throw new Error("Audius stream did not start");
      },
      closeOnPlay: false,
    }));

    const appleItems = apple.map((a) => ({
      title: a.title,
      artist: a.artist,
      time: "0:30",
      art: a.art,
      track: { type: "apple", preview: a.preview, title: a.title, artist: a.artist, art: a.art, time: "0:30" },
      onPlay: async () => {
        const audio = playRemote(a.preview);
        const ok = await waitForPlayback(audio, 12000);
        if (!ok) throw new Error("preview did not start");
      },
      closeOnPlay: false,
    }));

    const addonItems = (addon || []).slice(0, 8).map((t) => ({
      title: t.title || "Untitled",
      artist: t.artist || "add-on",
      time: t.duration ? fmtTime(t.duration) : "full",
      art: t.artwork || "",
      onPlay: async () => {
        const url = await addonStream(t.id);
        const ok = await playFirstPlayable([url]);
        if (!ok) throw new Error("add-on audio did not start");
      },
      closeOnPlay: false,
    }));

    showResults(
      query,
      [
        { label: `Your files (${rows.length})`, items: localItems },
        { label: "Full tracks · Internet Archive", items: archiveItems },
        { label: "Full tracks · Audius", items: audiusItems, note: audiusNote },
        ...(addonConfigured ? [{
          label: `OpenTune add-on · ${addonHost}`,
          items: addonItems,
          note: addonNote,
          onNoteClick: () => {
            const next = prompt("OpenTune add-on address (manifest.json or base URL):", addonBase());
            if (!next) return;
            try { localStorage.setItem(ADDON_KEY, next.trim()); } catch {}
            showNote("Add-on saved. Search again to use it.");
          },
        }] : []),
        { label: "Apple Music previews · 30s", items: appleItems },
      ],
      null,
    );
    return localItems.length + archiveItems.length + audiusItems.length + addonItems.length + appleItems.length;
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

  const isNarrowScreen = () => window.matchMedia("(max-width: 700px)").matches;

  const M = { queue: [], index: -1, el: null, item: null, shuffle: false, repeat: "off" };

  const mFmt = (sec) => {
    const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };

  function mEl() {
    if (M.el) return M.el;
    const remote = window.__riffRemoteAudio;
    if (remote && remote.src) return remote;
    return document.querySelector("audio");
  }

  const mSig = (t) => (t ? [t.type, t.id || t.preview || t.fileId || (t.urls && t.urls[0]) || "", t.title].join("|") : "");

  // ---- library storage: playlists, liked songs, recently played ----
  const LIB = { playlists: "riff-playlists", liked: "riff-liked", recent: "riff-recent" };
  const readList = (k) => {
    try {
      const v = JSON.parse(localStorage.getItem(k) || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const writeList = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  };
  const getPlaylists = () => readList(LIB.playlists);
  const getLiked = () => readList(LIB.liked);
  const getRecent = () => readList(LIB.recent);
  const isLiked = (t) => !!t && getLiked().some((x) => mSig(x) === mSig(t));

  function toggleLike(t) {
    if (!t) return;
    const list = getLiked();
    const i = list.findIndex((x) => mSig(x) === mSig(t));
    if (i >= 0) list.splice(i, 1);
    else list.unshift(t);
    writeList(LIB.liked, list);
    renderHome();
    mRenderPlayer();
  }

  function pushRecent(t) {
    if (!t) return;
    const list = getRecent().filter((x) => mSig(x) !== mSig(t));
    list.unshift(t);
    writeList(LIB.recent, list.slice(0, 50));
    renderHome();
  }

  // ---- track descriptors -> playable items ----
  function itemFromTrack(t) {
    if (!t || !t.type) return null;
    const base = {
      title: t.title || "Untitled",
      artist: t.artist || "",
      art: t.art || "",
      time: t.time || (t.duration ? fmtTime(t.duration) : "full"),
      kind: "remote",
      closeOnPlay: false,
      track: t,
    };
    if (t.type === "archive") {
      return { ...base, onPlay: async () => { if (!(await playFirstPlayable(t.urls || []))) throw new Error("no playable file"); } };
    }
    if (t.type === "audius") {
      return { ...base, onPlay: async () => { if (!(await playFirstPlayable([audiusStreamUrl(t.id)]))) throw new Error("Audius stream did not start"); } };
    }
    if (t.type === "apple") {
      return { ...base, onPlay: async () => { const a = playRemote(t.preview); if (!(await waitForPlayback(a, 12000))) throw new Error("preview did not start"); } };
    }
    if (t.type === "local") {
      return {
        ...base,
        kind: "local",
        onPlay: async () => {
          const rows = (await allFiles()) || [];
          const rec = rows.find((r) => r.id === t.fileId);
          if (!rec) throw new Error("that file is no longer on this device");
          stopRemote();
          const el = document.querySelector("audio");
          if (!el) throw new Error("no player element");
          el.src = trackFrom(rec).url;
          el.removeAttribute("crossorigin");
          el.load();
          if (typeof window.playSmooth === "function") window.playSmooth();
          if (!(await waitForPlayback(el, 8000))) throw new Error("your file did not start");
        },
      };
    }
    return null;
  }

  const itemsFromTracks = (tracks) => (tracks || []).map(itemFromTrack).filter(Boolean);

  function saveTracksToPlaylist(name, tracks) {
    const clean = (tracks || []).filter(Boolean);
    if (!clean.length) { showNote("Nothing to save yet — play or search something first."); return; }
    const list = getPlaylists();
    const key = name.trim().toLowerCase();
    const existing = list.find((p) => p.name.trim().toLowerCase() === key);
    if (existing) {
      const have = new Set(existing.tracks.map(mSig));
      for (const t of clean) if (!have.has(mSig(t))) existing.tracks.push(t);
    } else {
      list.push({ id: "pl_" + Date.now().toString(36), name: name.trim(), tracks: clean });
    }
    writeList(LIB.playlists, list);
    renderHome();
    showNote("Saved to “" + name.trim() + "”.");
  }

  function openTracks(title, tracks) {
    const items = itemsFromTracks(tracks);
    if (!items.length) { showNote("Nothing here yet."); return; }
    showResults(title, [{ label: title + " · " + items.length + (items.length === 1 ? " track" : " tracks"), items }], title);
  }

  // ---- player ----
  function mUpdatePill() {
    const pill = document.getElementById("riff-mobile-pill");
    if (!pill) return;
    if (!M.item) { pill.style.display = "none"; return; }
    pill.style.display = "flex";
    pill.querySelector(".m-art").style.backgroundImage = M.item.art ? 'url("' + M.item.art + '")' : "none";
    pill.querySelector(".m-title").textContent = M.item.title;
    pill.querySelector(".m-sub").textContent = M.item.artist || "";
    const el = mEl();
    pill.querySelector(".m-toggle").textContent = el && !el.paused ? "\u275A\u275A" : "\u25B6";
    const fill = document.getElementById("riff-mp-fill");
    if (fill && el && Number.isFinite(el.duration) && el.duration > 0) fill.style.width = (el.currentTime / el.duration) * 100 + "%";
  }

  function mSyncProgress() {
    const el = mEl();
    if (!el) return;
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    const fill = document.getElementById("riff-mp-fill");
    if (fill) fill.style.width = dur ? (el.currentTime / dur) * 100 + "%" : "0%";
    const cur = document.getElementById("riff-mp-cur");
    const tot = document.getElementById("riff-mp-dur");
    if (cur) cur.textContent = mFmt(el.currentTime);
    if (tot) tot.textContent = dur ? mFmt(dur) : "0:00";
  }

  function mAttach(el) {
    if (!el || el.__riffMobileBound) return;
    el.__riffMobileBound = true;
    el.addEventListener("timeupdate", mSyncProgress);
    el.addEventListener("play", mUpdatePill);
    el.addEventListener("pause", mUpdatePill);
    el.addEventListener("loadedmetadata", mSyncProgress);
    el.addEventListener("ended", () => mAdvance(true));
  }

  function mNextIndex(auto) {
    const n = M.queue.length;
    if (!n) return -1;
    if (auto && M.repeat === "one") return M.index;
    if (M.shuffle && n > 1) {
      let i = M.index;
      while (i === M.index) i = Math.floor(Math.random() * n);
      return i;
    }
    if (M.index + 1 < n) return M.index + 1;
    return M.repeat === "all" || auto ? 0 : -1;
  }

  function mAdvance(auto) {
    const next = mNextIndex(auto);
    if (next < 0) { mUpdatePill(); return; }
    mPlayIndex(next);
  }

  async function mPlayIndex(i) {
    const item = M.queue[i];
    if (!item) return;
    const token = (M.token = (M.token || 0) + 1);
    M.index = i;
    M.item = item;
    // show the selection immediately; playback catches up
    mRenderPlayer();
    mUpdatePill();
    try {
      await item.onPlay();
      if (token !== M.token) return;
      M.el = item.kind === "local" ? document.querySelector("audio") : window.__riffRemoteAudio;
      mAttach(M.el);
      if (item.track) pushRecent(item.track);
      mRenderPlayer();
      mUpdatePill();
      mSyncProgress();
    } catch (e) {
      showNote('Could not play \u201C' + item.title + '\u201D \u2014 ' + (e && e.message ? e.message : "unknown error") + ".");
    }
  }

  function mRenderPlayer() {
    const p = document.getElementById("riff-mobile-player");
    if (!p || !M.item) return;
    p.querySelector(".mp-art").style.backgroundImage = M.item.art ? 'url("' + M.item.art + '")' : "none";
    p.querySelector(".mp-title").textContent = M.item.title;
    p.querySelector(".mp-artist").textContent = M.item.artist || "";
    const el = mEl();
    p.querySelector(".mp-play").textContent = el && !el.paused ? "\u275A\u275A" : "\u25B6";
    const like = p.querySelector(".mp-like");
    const on = M.item.track && isLiked(M.item.track);
    like.textContent = on ? "\u2665" : "\u2661";
    like.style.color = on ? "#ff5a7a" : "#f4f4f7";
    p.querySelector(".mp-shuffle").style.color = M.shuffle ? "#7ee2a8" : "#8f8f99";
    p.querySelector(".mp-repeat").style.color = M.repeat === "off" ? "#8f8f99" : "#7ee2a8";
    p.querySelector(".mp-repeat").textContent = M.repeat === "one" ? "\u21BB1" : "\u21BB";
    mSyncProgress();
  }

  function toggleMobilePlayer(open) {
    const p = document.getElementById("riff-mobile-player");
    if (!p) return;
    p.style.display = open ? "flex" : "none";
    if (open) { mRenderPlayer(); closeResults(); }
  }

  function showMobileNow() { if (isNarrowScreen()) mUpdatePill(); }
  function hideMobileNow() { const pill = document.getElementById("riff-mobile-pill"); if (pill) pill.style.display = "none"; }
  function hideMobileEmpty() { const el = document.getElementById("riff-mobile-empty"); if (el) el.style.display = "none"; }
  function showMobileEmpty() { const el = document.getElementById("riff-mobile-empty"); if (el && !document.getElementById("riff-web-search")) { el.style.display = "flex"; renderHome(); } }

  // ---- home ----
  function renderHome() {
    const wrapLiked = document.getElementById("riff-mobile-liked");
    const wrapRecent = document.getElementById("riff-mobile-recent");
    const wrapPl = document.getElementById("riff-mobile-playlists");

    if (wrapLiked) {
      const n = getLiked().length;
      wrapLiked.innerHTML = "";
      wrapLiked.style.display = n ? "block" : "none";
      if (n) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText = "display:flex;align-items:center;gap:12px;width:100%;padding:10px 0;border:0;background:transparent;text-align:left;color:#f2f2f6";
        btn.innerHTML =
          '<span style="flex:0 0 44px;width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,#ff5a7a,#b54bff);display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff">\u2665</span>' +
          '<span style="flex:1"><span style="display:block;font:600 15px/1.25 system-ui,sans-serif">Liked songs</span><span style="display:block;margin-top:3px;color:#8e8e98;font:400 12px system-ui,sans-serif">' + n + (n === 1 ? " track" : " tracks") + "</span></span>";
        btn.addEventListener("click", () => openTracks("Liked songs", getLiked()));
        wrapLiked.appendChild(btn);
      }
    }

    if (wrapRecent) {
      const rows = getRecent().slice(0, 5);
      wrapRecent.innerHTML = "";
      wrapRecent.style.display = rows.length ? "block" : "none";
      if (rows.length) {
        const h = document.createElement("h2");
        h.textContent = "Recently played";
        h.style.cssText = "margin:16px 0 4px;color:#9a9aa4;font:600 11px/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase";
        wrapRecent.appendChild(h);
        for (const t of rows) {
          const b = document.createElement("button");
          b.type = "button";
          b.style.cssText = "display:block;width:100%;padding:7px 0;border:0;background:transparent;text-align:left;color:#e8e8ee;font:500 14px/1.3 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
          b.textContent = t.title + " · " + (t.artist || "");
          b.addEventListener("click", () => {
            const items = itemsFromTracks(rows);
            M.queue = items;
            const idx = rows.indexOf(t);
            mPlayIndex(idx >= 0 ? idx : 0);
            toggleMobilePlayer(true);
          });
          wrapRecent.appendChild(b);
        }
      }
    }

    if (wrapPl) {
      wrapPl.innerHTML = "";
      const list = getPlaylists();
      if (!list.length) { wrapPl.style.display = "none"; }
      else {
        wrapPl.style.display = "block";
        const h = document.createElement("h2");
        h.textContent = "Playlists";
        h.style.cssText = "margin:16px 0 4px;color:#9a9aa4;font:600 11px/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase";
        wrapPl.appendChild(h);
        for (const pl of list) {
          const row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0";
          const open = document.createElement("button");
          open.type = "button";
          open.style.cssText = "flex:1;min-width:0;text-align:left;border:0;background:transparent;color:#f2f2f6;font:600 15px/1.25 system-ui,sans-serif;padding:0";
          open.textContent = pl.name;
          const meta = document.createElement("span");
          meta.textContent = (pl.tracks || []).length + ((pl.tracks || []).length === 1 ? " track" : " tracks");
          meta.style.cssText = "display:block;margin-top:3px;color:#8e8e98;font:400 12px system-ui,sans-serif";
          open.appendChild(meta);
          open.addEventListener("click", () => openTracks(pl.name, pl.tracks));
          const del = document.createElement("button");
          del.type = "button";
          del.textContent = "\u00D7";
          del.setAttribute("aria-label", "Delete playlist");
          del.style.cssText = "flex:0 0 auto;width:30px;height:30px;border:0;border-radius:50%;background:rgba(255,255,255,.08);color:#d8d8e0;font:600 14px/1 system-ui,sans-serif";
          del.addEventListener("click", () => {
            writeList(LIB.playlists, getPlaylists().filter((p) => p.id !== pl.id));
            renderHome();
          });
          row.append(open, del);
          wrapPl.appendChild(row);
        }
      }
    }
  }

  // ---- sheets: queue and add-to-playlist ----
  function closeSheet() {
    document.querySelectorAll("#riff-mobile-sheet").forEach((n) => n.remove());
  }

  function openSheet(title, rows) {
    closeSheet();
    const sheet = document.createElement("div");
    sheet.id = "riff-mobile-sheet";
    const head = document.createElement("div");
    head.className = "ms-head";
    const h = document.createElement("span");
    h.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "\u00D7";
    close.addEventListener("click", closeSheet);
    head.append(h, close);
    const list = document.createElement("div");
    list.className = "ms-list";
    for (const r of rows) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ms-row" + (r.active ? " active" : "");
      b.textContent = r.label;
      if (r.sub) {
        const s = document.createElement("span");
        s.textContent = r.sub;
        s.style.cssText = "display:block;color:#8e8e98;font:400 12px system-ui,sans-serif;margin-top:2px";
        b.appendChild(s);
      }
      b.addEventListener("click", () => { closeSheet(); r.onPick && r.onPick(); });
      list.appendChild(b);
    }
    sheet.append(head, list);
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
    document.body.appendChild(sheet);
  }

  function openQueueSheet() {
    const rows = (M.queue || []).map((it, i) => ({
      label: it.title,
      sub: it.artist || "",
      active: i === M.index,
      onPick: () => { mPlayIndex(i); },
    }));
    if (!rows.length) { showNote("The queue is empty."); return; }
    openSheet("Up next", rows);
  }

  function openAddSheet(track) {
    if (!track) { showNote("Nothing is playing yet."); return; }
    const list = getPlaylists();
    const rows = list.map((pl) => ({
      label: pl.name,
      sub: (pl.tracks || []).length + " tracks",
      onPick: () => saveTracksToPlaylist(pl.name, [track]),
    }));
    rows.push({
      label: "+ New playlist",
      onPick: () => {
        const name = prompt("Playlist name", "My playlist");
        if (name && name.trim()) saveTracksToPlaylist(name, [track]);
      },
    });
    openSheet("Add to playlist", rows);
  }

  function mountMobileShell() {
    if (!isNarrowScreen()) return;
    if (document.getElementById("riff-mobile-bar")) return;

    const css = [
      "body.mini .titlebar,body.mini .titlebar-controls,body.mini .playbar{display:none!important}",
      "#riff-web-add{display:none!important}",
      "#riff-mobile-bar{position:fixed;top:0;left:0;right:0;z-index:2147483645;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:linear-gradient(180deg,#131317 0%,rgba(19,19,23,.86) 70%,rgba(19,19,23,0) 100%)}",
      "#riff-mobile-bar .m-field{display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;border-radius:14px;background:#232329;border:1px solid rgba(255,255,255,.07)}",
      "#riff-mobile-bar svg{flex:0 0 auto;opacity:.5}",
      "#riff-mobile-bar input{flex:1;min-width:0;border:0;background:transparent;color:#f2f2f5;font:500 15px/1 system-ui,-apple-system,sans-serif;outline:none}",
      "#riff-mobile-bar input::placeholder{color:#7c7c85}",
      "#riff-mobile-bar .m-add{flex:0 0 auto;width:32px;height:32px;border:0;border-radius:10px;background:#2c2c34;color:#e8e8ee;font:600 17px/1 system-ui,sans-serif}",
      "#riff-mobile-body{position:fixed;top:calc(74px + env(safe-area-inset-top));left:0;right:0;bottom:0;z-index:2147483644;padding:0 4px}",
      "#riff-mobile-empty{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:12px;padding:0 22px;overflow-y:auto}",
      "#riff-mobile-empty h1{margin:0;color:#f4f4f7;font:700 26px/1.15 system-ui,-apple-system,sans-serif;letter-spacing:-.02em}",
      "#riff-mobile-empty p{margin:0;color:#9a9aa4;font:400 14px/1.5 system-ui,-apple-system,sans-serif}",
      "#riff-mobile-empty .m-chips{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 2px}",
      "#riff-mobile-empty .m-chips button{padding:9px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#e9e9ef;font:500 13px/1 system-ui,sans-serif}",
      "#riff-mobile-pill{position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:2147483646;display:none;align-items:center;gap:12px;padding:9px 12px 9px 9px;border-radius:18px;background:rgba(32,32,37,.96);border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden}",
      "#riff-mobile-pill .m-art{flex:0 0 44px;width:44px;height:44px;border-radius:10px;background:#2a2a31 center/cover no-repeat}",
      "#riff-mobile-pill .m-txt{flex:1;min-width:0}",
      "#riff-mobile-pill .m-title{display:block;color:#f3f3f7;font:600 14px/1.25 system-ui,-apple-system,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#riff-mobile-pill .m-sub{display:block;color:#95959f;font:400 12px/1.3 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#riff-mobile-pill button{flex:0 0 auto;width:40px;height:40px;border:0;border-radius:50%;background:#f3f3f7;color:#131317;font:600 14px/1 system-ui,sans-serif}",
      "#riff-mobile-player{position:fixed;inset:0;z-index:2147483647;display:none;flex-direction:column;padding:calc(14px + env(safe-area-inset-top)) 22px calc(20px + env(safe-area-inset-bottom));background:radial-gradient(120% 80% at 50% 0%,#3a2a22 0%,#191519 55%,#0a0a0c 100%);color:#f4f4f7;overflow-y:auto}",
      "#riff-mobile-player .mp-top{display:flex;align-items:center;justify-content:space-between}",
      "#riff-mobile-player .mp-top button{width:36px;height:36px;border:0;border-radius:50%;background:rgba(255,255,255,.08);color:#e9e9ef;font:600 16px/1 system-ui,sans-serif}",
      "#riff-mobile-player .mp-label{color:#a9a9b2;font:500 11px/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase}",
      "#riff-mobile-player .mp-art{flex:0 0 auto;aspect-ratio:1;width:100%;max-width:300px;margin:20px auto 16px;border-radius:20px;background:#26262c center/cover no-repeat;box-shadow:0 24px 60px rgba(0,0,0,.55)}",
      "#riff-mobile-player .mp-row{display:flex;align-items:center;gap:12px}",
      "#riff-mobile-player .mp-title{flex:1;min-width:0;font:700 22px/1.2 system-ui,-apple-system,sans-serif;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#riff-mobile-player .mp-like{flex:0 0 auto;width:38px;height:38px;border:0;background:transparent;font-size:20px}",
      "#riff-mobile-player .mp-artist{margin-top:6px;color:#a3a3ad;font:400 15px/1.3 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#riff-mobile-player .mp-bar{position:relative;height:4px;margin:18px 0 6px;border-radius:999px;background:rgba(255,255,255,.16);cursor:pointer}",
      "#riff-mobile-player .mp-bar .mp-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:999px;background:#f4f4f7}",
      "#riff-mobile-player .mp-times{display:flex;justify-content:space-between;color:#91919b;font:500 11px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums}",
      "#riff-mobile-player .mp-controls{display:flex;align-items:center;justify-content:space-between;margin-top:20px}",
      "#riff-mobile-player .mp-controls button{border:0;background:transparent;color:#f4f4f7;font:600 20px/1 system-ui,sans-serif;padding:6px 10px}",
      "#riff-mobile-player .mp-play{width:62px;height:62px;border-radius:50%!important;background:#f4f4f7!important;color:#131317!important;font-size:20px!important;padding:0!important}",
      "#riff-mobile-player .mp-actions{display:flex;gap:10px;justify-content:center;margin-top:16px}",
      "#riff-mobile-player .mp-actions button{padding:10px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e9e9ef;font:500 13px/1 system-ui,sans-serif}",
      "#riff-mobile-sheet{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,.55)}",
      "#riff-mobile-sheet .ms-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;border-radius:20px 20px 0 0;background:#1b1b21;color:#f2f2f6;font:600 16px system-ui,sans-serif}",
      "#riff-mobile-sheet .ms-head button{width:30px;height:30px;border:0;border-radius:50%;background:rgba(255,255,255,.1);color:#e9e9ef;font:600 14px/1 system-ui,sans-serif}",
      "#riff-mobile-sheet .ms-list{max-height:60vh;overflow-y:auto;padding:0 10px calc(20px + env(safe-area-inset-bottom));background:#1b1b21}",
      "#riff-mobile-sheet .ms-row{display:block;width:100%;padding:12px 10px;border:0;border-radius:12px;background:transparent;color:#ececf2;text-align:left;font:500 14px/1.3 system-ui,sans-serif}",
      "#riff-mobile-sheet .ms-row.active{background:rgba(126,226,168,.14);color:#c9f7db}",
      "#riff-web-search{top:calc(74px + env(safe-area-inset-top))!important;left:0!important;right:0!important;bottom:86px!important;transform:none!important;width:100%!important;max-height:none!important;border-radius:0!important;border:0!important;background:#131317!important;padding:0 10px 24px!important}",
      "#riff-web-search>button{padding:9px 10px!important;border-radius:14px!important;gap:12px!important}",
      "#riff-web-search>button>div:first-child{width:48px!important;height:48px!important;flex:0 0 48px!important;border-radius:10px!important}",
      "#riff-web-note{left:10px!important;right:10px!important;bottom:90px!important;max-width:none!important;font-size:13px!important}",
    ].join("\n");
    const style = document.createElement("style");
    style.id = "riff-mobile-css";
    style.textContent = css;
    document.head.appendChild(style);

    const bar = document.createElement("div");
    bar.id = "riff-mobile-bar";
    bar.innerHTML =
      '<div class="m-field">' +
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
      '<input type="search" placeholder="Songs, artists, albums" autocomplete="off" enterkeyhint="search">' +
      '<button class="m-add" type="button" title="Add music">+</button>' +
      "</div>";
    const field = bar.querySelector(".m-field");
    const input = bar.querySelector("input");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "\u00D7";
    clear.setAttribute("aria-label", "Clear search");
    clear.style.cssText = "display:none;flex:0 0 auto;width:26px;height:26px;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#e9e9ef;font:600 14px/1 system-ui,sans-serif";
    clear.addEventListener("click", () => {
      input.value = "";
      clear.style.display = "none";
      closeResults();
      showMobileEmpty();
      input.focus();
    });
    input.addEventListener("input", () => { clear.style.display = input.value ? "block" : "none"; });
    field.appendChild(clear);
    const addBtn = bar.querySelector(".m-add");
    field.appendChild(addBtn);
    addBtn.addEventListener("click", () => {
      const real = document.getElementById("riff-web-add");
      if (real) real.click();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const q = (input.value || "").trim();
      if (!q) return;
      input.blur();
      searchLibrary(q);
    });
    document.body.appendChild(bar);

    const body = document.createElement("div");
    body.id = "riff-mobile-body";
    const empty = document.createElement("div");
    empty.id = "riff-mobile-empty";
    const h1 = document.createElement("h1");
    h1.textContent = "Play it in full.";
    const p = document.createElement("p");
    p.textContent = "Search any song, artist or album \u2014 tracks stream whole, not as previews.";
    const chips = document.createElement("div");
    chips.className = "m-chips";
    for (const term of ["lofi", "jazz", "classical", "hip hop", "grateful dead"]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = term;
      chip.addEventListener("click", () => {
        input.value = term;
        clear.style.display = "block";
        input.blur();
        searchLibrary(term);
      });
      chips.appendChild(chip);
    }
    const likedWrap = document.createElement("div");
    likedWrap.id = "riff-mobile-liked";
    likedWrap.style.display = "none";
    const recentWrap = document.createElement("div");
    recentWrap.id = "riff-mobile-recent";
    recentWrap.style.display = "none";
    const plWrap = document.createElement("div");
    plWrap.id = "riff-mobile-playlists";
    plWrap.style.display = "none";
    empty.append(h1, p, chips, likedWrap, recentWrap, plWrap);
    body.appendChild(empty);
    document.body.appendChild(body);

    const pill = document.createElement("div");
    pill.id = "riff-mobile-pill";
    pill.innerHTML =
      '<div class="m-art"></div>' +
      '<div class="m-txt"><span class="m-title"></span><span class="m-sub"></span></div>' +
      '<button class="m-toggle" type="button">\u25B6</button>';
    pill.querySelector(".m-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      const el = mEl();
      if (!el) return;
      if (el.paused) el.play().catch(() => {});
      else el.pause();
      mUpdatePill();
    });
    pill.addEventListener("click", () => toggleMobilePlayer(true));
    document.body.appendChild(pill);

    const player = document.createElement("div");
    player.id = "riff-mobile-player";
    player.innerHTML =
      '<div class="mp-top"><button class="mp-close" type="button">\u2304</button><span class="mp-label">Now playing</span><button class="mp-queue-open" type="button">\u2630</button></div>' +
      '<div class="mp-art"></div>' +
      '<div class="mp-row"><div class="mp-title"></div><button class="mp-like" type="button">\u2661</button></div>' +
      '<div class="mp-artist"></div>' +
      '<div class="mp-bar"><div class="mp-fill" id="riff-mp-fill"></div></div>' +
      '<div class="mp-times"><span id="riff-mp-cur">0:00</span><span id="riff-mp-dur">0:00</span></div>' +
      '<div class="mp-controls">' +
      '<button class="mp-shuffle" type="button">\u2B0E</button>' +
      '<button class="mp-prev" type="button">\u23EE</button>' +
      '<button class="mp-play" type="button">\u25B6</button>' +
      '<button class="mp-next" type="button">\u23ED</button>' +
      '<button class="mp-repeat" type="button">\u21BB</button>' +
      "</div>" +
      '<div class="mp-actions"><button class="mp-add" type="button">Add to playlist</button><button class="mp-save" type="button">Save queue</button></div>';
    player.querySelector(".mp-close").addEventListener("click", () => toggleMobilePlayer(false));
    player.querySelector(".mp-queue-open").addEventListener("click", openQueueSheet);
    player.querySelector(".mp-play").addEventListener("click", () => {
      const el = mEl();
      if (!el) return;
      if (el.paused) el.play().catch(() => {});
      else el.pause();
      mRenderPlayer();
      mUpdatePill();
    });
    player.querySelector(".mp-like").addEventListener("click", () => toggleLike(M.item && M.item.track));
    player.querySelector(".mp-shuffle").addEventListener("click", () => { M.shuffle = !M.shuffle; mRenderPlayer(); });
    player.querySelector(".mp-repeat").addEventListener("click", () => {
      M.repeat = M.repeat === "off" ? "all" : M.repeat === "all" ? "one" : "off";
      mRenderPlayer();
      showNote("Repeat: " + M.repeat);
    });
    player.querySelector(".mp-prev").addEventListener("click", () => {
      if (M.index > 0) mPlayIndex(M.index - 1);
      else { const el = mEl(); if (el) el.currentTime = 0; }
    });
    player.querySelector(".mp-next").addEventListener("click", () => mAdvance(false));
    player.querySelector(".mp-add").addEventListener("click", () => openAddSheet(M.item && M.item.track));
    player.querySelector(".mp-save").addEventListener("click", () => {
      const tracks = (M.queue || []).map((it) => it.track).filter(Boolean);
      if (!tracks.length) { showNote("Nothing queued yet."); return; }
      const name = prompt("Name this playlist", "My playlist");
      if (name && name.trim()) saveTracksToPlaylist(name, tracks);
    });
    player.querySelector(".mp-bar").addEventListener("click", (e) => {
      const el = mEl();
      if (!el || !Number.isFinite(el.duration) || !el.duration) return;
      const r = e.currentTarget.getBoundingClientRect();
      el.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * el.duration;
      mSyncProgress();
    });
    document.body.appendChild(player);

    renderHome();
  }

  function mSetQueue(group, item) {
    M.queue = (group && group.items) ? group.items.slice() : [];
    M.index = M.queue.indexOf(item);
  }

  function mountHooks() {
    mountAddButton();
    try {
      mountMobileShell();
    } catch (e) {
      console.warn("[riff] mobile shell failed", e);
    }
    if (!window.__riffMobileResizeBound) {
      window.__riffMobileResizeBound = true;
      window.addEventListener("resize", () => {
        if (!isNarrowScreen()) {
          ["riff-mobile-bar", "riff-mobile-body", "riff-mobile-pill", "riff-mobile-player", "riff-mobile-css"].forEach((id) => {
            const n = document.getElementById(id);
            if (n) n.remove();
          });
          M.item = null;
        } else {
          try {
            mountMobileShell();
          } catch (e) {
            console.warn("[riff] mobile shell failed", e);
          }
        }
      });
    }
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
