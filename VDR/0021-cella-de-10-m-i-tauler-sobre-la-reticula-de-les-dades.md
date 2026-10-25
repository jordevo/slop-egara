# VDR-0021 — Cel·les de relleu de 10 m, i el tauler d'asfalt dibuixat exactament sobre aquesta retícula

- **Data:** 2026-10-25
- **Estat:** Acceptada (substitueix la cel·la de 5 m de VDR-0013)

## Context

VDR-0013 fixava la cel·la del fitxer en 5 m, i VDR-0016 volia un tauler d'asfalt amb pas de 10 m en *tiles* de 500 m
com una retícula pròpia, diferent de la de les dades. A la segona ronda de proves (`HOW_TO_IMPROVE.md` §3, sessió 3,
punt 5) es veien fanals flotant i lloses que no casaven amb l'asfalt: la física (`terrainY`), el tauler
(`buildTerrainTiles`) i la geometria drapada (VDR-0020) interpolaven sobre retícules diferents i no donaven la mateixa
superfície. A més, el fitxer de 5 m quadruplica les dades i els triangles del tauler per a una ciutat on, de totes
maneres, els carrers i les illes es reescriuen amb l'eina (VDR-0022).

## Decisió

1. La **cel·la del relleu és de 10 m** (`--cell`, per defecte 10 a `parseArgs` de `tools/geo-terrain.mjs`;
   `FEATURES.terrainFile` ho recorda al comentari: "its cell size (10 m) is the lattice the asphalt deck is drawn on").
2. **El tauler es dibuixa sobre la retícula de les dades, no sobre una pròpia**: `buildTerrainTiles(bounds, cell,
   tile)` arrodoneix `cell` a un múltiple de `T.cell` (mai més petit) i ancora els *tiles* a `T.x0`, `T.z0`, de manera
   que **cada vèrtex del tauler és una mostra** i els seus triangles (diagonal b–d) són exactament la superfície que
   `terrainY()` interpola.
3. **`terrainLattice()`** (`{ x0, z0, cell }`) és la retícula que fan servir `js/city-grid.js` (`LATTICE`, amb
   `{ 0, 0, 10 }` de reserva) per tallar lloses i vorades (VDR-0020) i `js/road-paint.js` per tallar la pintura.
   Física, tauler i drapat són **una sola superfície**.

Fitxer actual, llegit de la capçalera de `js/terrassa-terrain.bin`: `TRN1`, **914 × 995 cel·les de 10 m**, origen
(x0, z0) = (−4200, −6140), `ref` = 278,9 m s.n.m., relleu −100,0 … +510,4 m, `flags` = 0 (real), σ = 5; 1,8 MB.

Referències: `tools/geo-terrain.mjs` (`parseArgs`, `gridFor`); `js/terrain.js` (`buildTerrainTiles`, `terrainLattice`,
`terrainY`); `js/city-grid.js` (`LATTICE`, crida a `buildTerrainTiles(WORLD_BOUNDS, LATTICE.cell, FEATURES.terrainTile)`);
`js/city-config.js` (`FEATURES.terrainTile = 500`); `tests/terrain.test.cjs` ("buildTerrainTiles reproduces terrainY on
the lattice and tiles the bounds").

## Alternatives considerades

- **Cel·la de 5 m** (VDR-0013): la resolució del WCS és 5 m i es perd la meitat; però el fitxer passaria a 7,3 MB i el
  tauler a 4× triangles, i el detall fi (murs, terrasses) l'eina igualment l'esborra dins de la ciutat. Es deixa per a
  quan hi hagi el LiDAR de 2 m (VDR-0018) i una raó per pagar-lo.
- **Retícula pròpia del tauler** (VDR-0016): dues interpolacions diferents a la mateixa (x, z); és el que fallava.
- **Cel·la de 20 m**: els carrers de 6–8 m desapareixen entre mostres.

## Conseqüències

- 10 m és més groller que el model: una vorada o un mur de 2 m no existeix al relleu; el que fa conduïbles els carrers
  és el condicionament de l'eina (VDR-0022), no la resolució.
- El tauler són *tiles* de 500 m (`FEATURES.terrainTile`) per al *frustum culling*; la consola ho diu
  (`[cityGrid] relief on: N deck tiles of 500 m, 10 m cells, …`). El nombre de *tiles* no s'ha comprovat en aquesta
  sessió de documentació.
- VDR-0013 queda **substituïda** pel que fa a la cel·la; el format `TRN1` (capçalera de 64 bytes, Int16 en cm relatius
  a la Plaça Vella, fitxer a part) continua vigent tal com el descriu, amb la taula `BRDG` afegida per VDR-0023.

*Un polsim de Viandox:* una sola graella per a tot el forn; si cada safata tingués la seva, res no quedaria a nivell.
