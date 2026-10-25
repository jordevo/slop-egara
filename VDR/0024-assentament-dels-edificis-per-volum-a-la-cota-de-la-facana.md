# VDR-0024 — Cada volum d'edifici s'assenta a la cota més alta de les seves façanes al carrer, amb sòcol cec fins al terreny més baix i façanes llargues esglaonades

- **Data:** 2026-10-25
- **Estat:** Acceptada (substitueix el "cota mínima de la petjada" de VDR-0016; revisada el mateix dia: plataformes
  només a les illes grans, i els modes aparcats del jugador assentats al relleu)

## Context

VDR-0016 assentava cada edifici a la **cota mínima** del terreny sota la seva petjada (`terrainMin`). Amb el relleu
real el propietari va veure **edificis enterrats** per la façana (la cantonada més baixa és sovint la del darrere o la
d'una illa que fa pendent) i va fixar la regla: *"si sabemos su forma y altura, ha de empezar desde el suelo, siempre"*,
explícitament **sense "ñapas"** (`HOW_TO_IMPROVE.md` §3, sessió 3, punt 8). A més, un registre rural del Catastro
reparteix les seves construccions a centenars de metres: qualsevol cota "per edifici" és absurda per a aquests.

## Decisió

A `commit()` de `js/buildings.js`, quan hi ha relleu, **per volum (`part`), no per edifici**:

1. **Volum de planta baixa** (`p.y0 ≤ EPS`, no `plinth`): la base és la **cota més alta del terreny al llarg de les
   seves façanes al carrer** (`frontHeights`: les cares amb `faces[...] ≤ WALL_KINDS.entry`, mostrejades a les dues
   cantonades de cada cara). Si no té cap façana al carrer, la **mediana** de les cinc mostres sota la petjada
   (quatre cantonades i centre). Es guarda a `partBase`.
2. **Volum superior** (`p.y0 > EPS`): pren la base del volum de planta baixa que té sota (el que conté el seu centre,
   o el primer).
3. **Sòcol**: per a cada volum de planta baixa, `partPlinth` = **el punt més baix** de les cinc mostres; si la caiguda
   (`drop = base − plinth`) supera 0,25 m, s'afegeix una **caixa sense finestres** (`faces = blankStone` als quatre
   costats) de `drop + 0,3` m d'alçada des de sota la planta baixa, amb el seu col·lisionador. Res no flota.
4. **Esglaonat** (`stepParts`, abans de tot l'anterior): una façana al carrer de **≥ 18 m** que puja **> 1 m** entre
   els seus extrems es parteix en `ceil(climb / 1 m)` trossos (de 2 a 6), separats 1 cm; les cares del tall passen a
   `WALL_KINDS.lotLine` (mitgeres cegues). Cada tros s'assenta pel seu compte.
5. **Monuments** (`js/landmarks.js`): `Sink.base` és el **percentil 90** de les cotes del contorn (un vèrtex perdut
   talús amunt no aixeca tot l'edifici), i un sòcol de formigó (`wallRing(ring, −drop − 0,5, 0)`) tanca fins al vèrtex
   més baix si la caiguda supera 0,3 m; sense contorn, la cota del punt.

A l'eina, la **plataforma** sota la part interior de la petjada (`flattenBuildings`, VDR-0022) **només es fa a les
illes grans (> 260 m) que conserven el model**, i mai per sobre del carrer més baix de l'edifici: a les illes urbanes
la membrana ja és llisa i una plataforma posava graons entre veïns i un montícul a una porta (el cas de Carrer de
Colom – Carretera de Montcada que va reportar el propietari; `HOW_TO_IMPROVE.md` §2.8 punt 5, §3 sessió 3 punt 10).

El mateix principi val per al **jugador**: els modes aparcats (vianant, ciclista) es creaven a `y = 0` i, amb el relleu,
la "gent volant al punt d'aparició" que va veure el propietari eren aquests; `spawnAt(ahead, right, y)` de
`js/controllers.js` ara retorna `y + groundHeightAt(x, z)` ("a parked mode never floats or sinks at the spawn").

El material de façana compta les plantes des de la base de cada caixa (atribut d'instància `base`, VDR-0017), de
manera que el sòcol no desplaça les finestres. Les estadístiques es publiquen a `window.__slop.seating` (VDR-0026).
Mesurat al navegador (`HOW_TO_IMPROVE.md` §3, sessió 3, punt 8): **115.517 volums, 50.962 sòcols (1.559 de més de
3 m), 2.134 esglaons, 1.617 volums amb el darrere enterrat > 2 m** (naus en vessant i polígons de l'oest, on la
plataforma de VDR-0022 no entra a la franja de carrer).

Referències: `js/buildings.js` (`commit`: `stepParts`, `frontHeights`, `partBase`, `partPlinth`, `BLANK`, `seating`);
`js/landmarks.js` (`Sink.base`, `wallRing`, bucle de `LANDMARK_SITES`); `js/tsl-materials.js` (atribut `base`);
`js/controllers.js` (`spawnAt`); `tools/geo-terrain.mjs` (`flattenBuildings`); `HOW_TO_IMPROVE.md` §5.4, §5.7, §3
sessió 3 (punts 8 i 10).

## Alternatives considerades

- **Cantonada més baixa** (VDR-0016, `terrainMin`): mai flota, però enterra la façana al carrer; és el que va veure el
  propietari.
- **Mediana de la petjada**: la meitat de les façanes floten o s'enterren mig metre.
- **Cota de la façana però per edifici**: a les parcel·les rurals del Catastro dóna sòcols de desenes de metres (el
  propietari en va reportar un de ~79 m durant la sessió; la xifra no consta als fitxers del repositori).
- **Retallar el volum contra el terreny** (booleans): car, i trenca la instanciació de caixes.
- **Esglaonar sempre**: multiplica els volums; només on la façana puja de debò.
- **Plataforma sota cada edifici de la ciutat** (la primera versió): a les illes urbanes posava un graó entre dos veïns
  assentats a cotes diferents i aixecava el terra davant d'una porta; la membrana de l'illa ja fa la feina.

## Conseqüències

- Les façanes al carrer comencen al terra sempre; les mitgeres i els patis del darrere poden quedar enterrats (1.617
  volums > 2 m, mesurats abans de restringir les plataformes a les illes grans; la xifra posterior no consta al
  diari): és el preu de no tocar el relleu darrere la franja de carrer.
- 50.962 caixes més (sòcols) i els seus col·lisionadors.
- Els materials de façana dels monuments encara compten les plantes en coordenades del món (`NEXT_STEPS.md`, pendent).
- El comentari de capçalera de `js/terrain.js` encara diu "seat every building at the lowest point of its footprint":
  està desfasat respecte d'aquesta decisió.

*Un polsim de Viandox:* cada pastís toca el plat per la banda que es veu; el que sobra per darrere es tapa amb el sòcol
de massapà, no s'enfonsa el pastís.
