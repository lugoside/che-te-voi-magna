// app.js — logica dell'interfaccia di "Che te voi magnà?".
// Collega il motore di selezione (engine.js), la sync famigliare (sync.js) e il DOM.
import {
  proponi, reduceStorico, normalizeRicetta, toList, norm,
  PORTATE, PORTATA_NOME, listaSpesa, ymd,
  PORZIONI_BASE, scalaIngredienti, commensaliDi, REPARTI,
} from "./engine.js";
import { Sync, load, save, mkUid, newDeviceId, mergeLog } from "./sync.js";

const APP_VERSION = "v14";

// ---------------------------------------------------------------------------
// Chiavi localStorage + stato
// ---------------------------------------------------------------------------
const LS = {
  config: "ctvm_config", sync: "ctvm_sync", device: "ctvm_device", ui: "ctvm_ui",
  profili: "ctvm_profili", dispensa: "ctvm_dispensa", regole: "ctvm_regole",
  ricette: "ctvm_ricette", storico: "ctvm_storico", coda: "ctvm_coda",
  piano: "ctvm_piano", spesaCheck: "ctvm_spesa_check",
};

const defaultProfili = () => ({
  valerio: { nome: "Valerio", bimbo: false, nonGraditi: [], allergie: [] },
  elena: { nome: "Elena", bimbo: false, nonGraditi: [], allergie: [] },
  ambra: { nome: "Ambra", bimbo: true, nonGraditi: [], allergie: [] },
});
const defaultConfig = () => ({ modelloPreferito: "claude-opus-5" });
const defaultDispensa = () => ["olio", "sale", "acqua", "pepe"];

let CONFIG = { ...defaultConfig(), ...load(LS.config, {}) };
let PROFILI = load(LS.profili, defaultProfili());
let DISPENSA = load(LS.dispensa, defaultDispensa());
let REGOLE = load(LS.regole, []);
let RICETTE = load(LS.ricette, []);          // mirror del ricettario (array)
let STORICO = load(LS.storico, []);          // log append-only
let CODA = load(LS.coda, []);                // log append-only
let PIANO = load(LS.piano, []);              // pasti pianificati (log, 1 per slot data+pasto)
let SYNC = load(LS.sync, { url: "", code: "", on: false });

let DEVICE_ID = load(LS.device, "");
if (!DEVICE_ID) { DEVICE_ID = newDeviceId(); save(LS.device, DEVICE_ID); }

const ui = Object.assign({
  screen: "home",
  presenti: Object.keys(PROFILI),
  ospiti: 0,
  nrPasti: 3,
  portate: ["primo"],
  ingredienti: [],
  seed: 1,
  cerca: "",
  filtroPortata: "tutte",
  obsTipo: "nuova-ricetta",
  proposte: [],
  pianoView: "agenda",       // agenda | settimana | mese
  pianoCursor: ymd(),        // data di riferimento per settimana/mese
  agendaDays: 14,            // quanti giorni mostra l'agenda
}, load(LS.ui, {}));
// i profili possono essere cambiati: tieni i presenti coerenti
ui.presenti = ui.presenti.filter((k) => PROFILI[k]);
if (!ui.presenti.length) ui.presenti = Object.keys(PROFILI);

function saveUI() { save(LS.ui, { presenti: ui.presenti, ospiti: ui.ospiti, nrPasti: ui.nrPasti, portate: ui.portate, ingredienti: ui.ingredienti, obsTipo: ui.obsTipo }); }

// ---------------------------------------------------------------------------
// Sync famigliare
// ---------------------------------------------------------------------------
const sync = new Sync({ url: SYNC.url, code: SYNC.code, deviceId: DEVICE_ID });
sync.onStatus = (s) => setDot(SYNC.on ? s : "off");
let _pollId = null;

function ricetteToObj(list) { const o = {}; for (const r of list) { const { id, ...rest } = r; if (id != null) o[id] = rest; } return o; }
// fetch che distingue "vuoto" da "errore di rete" (per potare in sicurezza)
async function getNode(path) {
  const u = sync.nodeUrl(path); if (!u) return { ok: false, data: null };
  try { const r = await fetch(u + ".json", { cache: "no-store" }); return { ok: true, data: await r.json() }; }
  catch { return { ok: false, data: null }; }
}

async function reconcile() {
  if (!SYNC.on || !sync.enabled) return;
  try {
    const [rc, rp, rd, rr, rric] = await Promise.all([
      sync.get("config"), sync.get("profili"), sync.get("dispensa"),
      sync.get("regole"), sync.get("ricette"),
    ]);
    const rsN = await getNode("storico");
    const rqN = await getNode("coda");
    const rpN = await getNode("piano");
    let changed = false;
    const differ = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
    const sortById = (l) => [...l].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    // documenti condivisi: se ci sono sul cloud li adotto (solo se diversi), altrimenti pubblico i miei
    if (rc && typeof rc === "object") { const m = { ...CONFIG, ...rc }; if (differ(m, CONFIG)) { CONFIG = m; save(LS.config, CONFIG); changed = true; } } else await sync.put("config", CONFIG);
    if (rp && typeof rp === "object") { if (differ(rp, PROFILI)) { PROFILI = rp; save(LS.profili, PROFILI); changed = true; } } else await sync.put("profili", PROFILI);
    if (Array.isArray(rd)) { if (differ(rd, DISPENSA)) { DISPENSA = rd; save(LS.dispensa, DISPENSA); changed = true; } } else await sync.put("dispensa", DISPENSA);
    if (Array.isArray(rr)) { if (differ(rr, REGOLE)) { REGOLE = rr; save(LS.regole, REGOLE); changed = true; } } else await sync.put("regole", REGOLE);
    // ricettario: se il cloud ne ha, adotto; se è vuoto, semino il mio (base per lo skill)
    const remoteRic = toList(rric);
    if (remoteRic.length) { if (differ(sortById(remoteRic), sortById(RICETTE))) { RICETTE = remoteRic; save(LS.ricette, RICETTE); changed = true; } }
    else if (RICETTE.length) await sync.put("ricette", ricetteToObj(RICETTE));
    // log append-only
    // log append-only: fondi le novità dal cloud e POTA le voci cancellate da remoto
    // (solo se il fetch è andato a buon fine → niente cancellazioni per colpa della rete)
    const ms = mergeLog(STORICO, rsN.data); if (ms.changed) { STORICO = ms.log; changed = true; }
    if (rsN.ok) { const ids = new Set(Object.keys(rsN.data || {})); const n = STORICO.length; STORICO = STORICO.filter((e) => !e.id || ids.has(e.id)); if (STORICO.length !== n) changed = true; }
    save(LS.storico, STORICO);
    const mq = mergeLog(CODA, rqN.data); if (mq.changed) { CODA = mq.log; changed = true; }
    if (rqN.ok) { const ids = new Set(Object.keys(rqN.data || {})); const n = CODA.length; CODA = CODA.filter((e) => !e.id || ids.has(e.id)); if (CODA.length !== n) changed = true; }
    save(LS.coda, CODA);
    const mp = mergeLog(PIANO, rpN.data); if (mp.changed) { PIANO = mp.log; changed = true; }
    if (rpN.ok) { const ids = new Set(Object.keys(rpN.data || {})); const n = PIANO.length; PIANO = PIANO.filter((e) => !e.id || ids.has(e.id)); if (PIANO.length !== n) changed = true; }
    save(LS.piano, PIANO);
    await flushPending();
    if (changed) renderAllSafe();
  } catch {}
}

const LOG_LS = { storico: LS.storico, coda: LS.coda, piano: LS.piano };
const LOG_ARR = () => ({ storico: STORICO, coda: CODA, piano: PIANO });
async function flushPending() {
  if (!SYNC.on || !sync.enabled) return;
  for (const path of ["storico", "coda", "piano"]) {
    for (const e of LOG_ARR()[path].filter((x) => x.posted === false && x.byDevice === DEVICE_ID)) await postLog(path, e);
  }
}
async function postLog(path, e) {
  const { id, posted, ...body } = e;
  const pushId = await sync.append(path, body);
  if (pushId) { e.posted = true; e.id = pushId; save(LOG_LS[path], LOG_ARR()[path]); }
}

