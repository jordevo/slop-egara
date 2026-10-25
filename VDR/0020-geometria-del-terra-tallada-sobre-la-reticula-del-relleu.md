# VDR-0020 — La geometria del terra es talla sobre la pròpia retícula del relleu, no per bisecció d'arestes

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

VDR-0016 decidia drapar la geometria del terra (lloses de vorera, parcs, vorades, tanques, camins) "refinada fins a
arestes ≤ 8 m per bisecció de l'aresta més llarga" i després elevada vèrtex a vèrtex. A la primera prova al navegador
del propietari el resultat va ser una **pantalla negra**: les voreres sortien en ~9 M de triangles, un únic búfer de
vèrtexs de **331 MB**, per sobre del `maxBufferSize` de WebGPU (256 MB), i `buildCityGrid` trigava **20 s**
(`HOW_TO_IMPROVE.md` §3, sessió 3, punt 4). La bisecció genera un ventall d'estelles per cada polígon llarg i estret
(una vorada de 100 m × 0,25 m) i, a més, els vèrtexs resultants no cauen sobre els triangles del tauler d'asfalt, de
manera que lloses i tauler es travessen en pendent.

## Decisió

Tota geometria del terra es **talla contra la retícula sobre la qual es dibuixa el tauler** (VDR-0021), de manera que
cada peça queda dins d'un sol triangle del tauler i, drapada vèrtex a vèrtex, s'hi assenta exactament:

- `refineGeometry(geo, cell, { dropDown, x0, z0, noDiag })` a `js/terrain.js`: retalla cada triangle per les tres
  famílies de rectes de la retícula (x = x0 + k·cell, z = z0 + k·cell i les diagonals b–d x + z = const). Les peces
  són convexes i es triangulen en ventall; els atributs s'interpolen linealment. La sortida és **indexada**, amb els
  vèrtexs de retícula compartits (`indexedFromSoup`). `dropDown` descarta primer les cares que miren cap avall (les
  tapes inferiors de les extrusions, que no es veuen mai); `noDiag` omet els talls diagonals a les franges estretes.
- `latticeCapGeometry(pts, holes, y, lat, triangulate)`: una **llosa plana construïda directament sobre la retícula**:
  cada cel·la interior és els dos triangles del propi tauler i només les cel·les que el contorn travessa es triangulen
  (`THREE.ShapeUtils.triangulateShape`) i es retallen contra la cel·la i la diagonal. Marca `userData.latticeAligned`
  perquè `addGeo` la drapi sense tornar-la a tallar.
- A `js/city-grid.js` (`buildCityGrid`): `addGeo` drapa amb `DRAPE_OPTS = { dropDown: true, x0, z0 }` de
  `terrainLattice()`; **les lloses** (`addSlab` → `addFlat`) són una sola tapa a `SW_TOP + 0.005`, sense cantells (els
  amaga la vorada); **les vorades** (`addKerb`) són `buildKerbGeometry(poly, KERB_BOTTOM = −0,4, SW_TOP, 0,25)`: només
  la paret exterior (des de 0,4 m sota el tauler, perquè en pendent no s'obri cap escletxa) i una **franja superior de
  0,25 m** amb falques a les cantonades; ni paret interior ni fons. Porten `userData.noDiag = true`.

Mesurat amb Chrome headless (VDR-0026): vèrtexs del terra de **~23 M a ~7 M**, `cityGrid` de **20 s a ~4,5 s** (0,5 s
sense relleu), 0 errors de WebGPU (`HOW_TO_IMPROVE.md` §3, sessió 3, punt 4; §5.7).

Referències: `js/terrain.js` (`refineGeometry`, `indexedFromSoup`, `latticeCapGeometry`, `drapeGeometry`);
`js/city-grid.js` (`addGeo`, `addFlat`, `addSlab`, `addKerb`, `buildKerbGeometry`, `KERB_BOTTOM`);
`tests/terrain.test.cjs` ("refineGeometry cuts along the deck lattice…", "…can drop the downward faces…",
"refined geometries share their lattice vertices", "latticeCapGeometry fills interior cells…").

## Alternatives considerades

- **Bisecció de l'aresta més llarga** (VDR-0016): és la que va fallar; una franja de vorada costa una cascada
  d'estelles per cel·la en lloc d'una peça.
- **Refinar menys (arestes de 15–20 m)**: menys triangles, però els vèrtexs continuen fora dels triangles del tauler
  i les lloses el travessen en pendent.
- **Mantenir lloses i vorades extruïdes senceres** (cares laterals, interiors i fons) i només tallar-les: la majoria
  d'aquestes cares no es veu mai; es paga memòria per res.
- **Pintar voreres com a textura sobre el tauler** (sense volum): elimina el problema, però es perd el graó de la
  vorada que el jugador i els vehicles noten.

## Conseqüències

- Les peces drapades coincideixen exactament amb la superfície del tauler: cap *z-fighting* ni escletxa en pendent,
  mentre la retícula del tall sigui la del tauler (VDR-0021).
- Les vorades no tenen paret interior ni fons: si mai es mira el terra des de sota (càmera soterrada), es veurà el buit.
- La geometria del terra és indexada i comparteix vèrtexs: menys memòria també sense pendent.
- `refineGeometry` es fa servir igualment per a la pintura vial (VDR-0023) i per a qualsevol prop futur que es drapi.

*Un polsim de Viandox:* es talla la pasta amb el motlle que ja hi ha a la safata, no a ull amb el ganivet.
