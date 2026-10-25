# VDR-0026 — Prova de fum *headless* pròpia (`tools/browser-smoke.mjs`): Chrome pel protocol DevTools, sense dependències, amb el ganxo `window.__slop`

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

`NEXT_STEPS.md` §2.9 proposava una "prova de fum en navegador" amb Playwright (opcional, "requiere dependencia"), i
CLAUDE.md prohibeix afegir dependències. Durant la sessió, l'agent no tenia cap navegador connectat (l'extensió de
Chrome no estava disponible, com ja havia passat a la sessió 1: `HOW_TO_IMPROVE.md` §3, sessió 1) i, segons el diari de
treball, provar amb `--virtual-time-budget` de Chrome no passava mai de la pantalla de càrrega (aquest intent no consta
als fitxers del repositori). Sense una manera de carregar la ciutat de debò no es podia mesurar res del relleu: ni els
vèrtexs (VDR-0020), ni els edificis enterrats (VDR-0024), ni els errors de WebGPU.

## Decisió

`tools/browser-smoke.mjs`, només Node i Chrome:

- Llança Chrome (`--headless=new`, `--enable-unsafe-webgpu`, `--use-angle=metal`, perfil temporal, port de depuració
  9333 per defecte) i hi parla pel **protocol DevTools** amb el **`WebSocket` propi de Node** (sense npm).
- Carrega `--url` (per defecte `http://127.0.0.1:8123/`, un servidor estàtic que ja ha de servir l'arrel del repositori),
  **espera el missatge `[init]`** de la consola (o un error no capturat) fins a `--wait` segons (240), i bolca la
  consola a `smoke-console.txt`.
- **`window.__slop`** (`js/main.js`, publicat quan acaba l'arrencada): `scene`, `colliders`, `seating` (VDR-0024),
  `groundHeightAt`, `terrainY`, `locations` i `teleport(x | nom, z, heading, mode)`. `--teleport "x,z,heading[,mode]"`
  (repetible) hi porta el jugador i fa una **captura** (`Page.captureScreenshot`); `--eval "js"` avalua qualsevol
  expressió a la pàgina i n'imprimeix el resultat.
- La pàgina carrega **three.js des de jsDelivr i Inter des de Google Fonts, com fa sempre `index.html`**: la prova no
  afegeix cap destí de xarxa nou (VDR-0010); la primera execució es va fer amb el permís del propietari.

Amb aquesta eina s'han mesurat totes les xifres del relleu d'aquesta sessió: vèrtexs del terra i temps de `cityGrid`
(VDR-0020), volums enterrats i sòcols (VDR-0024), i les captures de ponts i voreres (`HOW_TO_IMPROVE.md` §3, sessió 3,
punts 4, 6 i 8).

Referències: `tools/browser-smoke.mjs` (capçalera d'ús, `waitFor`, `--teleport`, `--eval`); `js/main.js`
(`window.__slop`, `[init]`); `NEXT_STEPS.md` §2.9 i estat 2026-10-25.

## Alternatives considerades

- **Playwright / Puppeteer** (`NEXT_STEPS.md` §2.9): una dependència npm, prohibida per CLAUDE.md, i una descàrrega de
  navegador.
- **Extensió de Chrome de l'agent**: no estava connectada; i no és reproduïble per a ningú més.
- **`--screenshot --virtual-time-budget`**: no espera el final de l'arrencada (WebGPU, `fetch` del `.bin`, construcció
  de la ciutat).
- **Tests `node:test` amb three.js simulat**: ja hi són (`tests/`), però no veuen WebGPU ni la mida real dels búfers.

## Conseqüències

- Requereix Chrome al sistema (ruta per defecte de macOS, `--chrome` per canviar-la) i un servidor estàtic engegat: és
  una eina de desenvolupador, **no un test** de `node --test`.
- El ganxo `window.__slop` és superfície pública del runtime; es manté petit i només per a diagnòstic.
- Les captures es fan a 1600 × 900 amb la càmera del mode triat; no hi ha comparació automàtica d'imatges.

*Un polsim de Viandox:* abans de servir, el xef tasta al passaplats amb una cullera pròpia; no espera que li ho expliqui el
cambrer.
