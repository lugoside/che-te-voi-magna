---
name: che-te-voi-magna
description: Processa la coda di osservazioni dell'app "Che te voi magnà?" (nuove ricette, import da URL, regole di addestramento, correzioni) e aggiorna il ricettario di famiglia su Firebase. Da lanciare a mano quando la coda ha elementi. Costo zero (usa Claude Code, nessuna API a pagamento).
---

# Che te voi magnà? — rigenerazione ricettario

Questo skill è la "parte intelligente" dell'app, eseguita in **batch** da Claude Code
(gratis, account aziendale). L'app di famiglia accumula **osservazioni** in una coda;
qui le processi tutte in una volta e aggiorni il **ricettario** condiviso.

Fonte dati: **Firebase Realtime Database** via REST (curl), sotto
`<url>/chetevoimagna/<codice>/`. Nodi:
- `coda/<pushId>` — osservazioni da processare (`stato: pending|processed`)
- `ricette/<id>` — il ricettario (lo scrivi tu qui)
- `regole` (array) — regole di addestramento in linguaggio naturale
- `dispensa` (array) — ingredienti sempre in casa, da NON elencare (olio, sale, …)
- `profili`, `storico` — solo lettura, per contesto (chi c'è, gusti/allergie, cosa è stato mangiato)

## Passo 0 — Configurazione

Leggi `.claude/skills/che-te-voi-magna/config.json` (non versionato). Deve contenere:
```json
{ "url": "https://<progetto>-default-rtdb.<region>.firebasedatabase.app", "code": "<codice-famiglia>", "modello": "claude-opus-5" }
```
Se il file manca, chiedi a Valerio URL e codice famiglia (li trova in app → Impostazioni →
Sincronizzazione) e crealo. `BASE="<url>/chetevoimagna/<code>"`.

> Il campo `modello` è una **preferenza**: se la sessione corrente di Claude Code non è
> su quel modello, avvisa Valerio (può cambiarlo con `/model`) ma procedi comunque.

## Passo 1 — Leggi lo stato

Con curl (niente SDK), scarica i nodi:
```bash
curl -s "$BASE/coda.json"     > /tmp/ctvm_coda.json
curl -s "$BASE/ricette.json"  > /tmp/ctvm_ricette.json
curl -s "$BASE/regole.json"   > /tmp/ctvm_regole.json
curl -s "$BASE/dispensa.json" > /tmp/ctvm_dispensa.json
curl -s "$BASE/profili.json"  > /tmp/ctvm_profili.json
curl -s "$BASE/storico.json"  > /tmp/ctvm_storico.json
```
Individua le osservazioni con `stato != "processed"`. Se non ce ne sono, fermati e dillo.

## Passo 2 — Processa la coda

Per **ogni** osservazione pending, in base a `tipo`:

- **`nuova-ricetta`** — genera le ricette richieste (rispetta numero/portata/ingredienti nel
  testo). Stile: **caserecce, saporite, poco elaborate** — è la famiglia di Valerio, Elena e
  Ambra (2 anni). Se il testo cita un ingrediente, mettilo al centro. Se plausibilmente in
  tavola c'è Ambra, marca `adattoBimbi: true` e tieni i piatti semplici.

- **`importa-url`** — apri il link con lo strumento **WebFetch** (se serve cerca con
  **WebSearch**), estrai la ricetta reale e normalizzala nello schema. `fonte: { tipo: "importata", url: "<link>" }`.

- **`regola`** — aggiungi/aggiorna la regola in `regole`. Se implica staple sempre in casa
  (es. "non elencare olio e sale"), aggiungi quei termini a `dispensa`. Se la regola cambia
  ricette già esistenti (es. togliere olio/sale dalle liste, o "niente maiale"), **applica la
  modifica anche alle ricette già presenti**.

- **`correzione`** — trova la ricetta citata e correggila (quantità, passaggi, tag).

### Schema ricetta (rispettalo esattamente)
```json
{
  "nome": "string",
  "portata": "antipasto|primo|secondo|contorno|dolce",
  "ingredienti": [{ "nome": "string", "q": 240, "unita": "g", "opzionale": false }],
  "passaggi": ["passo 1", "passo 2"],
  "tempoMin": 25,
  "difficolta": "facile|media|difficile",
  "tag": ["casereccio", "veloce", "..."],
  "adattoBimbi": true,
  "stagioni": ["estate"],
  "fonte": { "tipo": "generata|importata", "url": "opzionale" },
  "createdAt": 1712345678901
}
```

### Regole di generazione (sempre)
1. **NON elencare** gli ingredienti presenti in `dispensa` (olio, sale, acqua, pepe, …) tra gli `ingredienti`, ma **usali normalmente nei `passaggi`** dove servono (es. «rosola in un filo d'olio», «lessa in acqua salata», «aggiusta di sale»). Regola fissa: dispensa = sempre fuori dagli ingredienti, mai fuori dalle preparazioni.
2. Quantità per **~2 adulti + 1 bimbo**, con unità sensate (g, ml, pz, spicchio…).
3. Passaggi **sintetici** (2–5 righe), in italiano.
4. Rispetta **tutte** le `regole` esistenti e le `allergie`/gusti nei `profili`.
5. **Dedup**: non creare doppioni di ricette già presenti (stesso nome/ingredienti simili);
   semmai aggiornale.
6. `id` = slug del nome (minuscolo, trattini, senza accenti), es. "Pasta alla Norma" →
   `pasta-alla-norma`. Se collide con una diversa, aggiungi un suffisso.
7. **`createdAt`**: cattura UNA volta all'inizio l'epoch in **millisecondi** (bash: `date +%s%3N`)
   e usa lo STESSO valore per TUTTE le ricette create/importate in questa run. Serve all'app per
   ordinarle (più recenti in alto) e per il badge **"NEW"** (marca l'ultimo lotto). Non usare 0.

## Passo 3 — Scrivi i risultati

Per ogni **nuova/aggiornata** ricetta (oggetto SENZA il campo `id`):
```bash
curl -s -X PUT "$BASE/ricette/<id>.json" -H "Content-Type: application/json" -d @ricetta.json
```
Se hai toccato regole/dispensa:
```bash
curl -s -X PUT "$BASE/regole.json"   -H "Content-Type: application/json" -d @regole.json
curl -s -X PUT "$BASE/dispensa.json" -H "Content-Type: application/json" -d @dispensa.json
```
Marca **ogni** osservazione processata (usa il suo `<pushId>` dal nodo `coda`):
```bash
curl -s -X PATCH "$BASE/coda/<pushId>.json" -H "Content-Type: application/json" \
  -d '{"stato":"processed","processedAt":<epoch_ms>,"esito":"<breve nota>"}'
```
> `<epoch_ms>`: usa `date +%s%3N` (o equivalente). Non serve toccare `ts`.

## Passo 4 — Riepilogo

Riporta a Valerio: quante osservazioni processate, quante ricette nuove/aggiornate (coi nomi),
regole/dispensa modificate. L'app si aggiorna da sola (SSE/polling): niente commit necessario
per i dati. Facoltativo: aggiorna `docs/data/ricette.seed.json` come backup versionato e fai commit.

## Note
- **Idempotenza**: se rilanci, salta le osservazioni già `processed`.
- **Niente segreti nel repo**: `config.json` è in `.gitignore`; il `code` famiglia è la
  "password" del DB, non pubblicarlo.
- **Zero costi**: qui lavora Claude Code, non l'API a consumo. L'uso quotidiano dell'app
  (motore locale) non chiama mai Claude.
