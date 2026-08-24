// sync.js — sincronizzazione famigliare via Firebase Realtime Database.
//
// Usa SOLO REST (fetch) + SSE (EventSource): nessun SDK, nessuna dipendenza,
// niente build. Stesso approccio collaudato di FantaAsta. Tutto sotto:
//   <url>/chetevoimagna/<codiceFamiglia>/
// con i nodi:
//   /config /profili /dispensa /regole  → documenti condivisi (PUT/GET)
//   /ricette                            → il ricettario (GET; POST per aggiunte manuali)
//   /storico/<pushId>                   → log append-only dei pasti fatti
//   /coda/<pushId>                      → log append-only delle osservazioni per lo skill
//
// L'app mantiene un mirror in localStorage → funziona anche offline.

// ---------------------------------------------------------------------------
// Helper localStorage (con try/catch, chiavi con prefisso ctvm_)
// ---------------------------------------------------------------------------
export function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
export function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// uid client-generato per gli eventi append-only (dedup lato reducer)
export function mkUid(deviceId = "") {
  return (deviceId.replace(/^dev-/, "").slice(0, 6) || "x") + "-" +
         Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

export function newDeviceId() {
  return "dev-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Sync: incapsula base URL + operazioni REST + sottoscrizioni SSE.
// ---------------------------------------------------------------------------
export class Sync {
  constructor({ url, code, deviceId } = {}) {
    this.url = url || "";
    this.code = code || "";
    this.deviceId = deviceId || newDeviceId();
    this._streams = [];       // EventSource attivi
    this._status = "off";     // off | ok | err
    this.onStatus = null;     // callback(status)
  }

  set(cfg = {}) {
    if (cfg.url !== undefined) this.url = cfg.url;
    if (cfg.code !== undefined) this.code = cfg.code;
    return this;
  }
  get enabled() { return !!(this.url && this.code); }

  base() {
    if (!this.enabled) return null;
    return this.url.replace(/\/+$/, "") + "/chetevoimagna/" + encodeURIComponent(this.code.trim());
  }
  nodeUrl(path) { const b = this.base(); return b ? b + "/" + String(path).replace(/^\/+/, "") : null; }
  _setStatus(s) { this._status = s; if (typeof this.onStatus === "function") this.onStatus(s); }

  // --- REST ---------------------------------------------------------------
  async get(path) {
    const u = this.nodeUrl(path); if (!u) return null;
    try {
      const r = await fetch(u + ".json", { cache: "no-store" });
      this._setStatus("ok");
      return await r.json();
    } catch { this._setStatus("err"); return null; }
  }
  // documento condiviso: sostituisce il nodo
  async put(path, obj) {
    const u = this.nodeUrl(path); if (!u) return false;
    try {
      await fetch(u + ".json", { method: "PUT", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj) });
      this._setStatus("ok"); return true;
    } catch { this._setStatus("err"); return false; }
  }
  // aggiornamento parziale (merge di chiavi) del nodo
  async patch(path, obj) {
    const u = this.nodeUrl(path); if (!u) return false;
    try {
      await fetch(u + ".json", { method: "PATCH", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj) });
      this._setStatus("ok"); return true;
    } catch { this._setStatus("err"); return false; }
  }
  // append a un log: POST → Firebase genera un pushId. Ritorna il pushId o null.
  async append(path, obj) {
    const u = this.nodeUrl(path); if (!u) return null;
    const body = { ...obj, ts: { ".sv": "timestamp" } }; // timestamp del server (autorevole)
    try {
      const r = await fetch(u + ".json", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
      const j = await r.json();
      this._setStatus("ok");
      return j && j.name ? j.name : null;
    } catch { this._setStatus("err"); return null; }
  }

  // --- SSE (realtime) -----------------------------------------------------
  // onEvent riceve { path, data } così come li manda Firebase (path "/" = snapshot
  // completo del nodo; path "/<pushId>" = singolo elemento aggiunto/modificato).
  subscribe(path, onEvent) {
    const u = this.nodeUrl(path);
    if (!u || typeof EventSource === "undefined") return null;
    try {
      const es = new EventSource(u + ".json");
      const handler = (ev) => { try { const msg = JSON.parse(ev.data); if (msg) onEvent(msg); } catch {} };
      es.addEventListener("put", handler);
      es.addEventListener("patch", handler);
      es.onopen = () => this._setStatus("ok");
      es.onerror = () => this._setStatus("err");
      this._streams.push(es);
      return es;
    } catch { this._setStatus("err"); return null; }
  }
  closeStreams() { for (const es of this._streams) { try { es.close(); } catch {} } this._streams = []; }
}

// ---------------------------------------------------------------------------
// Merge di un log append-only ricevuto dal cloud dentro il log locale.
// Dedup per uid; l'evento con ts numerico (confermato dal server) prevale.
// Ritorna { log, changed }.
// ---------------------------------------------------------------------------
export function mergeLog(localLog, cloudObj) {
  const out = Array.isArray(localLog) ? localLog.slice() : [];
  if (!cloudObj || typeof cloudObj !== "object") return { log: out, changed: false };
  const byUid = new Map(out.map((m) => [m.uid, m]));
  let changed = false;
  for (const [pushId, mv] of Object.entries(cloudObj)) {
    if (!mv || typeof mv !== "object") continue;
    const uid = mv.uid || pushId;
    const local = byUid.get(uid);
    if (!local) {
      const inc = { ...mv, uid, id: pushId, posted: true };
      out.push(inc); byUid.set(uid, inc); changed = true;
    } else {
      // la copia cloud è autorevole: fondi TUTTI i suoi campi (così arrivano anche
      // i cambi di contenuto, es. stato:"processed" scritto dallo skill)
      const merged = { ...local, ...mv, uid, id: pushId, posted: true };
      if (JSON.stringify(merged) !== JSON.stringify(local)) { Object.assign(local, merged); changed = true; }
    }
  }
  return { log: out, changed };
}
