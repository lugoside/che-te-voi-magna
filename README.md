# Che te voi magnà? 🍝

Assistente di famiglia per decidere **cosa cucinare** quando mancano le idee.
PWA installabile (Valerio, Elena, Ambra), a **costo zero**.

*In onore di Ruben Bondi — cucina romana, casereccia e saporita.*

## Come funziona (due velocità)

- **Uso quotidiano → motore locale.** Tocca *"Che te voi magnà?"*, scegli chi c'è, quante
  idee, che portata ed eventuali ingredienti da usare: l'app propone piatti dal ricettario di
  famiglia, **escludendo quelli fatti negli ultimi 7 giorni**. Istantaneo, offline, gratis.
  Nessuna chiamata a Claude.
- **Crescita del ricettario → Claude Code (batch).** Dall'app, in *"Insegna a Ruben"*, accumuli
  osservazioni (nuove ricette, link da importare, regole tipo *"non elencare olio e sale"*).
  Quando vuoi, lanci lo skill Claude Code `/che-te-voi-magna` che le processa e aggiorna il
  ricettario. Usa l'account aziendale: **nessun costo API**.

## Struttura

```
docs/                     # PWA (GitHub Pages serve da qui)
  index.html  styles.css
  engine.js               # motore di selezione (funzioni pure, testate)
  sync.js                 # sync Firebase via REST/SSE (no SDK)
  app.js                  # UI
  sw.js  manifest.webmanifest  icons/
  data/ricette.seed.json  # ricettario iniziale
tests/test_engine.mjs     # node tests/test_engine.mjs
.claude/skills/che-te-voi-magna/  # skill di rigenerazione (batch, gratis)
```

## Sviluppo

- **Test motore:** `node tests/test_engine.mjs`
- **Anteprima locale:** servi `docs/` (es. `python -m http.server 8123 --directory docs`) e apri
  `http://localhost:8123`.

## Setup sync famiglia (una volta)

1. Crea un **Firebase Realtime Database** gratuito (o riusa un progetto esistente con un path
   dedicato). Regole di test iniziali (poi restringibili): lettura/scrittura sotto
   `chetevoimagna/<codice>`.
2. In app → **Impostazioni → Sincronizzazione**: incolla URL, scegli un **codice famiglia**,
   attiva la sync. Stesso URL+codice su tutti i telefoni.
3. Per lo skill: copia `config.example.json` in `config.json` (stessa cartella dello skill) con
   URL e codice. `config.json` è in `.gitignore` (il codice famiglia è come una password).

## Modello dati (Firebase)

`chetevoimagna/<codice>/` → `config`, `profili`, `dispensa`, `regole`, `ricette/<id>`,
`storico/<pushId>` (log append-only), `coda/<pushId>` (log append-only).
