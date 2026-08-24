// app.js — logica dell'interfaccia di "Che te voi magnà?".
// Collega il motore di selezione (engine.js), la sync famigliare (sync.js) e il DOM.
import {
  proponi, reduceStorico, normalizeRicetta, toList, norm,
  PORTATE, PORTATA_NOME,
} from "./engine.js";
import { Sync, load, save, mkUid, newDeviceId, mergeLog } from "./sync.js";

const APP_VERSION = "v3";

// ---------------------------------------------------------------------------
// Chiavi localStorage + stato
// ---------------------------------------------------------------------------
const LS = {
  config: "ctvm_config", sync: "ctvm_sync", device: "ctvm_device", ui: "ctvm_ui",
  profili: "ctvm_profili", dispensa: "ctvm_dispensa", regole: "ctvm_regole",
  ricette: "ctvm_ricette", storico: "ctvm_storico", coda: "ctvm_coda",
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
let SYNC = load(LS.sync, { url: "", code: "", on: false });

let DEVICE_ID = load(LS.device, "");
if (!DEVICE_ID) { DEVICE_ID = newDeviceId(); save(LS.device, DEVICE_ID); }

const ui = Object.assign({
  screen: "home",
  presenti: Object.keys(PROFILI),
  nrPasti: 3,
  portate: ["primo"],
  ingredienti: [],
  seed: 1,
  cerca: "",
  filtroPortata: "tutte",
  obsTipo: "nuova-ricetta",
  proposte: [],
}, load(LS.ui, {}));
// i profili possono essere cambiati: tieni i presenti coerenti
ui.presenti = ui.presenti.filter((k) => PROFILI[k]);
if (!ui.presenti.length) ui.presenti = Object.keys(PROFILI);

function saveUI() { save(LS.ui, { presenti: ui.presenti, nrPasti: ui.nrPasti, portate: ui.portate, ingredienti: ui.ingredienti, obsTipo: ui.obsTipo }); }

// ---------------------------------------------------------------------------
// Sync famigliare
// ---------------------------------------------------------------------------
const sync = new Sync({ url: SYNC.url, code: SYNC.code, deviceId: DEVICE_ID });
sync.onStatus = (s) => setDot(SYNC.on ? s : "off");
let _pollId = null;

function ricetteToObj(list) { const o = {}; for (const r of list) { const { id, ...rest } = r; if (id != null) o[id] = rest; } return o; }

async function reconcile() {
  if (!SYNC.on || !sync.enabled) return;
  try {
    const [rc, rp, rd, rr, rric, rs, rq] = await Promise.all([
      sync.get("config"), sync.get("profili"), sync.get("dispensa"),
      sync.get("regole"), sync.get("ricette"), sync.get("storico"), sync.get("coda"),
    ]);
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
    const ms = mergeLog(STORICO, rs); if (ms.changed) { STORICO = ms.log; save(LS.storico, STORICO); changed = true; }
    const mq = mergeLog(CODA, rq); if (mq.changed) { CODA = mq.log; save(LS.coda, CODA); changed = true; }
    await flushPending();
    if (changed) renderAllSafe();
  } catch {}
}

async function flushPending() {
  if (!SYNC.on || !sync.enabled) return;
  for (const e of STORICO.filter((x) => x.posted === false && x.byDevice === DEVICE_ID)) await postLog("storico", e);
  for (const e of CODA.filter((x) => x.posted === false && x.byDevice === DEVICE_ID)) await postLog("coda", e);
}
async function postLog(path, e) {
  const { id, posted, ...body } = e;
  const pushId = await sync.append(path, body);
  if (pushId) { e.posted = true; e.id = pushId; save(path === "storico" ? LS.storico : LS.coda, path === "storico" ? STORICO : CODA); }
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
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function setDot(s) { const d = $("#syncDot"); if (d) d.className = "sync-dot " + s; const st = $("#syncStato"); if (st) st.textContent = ({ ok: "connesso ✓", err: "in attesa…", off: "spenta" })[s] || s; }
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200); }

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
function renderIngChips() {
  $("#ingChips").innerHTML = ui.ingredienti.map((n, i) =>
    `<span class="chip rm" data-ing="${i}">${esc(n)} <span class="x">✕</span></span>`).join("");
}

