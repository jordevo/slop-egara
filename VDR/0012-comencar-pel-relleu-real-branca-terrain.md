# VDR-0012 — Començar el full de ruta pel relleu real, en una branca `terrain` i darrere de `FEATURES.terrain`

- **Data:** 2026-10-25
- **Estat:** Acceptada (en curs: la branca `terrain` encara no s'ha fusionat a `main`)

## Context

`NEXT_STEPS.md` prioritza quatre millores de baix risc (col·lisions, semàfors, aparició equilibrada, policia) i deixa
el relleu (§1.1) com a "la millora de més impacte visual que queda", però també la més transversal i arriscada
(prioritat 10 a la taula, "Alt" en esforç i risc, depèn del MDE de l'ICGC). Terrassa puja de ~250 m al sud a ~400 m
al nord, amb el torrent de Vallparadís 8–15 m enfonsat i la Riera de les Arenes encaixada; una ciutat plana ho
delata de seguida.

## Decisió

Invertir l'ordre recomanat i **atacar primer el relleu**, perquè és la palanca visual més gran i perquè condiciona
altres eixos (física amb pendent §2.1.2, ponts i túnels a cota, càmeres). Es fa seguint VDR-0011: branca pròpia
**`terrain`** i tot darrere d'un commutador a `js/city-config.js`:

```js
const FEATURES = {
  terrain: true,                               // el relleu real; apagat, o sense fitxer, la ciutat és plana
  terrainFile: './js/terrassa-terrain.bin',    // la seva mida de cel·la (10 m) és la retícula del tauler d'asfalt
  terrainTile: 500                             // m: tiles del tauler, per al frustum culling
};
```

Com a xarxa de seguretat extra, el runtime es comporta com fins ara si el fitxer no existeix o no es pot llegir
(`js/terrain.js`: sense dades, totes les funcions són no-op). `js/main.js` fa `await loadTerrain(FEATURES.terrainFile)`
**abans** de `buildCityGrid(scene)` (pas 3 de l'arrencada, marca `[init] terrain`), i `index.html` afegeix
`<link rel="modulepreload" href="./js/terrain.js">`.

Referències: `NEXT_STEPS.md` §1.1 i "Priorización propuesta"; `js/city-config.js` (`FEATURES`, exportat);
`js/main.js` (pas 3); `index.html`; `js/terrain.js` (capçalera); branca `terrain`.

## Alternatives considerades

- **Seguir l'ordre 1+2+3+4 de `NEXT_STEPS.md`**: menys risc, però cada una d'aquelles millores s'hauria de revisar
  després en afegir el relleu (alçades de props, trànsit, col·lisions).
- **Només relleu regional** (substituir `terrainModel()` de `surroundings.js` pel MDE, ciutat plana): canvi petit, però
  deixaria Vallparadís i les rieres falses.

## Conseqüències

- Sessions llargues sobre una branca; `main` queda arrencable mentrestant. La branca toca 14 mòduls de `js/`
  (`city-grid`, `buildings`, `landmarks`, `tsl-materials`, `traffic`, `controllers`, `cameras`, `audio-sources`,
  `road-paint`, `street-details`, `surroundings`, `main`, `city-config`, `terrain`) i 3 tests.
- `FEATURES` és des d'ara l'únic lloc dels commutadors (VDR-0011); `terrain` n'és el primer.
- Decisions derivades: VDR-0013 i VDR-0021 (format i cel·la del fitxer), VDR-0014, VDR-0015 (eina i mode sintètic),
  VDR-0016 (un sol punt de veritat), VDR-0017 (finestres des de la base), VDR-0018 (MDE de l'ICGC, descarregat),
  VDR-0020 (tall sobre la retícula), VDR-0022 (condicionament urbà), VDR-0023 (ponts com a taulers), VDR-0024
  (assentament per volum), VDR-0025 (alçades sobre el terra), VDR-0026 (prova de fum) i VDR-0027 (elevar un sol cop).
- Verificat el 2026-10-25 al working tree de la branca: `FEATURES` a `js/city-config.js` té els tres camps citats;
  `js/main.js` fa `await loadTerrain(...)` i `markInit('terrain')` abans de `buildCityGrid`; `index.html` preté
  `./js/terrain.js`; el fitxer `js/terrassa-terrain.bin` és el real de l'ICGC (VDR-0018, VDR-0021).

*Un polsim de Viandox:* abans de salar, s'escalfa la planxa: el relleu és la planxa de tot el que vindrà.
