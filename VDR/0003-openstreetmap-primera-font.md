# VDR-0003 — OpenStreetMap com a primera font de dades (descarregat amb permís explícit)

- **Data:** 2026-10-24
- **Estat:** Acceptada (complementada per VDR-0004 per als edificis)

## Context

Nova York tenia dades municipals obertes (DCP, CSCL, NYC Parks). Per a Terrassa calia una font única, lliure, amb
geometria 1:1 i topònims en català complets ("Carrer de Sant Pere", no "C/ Sant Pere").

## Decisió

Fer servir **exclusivament OpenStreetMap** (ODbL) com a punt de partida: carrers (12.914 vies `highway=*`, semàfors,
passos, stop), límits municipals, usos del sòl, rieres, arbres, monuments, barris, comerços i la regió per a
l'horitzó. Es descarrega amb `tools/overpass.sh` i les consultes `tools/data/q_*.overpassql` cap a
`tools/data/terrassa/osm_*.json` (77 MB), amb validació del JSON i reanomenat atòmic. La descàrrega es va fer el
2026-10-24 **amb permís explícit del propietari** (VDR-0010).

Referències: `HOW_TO_IMPROVE.md` §1.3 i §2; `tools/overpass.sh`; `tools/data/q_*.overpassql`; `README.md`
("Construir les dades").

## Alternatives considerades

- **ICGC (Base topogràfica 1:5.000, Edificacions 3D)**: millor geometria de calçades i alçades, però més feina
  d'integració; queda com a millora documentada (`NEXT_STEPS.md` §1.2, §1.7).
- **Dades obertes de l'Ajuntament** (barris, arbrat, enllumenat): millors per a capes concretes; pendents
  (`NEXT_STEPS.md` §1.4, §1.6).

## Conseqüències

- Cobertura exacta de carrers, semàfors i passos, però **parcial d'edificis** (13.504 petjades, només 390 amb
  plantes): va forçar VDR-0004 el mateix dia.
- Els amples de calçada no hi són (120 vies amb `width`) i es deriven d'un model per classe de via
  (`tools/geo-roads.mjs`, `HOW_TO_IMPROVE.md` §2.2).
- Obligació d'atribució ODbL al README.

*Un polsim de Viandox:* OSM és la base de l'estofat; sense ella no hi ha plat, però sola queda una mica clara.
