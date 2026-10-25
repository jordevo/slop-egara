# VDR-0023 — Els ponts són taulers sobre el relleu, no terraplens: taula `BRDG` al fitxer i nivell triat per proximitat (`hint`)

- **Data:** 2026-10-25
- **Estat:** Acceptada (revisada el mateix dia: estreps elevats en lloc d'excavar el carrer de sota; sense pilars ni
  arcs; els passos superiors sense etiqueta continuen com a rampes)

## Context

VDR-0016 deixava els ponts "a cota de terreny: pas següent". La primera versió els gravava com a rampes al relleu, i el
propietari va veure **calçades que s'enfonsaven als ponts** (la zona de la Mútua, segons el seu informe de sessió;
`HOW_TO_IMPROVE.md` §3, sessió 3, punt 5: "calzadas que se hunden en los puentes"). El problema de fons és la
limitació d'**una sola alçada per (x, z)**: un pont sobre Vallparadís i el camí del parc que passa per sota no poden
compartir un ràster. OSM etiqueta 140 trams amb `bridge=yes`, i `GEO.roadGraph.links` ja porta el flag.

## Decisió

1. **A l'eina**: els trams `bridge` **no es graven** al relleu (`carveRoads` els exclou tret d'`embank: true`); són
   **rectes entre les cotes dels seus estreps** (`nodeHeights`, VDR-0022) i es guarden en una **taula `BRDG` després
   del grid** del `.bin`: `'BRDG'`, `u32 count`, i per tram `u32 link` (índex a `GEO.roadGraph.links`), `f32 y0`,
   `f32 y1` (cota del tauler als dos extrems, relativa a la Plaça Vella) (`bridgeDecks`, `encodeTerrain`).
   **Si sota un tauler passa una calçada amb menys de 4,6 m de gàlib** (i ja ≥ 1,5 m per sota del tauler: un pas
   inferior de debò, no l'accés del propi pont), **s'eleven els dos estreps** el que falta, fins a 5 m
   (`raiseBridgeAbutments`, llegeix `grid.carriagewayMask`; 19 taulers al fitxer actual) i els carrers d'accés hi
   pugen en rampa limitada: **mai s'excava el carrer de sota**. Després, el terreny es rebaixa ≥ 0,6 m sota el tauler
   (`clearUnderBridges`), **sense tocar cap cel·la de `roadMask`**.
2. **Al runtime** (`js/terrain.js`): `parseTerrain` llegeix la taula; `buildBridges` reconstrueix cada tauler a partir
   del seu *link* (polilínia, amplada de calçada + 2,4 m de vorera per banda) en una graella espacial de 64 m;
   `bridgeAt(x, z, extra)` troba el tauler sota un punt (amb la seva distància lateral `t`); `deckY(b, d)` interpola la
   cota al llarg del tauler; `surfaceY(x, z, hint)` tria entre terreny i tauler.
3. **El nivell el tria qui pregunta**: `groundHeightAt(x, z, hint)` i `roadHeightAt(x, z, hint)` a `js/city-grid.js`
   retornen, si hi ha `hint` (l'alçada actual de qui pregunta), **el nivell més proper a aquesta alçada**; sense `hint`,
   el més alt. Sobre el tauler, les voreres van `SW_TOP` més amunt quan `|t|` supera mitja calçada. El jugador hi passa
   la seva `position.y` (`controllers.js`, `getGroundHeight(x, z, mode, hint)`): **un cotxe sota un viaducte s'hi queda a
   sota**.
4. **Trànsit i vianants no endevinen: ho saben per l'arista**. `js/road-network.js` propaga `bridge` dels *links* a
   les arestes; `traffic.js` (`vehicleGround` dins de `groundPose`) i `pedGround` fan servir `bridgeAt(...).y` només si
   `edge.bridge`, i `terrainY` altrament.
5. **Geometria** (`buildBridgeGeometry` a `js/city-grid.js`): calçada d'asfalt (el mateix `roadMat` dels carrers),
   llosa de 0,9 m de cantell amb cares inferior i laterals, voreres elevades 0,15 m i **ampits** d'1,1 m × 0,3 m amb
   **col·lisionadors de paret** (`addWallCollider`). No es drapa (`addGeo(..., raw = true)`): és l'única cosa que no és
   terra. `js/road-paint.js` pinta els carrils també sobre els taulers (`surfaceY`).

Referències: `tools/geo-terrain.mjs` (`bridgeDecks`, `encodeTerrain`, `raiseBridgeAbutments`, `clearUnderBridges`,
`carveRoads`);
`js/terrain.js` (`parseTerrain`, `buildBridges`, `bridgeAt`, `deckY`, `surfaceY`, `bridgeList`); `js/city-grid.js`
(`groundHeightAt`, `roadHeightAt`, `buildBridgeGeometry`, bloc "The bridges" de `buildCityGrid`); `js/controllers.js`
(`getGroundHeight`); `js/traffic.js` (`groundPose`, `pedGround`); `js/road-network.js` (`bridge` als *links* i arestes);
`js/road-paint.js`; `tests/terrain.test.cjs` ("bridge decks: parsed from the file, found under a point, chosen by the
height hint"); `HOW_TO_IMPROVE.md` §2.8 (punts 1 i 3), §3 sessió 3 (punts 7, 9 i 10), §5.7.

## Alternatives considerades

- **Terraplens** (primera versió; `embank: true` encara existeix): la calçada de sota s'enfonsa o el pont baixa a la
  vall.
- **`y` als nodes i arestes del graf** (`NEXT_STEPS.md` §1.1): és el que fa l'eina internament (`nodeHeights`), però
  només s'exporta per als ponts; estendre-ho a tot el graf toca tots els mòduls.
- **Capes de terreny** (dos ràsters): memòria doble per 140 trams.
- **Detectar encreuaments a nivells diferents al runtime** sense etiqueta: és el que falta per als passos superiors
  de la C-58 i la N-150; avui són rampes limitades al 18 % (VDR-0022).
- **Rebaixar el terreny sota el tauler sense excepcions** (la primera versió de `clearUnderBridges`): excavava els
  carrers que passen per sota (l'Avinguda de Joaquim de Sagrera sota la N-150, segons el propietari). Un carrer no es
  rebaixa mai per un pont; el pont puja.

## Conseqüències

- La limitació d'una alçada per (x, z) s'aixeca **només** als trams etiquetats `bridge`; els túnels queden exclosos.
- Sense pilars ni arcs: els taulers floten sobre la vall (pendent a `NEXT_STEPS.md`).
- Les mesures del tauler del Pont del Passeig (≈ 11,4 m i 8,8 m als dos extrems) les va prendre el propietari durant la
  sessió amb la prova de fum (VDR-0026); **no consten als fitxers del repositori** i no s'han pogut verificar aquí.
- Un tauler inclinat per un camí que baixava al parc es va corregir fent que l'estrep prengui el punt més alt dels
  primers 30 m (VDR-0022, punt 1).
- Elevar els estreps fa pujar en rampa els carrers d'accés (el limitador del 18 % de VDR-0022 hi mana): un pont que
  OSM dibuixa curt pot quedar amb rampes més llargues que les reals.

*Un polsim de Viandox:* el pont és la graella sobre l'olla, no una paret de farina que tapa el brou.
