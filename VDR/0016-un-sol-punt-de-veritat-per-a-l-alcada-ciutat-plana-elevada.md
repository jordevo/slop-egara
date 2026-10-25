# VDR-0016 — Un sol punt de veritat per a l'alçada (`terrainY` → `groundHeightAt`); la ciutat es genera plana i després s'eleva

- **Data:** 2026-10-25
- **Estat:** Acceptada (implementada; dos detalls substituïts per VDR-0020 i VDR-0024, vegeu "Conseqüències")

## Context

Tot el que hi ha a la ciutat (asfalt, voreres, vorades, edificis, monuments, mobiliari, arbres, trànsit, vianants i el
jugador) assumeix `y = 0` com a calçada. `city-grid.js` ja té un únic punt d'enganxament per a l'alçada local,
`groundHeightAt(x, z)` (0 a la calçada, `sidewalkHeight` a les voreres, parcs enfonsats), que llegeixen
`controllers.js`, `street-details.js` i, a través d'ells, la resta. `NEXT_STEPS.md` §1.1 ja proposava ampliar-lo.

## Decisió

1. **`terrainY(x, z)` a `js/terrain.js` és l'única font de l'alçada del relleu.** Interpola sobre el grid amb el
   mateix **tall per triangles** (diagonal b–d de cada cel·la) que fa servir la malla renderitzada, de manera que el
   que es calcula i el que es veu coincideixen exactament; fora del grid, es fixa a la vora. Sense relleu, retorna 0.
2. **`groundHeightAt()` a `js/city-grid.js` hi suma `terrainY`**: `localGroundAt(x, z) + terrainY(x, z)` (i, des de
   VDR-0023, tria el tauler d'un pont si n'hi ha un i és el nivell més proper al `hint`). Tot el que ja el llegia
   (jugador, trànsit, vianants, props) puja sense tocar-lo. `roadHeightAt` és la variant per a vehicles (mai la vorera).
3. **La ciutat es continua generant plana i després s'eleva**, en lloc de reescriure cada constructor:
   - la geometria del terra (voreres, lloses de parc, vorades, tanques, camins) s'escriu amb `y` relativa a la calçada
     i `addGeo` la drapa vèrtex a vèrtex (`drapeGeometry`) després de tallar-la **sobre la retícula del tauler**
     (`refineGeometry` / `latticeCapGeometry`, VDR-0020; la bisecció d'arestes ≤ 8 m d'aquest registre es va descartar);
   - el **tauler d'asfalt** deixa de ser un pla i passa a ser una malla del relleu per *tiles* (frustum culling) amb
     `buildTerrainTiles(WORLD_BOUNDS, LATTICE.cell, FEATURES.terrainTile)`: **10 m de cel·la en tiles de 500 m**, sobre
     la retícula de les dades (VDR-0021);
   - les **vorades** baixen fins a 0,4 m sota el tauler (`KERB_BOTTOM = −0.4`) perquè no s'obri cap escletxa en pendent;
   - **edificis i monuments** s'assenten al relleu; la cota mínima de la petjada (`terrainMin`) d'aquest registre es va
     substituir per la cota de la façana al carrer amb sòcol (VDR-0024);
   - els **vehicles** llegeixen l'alçada del terreny i **capcinegen amb el pendent** (`groundPose` a `traffic.js` amb
     `_gy` i `_slope`; el cotxe del jugador amb `terrainGradient` a `controllers.js`);
   - el **Parc de Vallparadís enfonsat i els canals de les rieres sintètics** de `city-grid.js` **es deixen de construir
     quan el relleu real està actiu** (`for (const b of relief ? [] : BLOCKS)`): el MDE ja porta la vall.

Referències: `js/terrain.js` (`terrainY`, `terrainGradient`, `terrainMin`, `drapeGeometry`, `buildTerrainTiles`);
`js/city-grid.js` (`groundHeightAt`, `roadHeightAt`, `localGroundAt`, `addGeo`, `KERB_BOTTOM`, exclusió dels blocs
enfonsats); `js/traffic.js` (`groundPose`); `js/controllers.js` (`getGroundHeight`, `terrainGradient`); `js/main.js`
(`loadTerrain` abans de `buildCityGrid`); `tests/terrain.test.cjs`; `NEXT_STEPS.md` §1.1 (ordre de migració).

## Alternatives considerades

- **Afegir `y` als nodes i arestes del graf** i fer que cada constructor pregunti la cota (`NEXT_STEPS.md` §1.1, pas 3):
  més "correcte" però toca tots els mòduls alhora; l'eina ho fa internament per als ponts (VDR-0022, VDR-0023).
- **Interpolació bilineal** a `terrainY`: més suau, però no coincideix amb els triangles de la malla i les rodes
  flotarien o s'enfonsarien un parell de centímetres.
- **Assentar cada edifici a la cota mitjana**: les cantonades de sotavent quedarien a l'aire (vegeu VDR-0024).
- **Mantenir Vallparadís sintètic damunt del relleu real**: sumaria dues valls.

## Conseqüències

- Un sol canvi (`groundHeightAt`) propaga el relleu a tot el que ja hi estava connectat; el que no (el tauler,
  `buildings.js`, càmeres i àudio) es va modificar un cop i darrere del commutador (VDR-0025 per a càmeres i àudio).
- Més triangles al terra: la primera versió (bisecció) va fer caure el navegador i la va substituir VDR-0020.
- Ponts i viaductes: VDR-0023.
- **Verificació (2026-10-25, segona passada):** tot el que descriu aquest registre és al working tree de la branca
  `terrain` i es prova a `tests/terrain.test.cjs` (9 tests): `groundHeightAt` suma `terrainY`; `buildTerrainTiles` es
  crida amb `LATTICE.cell` (10 m, del fitxer) i `FEATURES.terrainTile` (500); `KERB_BOTTOM = −0.4`; `groundPose` dóna
  `_slope`; els blocs enfonsats s'ometen amb relleu; `main.js` crida `loadTerrain`. La nota anterior ("no hi són encara
  al working tree") ja no és vigent. Dos detalls d'aquest registre han canviat de forma i tenen registre propi: el
  refinament per bisecció (→ VDR-0020) i la cota mínima dels edificis (→ VDR-0024).

*Un polsim de Viandox:* la massa s'estén plana i després es posa damunt del motlle; si el motlle és bo, agafa la forma
sola.
