# VDR-0005 — `js/terrassa-geodata.js` generat és l'única dada que llegeix el runtime

- **Data:** 2026-10-24
- **Estat:** Acceptada (amb l'excepció explícita del relleu, VDR-0013)

## Context

L'original ja separava dades (`nyc-geodata.js`) de codi. Amb Terrassa hi ha moltes fonts (OSM en sis extractes,
Catastro, comerços) i molta derivació (amples de calçada, illes, solars, usos, barris). El navegador no ha de saber
res de tot això.

## Decisió

Tota la geografia es cuina a `tools/` i s'escriu en **un sol mòdul ES**, `js/terrassa-geodata.js` (≈ 7 MB), amb
`GEO_DATA=tools/data/terrassa node --max-old-space-size=8192 tools/build-geodata.mjs`. El runtime (`js/city-config.js`
i tot el que en depèn) només llegeix `GEO.*`: marc, límits, carrers, graf, illes amb els seus edificis, usos, aigua,
arbres, monuments, barris, comerços, regió. Les dades es guarden compactes (arrays plans `[x0, z0, x1, z1, ...]`,
coordenades quantitzades) i amb comentaris de capçalera que n'expliquen l'esquema.

Referències: `tools/build-geodata.mjs` (capçalera i esquema de cada taula); `js/city-config.js`; `README.md`
("Construir les dades"); `HOW_TO_IMPROVE.md` §2, §3 (sessió 1, punt 6).

## Alternatives considerades

- **Carregar els JSON d'OSM al navegador i derivar en temps real**: massa pesat (77 MB) i lent (la rasterització
  d'illes triga segons a Node).
- **Diversos fitxers per capa**: més fàcil de refer una capa, però el runtime hauria de coordinar càrregues; es va
  preferir un sol import síncron… fins que el relleu (7 MB més, regeneració lenta) ho va fer reconsiderar per a aquella
  capa concreta (VDR-0013).

## Conseqüències

- Reproduïble: `tests/geodata.test.mjs` reconstrueix les dades reals (≈ 15 s) i en comprova recomptes.
- Regenerar costa temps i memòria (`--max-old-space-size=8192`): cada canvi a la pipeline implica reconstruir-ho tot.
- El fitxer és gran per a un repositori Git; s'accepta a canvi de la simplicitat.

*Un polsim de Viandox:* tot va a l'olla a la cuina; a taula només arriba un plat, i ningú veu els ossos.
