// Test del motore di selezione — eseguibile con: node tests/test_engine.mjs
// Niente dipendenze: asserzioni fatte a mano.
import {
  proponi, ricetteRecenti, stagioneCorrente, norm, reduceStorico, normalizeRicetta,
} from "../docs/engine.js";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (atteso ${JSON.stringify(b)}, ottenuto ${JSON.stringify(a)})`); }

// --- dati di prova ---------------------------------------------------------
const RICETTE = [
  { id: "r1", nome: "Pasta al pomodoro", portata: "primo", ingredienti: [{ nome: "pasta" }, { nome: "pomodoro" }], difficolta: "facile", tempoMin: 20, stagioni: [], adattoBimbi: true },
  { id: "r2", nome: "Pasta alla zucca", portata: "primo", ingredienti: [{ nome: "pasta" }, { nome: "zucca" }], stagioni: ["autunno"], adattoBimbi: true },
  { id: "r3", nome: "Pollo al forno", portata: "secondo", ingredienti: [{ nome: "pollo" }, { nome: "patate" }], adattoBimbi: true },
  { id: "r4", nome: "Peperoncini piccanti ripieni", portata: "secondo", ingredienti: [{ nome: "peperoncino" }], tag: ["piccante"] },
  { id: "r5", nome: "Frittata con noci", portata: "secondo", ingredienti: [{ nome: "uova" }, { nome: "noci" }] },
  { id: "r6", nome: "Insalata di riso", portata: "primo", ingredienti: [{ nome: "riso" }, { nome: "tonno" }], stagioni: ["estate"] },
];
const PROFILI = {
  valerio: { nome: "Valerio", bimbo: false, nonGraditi: [], allergie: [] },
  elena: { nome: "Elena", bimbo: false, nonGraditi: [], allergie: ["noci"] },
  ambra: { nome: "Ambra", bimbo: true, nonGraditi: [], allergie: [] },
};
const OGGI = new Date("2026-08-24T12:00:00");

// --- norm() ----------------------------------------------------------------
console.log("norm()");
eq(norm("Zucchine à la façon"), "zucchine a la facon", "toglie accenti e simboli");
eq(norm("  PASTA   al  Pomodoro "), "pasta al pomodoro", "spazi e maiuscole");

// --- stagione --------------------------------------------------------------
console.log("stagioneCorrente()");
eq(stagioneCorrente(new Date("2026-01-15")), "inverno", "gennaio → inverno");
eq(stagioneCorrente(new Date("2026-08-24")), "estate", "agosto → estate");
eq(stagioneCorrente(new Date("2026-10-10")), "autunno", "ottobre → autunno");

// --- ricetteRecenti / no-repeat 7 giorni -----------------------------------
console.log("ricetteRecenti()");
const STORICO = [
  { uid: "a", ricettaId: "r1", data: "2026-08-22" }, // 2 giorni fa → dentro i 7
  { uid: "b", ricettaId: "r3", data: "2026-08-10" }, // 14 giorni fa → fuori dai 7
];
const rec = ricetteRecenti(STORICO, OGGI, 7);
ok(rec.has("r1") && rec.get("r1") === 2, "r1 fatta 2 giorni fa");
ok(!rec.has("r3") || rec.get("r3") >= 7, "r3 (14gg fa) non è tra i recenti-7");

// r1 fatta 2 giorni fa NON deve comparire nelle proposte
console.log("proponi(): esclusione 7 giorni");
let out = proponi({ ricette: RICETTE, storico: STORICO, profili: PROFILI, presenti: ["valerio"], nrPasti: 6, portate: [], oggi: OGGI, seed: 1 });
ok(!out.proposte.some((p) => p.id === "r1"), "r1 (2gg fa) esclusa dalle proposte");
ok(out.scartate.recenti >= 1, "conteggio scartate.recenti");

// --- filtro portata --------------------------------------------------------
console.log("proponi(): filtro portata");
out = proponi({ ricette: RICETTE, storico: [], profili: PROFILI, presenti: ["valerio"], nrPasti: 6, portate: ["primo"], oggi: OGGI, seed: 1 });
ok(out.proposte.every((p) => p.portata === "primo"), "solo primi quando portata=primo");

// --- allergie (Elena, noci) = blocco --------------------------------------
console.log("proponi(): allergie");
out = proponi({ ricette: RICETTE, storico: [], profili: PROFILI, presenti: ["elena"], nrPasti: 6, portate: [], oggi: OGGI, seed: 1 });
ok(!out.proposte.some((p) => p.id === "r5"), "frittata con noci esclusa se c'è Elena (allergia)");

// --- bimbo presente: esclude piccante, premia adatto-bimbi -----------------
console.log("proponi(): bimbo in tavola");
out = proponi({ ricette: RICETTE, storico: [], profili: PROFILI, presenti: ["ambra"], nrPasti: 6, portate: [], oggi: OGGI, seed: 1 });
ok(!out.proposte.some((p) => p.id === "r4"), "peperoncini piccanti esclusi con Ambra in tavola");

// --- boost ingredienti da usare -------------------------------------------
console.log("proponi(): boost ingredienti");
out = proponi({ ricette: RICETTE, storico: [], profili: PROFILI, presenti: ["valerio"], nrPasti: 1, portate: ["primo"], ingredientiDaUsare: ["zucca"], oggi: OGGI, seed: 1 });
eq(out.proposte[0].id, "r2", "con 'zucca' richiesta, la pasta alla zucca è la prima proposta");

// --- reduceStorico: idempotente/dedup per uid ------------------------------
console.log("reduceStorico()");
const dup = reduceStorico([
  { uid: "x", ricettaId: "r1", ts: 100 },
  { uid: "x", ricettaId: "r1", ts: 200 }, // stessa uid, ts maggiore → vince
  { uid: "y", ricettaId: "r2", ts: 150 },
]);
eq(dup.length, 2, "dedup per uid");
eq(dup.map((e) => e.uid), ["y", "x"], "ordinati per ts (y=150 prima di x=200 dopo dedup)");

// --- normalizeRicetta: ingredienti come stringhe ---------------------------
console.log("normalizeRicetta()");
const nr = normalizeRicetta({ id: "z", nome: "X", portata: "boh", ingredienti: ["pane", { nome: "burro", q: 20, unita: "g" }] });
eq(nr.portata, "secondo", "portata sconosciuta → default secondo");
eq(nr.ingredienti[0], { nome: "pane", q: null, unita: "", opzionale: false }, "ingrediente stringa normalizzato");

// --- esito -----------------------------------------------------------------
console.log(`\n${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
