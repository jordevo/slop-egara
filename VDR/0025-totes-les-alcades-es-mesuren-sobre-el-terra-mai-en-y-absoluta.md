# VDR-0025 — Totes les alçades es mesuren sobre el terra (`groundHeightAt` / `terrainY`), mai com a `y` absoluta

- **Data:** 2026-10-25
- **Estat:** Acceptada (regla per a tot codi nou; ampliada el mateix dia al *frustum* i a les espurnes del trànsit)

## Context

Amb la ciutat plana, "a 0,65 m" i "a 0,65 m sobre el terra" eren el mateix, i diversos mòduls comparaven la `y` del
món amb constants: la càmera tenia dos sòls absoluts (`Math.max(0.65, y + h)`), l'àudio decidia si un vehicle era al
terra o un helicòpter volava mirant `position.y`, i el trànsit activava la col·lisió amb el jugador amb `y < 2.6`. Amb
el relleu real la caixa va de **−100 m a +510 m** respecte de la Plaça Vella: a cota negativa la càmera en tercera
persona quedava desenes de metres per sobre del cotxe (el propietari en va reportar ~40 m) i els motors callaven
(`HOW_TO_IMPROVE.md` §3, sessió 3, punt 5 (c) i (d), i punt 9: "cámara y audio con cotas absolutas"). VDR-0015 ja
avisava que el relleu sintètic "faria sortir qualsevol objecte que mesuri alçades en absolut".

## Decisió

**Cap mòdul compara `position.y` amb una constant.** Tota alçada és relativa al terra sota el punt:

- **Càmeres** (`js/cameras.js`): el sòl de la càmera és `groundHeightAt(camX, camZ) + 0,65` (tercera persona) i
  `groundHeightAt(x, z) + 0,55` (càmera baixa i correcció final de `currentPos.y`): "the floor is the ground under the
  camera, never an absolute height".
- **Àudio** (`js/audio-sources.js`): l'altitud de l'helicòpter i la condició de "a terra" són `position.y −
  terrainY(x, z)`; el motor de cada vehicle del trànsit sona a `(v._gy ?? terrainY(v.x, v.z)) + 0,7` (`_gy` el deixa
  `groundPose` de `traffic.js`); una font es descarta si `y − terrainY(x, z) < −0,05`; els vianants sonen a
  `terrainY + 0,012 / 0,22`.
- **Trànsit** (`js/traffic.js`): `player.active` és `position.y − terrainY(x, z) < 2,6` (el jugador és al terra, no a
  l'helicòpter). La prova de *frustum* `visible(x, z, r, y)` **rep l'alçada del terra** (`c._gy + 1`, `b._gy + 1`): abans
  assumia `y = 1` i, en un vessant, descartava vehicles i vianants que la càmera veia perfectament (desapareixien abans
  que el jugador hi arribés: `HOW_TO_IMPROVE.md` §3, sessió 3, punt 10). `nearView` (protecció de les aparicions) mesura
  la distància a la càmera des de `terrainY` del punt, i la distància dels fars agrupats des del `_gy` del vehicle
  (`dyCam = camY − c._gy`). Les **espurnes de col·lisió** neixen a `(v._gy || 0) + 0,56 / 0,58 / 0,65`, no a la cota 0.
- **Jugador aparcat** (`js/controllers.js`): `spawnAt` suma `groundHeightAt` (VDR-0024).
- **Jugador** (`js/controllers.js`): `getGroundHeight(x, z, mode, hint)` → `groundHeightAt` / `roadHeightAt`; l'aire
  sota els peus és `position.y − getGroundHeight(...)`.

Referències: `js/cameras.js` (línies amb `groundHeightAt`, comentaris "never an absolute height"); `js/audio-sources.js`
(`terrainY`, `_gy`); `js/traffic.js` (`player.active`, `groundPose`, `visible`, `nearView`, `spawnCollisionSparks`);
`js/controllers.js` (`getGroundHeight`, `spawnAt`);
`HOW_TO_IMPROVE.md` §5.7 ("Cámara y audio: todas las alturas son sobre el suelo").

## Alternatives considerades

- **Restar un desplaçament global** (la cota del jugador) a tot: només val mentre el jugador no es mou de cota.
- **Mantenir `y = 0` com a terra i moure el món** (centrar el relleu al jugador): canvia totes les matrius a cada
  quadre; innecessari amb una funció d'alçada barata.
- **Tolerar-ho a la càmera i a l'àudio només**: la regla ha de ser general, perquè el proper prop la trencaria igual.

## Conseqüències

- Una consulta d'alçada (`terrainY`: una cel·la, dos triangles) per càmera i per font d'àudio per quadre: negligible.
- Regla per a codi nou: qualsevol condició sobre `y` s'escriu com `y − groundHeightAt(x, z)` (o `terrainY` quan
  l'objecte no segueix vorades). Les revisions de codi ho han de mirar.
- La càmera de persecució encara no col·lideix amb els edificis (preexistent, es nota més als vessants:
  `HOW_TO_IMPROVE.md` §3, sessió 3, punt 10).

*Un polsim de Viandox:* el nivell del brou es mira des de la vora de l'olla, no des del terra de la cuina.