function ricettaCardHTML(r, opts = {}) {
  const ing = senzaDispensa(r.ingredienti);
  const meta = [];
  if (r.tempoMin) meta.push(`⏱️ ${r.tempoMin} min`);
  if (r.difficolta) meta.push(`🔥 ${esc(r.difficolta)}`);
  if (r.adattoBimbi) meta.push("🍼 adatto ai bimbi");
  const motivi = opts.motivi && opts.motivi.length ? `<div class="perche">💡 ${esc(opts.motivi.join(" · "))}</div>` : "";
  const acts = (opts.actions || opts.remove) ? `
    <div class="ricetta-actions">
      ${opts.actions ? `<button type="button" class="btn-ghost" data-fatto="${esc(r.id)}">✅ L'abbiamo fatto</button>` : ""}
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
  box.innerHTML = ui.proposte.map((r) => ricettaCardHTML(r, { actions: true, motivi: r._motivi })).join("");
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
  let list = RICETTE.map(normalizeRicetta);
  if (ui.filtroPortata !== "tutte") list = list.filter((r) => r.portata === ui.filtroPortata);
  if (q) list = list.filter((r) => norm(r.nome).includes(q) || r.ingredienti.some((i) => norm(i.nome).includes(q)));
  list.sort((a, b) => a.nome.localeCompare(b.nome, "it"));
  const box = $("#listaRicette");
  if (!list.length) { box.innerHTML = `<div class="card empty">Nessuna ricetta trovata.</div>`; return; }
  box.innerHTML = list.map((r) => `
    <div class="riga" data-ricetta="${esc(r.id)}">
      <div class="r-main">
        <div class="r-title">${esc(r.nome)}</div>
        <div class="r-sub">${esc(PORTATA_NOME[r.portata] || r.portata)}${r.tempoMin ? " · " + r.tempoMin + " min" : ""}${r.adattoBimbi ? " · 🍼" : ""}</div>
      </div>
      <button class="icon-btn" data-apri="${esc(r.id)}">›</button>
    </div>
    <div class="det" id="det-${esc(r.id)}" hidden></div>
  `).join("");
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
      <button class="icon-btn" data-delstorico="${esc(e.uid)}">🗑️</button>
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
function renderImpostazioni() {
  renderProfili(); renderDispensa();
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
  renderPresenti(); renderPortate(); renderNr(); renderIngChips();
  renderRicettario(); renderCoda(); renderStorico(); renderInsegnaForm(); renderImpostazioni();
}
// come renderAll ma non ridisegna se l'utente sta scrivendo in un campo (non ruba il focus)
function renderAllSafe() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  renderAll();
}
function renderIfVisible(screens) { if (screens.includes(ui.screen)) { if (ui.screen === "ricettario") renderRicettario(); if (ui.screen === "storico") renderStorico(); if (ui.screen === "insegna") renderCoda(); if (ui.screen === "home") { renderPresenti(); } } }

function setScreen(name) {
  ui.screen = name;
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.screen === name));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
function segnaFatto(ricettaId) {
  const r = RICETTE.find((x) => x.id === ricettaId);
  const now = new Date();
  const e = {
    uid: mkUid(DEVICE_ID), ricettaId, nome: r ? r.nome : "",
    data: now.toISOString().slice(0, 10),
    pasto: now.getHours() < 16 ? "pranzo" : "cena",
    presenti: ui.presenti.slice(), byDevice: DEVICE_ID, ts: now.getTime(), posted: false,
  };
  STORICO.push(e); save(LS.storico, STORICO);
  if (SYNC.on && sync.enabled) postLog("storico", e);
  toast(`"${e.nome}" segnato! Non tornerà per 7 giorni 👌`);
  // rimuovi dalla vista proposte
  ui.proposte = ui.proposte.filter((p) => p.id !== ricettaId);
  renderProposte(); renderStorico();
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
  const addIng = () => { const v = $("#ingInput").value.trim(); if (!v) return; ui.ingredienti.push(v); $("#ingInput").value = ""; saveUI(); renderIngChips(); };
  $("#ingAdd").addEventListener("click", addIng);
  $("#ingInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addIng(); } });
  $("#ingChips").addEventListener("click", (e) => { const c = e.target.closest("[data-ing]"); if (!c) return; ui.ingredienti.splice(+c.dataset.ing, 1); saveUI(); renderIngChips(); });
  $("#proponiBtn").addEventListener("click", () => doProponi(false));
  $("#rimescolaBtn").addEventListener("click", () => doProponi(true));
  $("#proposte").addEventListener("click", (e) => { const b = e.target.closest("[data-fatto]"); if (b) segnaFatto(b.dataset.fatto); });

  // RICETTARIO
  $("#cercaRic").addEventListener("input", (e) => { ui.cerca = e.target.value; renderRicettario(); });
  $("#filtriPortata").addEventListener("click", (e) => { const b = e.target.closest("[data-filtro]"); if (!b) return; ui.filtroPortata = b.dataset.filtro; renderRicettario(); });
  $("#listaRicette").addEventListener("click", (e) => {
    const b = e.target.closest("[data-apri]") || e.target.closest("[data-ricetta]"); if (!b) return;
    const id = b.dataset.apri || b.dataset.ricetta;
    const det = $("#det-" + CSS.escape(id)); if (!det) return;
    if (det.hidden) { const r = RICETTE.find((x) => x.id === id); det.innerHTML = ricettaCardHTML(normalizeRicetta(r), { actions: true, remove: true }); det.hidden = false; }
    else det.hidden = true;
  });
  $("#listaRicette").addEventListener("click", (e) => { const b = e.target.closest("[data-fatto]"); if (b) segnaFatto(b.dataset.fatto); });
  $("#listaRicette").addEventListener("click", (e) => { const b = e.target.closest("[data-rimuovi]"); if (b) rimuoviRicetta(b.dataset.rimuovi); });

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
  $("#listaStorico").addEventListener("click", (e) => {
    const b = e.target.closest("[data-delstorico]"); if (!b) return;
    const uid = b.dataset.delstorico; const ev = STORICO.find((x) => x.uid === uid);
    STORICO = STORICO.filter((x) => x.uid !== uid); save(LS.storico, STORICO);
    if (ev && ev.id) deleteFromCloud("storico", ev.id);
    renderStorico(); renderProposte();
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