function subscribeAll() {
  sync.closeStreams();
  if (!SYNC.on || !sync.enabled) return;
  // Nota: gli aggiornamenti PARZIALI (patch senza uid, es. lo skill che marca "processed")
  // vengono ignorati qui e recuperati dal reconcile() periodico (snapshot completo).
  sync.subscribe("storico", (msg) => {
    let obj = null;
    if (msg.path === "/") obj = msg.data; else if (msg.path && msg.data && msg.data.uid) obj = { [msg.path.replace(/^\//, "")]: msg.data };
    const m = mergeLog(STORICO, obj); if (m.changed) { STORICO = m.log; save(LS.storico, STORICO); renderIfVisible(["home", "storico"]); }
  });
  sync.subscribe("coda", (msg) => {
    let obj = null;
    if (msg.path === "/") obj = msg.data; else if (msg.path && msg.data && msg.data.uid) obj = { [msg.path.replace(/^\//, "")]: msg.data };
    const m = mergeLog(CODA, obj); if (m.changed) { CODA = m.log; save(LS.coda, CODA); renderIfVisible(["insegna"]); }
  });
  sync.subscribe("piano", (msg) => {
    let obj = null;
    if (msg.path === "/") obj = msg.data; else if (msg.path && msg.data && msg.data.uid) obj = { [msg.path.replace(/^\//, "")]: msg.data };
    const m = mergeLog(PIANO, obj); if (m.changed) { PIANO = m.log; save(LS.piano, PIANO); renderIfVisible(["piano", "home"]); }
  });
  sync.subscribe("ricette", (msg) => {
    if (msg.path === "/") { RICETTE = toList(msg.data); }
    else if (msg.path && msg.path !== "/") {
      const id = msg.path.replace(/^\//, "").split("/")[0];
      const i = RICETTE.findIndex((r) => r.id === id);
      if (msg.data == null) { if (i >= 0) RICETTE.splice(i, 1); } // ricetta rimossa sul cloud
      else if (typeof msg.data === "object" && !Array.isArray(msg.data)) {
        const rec = { id, ...msg.data };                          // ricetta intera (PUT)
        if (i >= 0) RICETTE[i] = rec; else RICETTE.push(rec);
      } // patch parziali (path "/<id>/<campo>") le recupera il reconcile periodico
    }
    save(LS.ricette, RICETTE); renderIfVisible(["ricettario", "home"]);
  });
}

function startSync() {
  sync.set({ url: SYNC.url, code: SYNC.code });
  if (!SYNC.on || !sync.enabled) { setDot("off"); return; }
  reconcile().then(subscribeAll);
  if (!_pollId) _pollId = setInterval(() => reconcile(), 15000);
}
function stopSync() { sync.closeStreams(); if (_pollId) { clearInterval(_pollId); _pollId = null; } setDot("off"); }

// pubblica un documento condiviso (config/profili/dispensa/regole)
function pushDoc(path, val) { if (SYNC.on && sync.enabled) sync.put(path, val); }
// cancella un elemento di un log dal cloud (per non farlo ripristinare dal sync)
async function deleteFromCloud(path, id) {
  if (!SYNC.on || !sync.enabled || !id) return;
  const u = sync.nodeUrl(path + "/" + id); if (!u) return;
  try { await fetch(u + ".json", { method: "DELETE" }); } catch {}
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
// ripara il classico doppio-encoding UTF-8 ("Ã©"→"é", "Ã "→"à"): in italiano il
// pattern "Ã/Â + byte alto" non è mai legittimo, quindi correggerlo è sicuro.
function fixMojibake(s) {
  if (!/[ÂÃ][-¿]/.test(s)) return s;
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}
function esc(s) { return fixMojibake(String(s == null ? "" : s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function setDot(s) { const d = $("#syncDot"); if (d) d.className = "sync-dot " + s; const st = $("#syncStato"); if (st) st.textContent = ({ ok: "connesso ✓", err: "in attesa…", off: "spenta" })[s] || s; }
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200); }
const todayISO = () => new Date().toISOString().slice(0, 10);

// --- modale generica ---
let modalCtx = null;
function openModal(html) { $("#modalBody").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; $("#modalBody").innerHTML = ""; modalCtx = null; }

// nasconde gli staple di dispensa dalle liste ingredienti (sono sempre in casa)
function senzaDispensa(ingredienti) {
  const disp = DISPENSA.map(norm);
  return (ingredienti || []).filter((i) => { const n = norm(i.nome); return !disp.some((d) => n === d || n.includes(d)); });
}
function fmtIngrediente(i) {
  const q = i.q != null && i.q !== "" ? `${i.q}${i.unita ? " " + i.unita : ""}` : "";
  return `<li><span>${esc(i.nome)}</span>${q ? ` <span class="qta">— ${esc(q)}</span>` : ""}${i.opzionale ? ' <span class="qta">(facolt.)</span>' : ""}</li>`;
}

// ---------------------------------------------------------------------------
// Render: HOME
// ---------------------------------------------------------------------------
function renderPresenti() {
  $("#presentiChips").innerHTML = Object.entries(PROFILI).map(([k, p]) =>
    `<button type="button" class="chip ${ui.presenti.includes(k) ? "on" : ""}" data-pres="${esc(k)}">${p.bimbo ? "🍼 " : ""}${esc(p.nome)}</button>`
  ).join("");
}
function renderPortate() {
  $("#portateChips").innerHTML = PORTATE.map((p) =>
    `<button type="button" class="chip ${ui.portate.includes(p) ? "on" : ""}" data-port="${p}">${esc(PORTATA_NOME[p])}</button>`
  ).join("");
}
function renderNr() { $("#nrPasti").textContent = ui.nrPasti; }
function renderOspiti() { const el = $("#ospiti"); if (el) el.textContent = ui.ospiti; }
function commensaliUI() { return ui.presenti.length + (ui.ospiti || 0); }
function renderIngChips() {
  $("#ingChips").innerHTML = ui.ingredienti.map((n, i) =>
    `<span class="chip rm" data-ing="${i}">${esc(n)} <span class="x">✕</span></span>`).join("");
}

function ricettaCardHTML(r, opts = {}) {
  const comm = opts.commensali;
  const f = comm ? comm / (r.porzioni || PORZIONI_BASE) : 1;
  const ing = senzaDispensa(f !== 1 ? scalaIngredienti(r.ingredienti, f) : r.ingredienti);
  const meta = [];
  if (comm) meta.push(`👥 per ${comm}`);
  if (r.tempoMin) meta.push(`⏱️ ${r.tempoMin} min`);
  if (r.difficolta) meta.push(`🔥 ${esc(r.difficolta)}`);
  if (r.adattoBimbi) meta.push("🍼 adatto ai bimbi");
  const motivi = opts.motivi && opts.motivi.length ? `<div class="perche">💡 ${esc(opts.motivi.join(" · "))}</div>` : "";
  const acts = (opts.actions || opts.remove || opts.edit) ? `
    <div class="ricetta-actions">
      ${opts.actions ? `<button type="button" class="btn-ghost" data-fatto="${esc(r.id)}">✅ L'abbiamo fatto</button>` : ""}
      ${opts.edit ? `<button type="button" class="btn-ghost" data-modifica="${esc(r.id)}">✏️ Modifica</button>` : ""}
      ${opts.remove ? `<button type="button" class="btn-ghost danger" data-rimuovi="${esc(r.id)}">🗑️ Rimuovi</button>` : ""}
    </div>` : "";
  return `
  <article class="ricetta">
    <div class="ricetta-head">
      <h3>${esc(r.nome)}</h3>
      <span class="pill">${esc(PORTATA_NOME[r.portata] || r.portata)}</span>
    </div>
    <div class="ricetta-body">
      <div class="meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
      ${motivi}
      <div class="sez-tit">Ingredienti</div>
      <ul class="ingredienti">${ing.map(fmtIngrediente).join("")}</ul>
      <div class="sez-tit">Preparazione</div>
      <ol class="passaggi">${(r.passaggi || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
    </div>
    ${acts}
  </article>`;
}

function renderProposte() {
  const box = $("#proposte");
  if (!ui.proposte.length) { box.innerHTML = ""; return; }
  box.innerHTML = ui.proposte.map((r) => ricettaCardHTML(r, { actions: true, motivi: r._motivi, commensali: commensaliUI() })).join("");
}

function doProponi(rimescola) {
  if (rimescola) ui.seed = (ui.seed + 1) % 100000;
  const res = proponi({
    ricette: RICETTE, storico: STORICO, profili: PROFILI,
    presenti: ui.presenti, nrPasti: ui.nrPasti, portate: ui.portate,
    ingredientiDaUsare: ui.ingredienti, seed: ui.seed,
  });
  ui.proposte = res.proposte;
  renderProposte();
  if (!res.proposte.length) {
    $("#proposte").innerHTML = `<div class="card empty">Nessuna idea coi filtri scelti.<br>Prova a togliere qualche vincolo o aggiungi ricette da "Insegna a Ruben".</div>`;
  }
}

// ---------------------------------------------------------------------------
// Render: RICETTARIO
// ---------------------------------------------------------------------------
function renderFiltriPortata() {
  const opts = ["tutte", ...PORTATE];
  $("#filtriPortata").innerHTML = opts.map((p) =>
    `<button type="button" class="chip ${ui.filtroPortata === p ? "on" : ""}" data-filtro="${p}">${p === "tutte" ? "Tutte" : esc(PORTATA_NOME[p])}</button>`
  ).join("");
}
function renderRicettario() {
  renderFiltriPortata();
  const q = norm(ui.cerca);
  // "NEW" = ricette dell'ultimo lotto (createdAt massimo). Calcolato su TUTTO il
  // ricettario, così il badge non dipende dal filtro selezionato.
  const maxTs = RICETTE.reduce((m, r) => Math.max(m, r.createdAt || 0), 0);
  let list = RICETTE.map(normalizeRicetta);
  if (ui.filtroPortata !== "tutte") list = list.filter((r) => r.portata === ui.filtroPortata);
  if (q) list = list.filter((r) => norm(r.nome).includes(q) || r.ingredienti.some((i) => norm(i.nome).includes(q)));
  // ordinamento: più recenti in alto (per data di inserimento), poi per nome
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.nome.localeCompare(b.nome, "it"));
  const box = $("#listaRicette");
  if (!list.length) { box.innerHTML = `<div class="card empty">Nessuna ricetta trovata.</div>`; return; }
  box.innerHTML = list.map((r) => {
    const isNew = maxTs > 0 && (r.createdAt || 0) === maxTs;
    return `
    <div class="riga" data-ricetta="${esc(r.id)}">
      <div class="r-main">
        <div class="r-title">${esc(r.nome)}${isNew ? ' <span class="new-badge">NEW</span>' : ""}</div>
        <div class="r-sub">${esc(PORTATA_NOME[r.portata] || r.portata)}${r.tempoMin ? " · " + r.tempoMin + " min" : ""}${r.adattoBimbi ? " · 🍼" : ""}</div>
      </div>
      <button class="icon-btn" data-apri="${esc(r.id)}">›</button>
    </div>
    <div class="det" id="det-${esc(r.id)}" hidden></div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Render: INSEGNA (coda osservazioni)
// ---------------------------------------------------------------------------
const ESEMPI = {
  "nuova-ricetta": "es. «3 primi veloci con la zucca» oppure «secondi di pesce per l'estate»",
  "importa-url": "Incolla il link della ricetta (es. da un blog di cucina)",
  "regola": "es. «non elencare olio e sale, sono sempre in casa» · «Elena non mangia il coriandolo»",
  "correzione": "es. «nella torta di mele metti 120g di zucchero, non 150»",
};
function renderInsegnaForm() { $("#obsEsempio").textContent = ESEMPI[ui.obsTipo] || ""; $("#obsTipo").value = ui.obsTipo; }
function tipoLabel(t) { return ({ "nuova-ricetta": "💡 Nuova ricetta", "importa-url": "🔗 Importa", "regola": "📏 Regola", "correzione": "✏️ Correzione" })[t] || t; }
function renderCoda() {
  const pending = CODA.filter((c) => c.stato !== "processed");
  $("#codaCount").textContent = pending.length;
  const box = $("#listaCoda");
  const list = reduceStorico(CODA).slice().reverse(); // riuso il reducer (dedup+ordina)
  if (!list.length) { box.innerHTML = `<div class="empty">Ancora niente in coda.</div>`; return; }
  box.innerHTML = list.map((c) => `
    <div class="riga">
      <div class="r-main">
        <div class="r-title">${esc(c.testo || "")}</div>
        <div class="r-sub">${tipoLabel(c.tipo)} · <span class="stato-pill ${c.stato === "processed" ? "processed" : "pending"}">${c.stato === "processed" ? "fatto" : "in attesa"}</span></div>
      </div>
      ${c.stato !== "processed" ? `<button class="icon-btn" data-delobs="${esc(c.uid)}">🗑️</button>` : ""}
    </div>`).join("");
}

// ---------------------------------------------------------------------------
// Render: STORICO
// ---------------------------------------------------------------------------
function nomeRicetta(id) { const r = RICETTE.find((x) => x.id === id); return r ? r.nome : "(ricetta rimossa)"; }
function renderStorico() {
  const list = reduceStorico(STORICO).slice().reverse();
  const box = $("#listaStorico");
  if (!list.length) { box.innerHTML = `<div class="card empty">Nessun pasto registrato.<br>Dopo aver cucinato tocca "L'abbiamo fatto".</div>`; return; }
  box.innerHTML = list.map((e) => {
    const d = e.data ? new Date(e.data) : (e.ts ? new Date(e.ts) : null);
    const dstr = d && !isNaN(d) ? d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" }) : "";
    const pres = (e.presenti || []).map((k) => PROFILI[k] ? PROFILI[k].nome : k).join(", ");
    return `
    <div class="riga">
      <div class="r-main">
        <div class="r-title">${esc(nomeRicetta(e.ricettaId))}</div>
        <div class="r-sub">${esc(dstr)}${e.pasto ? " · " + esc(e.pasto) : ""}${pres ? " · " + esc(pres) : ""}</div>
      </div>
      <div class="r-act">
        <button class="icon-btn" data-editstorico="${esc(e.uid)}">✏️</button>
        <button class="icon-btn" data-delstorico="${esc(e.uid)}">🗑️</button>
      </div>
    </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Render: IMPOSTAZIONI
// ---------------------------------------------------------------------------
function renderProfili() {
  $("#profiliEditor").innerHTML = Object.entries(PROFILI).map(([k, p]) => `
    <div class="prof-row" data-prof="${esc(k)}">
      <div class="prof-top">
        <input type="text" value="${esc(p.nome)}" data-pnome="${esc(k)}" />
        <button class="icon-btn" data-delprof="${esc(k)}">🗑️</button>
      </div>
      <div class="prof-flags">
        <label><input type="checkbox" data-pbimbo="${esc(k)}" ${p.bimbo ? "checked" : ""}/> bimbo/a</label>
      </div>
      <input type="text" placeholder="allergie (virgola)" value="${esc((p.allergie || []).join(", "))}" data-palle="${esc(k)}" />
      <input type="text" placeholder="non graditi (virgola)" value="${esc((p.nonGraditi || []).join(", "))}" data-pgusti="${esc(k)}" />
    </div>`).join("");
}
function renderDispensa() {
  $("#dispChips").innerHTML = DISPENSA.map((d, i) =>
    `<span class="chip rm" data-disp="${i}">${esc(d)} <span class="x">✕</span></span>`).join("");
}
// ===========================================================================
// PIANO settimanale (agenda / settimana / mese) + lista della spesa
// ===========================================================================
const tsFor = (d) => { const t = new Date(d + "T12:00:00").getTime(); return isNaN(t) ? Date.now() : t; };
const GIORNI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const GIORNI_LUN = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
function parseYMD(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0); }
function addDaysISO(s, n) { const d = parseYMD(s); d.setDate(d.getDate() + n); return ymd(d); }
function addMonthsISO(s, n) { const d = parseYMD(s); d.setMonth(d.getMonth() + n); return ymd(d); }
function startWeekISO(s) { const d = parseYMD(s); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return ymd(d); }
function fmtBreve(s) { const d = parseYMD(s); return `${GIORNI[d.getDay()]} ${d.getDate()} ${MESI[d.getMonth()].slice(0, 3)}`; }
function fmtLungo(s) { const d = parseYMD(s); return `${GIORNI[d.getDay()]} ${d.getDate()} ${MESI[d.getMonth()]}`; }

function pianoSlot(data, pasto) { return PIANO.find((x) => x.data === data && x.pasto === pasto); }
const STATI = [["programma", "In programma"], ["dispensa", "Ho gli ingredienti"], ["fatto", "Fatto"]];
const statoLabel = (s) => (STATI.find(([k]) => k === (s || "programma")) || STATI[0])[1];

// STORICO "gemello" (stessa uid) di un pasto Fatto → Piano e Storico coincidono.
function syncTwin(e) {
  const r = RICETTE.find((x) => x.id === e.ricettaId);
  const body = { ricettaId: e.ricettaId, nome: r ? r.nome : "", data: e.data, pasto: e.pasto, presenti: (e.presenti || Object.keys(PROFILI)).slice(), ospiti: e.ospiti || 0 };
  const tw = STORICO.find((x) => x.uid === e.uid);
  if (tw) { Object.assign(tw, body); save(LS.storico, STORICO); if (SYNC.on && sync.enabled && tw.id) sync.patch("storico/" + tw.id, body); }
  else { const nw = { uid: e.uid, ...body, byDevice: DEVICE_ID, ts: tsFor(e.data), posted: false }; STORICO.push(nw); save(LS.storico, STORICO); if (SYNC.on && sync.enabled) postLog("storico", nw); }
}
function removeTwin(uid) {
  const tw = STORICO.find((x) => x.uid === uid); if (!tw) return;
  STORICO = STORICO.filter((x) => x.uid !== uid); save(LS.storico, STORICO);
  if (tw.id) deleteFromCloud("storico", tw.id);
}
function setPiano(data, pasto, ricettaId) {
  const prev = pianoSlot(data, pasto);
  const presenti = prev && Array.isArray(prev.presenti) ? prev.presenti : Object.keys(PROFILI);
  const ospiti = prev && prev.ospiti != null ? prev.ospiti : 0;
  for (const e of PIANO.filter((x) => x.data === data && x.pasto === pasto)) { if (e.stato === "fatto") removeTwin(e.uid); if (e.id) deleteFromCloud("piano", e.id); }
  PIANO = PIANO.filter((x) => !(x.data === data && x.pasto === pasto));
  const e = { uid: mkUid(DEVICE_ID), data, pasto, ricettaId, presenti, ospiti, stato: "programma", byDevice: DEVICE_ID, ts: Date.now(), posted: false };
  PIANO.push(e); save(LS.piano, PIANO);
  if (SYNC.on && sync.enabled) postLog("piano", e);
}
function updatePianoMeal(uid, patch) {
  const e = PIANO.find((x) => x.uid === uid); if (!e) return;
  Object.assign(e, patch); save(LS.piano, PIANO);
  if (SYNC.on && sync.enabled && e.id) sync.patch("piano/" + e.id, patch);
  if (e.stato === "fatto") syncTwin(e); // tieni allineato il gemello nello storico
}
function setPianoStato(uid, stato) {
  const e = PIANO.find((x) => x.uid === uid); if (!e) return;
  e.stato = stato; save(LS.piano, PIANO);
  if (SYNC.on && sync.enabled && e.id) sync.patch("piano/" + e.id, { stato });
  if (stato === "fatto") syncTwin(e); else removeTwin(uid);
  renderStorico();
}
function rimuoviPiano(uid) {
  const e = PIANO.find((x) => x.uid === uid);
  if (e && e.stato === "fatto") removeTwin(uid);
  PIANO = PIANO.filter((x) => x.uid !== uid); save(LS.piano, PIANO);
  if (e && e.id) deleteFromCloud("piano", e.id);
}
// registra un pasto "Fatto" da qualunque punto: finisce SIA nel Piano SIA nello Storico
function registraFatto({ ricettaId, data, pasto, presenti, ospiti }) {
  for (const e of PIANO.filter((x) => x.data === data && x.pasto === pasto)) { if (e.stato === "fatto") removeTwin(e.uid); if (e.id) deleteFromCloud("piano", e.id); }
  PIANO = PIANO.filter((x) => !(x.data === data && x.pasto === pasto));
  const e = { uid: mkUid(DEVICE_ID), data, pasto, ricettaId, presenti: (presenti || Object.keys(PROFILI)).slice(), ospiti: ospiti || 0, stato: "fatto", byDevice: DEVICE_ID, ts: Date.now(), posted: false };
  PIANO.push(e); save(LS.piano, PIANO);
  if (SYNC.on && sync.enabled) postLog("piano", e);
  syncTwin(e); // crea la voce gemella nello storico (stessa uid)
  return e;
}

function slotHTML(data, pasto) {
  const e = pianoSlot(data, pasto);
  const lbl = pasto === "pranzo" ? "☀️ Pranzo" : "🌙 Cena";
  if (e) {
    const r = RICETTE.find((x) => x.id === e.ricettaId);
    const osp = e.ospiti ? ` <span class="slot-osp">+${e.ospiti}👥</span>` : "";
    const badge = e.stato === "fatto" ? ` <span class="slot-badge">✅</span>` : e.stato === "dispensa" ? ` <span class="slot-badge">🧺</span>` : "";
    const cls = e.stato === "fatto" ? " done" : "";
    return `<button type="button" class="slot filled${cls}" data-voce="${esc(e.uid)}"><span class="slot-lbl">${lbl}</span><span class="slot-ric">${esc(r ? r.nome : "(rimossa)")}${badge}${osp}</span></button>`;
  }
  return `<button type="button" class="slot empty" data-slot="${data}|${pasto}"><span class="slot-lbl">${lbl}</span><span class="slot-add">＋</span></button>`;
}
function dayCardHTML(d) {
  const oggi = d === ymd();
  return `<div class="giorno-card${oggi ? " oggi" : ""}">
    <div class="giorno-h">${oggi ? "Oggi · " : ""}${esc(fmtLungo(d))}</div>
    <div class="slot-wrap">${slotHTML(d, "pranzo")}${slotHTML(d, "cena")}</div>
  </div>`;
}
function renderAgenda() {
  const start = ymd();
  let html = "";
  for (let i = 0; i < ui.agendaDays; i++) html += dayCardHTML(addDaysISO(start, i));
  return html + `<button type="button" class="btn-ghost small" data-agendamore style="margin-top:6px">＋ altri 7 giorni</button>`;
}
function renderSettimana() {
  const s = startWeekISO(ui.pianoCursor);
  let html = "";
  for (let i = 0; i < 7; i++) html += dayCardHTML(addDaysISO(s, i));
  return html;
}
function renderMese() {
  const cur = parseYMD(ui.pianoCursor);
  const y = cur.getFullYear(), m = cur.getMonth();
  const first = new Date(y, m, 1, 12);
  const startDow = (first.getDay() + 6) % 7;
  const gridStart = new Date(y, m, 1 - startDow, 12);
  const oggi = ymd();
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const dd = new Date(gridStart); dd.setDate(gridStart.getDate() + i);
    const s = ymd(dd), inM = dd.getMonth() === m;
    const cnt = new Set(PIANO.filter((x) => x.data === s).map((x) => x.pasto)).size;
    cells += `<button type="button" class="mcell${inM ? "" : " off"}${s === oggi ? " today" : ""}" data-day="${s}"><span class="mnum">${dd.getDate()}</span>${cnt ? `<span class="mdot">${cnt >= 2 ? "●●" : "●"}</span>` : ""}</button>`;
  }
  return `<div class="mgrid">${GIORNI_LUN.map((g) => `<div class="mhead">${g}</div>`).join("")}${cells}</div>`;
}
function renderPiano() {
  const box = $("#pianoBox"); if (!box) return;
  const view = ui.pianoView;
  let label = "", nav = "";
  if (view === "agenda") { label = "Prossimi giorni"; }
  else if (view === "settimana") { const s = startWeekISO(ui.pianoCursor); label = `${fmtBreve(s)} – ${fmtBreve(addDaysISO(s, 6))}`; nav = `<button type="button" class="icon-btn" data-pianonav="prev">‹</button><button type="button" class="icon-btn" data-pianonav="next">›</button>`; }
  else { label = `${MESI[parseYMD(ui.pianoCursor).getMonth()]} ${parseYMD(ui.pianoCursor).getFullYear()}`; nav = `<button type="button" class="icon-btn" data-pianonav="prev">‹</button><button type="button" class="icon-btn" data-pianonav="next">›</button>`; }
  const seg = [["agenda", "Agenda"], ["settimana", "Settimana"], ["mese", "Mese"]].map(([v, t]) => `<button type="button" class="segbtn${view === v ? " on" : ""}" data-pianoview="${v}">${t}</button>`).join("");
  const body = view === "agenda" ? renderAgenda() : view === "settimana" ? renderSettimana() : renderMese();
  box.innerHTML = `
    <div class="segmented">${seg}</div>
    <div class="piano-nav">
      <button type="button" class="btn-ghost small" data-pianotoday>Oggi</button>
      <span class="piano-label">${esc(label)}</span>
      <span class="piano-arrows">${nav}</span>
    </div>
    <div class="piano-body ${view}">${body}</div>
    <button type="button" class="btn-primary" data-spesa style="margin-top:14px">🛒 Lista della spesa</button>`;
}

// --- modali del piano ---
function apriSlotPicker(data, pasto) {
  modalCtx = { kind: "slot", data, pasto, q: "" };
  openModal(slotPickerHTML());
}
function slotListHTML() {
  const nq = norm(modalCtx.q || "");
  let list = RICETTE.map(normalizeRicetta);
  if (nq) list = list.filter((r) => norm(r.nome).includes(nq) || r.ingredienti.some((i) => norm(i.nome).includes(nq)));
  list.sort((a, b) => a.nome.localeCompare(b.nome, "it"));
  if (!list.length) return `<div class="empty">Nessuna ricetta</div>`;
  return list.slice(0, 250).map((r) => `
    <button type="button" class="riga" data-pickric="${esc(r.id)}">
      <div class="r-main"><div class="r-title">${esc(r.nome)}</div>
      <div class="r-sub">${esc(PORTATA_NOME[r.portata] || r.portata)}${r.tempoMin ? " · " + r.tempoMin + " min" : ""}${r.adattoBimbi ? " · 🍼" : ""}</div></div>
    </button>`).join("");
}
function slotPickerHTML() {
  return `
    <h2 class="q">${modalCtx.pasto === "pranzo" ? "☀️ Pranzo" : "🌙 Cena"} · ${esc(fmtLungo(modalCtx.data))}</h2>
    <div class="ing-input">
      <input id="slotSearch" type="search" placeholder="Cerca una ricetta…" value="${esc(modalCtx.q || "")}" />
      <button type="button" class="btn-mini" data-proponi-slot title="Proponi un'idea">🎲</button>
    </div>
    <div id="slotList" class="lista" style="margin-top:10px;max-height:52vh;overflow:auto">${slotListHTML()}</div>
    <div class="cta-row"><button type="button" class="btn-ghost" data-modal-close>Chiudi</button></div>`;
}
function proponiPerSlot() {
  const pianoEv = PIANO.map((p) => ({ ricettaId: p.ricettaId, data: p.data }));
  const res = proponi({ ricette: RICETTE, storico: STORICO.concat(pianoEv), profili: PROFILI, presenti: ui.presenti, nrPasti: 1, portate: [], oggi: modalCtx.data, seed: Math.floor(Math.random() * 100000) });
  if (!res.proposte.length) { toast("Nessuna idea adatta 🤔"); return; }
  const r = res.proposte[0];
  setPiano(modalCtx.data, modalCtx.pasto, r.id);
  closeModal(); renderPiano(); toast(`Pianificato: ${r.nome}`);
}
function voceHTML(uid) {
  const e = PIANO.find((x) => x.uid === uid); if (!e) return "";
  const r = RICETTE.find((x) => x.id === e.ricettaId);
  const presSet = new Set(Array.isArray(e.presenti) ? e.presenti : Object.keys(PROFILI));
  const chips = Object.entries(PROFILI).map(([k, p]) => `<button type="button" class="chip ${presSet.has(k) ? "on" : ""}" data-vp="${esc(k)}">${p.bimbo ? "🍼 " : ""}${esc(p.nome)}</button>`).join("");
  const comm = commensaliDi({ presenti: [...presSet], ospiti: e.ospiti || 0 });
  let ingHtml = "";
  if (r) {
    const nr = normalizeRicetta(r);
    const f = comm / (nr.porzioni || PORZIONI_BASE);
    const ing = senzaDispensa(scalaIngredienti(nr.ingredienti, f));
    ingHtml = `<div class="sez-tit">Ingredienti (per ${comm})</div><ul class="ingredienti">${ing.map(fmtIngrediente).join("")}</ul>
      <div class="sez-tit">Preparazione</div><ol class="passaggi">${(nr.passaggi || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`;
  }
  const statoChips = STATI.map(([k, l]) => `<button type="button" class="chip ${(e.stato || "programma") === k ? "on" : ""}" data-statopiano="${k}">${l}</button>`).join("");
  return `
    <h2 class="q">${e.pasto === "pranzo" ? "☀️ Pranzo" : "🌙 Cena"} · ${esc(fmtLungo(e.data))}</h2>
    <p class="hint">🍽️ ${esc(r ? r.nome : "(ricetta rimossa)")}</p>
    <label class="lbl">Stato</label>
    <div class="chips" id="statoChips">${statoChips}</div>
    <label class="lbl">Chi c'è</label>
    <div class="chips" id="vpChips">${chips}</div>
    <div class="ospiti-row"><span class="ospiti-lbl">👥 + Ospiti</span>
      <div class="stepper"><button type="button" class="step" data-vosp="-1">−</button><span class="step-val">${e.ospiti || 0}</span><button type="button" class="step" data-vosp="1">+</button></div>
      <span class="hint" style="margin-left:auto">Commensali: <b>${comm}</b></span></div>
    ${ingHtml}
    <div class="cta-row" style="flex-wrap:wrap">
      <button type="button" class="btn-ghost" data-voce-cambia>🔄 Cambia ricetta</button>
      <button type="button" class="btn-ghost danger" data-voce-rimuovi>🗑️ Rimuovi</button>
    </div>
    <div class="cta-row"><button type="button" class="btn-ghost" data-modal-close>Chiudi</button></div>`;
}
function apriPianoVoce(uid) {
  const e = PIANO.find((x) => x.uid === uid); if (!e) return;
  modalCtx = { kind: "voce", uid, data: e.data, pasto: e.pasto };
  openModal(voceHTML(uid));
}
function apriGiorno(data) {
  modalCtx = { kind: "giorno", data };
  openModal(`
    <h2 class="q">${esc(fmtLungo(data))}</h2>
    <div class="slot-wrap">${slotHTML(data, "pranzo")}${slotHTML(data, "cena")}</div>
    <div class="cta-row"><button type="button" class="btn-ghost" data-modal-close>Chiudi</button></div>`);
}
function apriSpesa() {
  modalCtx = { kind: "spesa" };
  openModal(spesaHTML());
}
function spesaHTML() {
  const items = listaSpesa({ piano: PIANO, ricette: RICETTE, dispensa: DISPENSA, oggi: new Date() });
  if (!items.length) return `<h2 class="q">🛒 Lista della spesa</h2><div class="empty">Nessun pasto pianificato da oggi in poi.<br>Aggiungi pasti nel Piano.</div><div class="cta-row"><button type="button" class="btn-ghost" data-modal-close>Chiudi</button></div>`;
  const checked = new Set(load(LS.spesaCheck, []));
  let cur = null;
  const rows = items.map((it) => {
    let head = "";
    if (it.reparto !== cur) { cur = it.reparto; head = `<div class="reparto-h">${esc(cur)}</div>`; }
    const k = norm(it.nome); const on = checked.has(k);
    return head + `<label class="spesa-row${on ? " done" : ""}"><input type="checkbox" data-spesacheck="${esc(k)}" ${on ? "checked" : ""}/><span class="sp-nome">${esc(it.nome)}</span><span class="sp-q">${esc(it.quantita)}</span></label>`;
  }).join("");
  return `
    <h2 class="q">🛒 Lista della spesa <small>(${items.length})</small></h2>
    <p class="hint">Da tutti i pasti pianificati da oggi in poi. Dispensa esclusa.</p>
    <div class="lista">${rows}</div>
    <div class="cta-row" style="flex-wrap:wrap">
      <button type="button" class="btn-ghost small" data-spesa-copia>📋 Copia</button>
      <button type="button" class="btn-ghost small" data-spesa-reset>↺ Azzera spunte</button>
      <button type="button" class="btn-ghost small" data-modal-close>Chiudi</button>
    </div>`;
}

function regolaTesto(r) { return typeof r === "string" ? r : (r && r.testo) || ""; }
function renderRegole() {
  const box = $("#regoleList");
  if (!REGOLE.length) { box.innerHTML = `<div class="empty">Ancora nessuna regola.</div>`; return; }
  box.innerHTML = REGOLE.map((r, i) => `
    <div class="riga">
      <div class="r-main"><div class="r-sub">📏 ${esc(regolaTesto(r))}</div></div>
      <button class="icon-btn" data-delregola="${i}">🗑️</button>
    </div>`).join("");
}
function renderImpostazioni() {
  renderProfili(); renderDispensa(); renderRegole();
  $("#syncUrl").value = SYNC.url || "";
  $("#syncCode").value = SYNC.code || "";
  $("#syncOn").checked = !!SYNC.on;
  $("#modello").value = CONFIG.modelloPreferito || "claude-opus-5";
  $("#appVer").textContent = APP_VERSION;
  setDot(SYNC.on ? sync._status : "off");
}

// ---------------------------------------------------------------------------
// Render orchestration
// ---------------------------------------------------------------------------
function renderAll() {
  renderPresenti(); renderPortate(); renderNr(); renderOspiti(); renderIngChips();
  renderRicettario(); renderCoda(); renderStorico(); renderInsegnaForm(); renderImpostazioni(); renderPiano();
}
// come renderAll ma non ridisegna se l'utente sta scrivendo in un campo (non ruba il focus)
function renderAllSafe() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  renderAll();
}
function renderIfVisible(screens) { if (screens.includes(ui.screen)) { if (ui.screen === "ricettario") renderRicettario(); if (ui.screen === "storico") renderStorico(); if (ui.screen === "insegna") renderCoda(); if (ui.screen === "piano") renderPiano(); if (ui.screen === "home") { renderPresenti(); } } }

function setScreen(name) {
  ui.screen = name;
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.screen === name));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
// ---- Registra / modifica un PASTO nello storico (data, pasto, chi) ----
function pastoFormHTML(o) {
  const presSet = new Set(o.presenti || []);
  const presChips = Object.entries(PROFILI).map(([k, p]) =>
    `<button type="button" class="chip ${presSet.has(k) ? "on" : ""}" data-mp="${esc(k)}">${p.bimbo ? "🍼 " : ""}${esc(p.nome)}</button>`).join("");
  return `
    <h2 class="q">${esc(o.titolo)}</h2>
    ${o.ricettaNome ? `<p class="hint">🍽️ ${esc(o.ricettaNome)}</p>` : ""}
    <label class="lbl">Quando</label>
    <input type="date" id="mpData" value="${esc(o.data)}" max="${todayISO()}">
    <label class="lbl">Pasto</label>
    <div class="chips" id="mpPasto">
      <button type="button" class="chip ${o.pasto === "pranzo" ? "on" : ""}" data-pasto="pranzo">☀️ Pranzo</button>
      <button type="button" class="chip ${o.pasto === "cena" ? "on" : ""}" data-pasto="cena">🌙 Cena</button>
    </div>
    <label class="lbl">Chi l'ha mangiata</label>
    <div class="chips" id="mpPresenti">${presChips}</div>
    <div class="ospiti-row"><span class="ospiti-lbl">👥 + Ospiti</span>
      <div class="stepper"><button type="button" class="step" data-mposp="-1">−</button><span class="step-val" id="mpOspVal">${o.ospiti || 0}</span><button type="button" class="step" data-mposp="1">+</button></div></div>
    <div class="cta-row">
      <button type="button" class="btn-ghost" data-modal-close>Annulla</button>
      <button type="button" class="btn-primary" id="mpSalva">Salva</button>
    </div>`;
}
function apriRegistraPasto(ricettaId) {
  const r = RICETTE.find((x) => x.id === ricettaId);
  const now = new Date();
  modalCtx = { kind: "pasto", mode: "new", ricettaId, ospiti: ui.ospiti || 0 };
  openModal(pastoFormHTML({ titolo: "L'abbiamo fatto!", ricettaNome: r ? r.nome : "", data: todayISO(), pasto: now.getHours() < 16 ? "pranzo" : "cena", presenti: ui.presenti.slice(), ospiti: modalCtx.ospiti }));
}
function apriModificaPasto(uid) {
  const e = STORICO.find((x) => x.uid === uid);
  if (!e) return;
  modalCtx = { kind: "pasto", mode: "edit", uid, ospiti: e.ospiti || 0 };
  openModal(pastoFormHTML({ titolo: "Modifica pasto", ricettaNome: nomeRicetta(e.ricettaId), data: e.data || todayISO(), pasto: e.pasto || "pranzo", presenti: (e.presenti || []).slice(), ospiti: modalCtx.ospiti }));
}
function salvaPasto() {
  const data = $("#mpData").value || todayISO();
  const pb = $("#mpPasto .chip.on"); const pasto = pb ? pb.dataset.pasto : "pranzo";
  const presenti = $$("#mpPresenti .chip.on").map((c) => c.dataset.mp);
  const tsFor = (d) => { const t = new Date(d + "T12:00:00").getTime(); return isNaN(t) ? Date.now() : t; };
  if (modalCtx.mode === "new") {
    registraFatto({ ricettaId: modalCtx.ricettaId, data, pasto, presenti, ospiti: modalCtx.ospiti || 0 });
    ui.proposte = ui.proposte.filter((p) => p.id !== modalCtx.ricettaId);
    toast("Segnato! È nello Storico e nel Piano 👌");
  } else {
    const e = STORICO.find((x) => x.uid === modalCtx.uid);
    if (e) {
      e.data = data; e.pasto = pasto; e.presenti = presenti; e.ospiti = modalCtx.ospiti || 0; e.ts = tsFor(data);
      save(LS.storico, STORICO);
      if (SYNC.on && sync.enabled && e.id) sync.patch("storico/" + e.id, { data, pasto, presenti, ospiti: e.ospiti, ts: e.ts });
      // se è il gemello di un pasto del Piano, allinealo
      const pe = PIANO.find((x) => x.uid === modalCtx.uid);
      if (pe) { Object.assign(pe, { data, pasto, presenti, ospiti: modalCtx.ospiti || 0 }); save(LS.piano, PIANO); if (SYNC.on && sync.enabled && pe.id) sync.patch("piano/" + pe.id, { data, pasto, presenti, ospiti: pe.ospiti }); }
    }
    toast("Pasto aggiornato ✓");
  }
  closeModal(); renderProposte(); renderStorico(); renderPiano();
}

// ---- Modifica una RICETTA (ingredienti / preparazione / dettagli) ----
function ricettaFormHTML(d) {
  const ing = (d.ingredienti || []).map((i, idx) => `
    <div class="ed-row" data-i="${idx}">
      <input class="grow" data-f="nome" value="${esc(i.nome || "")}" placeholder="ingrediente">
      <input class="q-in" data-f="q" value="${i.q ?? ""}" placeholder="q">
      <input class="u-in" data-f="unita" value="${esc(i.unita || "")}" placeholder="unità">
      <button type="button" class="icon-btn" data-rming="${idx}">🗑️</button>
    </div>`).join("");
  const steps = (d.passaggi || []).map((p, idx) => `
    <div class="ed-row" data-i="${idx}">
      <textarea data-sf="${idx}" rows="2">${esc(p)}</textarea>
      <button type="button" class="icon-btn" data-rmstep="${idx}">🗑️</button>
    </div>`).join("");
  const portOpts = PORTATE.map((p) => `<option value="${p}" ${d.portata === p ? "selected" : ""}>${esc(PORTATA_NOME[p])}</option>`).join("");
  const diffOpts = ["facile", "media", "difficile"].map((x) => `<option value="${x}" ${d.difficolta === x ? "selected" : ""}>${x}</option>`).join("");
  return `
    <h2 class="q">Modifica ricetta</h2>
    <label class="lbl">Nome</label>
    <input id="rNome" value="${esc(d.nome || "")}">
    <div class="row2">
      <div class="grow"><label class="lbl">Portata</label><select id="rPortata">${portOpts}</select></div>
      <div class="grow"><label class="lbl">Difficoltà</label><select id="rDiff">${diffOpts}</select></div>
    </div>
    <div class="row2">
      <div class="grow"><label class="lbl">Tempo (min)</label><input id="rTempo" type="number" value="${d.tempoMin ?? ""}"></div>
      <div class="grow"><label class="lbl">Bimbi</label><label class="switch"><input type="checkbox" id="rBimbi" ${d.adattoBimbi ? "checked" : ""}> adatto</label></div>
    </div>
    <label class="lbl">Ingredienti</label>
    <div id="rIng">${ing}</div>
    <button type="button" class="btn-ghost small add-line" data-adding>＋ ingrediente</button>
    <label class="lbl">Preparazione</label>
    <div id="rSteps">${steps}</div>
    <button type="button" class="btn-ghost small add-line" data-addstep>＋ passaggio</button>
    <label class="lbl">Tag (virgola)</label>
    <input id="rTag" value="${esc((d.tag || []).join(", "))}">
    <label class="lbl">Stagioni (inverno, primavera, estate, autunno)</label>
    <input id="rStag" value="${esc((d.stagioni || []).join(", "))}">
    <div class="cta-row">
      <button type="button" class="btn-ghost" data-modal-close>Annulla</button>
      <button type="button" class="btn-primary" id="rSalva">Salva</button>
    </div>`;
}
function apriModificaRicetta(id) {
  const r = RICETTE.find((x) => x.id === id);
  if (!r) return;
  modalCtx = { kind: "ricetta", id, draft: normalizeRicetta(JSON.parse(JSON.stringify(r))) };
  openModal(ricettaFormHTML(modalCtx.draft));
}
function syncDraftFromDOM() {
  const d = modalCtx.draft;
  d.nome = $("#rNome").value.trim();
  d.portata = $("#rPortata").value;
  d.difficolta = $("#rDiff").value;
  const t = parseInt($("#rTempo").value, 10); d.tempoMin = isNaN(t) ? null : t;
  d.adattoBimbi = $("#rBimbi").checked;
  d.tag = $("#rTag").value.split(",").map((s) => s.trim()).filter(Boolean);
  d.stagioni = $("#rStag").value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  d.ingredienti = $$("#rIng .ed-row").map((row) => {
    const g = (f) => row.querySelector(`[data-f="${f}"]`);
    const q = g("q").value.trim();
    return { nome: g("nome").value.trim(), q: q === "" ? null : (isNaN(+q) ? q : +q), unita: g("unita").value.trim(), opzionale: false };
  }).filter((i) => i.nome);
  d.passaggi = $$("#rSteps textarea").map((t) => t.value.trim()).filter(Boolean);
}
function salvaRicetta() {
  syncDraftFromDOM();
  const d = modalCtx.draft;
  if (!d.nome) { toast("Serve almeno il nome"); return; }
  const i = RICETTE.findIndex((x) => x.id === modalCtx.id);
  if (i >= 0) { RICETTE[i] = { ...RICETTE[i], ...d }; save(LS.ricette, RICETTE);
    if (SYNC.on && sync.enabled) { const { id, ...rest } = RICETTE[i]; sync.put("ricette/" + id, rest); } }
  closeModal(); renderRicettario(); toast("Ricetta aggiornata ✓");
}

function rimuoviRicetta(id) {
  const r = RICETTE.find((x) => x.id === id);
  if (!r) return;
  if (!confirm(`Rimuovere "${r.nome}" dal ricettario di famiglia?\nVale per tutti (viene tolta anche dal database condiviso).`)) return;
  RICETTE = RICETTE.filter((x) => x.id !== id);
  save(LS.ricette, RICETTE);
  deleteFromCloud("ricette", id); // così il sync non la ripristina
  ui.proposte = ui.proposte.filter((p) => p.id !== id);
  renderRicettario(); renderProposte();
  toast(`"${r.nome}" rimossa dal ricettario`);
}

function aggiungiOsservazione() {
  const testo = $("#obsTesto").value.trim();
  if (!testo) { toast("Scrivi qualcosa prima 🙂"); return; }
  const e = { uid: mkUid(DEVICE_ID), tipo: ui.obsTipo, testo, stato: "pending", byDevice: DEVICE_ID, ts: Date.now(), posted: false };
  CODA.push(e); save(LS.coda, CODA);
  if (SYNC.on && sync.enabled) postLog("coda", e);
  $("#obsTesto").value = "";
  renderCoda();
  toast("Aggiunto! Lancia /che-te-voi-magna quando vuoi 👨‍🍳");
}

function comandoRigenera() {
  return "In Claude Code, nel repo di 'Che te voi magnà?', lancia: /che-te-voi-magna";
}

// export/import
function doExport() {
  const data = { app: "che-te-voi-magna", version: APP_VERSION, ts: Date.now(),
    config: CONFIG, profili: PROFILI, dispensa: DISPENSA, regole: REGOLE, ricette: RICETTE, storico: STORICO, coda: CODA };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `che-te-voi-magna-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
}
function doImport(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (d.config) { CONFIG = { ...defaultConfig(), ...d.config }; save(LS.config, CONFIG); }
      if (d.profili) { PROFILI = d.profili; save(LS.profili, PROFILI); }
      if (Array.isArray(d.dispensa)) { DISPENSA = d.dispensa; save(LS.dispensa, DISPENSA); }
      if (Array.isArray(d.regole)) { REGOLE = d.regole; save(LS.regole, REGOLE); }
      if (Array.isArray(d.ricette)) { RICETTE = d.ricette; save(LS.ricette, RICETTE); }
      if (Array.isArray(d.storico)) { STORICO = d.storico; save(LS.storico, STORICO); }
      if (Array.isArray(d.coda)) { CODA = d.coda; save(LS.coda, CODA); }
      ui.presenti = Object.keys(PROFILI);
      renderAll(); toast("Importato ✓");
      if (SYNC.on) reconcile();
    } catch { toast("File non valido ✗"); }
  };
  r.readAsText(file);
}
async function ensureRicette() {
  if (RICETTE.length) return;
  try {
    const j = await (await fetch("./data/ricette.seed.json", { cache: "no-store" })).json();
    RICETTE = j.ricette || []; save(LS.ricette, RICETTE);
  } catch {}
}

// ---------------------------------------------------------------------------
// Event wiring (delega dove possibile)
// ---------------------------------------------------------------------------
function wire() {
  // navigazione
  $$(".tab").forEach((t) => t.addEventListener("click", () => setScreen(t.dataset.screen)));

  // HOME: presenti / portate / nr / ingredienti
  $("#presentiChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pres]"); if (!b) return;
    const k = b.dataset.pres;
    if (ui.presenti.includes(k)) ui.presenti = ui.presenti.filter((x) => x !== k); else ui.presenti.push(k);
    if (!ui.presenti.length) ui.presenti.push(k); // almeno uno
    saveUI(); renderPresenti();
  });
  $("#portateChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-port]"); if (!b) return;
    const p = b.dataset.port;
    if (ui.portate.includes(p)) ui.portate = ui.portate.filter((x) => x !== p); else ui.portate.push(p);
    saveUI(); renderPortate();
  });
  $("#nrMeno").addEventListener("click", () => { ui.nrPasti = Math.max(1, ui.nrPasti - 1); saveUI(); renderNr(); });
  $("#nrPiu").addEventListener("click", () => { ui.nrPasti = Math.min(12, ui.nrPasti + 1); saveUI(); renderNr(); });
  $("#ospMeno").addEventListener("click", () => { ui.ospiti = Math.max(0, ui.ospiti - 1); saveUI(); renderOspiti(); renderProposte(); });
  $("#ospPiu").addEventListener("click", () => { ui.ospiti = Math.min(20, ui.ospiti + 1); saveUI(); renderOspiti(); renderProposte(); });
  const addIng = () => { const v = $("#ingInput").value.trim(); if (!v) return; ui.ingredienti.push(v); $("#ingInput").value = ""; saveUI(); renderIngChips(); };
  $("#ingAdd").addEventListener("click", addIng);
  $("#ingInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addIng(); } });
  $("#ingChips").addEventListener("click", (e) => { const c = e.target.closest("[data-ing]"); if (!c) return; ui.ingredienti.splice(+c.dataset.ing, 1); saveUI(); renderIngChips(); });
  $("#proponiBtn").addEventListener("click", () => doProponi(false));
  $("#rimescolaBtn").addEventListener("click", () => doProponi(true));
  $("#proposte").addEventListener("click", (e) => { const b = e.target.closest("[data-fatto]"); if (b) apriRegistraPasto(b.dataset.fatto); });

  // RICETTARIO
  $("#cercaRic").addEventListener("input", (e) => { ui.cerca = e.target.value; renderRicettario(); });
  $("#filtriPortata").addEventListener("click", (e) => { const b = e.target.closest("[data-filtro]"); if (!b) return; ui.filtroPortata = b.dataset.filtro; renderRicettario(); });
  $("#listaRicette").addEventListener("click", (e) => {
    const b = e.target.closest("[data-apri]") || e.target.closest("[data-ricetta]"); if (!b) return;
    const id = b.dataset.apri || b.dataset.ricetta;
    const det = $("#det-" + CSS.escape(id)); if (!det) return;
    if (det.hidden) { const r = RICETTE.find((x) => x.id === id); det.innerHTML = ricettaCardHTML(normalizeRicetta(r), { actions: true, edit: true, remove: true }); det.hidden = false; }
    else det.hidden = true;
  });
  $("#listaRicette").addEventListener("click", (e) => { const b = e.target.closest("[data-fatto]"); if (b) apriRegistraPasto(b.dataset.fatto); });
  $("#listaRicette").addEventListener("click", (e) => { const b = e.target.closest("[data-rimuovi]"); if (b) rimuoviRicetta(b.dataset.rimuovi); });
  $("#listaRicette").addEventListener("click", (e) => { const b = e.target.closest("[data-modifica]"); if (b) apriModificaRicetta(b.dataset.modifica); });

  // INSEGNA
  $("#obsTipo").addEventListener("change", (e) => { ui.obsTipo = e.target.value; saveUI(); renderInsegnaForm(); });
  $("#obsAdd").addEventListener("click", aggiungiOsservazione);
  $("#copiaComando").addEventListener("click", async () => { try { await navigator.clipboard.writeText(comandoRigenera()); toast("Comando copiato 📋"); } catch { toast(comandoRigenera()); } });
  $("#listaCoda").addEventListener("click", (e) => {
    const b = e.target.closest("[data-delobs]"); if (!b) return;
    const uid = b.dataset.delobs; const c = CODA.find((x) => x.uid === uid);
    CODA = CODA.filter((x) => x.uid !== uid); save(LS.coda, CODA);
    if (c && c.id) deleteFromCloud("coda", c.id); renderCoda();
  });

  // STORICO
  $("#listaStorico").addEventListener("click", (e) => { const b = e.target.closest("[data-editstorico]"); if (b) apriModificaPasto(b.dataset.editstorico); });
  $("#listaStorico").addEventListener("click", (e) => {
    const b = e.target.closest("[data-delstorico]"); if (!b) return;
    const uid = b.dataset.delstorico; const ev = STORICO.find((x) => x.uid === uid);
    STORICO = STORICO.filter((x) => x.uid !== uid); save(LS.storico, STORICO);
    if (ev && ev.id) deleteFromCloud("storico", ev.id);
    // il "fatto" è un'unica voce: eliminandolo dallo Storico sparisce anche dal Piano
    const pe = PIANO.find((x) => x.uid === uid);
    if (pe) { PIANO = PIANO.filter((x) => x.uid !== uid); save(LS.piano, PIANO); if (pe.id) deleteFromCloud("piano", pe.id); renderPiano(); }
    renderStorico(); renderProposte();
  });

  // PIANO
  $("#pianoBox").addEventListener("click", (e) => {
    const v = e.target.closest("[data-pianoview]"); if (v) { ui.pianoView = v.dataset.pianoview; renderPiano(); return; }
    const nav = e.target.closest("[data-pianonav]"); if (nav) { const dir = nav.dataset.pianonav === "next" ? 1 : -1; ui.pianoCursor = ui.pianoView === "mese" ? addMonthsISO(ui.pianoCursor, dir) : addDaysISO(ui.pianoCursor, dir * 7); renderPiano(); return; }
    if (e.target.closest("[data-pianotoday]")) { ui.pianoCursor = ymd(); if (ui.pianoView === "agenda") ui.agendaDays = 14; renderPiano(); return; }
    if (e.target.closest("[data-agendamore]")) { ui.agendaDays += 7; renderPiano(); return; }
    const slot = e.target.closest("[data-slot]"); if (slot) { const [d, p] = slot.dataset.slot.split("|"); apriSlotPicker(d, p); return; }
    const voce = e.target.closest("[data-voce]"); if (voce) { apriPianoVoce(voce.dataset.voce); return; }
    const day = e.target.closest("[data-day]"); if (day) { apriGiorno(day.dataset.day); return; }
    if (e.target.closest("[data-spesa]")) { apriSpesa(); return; }
  });

  // IMPOSTAZIONI: profili
  const pe = $("#profiliEditor");
  pe.addEventListener("input", (e) => {
    const t = e.target;
    const k = t.dataset.pnome || t.dataset.palle || t.dataset.pgusti; if (!k || !PROFILI[k]) return;
    if (t.dataset.pnome) PROFILI[k].nome = t.value;
    if (t.dataset.palle) PROFILI[k].allergie = t.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (t.dataset.pgusti) PROFILI[k].nonGraditi = t.value.split(",").map((s) => s.trim()).filter(Boolean);
    save(LS.profili, PROFILI); pushDoc("profili", PROFILI);
  });
  pe.addEventListener("change", (e) => {
    const t = e.target; if (t.dataset.pbimbo) { PROFILI[t.dataset.pbimbo].bimbo = t.checked; save(LS.profili, PROFILI); pushDoc("profili", PROFILI); }
  });
  pe.addEventListener("click", (e) => {
    const b = e.target.closest("[data-delprof]"); if (!b) return;
    const k = b.dataset.delprof; if (Object.keys(PROFILI).length <= 1) { toast("Serve almeno una persona"); return; }
    delete PROFILI[k]; ui.presenti = ui.presenti.filter((x) => x !== k); if (!ui.presenti.length) ui.presenti = Object.keys(PROFILI);
    save(LS.profili, PROFILI); pushDoc("profili", PROFILI); renderProfili(); renderPresenti();
  });
  $("#addProfilo").addEventListener("click", () => {
    const k = "p" + Date.now().toString(36);
    PROFILI[k] = { nome: "Nuovo", bimbo: false, nonGraditi: [], allergie: [] };
    save(LS.profili, PROFILI); pushDoc("profili", PROFILI); renderProfili(); renderPresenti();
  });

  // IMPOSTAZIONI: dispensa
  const addDisp = () => { const v = $("#dispInput").value.trim(); if (!v) return; DISPENSA.push(v); $("#dispInput").value = ""; save(LS.dispensa, DISPENSA); pushDoc("dispensa", DISPENSA); renderDispensa(); };
  $("#dispAdd").addEventListener("click", addDisp);
  $("#dispInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addDisp(); } });
  $("#dispChips").addEventListener("click", (e) => { const c = e.target.closest("[data-disp]"); if (!c) return; DISPENSA.splice(+c.dataset.disp, 1); save(LS.dispensa, DISPENSA); pushDoc("dispensa", DISPENSA); renderDispensa(); });

  // IMPOSTAZIONI: regole
  const addRegola = () => { const v = $("#regolaInput").value.trim(); if (!v) return; REGOLE.push(v); $("#regolaInput").value = ""; save(LS.regole, REGOLE); pushDoc("regole", REGOLE); renderRegole(); toast("Regola aggiunta ✓"); };
  $("#regolaAdd").addEventListener("click", addRegola);
  $("#regolaInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addRegola(); } });
  $("#regoleList").addEventListener("click", (e) => { const b = e.target.closest("[data-delregola]"); if (!b) return; REGOLE.splice(+b.dataset.delregola, 1); save(LS.regole, REGOLE); pushDoc("regole", REGOLE); renderRegole(); });

  // IMPOSTAZIONI: sync + modello
  const applySync = () => {
    SYNC = { url: $("#syncUrl").value.trim(), code: $("#syncCode").value.trim(), on: $("#syncOn").checked };
    save(LS.sync, SYNC); stopSync(); startSync();
  };
  $("#syncUrl").addEventListener("change", applySync);
  $("#syncCode").addEventListener("change", applySync);
  $("#syncOn").addEventListener("change", applySync);
  $("#modello").addEventListener("change", (e) => { CONFIG.modelloPreferito = e.target.value; save(LS.config, CONFIG); pushDoc("config", CONFIG); });

  // IMPOSTAZIONI: dati
  $("#exportBtn").addEventListener("click", doExport);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ""; });

  // MODALE (delega unica per pasto + editor ricetta)
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") { closeModal(); return; }                 // click sullo sfondo
    if (e.target.closest("[data-modal-close]")) { closeModal(); return; }
    // form PASTO
    const pasto = e.target.closest("[data-pasto]");
    if (pasto) { $$("#mpPasto .chip").forEach((c) => c.classList.remove("on")); pasto.classList.add("on"); return; }
    const mp = e.target.closest("[data-mp]"); if (mp) { mp.classList.toggle("on"); return; }
    const mposp = e.target.closest("[data-mposp]"); if (mposp) { modalCtx.ospiti = Math.max(0, (modalCtx.ospiti || 0) + Number(mposp.dataset.mposp)); const el = $("#mpOspVal"); if (el) el.textContent = modalCtx.ospiti; return; }
    if (e.target.closest("#mpSalva")) { salvaPasto(); return; }
    // form RICETTA
    if (e.target.closest("[data-adding]")) { syncDraftFromDOM(); modalCtx.draft.ingredienti.push({ nome: "", q: null, unita: "", opzionale: false }); openModal(ricettaFormHTML(modalCtx.draft)); return; }
    const rming = e.target.closest("[data-rming]"); if (rming) { syncDraftFromDOM(); modalCtx.draft.ingredienti.splice(+rming.dataset.rming, 1); openModal(ricettaFormHTML(modalCtx.draft)); return; }
    if (e.target.closest("[data-addstep]")) { syncDraftFromDOM(); modalCtx.draft.passaggi.push(""); openModal(ricettaFormHTML(modalCtx.draft)); return; }
    const rmstep = e.target.closest("[data-rmstep]"); if (rmstep) { syncDraftFromDOM(); modalCtx.draft.passaggi.splice(+rmstep.dataset.rmstep, 1); openModal(ricettaFormHTML(modalCtx.draft)); return; }
    if (e.target.closest("#rSalva")) { salvaRicetta(); return; }
    // PIANO — dentro le modali
    const slot = e.target.closest("[data-slot]"); if (slot) { const [d, p] = slot.dataset.slot.split("|"); apriSlotPicker(d, p); return; }
    const voce = e.target.closest("[data-voce]"); if (voce) { apriPianoVoce(voce.dataset.voce); return; }
    const pick = e.target.closest("[data-pickric]"); if (pick) { setPiano(modalCtx.data, modalCtx.pasto, pick.dataset.pickric); closeModal(); renderPiano(); toast("Pianificato ✓"); return; }
    if (e.target.closest("[data-proponi-slot]")) { proponiPerSlot(); return; }
    const vp = e.target.closest("[data-vp]"); if (vp) { const en = PIANO.find((x) => x.uid === modalCtx.uid); if (en) { const set = new Set(Array.isArray(en.presenti) ? en.presenti : Object.keys(PROFILI)); const k = vp.dataset.vp; set.has(k) ? set.delete(k) : set.add(k); updatePianoMeal(modalCtx.uid, { presenti: [...set] }); openModal(voceHTML(modalCtx.uid)); renderPiano(); } return; }
    const vo = e.target.closest("[data-vosp]"); if (vo) { const en = PIANO.find((x) => x.uid === modalCtx.uid); if (en) { updatePianoMeal(modalCtx.uid, { ospiti: Math.max(0, (en.ospiti || 0) + Number(vo.dataset.vosp)) }); openModal(voceHTML(modalCtx.uid)); renderPiano(); } return; }
    const sp = e.target.closest("[data-statopiano]"); if (sp) { setPianoStato(modalCtx.uid, sp.dataset.statopiano); openModal(voceHTML(modalCtx.uid)); renderPiano(); toast("Stato: " + statoLabel(sp.dataset.statopiano)); return; }
    if (e.target.closest("[data-voce-cambia]")) { apriSlotPicker(modalCtx.data, modalCtx.pasto); return; }
    if (e.target.closest("[data-voce-rimuovi]")) { rimuoviPiano(modalCtx.uid); closeModal(); renderPiano(); return; }
    if (e.target.closest("[data-spesa-copia]")) {
      const its = listaSpesa({ piano: PIANO, ricette: RICETTE, dispensa: DISPENSA, oggi: new Date(), porzioniBase: PORZIONI_BASE });
      let cur = null; const lines = [];
      for (const i of its) { if (i.reparto !== cur) { cur = i.reparto; lines.push(`\n${cur.toUpperCase()}`); } lines.push(`- ${i.nome}: ${i.quantita}`); }
      const txt = lines.join("\n").trim();
      (async () => { try { await navigator.clipboard.writeText(txt); toast("Lista copiata 📋"); } catch { toast("Copia non riuscita"); } })(); return;
    }
    if (e.target.closest("[data-spesa-reset]")) { save(LS.spesaCheck, []); openModal(spesaHTML()); return; }
  });
  // ricerca live nel picker ricetta (aggiorna solo la lista, non perde il focus)
  $("#modal").addEventListener("input", (e) => {
    if (e.target.id === "slotSearch" && modalCtx && modalCtx.kind === "slot") { modalCtx.q = e.target.value; const l = $("#slotList"); if (l) l.innerHTML = slotListHTML(); }
  });
  // spunte lista spesa (persistite in locale)
  $("#modal").addEventListener("change", (e) => {
    const c = e.target.closest("[data-spesacheck]"); if (!c) return;
    const set = new Set(load(LS.spesaCheck, []));
    if (c.checked) set.add(c.dataset.spesacheck); else set.delete(c.dataset.spesacheck);
    save(LS.spesaCheck, [...set]);
    const row = c.closest(".spesa-row"); if (row) row.classList.toggle("done", c.checked);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
async function init() {
  wire();
  await ensureRicette();
  renderAll();
  setScreen("home");
  startSync();
  if ("serviceWorker" in navigator) { try { await navigator.serviceWorker.register("./sw.js"); } catch {} }
}
init();
