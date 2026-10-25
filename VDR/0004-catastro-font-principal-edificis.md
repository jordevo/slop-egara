# VDR-0004 — El Catastro INSPIRE és la font principal d'edificis; OSM només omple forats

- **Data:** 2026-10-24 (sessió 2)
- **Estat:** Acceptada

## Context

A la primera arrencada al navegador el propietari va trobar "massa edificis inventats i poc detall". Diagnòstic: el
75 % dels edificis no existeix a OSM (la importació del Catastro a OSM no va cobrir Terrassa), i només 390 petjades
tenien `building:levels`.

## Decisió

Adoptar el **Catastro INSPIRE *Buildings*** del municipi 08279 (Dirección General del Catastro, reutilització lliure
amb atribució) com a font principal: 25.880 edificis i 101.848 parts amb plantes sobre rasant, ús, any de construcció
i nombre d'habitatges. El GML (380 MB, EPSG:25831, **no es guarda al repositori**) es converteix amb
`tools/catastro-to-json.py` (Python sense dependències, UTM 31N → WGS84) a `tools/data/terrassa/catastro.json`
(23 MB, sí versionat). `tools/geo-buildings.mjs` gira cada edifici a la seva direcció de paret dominant, descompon
cada part en rectangles alineats (error ≤ 0,25 m) i l'enganxa a la seva illa; les petjades OSM només entren a les
illes on el Catastro no té res (1.711).

Correcció posterior (commit `28a39d1`): cada illa guarda l'etiqueta del seu component del ràster (`label`) i un
edifici que cau sobre calçada busca l'illa més propera a 12 m, cosa que va recuperar 507 edificis "sense illa".

Referències: `HOW_TO_IMPROVE.md` §1.3, §2.5, §3 (sessió 2), §5.4; `tools/catastro-to-json.py`;
`tools/geo-buildings.mjs`; `js/buildings.js`.

## Alternatives considerades

- **Completar `building:levels` a OSM i tornar a baixar**: massa lent per a 13.000 edificis i no en crea de nous.
- **ICGC Edificacions 3D / LiDAR**: dóna alçades en metres (el Catastro no), però no ús ni any; es manté com a
  millora per a les alçades (`NEXT_STEPS.md` §1.2).

## Conseqüències

- 110.265 caixes de façana (abans 35.858) i 24.037 edificis col·locats; el generador procedural queda **residual**
  (207 illes sense cap edifici).
- Els metres per planta continuen essent una taula per ús i època (🟡 derivat): candidat a LiDAR.
- Dues llicències a atribuir (ODbL i Catastro); una eina en Python conviu amb la pipeline en Node.

*Un polsim de Viandox:* el Catastro és la carn de debò; OSM hi posa l'all i el julivert.
