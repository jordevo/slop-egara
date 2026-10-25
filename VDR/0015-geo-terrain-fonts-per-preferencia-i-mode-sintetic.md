# VDR-0015 — `tools/geo-terrain.mjs`: diversos ràsters per ordre de preferència, forats omplerts, i un mode `--synthetic` només per a desenvolupament

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

Cap MDE cobreix sol tota la caixa de detall amb el millor detall: l'ICGC MET 2 m va per fulls, el 5 m és continu, el
Copernicus 30 m ho cobreix tot. I, mentre no hi hagi permís per baixar-ne cap (VDR-0010, VDR-0018), cal poder
desenvolupar i provar tot el camí (`tools` → `.bin` → `js/terrain.js` → ciutat elevada) amb alguna cosa.

## Decisió

- **Ràsters en ordre de preferència**: `node tools/geo-terrain.mjs dem1.tif dem2.asc …`; per a cada cel·la del grid
  del món, guanya el primer ràster amb valor vàlid (`resample`). Ordre previst: ICGC MET 2 m → 5 m → Copernicus 30 m.
- **Forats omplerts** per dilatació iterativa des dels veïns vàlids (`fillHoles`); si en queden, 0.
- **Suavitzat** gaussià separable (`gaussianBlur`, σ per defecte 4 m) per treure el soroll de píxel abans de drapar-hi
  vorades i edificis. (El condicionament urbà posterior, carrers i illes, és VDR-0022.)
- **Mode `--synthetic`**: sense cap ràster, `syntheticHeights()` genera un relleu **inventat i marcat** (bit 1 de
  `flags` a la capçalera): un pla que puja cap al nord-oest (~2,8 % nord, ~0,5 % oest, com el peu de mont del Vallès),
  els torrents de `GEO.water` tallats ~5 m i les illes del Parc de Vallparadís ~9 m, més una ondulació suau. Serveix
  **només per desenvolupar**: el runtime ho anuncia a la consola ("SYNTHETIC stand-in, not the real relief") i **no
  s'ha de cometre mai com a dada** (el real sí: VDR-0018).

Referències: `tools/geo-terrain.mjs` (capçalera d'ús, `resample`, `fillHoles`, `gaussianBlur`, `syntheticHeights`);
`js/terrain.js` (`loadTerrain`, missatge de consola); `tests/geo-terrain.test.mjs` (prova *end to end* amb el relleu
sintètic sobre el marc real).

## Alternatives considerades

- **Un sol ràster obligatori**: més simple, però obligaria a fusionar fulls fora de l'eina.
- **Interpolar els forats des del ràster de menys resolució** en lloc de dilatar: ja ho fa l'ordre de preferència; la
  dilatació només tapa el que cap font cobreix.
- **Sense mode sintètic, esperar el MDE**: bloquejaria tota la integració del runtime fins a tenir permís de xarxa.

## Conseqüències

- Hi ha un risc real de confondre el sintètic amb el real: mitigat amb el bit de capçalera, el missatge de consola,
  aquesta decisió (el `.gitignore` ja no ignora el `.bin`: el real es versiona, VDR-0018).
- "Ho anuncia a la consola" és un `console.info` amb el text en majúscules; si cal, es pot pujar a `console.warn` o a
  un avís al HUD.
- El fitxer sintètic actual té relleu de −131 a +195 m respecte de la Plaça Vella: prou per fer sortir qualsevol
  objecte que mesuri alçades en absolut (VDR-0025).

*Un polsim de Viandox:* mentre no arriba el bou de debò, s'assaja la recepta amb un extracte… i es diu ben clar a la
carta.
