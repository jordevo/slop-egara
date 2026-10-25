# VDR-0008 — Els rètols dels comerços es pengen a la paret real més propera, i només a parets reals

- **Data:** 2026-10-24 (sessió 2)
- **Estat:** Acceptada

## Context

OSM té 868 comerços i serveis a Terrassa (766 amb nom) com a **nodes**, sense portal exacte. El primer intent
muntava rètols, plaques de carrer i fanals "a la façana" sense comprovar que n'hi hagués, i en quedaven de flotants
en solars i cantonades buides.

## Decisió

- `tools/data/q_shops.overpassql` → `GEO.shops` → `SHOPS` a `js/city-config.js`.
- `js/buildings.js` col·loca el rètol i el tendal de cada comerç amb nom a la **paret a carrer més propera** del seu
  edifici (≤ 14 m; 20 m en una segona passada); 547 rètols reals, cap edifici sense comerç a OSM en porta.
- `js/street-details.js` rep els col·lisionadors dels edificis i només munta plaques i fanals de paret on hi ha paret
  real (la placa llisca fins a 6 m per la façana); a les cantonades sense edifici les plaques pengen d'un pal
  (commit `28a39d1`).

Referències: `HOW_TO_IMPROVE.md` §2.5, §3 (sessió 2, punts 1 i 5), §5.4, §5.6.

## Alternatives considerades

- **Rètols genèrics inventats a tots els baixos**: fals i contrari a l'esperit del projecte (res d'inventat on hi
  pugui haver dada).
- **Geocodificar contra les adreces del Catastro** (portal exacte per referència cadastral): millor, però requereix el
  GML d'adreces; queda a `NEXT_STEPS.md` §1.5.

## Conseqüències

- Nom exacte (✅), portal aproximat (🟡); 217 comerços (benzineres, grans superfícies, masies) queden sense rètol.
- L'atles de rètols és una textura de 4096×2304 (37 MB a GPU): cost a vigilar si se'n multipliquen.

*Un polsim de Viandox:* l'etiqueta va enganxada al pot que toca, i si no hi ha pot, no s'enganxa a l'aire.
