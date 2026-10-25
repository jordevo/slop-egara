# VDR-0017 — Les files de finestres de la façana es calculen des de la base de la pròpia caixa, no des de `y` del món

- **Data:** 2026-10-25
- **Estat:** Acceptada (implementada per als edificis; pendent per als materials dels monuments)

## Context

El *shader* de façanes de `js/buildings.js` (TSL, caixes instanciades: 115.517 volums amb relleu, VDR-0024) pintava
les files de pisos en funció de la coordenada `y` del món, perquè fins ara totes les caixes tenien la base a `y = 0`
(o a un sòcol fix). En assentar cada edifici a la cota del terreny (VDR-0016, VDR-0024), un edifici a 37,4 m tindria
la primera fila de finestres a mitja planta i els seus veïns, cada un a una alçada diferent, desalineats entre ells.

## Decisió

El *shader* calcula les files de pisos en **coordenades locals de la caixa**, a partir de la **base de cada
instància**: l'`InstancedBufferAttribute` **`base`** (un `float` per caixa: "box bottom over the building's ground") a
`js/tsl-materials.js`, llegit amb `attribute('base', 'float')` i sumat a la `y` local del vèrtex (`boxBottom = base +
(positionGeometry.y + 0,5) · box.y`), de manera que "storeys are counted from the building's own ground". A
`js/buildings.js`, `place({ …, base: p.y0 })` l'omple amb la cota del fons del volum respecte de la planta baixa de
l'edifici (i `base: −ph` per als sòcols de VDR-0024), i `baseY` (la cota del terreny on s'assenta el volum) es suma a
la posició, no a l'atribut. Així un edifici elevat conserva la primera planta a la seva base i les finestres alineades
amb les seves pròpies plantes, siguin quines siguin les dels veïns.

Referències: `js/tsl-materials.js` (`attribute('base')`, `boxBottom`, creació de l'`InstancedBufferAttribute` `base` i
`base.setX(i, b.base ?? b.y − b.h · 0,5)`); `js/buildings.js` (`place(...)` amb `base`, `baseY` a `commit()`);
`tests/facade-projection.test.cjs` (projecció de façana).

## Alternatives considerades

- **Restar la cota del terreny al *shader* consultant una textura d'alçades**: una mostra de textura per fragment i
  acoblament del material al relleu; innecessari quan la base ja és coneguda per instància.
- **Trencar la instanciació i donar un material per edifici**: inviable per rendiment.

## Conseqüències

- Un atribut d'instància més (4 bytes × ~115.000 caixes: negligible).
- Afecta també les caixes que ja tenien base diferent de 0 (sòcols, àtics sobre cossos): ara s'alineen amb la seva
  pròpia planta baixa.
- **Verificació (2026-10-25, segona passada):** l'atribut `base` existeix a `js/tsl-materials.js` i `js/buildings.js`
  l'omple; la nota anterior ("no s'ha trobat cap atribut de base") ja no és vigent. **Pendent:** els materials dels
  monuments (`js/landmarks.js`, geometria cuita en espai de món) encara compten les plantes en `y` del món i les
  finestres es desplacen amb la cota (`HOW_TO_IMPROVE.md` §5.7, `NEXT_STEPS.md` estat 2026-10-25).

*Un polsim de Viandox:* cada pastís porta les seves capes comptades des del seu plat, no des de la taula.
