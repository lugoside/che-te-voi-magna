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
  // Richiesta generica. Ritorna { ok, status, data }: ok SOLO se la risposta HTTP è 2xx
  // e il corpo non è un errore Firebase ({"error": "Permission denied"} ecc.).
  // status 0 = errore di rete. Un errore NON va mai trattato come "nodo vuoto".
  async request(method, path, obj) {
    const u = this.nodeUrl(path); if (!u) return { ok: false, status: 0, data: null };
    try {
      const init = method === "GET" ? { cache: "no-store" }
        : { method, headers: { "Content-Type": "application/json; charset=utf-8" }, body: obj === undefined ? undefined : JSON.stringify(obj) };
      const r = await fetch(u + ".json", init);
      let data = null; try { data = await r.json(); } catch {}
      const ok = r.ok && !(data && typeof data === "object" && !Array.isArray(data) && "error" in data && Object.keys(data).length === 1);
      this._setStatus(ok ? "ok" : "err");
      return { ok, status: r.status, data: ok ? data : null };
    } catch { this._setStatus("err"); return { ok: false, status: 0, data: null }; }
  }
  // lettura di un nodo: { ok, data } (data null = nodo davvero vuoto, solo se ok)
  get(path) { return this.request("GET", path); }
  // documento condiviso: sostituisce il nodo
  async put(path, obj) { return (await this.request("PUT", path, obj)).ok; }
  // aggiornamento parziale (merge di chiavi) del nodo
  async patch(path, obj) { return (await this.request("PATCH", path, obj)).ok; }
  // append a un log: POST → Firebase genera un pushId. Ritorna il pushId o null.
  async append(path, obj) {
    const body = { ...obj, ts: { ".sv": "timestamp" } }; // timestamp del server (autorevole)
    const r = await this.request("POST", path, body);
    return r.ok && r.data && r.data.name ? r.data.name : null;
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
