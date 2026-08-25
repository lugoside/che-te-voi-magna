// engine.js — motore di SELEZIONE dei pasti per "Che te voi magnà?".
//
// Funzioni PURE (nessun DOM): usabili sia nel browser (import da app.js) sia in
// Node per i test. Il cuore è `proponi()`, che dato il ricettario di famiglia,
// lo storico dei pasti e le variabili scelte (chi c'è, quante idee, che portata,
// quali ingredienti tenere in conto) restituisce N proposte adatte, escludendo
// i piatti già fatti negli ultimi 7 giorni.
//
// NIENTE chiamate a Claude: l'uso quotidiano è istantaneo, offline e gratuito.
// Claude interviene solo in BATCH (skill Claude Code) per far crescere il
// ricettario — vedi .claude/skills/che-te-voi-magna/SKILL.md.

// ---------------------------------------------------------------------------
// Costanti di dominio
// ---------------------------------------------------------------------------
export const PORTATE = ["antipasto", "primo", "secondo", "contorno", "dolce"];
export const PORTATA_NOME = {
  antipasto: "Antipasto",
  primo: "Primo",
  secondo: "Secondo",
  contorno: "Contorno",
  dolce: "Dolce",
};
// reparti del supermercato, in ordine di spesa
export const REPARTI = [
  "Frutta e verdura", "Carne e salumi", "Pesce e frutti di mare", "Latticini e uova",
  "Pane e panetteria", "Pasta, riso e cereali", "Scatolame e conserve",
  "Dispensa, dolci e spezie", "Surgelati", "Altro",
];
// classificatore per parola chiave (ordine = priorità: il primo match vince)
const REPARTO_MATCH = [
  ["Pesce e frutti di mare", ["salmone", "merluzzo", "nasello", "vongol", "cozze", "gamber", "calamar", "frutti di mare", "misto di mare", "misto mare", "platessa", "orata", "branzino", "seppie", "polpo", "spigola", "trota", "pesce"]],
  ["Carne e salumi", ["pollo", "sovracosce", "macinat", "manzo", "vitello", "girello", "salsiccia", "speck", "prosciutto", "pancetta", "bresaola", "wurstel", "hamburger", "bistecc", "tacchino", "carne", "cotolett", "spezzatino", "arrosto"]],
  ["Scatolame e conserve", ["passata", "pelati", "concentrato di pomodoro", "tonno", "acciugh", "capperi", "oliv", "mais", "fagiol", "ceci", "lenticch", "legumi", "sottolio", "sottaceti", "in scatola"]],
  ["Latticini e uova", ["latte", "uova", "uovo", "mozzarell", "parmigian", "pecorin", "ricotta", "burro", "yogurt", "mascarpone", "panna", "formaggio", "stracchino", "scamorza", "fontina", "provola", "gorgonzola", "philadelphia"]],
  ["Pane e panetteria", ["pane", "pangrattat", "grissini", "crostini", "savoiard", "biscott", "fette biscottate", "piadina", "tortilla", "focaccia"]],
  ["Pasta, riso e cereali", ["pasta", "spaghett", "tonnarell", "lasagn", "riso", "cereali", "farro", "orzo", "gnocch", "couscous", "polenta", "fusilli", "penne", "tagliatell", "maccheroni", "tortellini", "ravioli"]],
  ["Frutta e verdura", ["zucc", "pomodor", "patat", "cipoll", "aglio", "insalat", "fungh", "champignon", "mela", "mele", "banan", "limone", "melone", "arance", "basilico", "prezzemolo", "rosmarino", "salvia", "carot", "sedano", "melanzan", "peperon", "spinac", "fagiolini", "piselli", "cavolfiore", "cavolo", "broccol", "minestrone", "verdur", "aneto", "zenzero", "porri", "finocchi", "radicchio", "rucola", "fragole", "pere", "pesche", "uva", "misto minestrone"]],
  ["Dispensa, dolci e spezie", ["farina", "zucchero", "lievito", "cacao", "miele", "marmellata", "confettura", "aceto", "zafferano", "tahina", "pesto", "brodo", "caffe", "besciamella", "ragu", "noci", "nocciole", "mandorle", "pinoli", "vaniglia", "cannella", "cioccolat", "vino", "curry", "paprika", "semi", "gelatina", "amido"]],
  ["Surgelati", ["surgelat", "gelato"]],
];
export function repartoDi(nome) {
  const n = norm(nome);
  for (const [rep, kws] of REPARTO_MATCH) if (kws.some((k) => n.includes(norm(k)))) return rep;
  return "Altro";
}

