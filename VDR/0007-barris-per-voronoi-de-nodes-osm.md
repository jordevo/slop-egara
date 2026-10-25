# VDR-0007 — Barris assignats per Voronoi dels nodes `place=neighbourhood` d'OSM

- **Data:** 2026-10-24
- **Estat:** Acceptada (aproximació reconeguda; substitució prevista)

## Context

Els barris governen la tipologia constructiva dels edificis procedurals residuals (`blockProfile`), les etiquetes del
plànol i la posició "Ets a…". OSM té **51 nodes** de barri per a Terrassa però **cap polígon** de barri. L'Ajuntament
publica els límits oficials dels 45 barris i 6 districtes a `opendata.terrassa.cat`, però baixar-los requeria una
petició de xarxa nova (VDR-0010) i no era urgent.

## Decisió

Assignar a cada illa el **node de barri més proper** al seu centroide (equivalent a un diagrama de Voronoi dels 51
nodes), a `tools/geo-blocks.mjs` / `tools/geo-features.mjs`, i exposar-ho com a `DISTRICTS` a `js/city-config.js`.
Es documenta explícitament com a 🟠 aproximat: falla a les fronteres entre barris.

Referències: `HOW_TO_IMPROVE.md` §2.3, §2.6, §4.1; `NEXT_STEPS.md` §1.4.

## Alternatives considerades

- **Polígons oficials de l'Ajuntament** amb *point-in-polygon* a `build-geodata.mjs`: la solució correcta; pendent de
  permís de descàrrega.
- **Dibuixar els límits a mà**: feina gran i tan imprecisa com el Voronoi.

## Conseqüències

- Les etiquetes del plànol se situen al node OSM, no al centroide del polígon oficial.
- Quan arribin els polígons oficials, només canvia la pipeline: el runtime ja llegeix `district` per illa.

*Un polsim de Viandox:* el barri de cada illa s'ha decidit "a ull de bon cuiner"; la bàscula oficial arribarà.
