# VDR-0006 — Les illes surten d'un ràster de les calçades, no d'OSM

- **Data:** 2026-10-24
- **Estat:** Acceptada

## Context

OSM dóna eixos de carrer, no illes ni vorades. El motor necessita, per a cada illa, el contorn de vorada, la línia de
propietat (vorada − vorera), solars rectangulars i, si no està alineada amb els eixos, un marc propi. L'original feia
exactament això per a Manhattan.

## Decisió

Mantenir l'algoritme de l'original a `tools/geo-blocks.mjs`: rasteritzar a 1 m tota la caixa de detall, **estampar
cada calçada a nivell de carrer amb el seu ample** (model de `tools/geo-roads.mjs`: `width` d'OSM si existeix, si no
carrils × ample de carril + aparcament típic), i etiquetar els components que queden: les **"illes de vorada"**. Per
a cada una: contorn simplificat, línia de propietat amb `SIDEWALK = 2,4 m`, solars rectangulars, *frontage frames*
girats a la direcció de cada carrer que la voreja (1.467 de 2.320 illes), quota d'usos del sòl (`CLS` de
`tools/geo-features.mjs`) i barri (VDR-0007). Túnels exclosos; ponts tractats a cota de carrer (ciutat plana en aquell
moment).

Referències: `HOW_TO_IMPROVE.md` §2.2, §2.3; `tools/geo-blocks.mjs`; `tools/geo-roads.mjs`.

## Alternatives considerades

- **Polígons de calçada i vorera de l'ICGC 1:5.000**: més exactes, però no eren a l'abast el primer dia; queda com a
  millora (`NEXT_STEPS.md` §1.7), amb l'avís de comparar recomptes (2.320 illes) en regenerar.
- **Construir illes per cicles del graf**: fràgil amb vials de polígon, culs-de-sac i vies que no tanquen.

## Conseqüències

- Les illes són "derivades" (🟡): eix real + ample modelat; l'ample de vorera constant és una aproximació.
- 386 trams de pont/viaducte comparteixen cota amb el que creuen: visualment plans fins que hi hagi relleu i nivells.
- Tot el que es col·loca a la ciutat (edificis, mobiliari, arbres) s'ancora a una illa: la taula ràster → illa és
  crítica (vegeu la correcció de VDR-0004).

*Un polsim de Viandox:* talles la pasta amb el motlle de la calçada i et queden les galetes: les illes.