export const NO_REPEAT_GIORNI = 7; // niente ripetizioni entro 7 giorni
// finestra "morbida" più lunga: piatti fatti da poco (ma oltre i 7 gg) vengono
// leggermente penalizzati per favorire la rotazione, senza escluderli.
const ROTAZIONE_GIORNI = 30;
// tag che rendono un piatto poco adatto a un bimbo piccolo (Ambra): se in tavola
// c'è un bimbo, questi piatti vengono esclusi.
const TAG_NO_BIMBI = ["piccante", "alcolico", "crudo"];

// ---------------------------------------------------------------------------
// Utility deterministiche (niente Math.random nel core: seed esplicito)
// ---------------------------------------------------------------------------
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// PRNG deterministico (mulberry32): stesso seed → stessa sequenza → proposte
// riproducibili finché non si "rimescola" cambiando seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(x) {
  const s = String(x == null ? "" : x);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// normalizza una stringa per confronti robusti (accenti, maiuscole, plurali soft)
export function norm(s) {
  const nfd = String(s || "").toLowerCase().normalize("NFD");
  let out = "";
  for (const ch of nfd) {
    const c = ch.codePointAt(0);
    if (c >= 0x300 && c <= 0x36f) continue; // scarta i segni diacritici combinanti (via accenti)
    out += ch;
  }
  return out.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// data locale in formato YYYY-MM-DD (niente UTC: conta il giorno "di casa")
export function ymd(d = new Date()) {
  const x = new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const g = String(x.getDate()).padStart(2, "0");
  return `${x.getFullYear()}-${m}-${g}`;
}

// stagione corrente (emisfero nord) da una data → "inverno|primavera|estate|autunno"
export function stagioneCorrente(date = new Date()) {
  const m = date.getMonth() + 1; // 1..12
  if (m === 12 || m <= 2) return "inverno";
  if (m <= 5) return "primavera";
  if (m <= 8) return "estate";
  return "autunno";
}

// ---------------------------------------------------------------------------
// Normalizzazione dati (accetta formati un po' sporchi dal ricettario/skill)
// ---------------------------------------------------------------------------
// accetta sia array [{id,...}] sia oggetto Firebase { id: {...} }
export function toList(coll) {
  if (Array.isArray(coll)) return coll.filter(Boolean);
  return Object.entries(coll || {}).map(([id, v]) => ({ id, ...(v || {}) })).filter((r) => r && (r.id != null));
}

export function normalizeRicetta(r) {
  r = r || {};
  const ingredienti = (Array.isArray(r.ingredienti) ? r.ingredienti : []).map((i) =>
    typeof i === "string" ? { nome: i, q: null, unita: "", opzionale: false }
                          : { nome: i.nome || "", q: i.q ?? null, unita: i.unita || "", opzionale: !!i.opzionale }
  );
  return {
    id: r.id,
    nome: r.nome || "(senza nome)",
    portata: PORTATE.includes(r.portata) ? r.portata : "secondo",
    ingredienti,
    passaggi: Array.isArray(r.passaggi) ? r.passaggi : (r.passaggi ? [String(r.passaggi)] : []),
    tempoMin: Number.isFinite(r.tempoMin) ? r.tempoMin : null,
    difficolta: r.difficolta || "media",
    tag: Array.isArray(r.tag) ? r.tag.map(norm) : [],
    adattoBimbi: !!r.adattoBimbi,
    stagioni: Array.isArray(r.stagioni) ? r.stagioni.map(norm) : [],
    fonte: r.fonte || { tipo: "generata" },
    createdAt: r.createdAt || 0,
  };
}

// set degli id ricetta usati negli ultimi `giorni` (dal giorno `oggi`)
export function ricetteRecenti(storico, oggi = new Date(), giorni = NO_REPEAT_GIORNI) {
  const eventi = toList(storico);
  const soglia = new Date(oggi); soglia.setHours(0, 0, 0, 0); soglia.setDate(soglia.getDate() - (giorni - 1));
  const recenti = new Map(); // ricettaId -> giorni fa (min)
  for (const e of eventi) {
    if (!e.ricettaId) continue;
    const d = e.data ? new Date(e.data) : (e.ts ? new Date(e.ts) : null);
    if (!d || isNaN(d)) continue;
    d.setHours(0, 0, 0, 0);
    const giorniFa = Math.round((new Date(oggi).setHours(0, 0, 0, 0) - d.getTime()) / 86400000);
    if (giorniFa < 0) continue;
    if (!recenti.has(e.ricettaId) || giorniFa < recenti.get(e.ricettaId)) recenti.set(e.ricettaId, giorniFa);
  }
  return recenti; // Map ricettaId -> quanti giorni fa è stata fatta
}

// una persona presente "blocca" una ricetta se contiene un suo allergene;
// la "penalizza" se contiene un ingrediente non gradito. `presentiProfili` è
// la lista dei profili delle persone effettivamente in tavola.
function vincoliPersone(ricetta, presentiProfili) {
  const ingNorm = ricetta.ingredienti.map((i) => norm(i.nome));
  const contiene = (term) => { const t = norm(term); return ingNorm.some((n) => n.includes(t) || t.includes(n)); };
  let bloccata = false;
  let penalitaGusti = 0;
  let cBimbo = false;
  for (const p of presentiProfili) {
    for (const a of (p.allergie || [])) if (a && contiene(a)) bloccata = true;
    for (const g of (p.nonGraditi || [])) if (g && contiene(g)) penalitaGusti += 1;
    if (p.bimbo) cBimbo = true;
  }
  // se c'è un bimbo e il piatto è taggato non adatto → blocca
  if (cBimbo && ricetta.tag.some((t) => TAG_NO_BIMBI.includes(t))) bloccata = true;
  return { bloccata, penalitaGusti, cBimbo };
}

// ---------------------------------------------------------------------------
// proponi() — funzione principale chiamata dall'app al tap su "Proponi".
//
// opts = {
//   ricette,            // ricettario (array o oggetto Firebase)
//   storico,            // storico pasti (array o oggetto)
//   profili,            // { chiave: {nome, bimbo, nonGraditi[], allergie[]} }
//   presenti,           // [chiave, ...] chi è in tavola
//   nrPasti,            // quante proposte restituire (default 3)
//   portate,            // [portata, ...] portate ammesse ([] = tutte)
//   ingredientiDaUsare, // [nome, ...] frigo/scadenza/voglie (boost)
//   oggi,               // Date di riferimento (default now)
//   seed,               // per riproducibilità / rimescolo
// }
// Ritorna { proposte:[ricetta arricchita], candidati, scartate:{...}, stagione }
// ---------------------------------------------------------------------------
export function proponi(opts = {}) {
  const oggi = opts.oggi ? new Date(opts.oggi) : new Date();
  const nrPasti = clamp(Math.round(opts.nrPasti || 3), 1, 12);
  const portate = (opts.portate || []).filter((p) => PORTATE.includes(p));
  const ingredientiDaUsare = (opts.ingredientiDaUsare || []).map(norm).filter(Boolean);
  const profili = opts.profili || {};
  const presenti = Array.isArray(opts.presenti) ? opts.presenti : [];
  const presentiProfili = presenti.map((k) => profili[k]).filter(Boolean);
  const rnd = mulberry32(hashSeed(opts.seed) ^ hashSeed(oggi.toDateString()));

  const ricette = toList(opts.ricette).map(normalizeRicetta).filter((r) => r.id != null);
  const recenti = ricetteRecenti(opts.storico, oggi, NO_REPEAT_GIORNI);
  const stagione = stagioneCorrente(oggi);

  const scartate = { recenti: 0, portata: 0, persone: 0 };
  const scored = [];

  for (const r of ricette) {
    // 1) niente ripetizioni entro 7 giorni (esclusione dura)
    if (recenti.has(r.id) && recenti.get(r.id) < NO_REPEAT_GIORNI) { scartate.recenti++; continue; }
    // 2) filtro portata (se richiesta)
    if (portate.length && !portate.includes(r.portata)) { scartate.portata++; continue; }
    // 3) vincoli delle persone in tavola (allergie/bimbo = blocco)
    const v = vincoliPersone(r, presentiProfili);
    if (v.bloccata) { scartate.persone++; continue; }

    // --- punteggio ---
    let score = 1;
    const motivi = [];

    // boost ingredienti da usare (frigo/scadenza/voglie): forte
    const ingNorm = r.ingredienti.map((i) => norm(i.nome));
    let match = 0;
    for (const term of ingredientiDaUsare) if (ingNorm.some((n) => n.includes(term) || term.includes(n))) match++;
    if (match) { score += match * 3; motivi.push(`usa ${match} ingrediente/i richiesti`); }

    // stagione
    if (r.stagioni.length === 0 || r.stagioni.includes(stagione)) { score += 0.6; if (r.stagioni.includes(stagione)) motivi.push(`di stagione (${stagione})`); }
    else { score -= 0.4; }

    // bimbo in tavola → premia i piatti adatti
    if (v.cBimbo && r.adattoBimbi) { score += 1.2; motivi.push("adatto ad Ambra"); }

    // gusti non graditi (soft)
    if (v.penalitaGusti) score -= v.penalitaGusti * 1.5;

    // rotazione: se fatto tra 7 e 30 giorni fa, leggera penalità decrescente
    if (recenti.has(r.id)) {
      const gf = recenti.get(r.id);
      if (gf < ROTAZIONE_GIORNI) score -= (ROTAZIONE_GIORNI - gf) / ROTAZIONE_GIORNI * 0.8;
    } else {
      score += 0.3; // mai fatto (o da tanto): un po' di novità
    }

    // preferenza leggera per piatti poco elaborati (facili/veloci): l'utente li vuole caserecci
    if (r.difficolta === "facile") score += 0.3;
    if (Number.isFinite(r.tempoMin) && r.tempoMin <= 30) score += 0.2;

    // jitter deterministico per varietà tra un "Proponi" e l'altro
    score += rnd() * 0.5;

    scored.push({ ricetta: r, score, motivi, match });
  }

  // ordina per punteggio decrescente
  scored.sort((a, b) => b.score - a.score);

  // selezione con diversità: evita due proposte con lo stesso ingrediente-chiave
  // (primo ingrediente non opzionale) quando possibile.
  const proposte = [];
  const chiaviUsate = new Set();
  const chiaveDi = (r) => {
    const primo = r.ingredienti.find((i) => !i.opzionale) || r.ingredienti[0];
    return primo ? norm(primo.nome) : r.id;
  };
  for (const s of scored) {
    const k = chiaveDi(s.ricetta);
    if (chiaviUsate.has(k)) continue;
    proposte.push({ ...s.ricetta, _score: s.score, _motivi: s.motivi, _match: s.match });
    chiaviUsate.add(k);
    if (proposte.length >= nrPasti) break;
  }
  // se la diversità ha lasciato buchi (poche ricette), completa con i migliori rimasti
  if (proposte.length < nrPasti) {
    const gia = new Set(proposte.map((p) => p.id));
    for (const s of scored) {
      if (gia.has(s.ricetta.id)) continue;
      proposte.push({ ...s.ricetta, _score: s.score, _motivi: s.motivi, _match: s.match });
      if (proposte.length >= nrPasti) break;
    }
  }

  return { proposte, candidati: scored.length, scartate, stagione };
}

// ---------------------------------------------------------------------------
// listaSpesa() — aggrega gli ingredienti dei pasti PIANIFICATI (da oggi in poi).
// Esclude la dispensa (staple sempre in casa). Somma le quantità per ingrediente,
// raggruppando per unità di misura; se manca la quantità → "q.b.".
//
// opts = { piano, ricette, dispensa, oggi }
// Ritorna [{ nome, quantita, fonti:[nomiRicetta] }] ordinato per nome.
// ---------------------------------------------------------------------------
// unità "a pezzi" (arrotondate a intero); g/ml a multipli di 5; le altre a 1 decimale
const UNITA_CONTA = ["pz", "uovo", "uova", "spicchio", "spicchi", "fetta", "fette", "rametto", "rametti", "bustina", "foglia", "foglie", "ciuffo", "costa", "coste", "manciata", "bicchiere", "cucchiaio", "cucchiai", "cucchiaino", "cucchiaini", "q.b."];
function roundQ(v, unita) {
  const u = norm(unita);
  if (u === "g" || u === "ml") return Math.max(5, Math.round(v / 5) * 5);
  if (u === "" || UNITA_CONTA.includes(u)) return Math.max(1, Math.round(v));
  return Math.round(v * 10) / 10;
}
// scala una quantità per un fattore (q null resta null)
export function scalaQ(q, unita, f) { return typeof q === "number" ? roundQ(q * f, unita) : q; }
export function scalaIngredienti(ingredienti, fattore) {
  return (ingredienti || []).map((i) => ({ ...i, q: scalaQ(i.q, i.unita, fattore) }));
}

// PORZIONI base: quante persone servono le quantità scritte nelle ricette.
export const PORZIONI_BASE = 3;
// commensali di un pasto pianificato = familiari presenti (o base) + ospiti
export function commensaliDi(p, base = PORZIONI_BASE) {
  const fam = Array.isArray(p.presenti) && p.presenti.length ? p.presenti.length : base;
  return fam + (p.ospiti || 0);
}

export function listaSpesa(opts = {}) {
  const oggiStr = ymd(opts.oggi ? new Date(opts.oggi) : new Date());
  const base = opts.porzioniBase || PORZIONI_BASE;
  const dispSet = (opts.dispensa || []).map(norm).filter(Boolean);
  const byId = new Map(toList(opts.ricette).map((r) => [r.id, normalizeRicetta(r)]));
  const piano = toList(opts.piano);
  const items = new Map(); // norm(nome) -> { nome, units, fonti, reparto }

  for (const p of piano) {
    if (!p || !p.data || p.data < oggiStr) continue; // solo oggi/futuro
    const r = byId.get(p.ricettaId);
    if (!r) continue;
    const f = commensaliDi(p, base) / (r.porzioni || base); // scala per commensali
    for (const ing of r.ingredienti) {
      const n = norm(ing.nome);
      if (!n) continue;
      if (dispSet.some((d) => n === d || n.includes(d))) continue; // salta dispensa
      if (!items.has(n)) items.set(n, { nome: ing.nome, units: new Map(), fonti: new Set(), reparto: repartoDi(ing.nome) });
      const it = items.get(n);
      it.fonti.add(r.nome);
      const u = (ing.unita || "").trim();
      const q = typeof ing.q === "number" ? ing.q : null;
      if (q == null) it.units.set("__qb__", null);
      else it.units.set(u, (it.units.get(u) || 0) + q * f);
    }
  }

  const out = [];
  for (const it of items.values()) {
    const parts = [];
    for (const [u, q] of it.units) { if (u === "__qb__") continue; parts.push(`${roundQ(q, u)}${u ? " " + u : ""}`); }
    if (it.units.has("__qb__")) parts.push("q.b.");
    out.push({ nome: it.nome, quantita: parts.join(" + "), reparto: it.reparto, fonti: [...it.fonti] });
  }
  const ord = (rep) => { const i = REPARTI.indexOf(rep); return i < 0 ? REPARTI.length : i; };
  out.sort((a, b) => ord(a.reparto) - ord(b.reparto) || a.nome.localeCompare(b.nome, "it"));
  return out;
}

// ---------------------------------------------------------------------------
// Reducer dello STORICO pasti (log append-only, come le "mosse" di FantaAsta).
// Ogni evento: { uid, ricettaId, data (YYYY-MM-DD), pasto, presenti[], ts, byDevice }
// Idempotente (de-dup per uid) e deterministico (ordina per ts, poi id).
// ---------------------------------------------------------------------------
export function reduceStorico(eventi) {
  const list = toList(eventi);
  const byUid = new Map();
  for (const e of list) {
    const key = e.uid || Symbol();
    const prev = byUid.get(key);
    if (!prev) { byUid.set(key, e); continue; }
    const pt = typeof prev.ts === "number" ? prev.ts : -1;
    const ct = typeof e.ts === "number" ? e.ts : -1;
    if (ct >= pt) byUid.set(key, e);
  }
  const uniq = [...byUid.values()].filter(Boolean);
  uniq.sort((a, b) => {
    const ta = typeof a.ts === "number" ? a.ts : Infinity;
    const tb = typeof b.ts === "number" ? b.ts : Infinity;
    if (ta !== tb) return ta - tb;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
  return uniq;
}
