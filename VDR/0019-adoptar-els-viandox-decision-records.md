# VDR-0019 — Adoptar els Viandox Decision Records (VDR) per a les decisions significatives

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

Les decisions del projecte vivien repartides entre `HOW_TO_IMPROVE.md` §1 (arquitectura), el diari §3, `NEXT_STEPS.md`
(principis), els comentaris de capçalera de `tools/*.mjs` i la memòria de l'agent. Qui arriba nou (o un agent en una
sessió nova) no sap per què es va triar una cosa i no una altra, ni quines alternatives es van descartar.

## Decisió

Crear `VDR/`: un *Architecture Decision Record* clàssic "aderezado con un poco de Viandox" (una frase final de regust
culinari, mai per sobre del contingut). **En català**, un fitxer per decisió, `NNNN-slug.md`, numeració seqüencial,
plantilla i índex a `VDR/README.md`. A partir d'ara, **cada decisió significativa** (arquitectura, font de dades,
format, compromís, abast) presa en treballar al repositori rep el seu registre; el `CLAUDE.md` de l'arrel ho recorda a
qualsevol agent. `HOW_TO_IMPROVE.md` continua essent el registre de fidelitat i el diari (VDR-0009).

Referències: `VDR/README.md`; `CLAUDE.md`.

## Alternatives considerades

- **Continuar amb `HOW_TO_IMPROVE.md` §1**: no escala i barreja decisió amb estat.
- **ADR en anglès**: el codi i les capçaleres són en anglès, però el README és en català i el diari en castellà; es tria
  el català perquè és la llengua del projecte de cara enfora.

## Conseqüències

- Una mica més de burocràcia per decisió (5 minuts) a canvi de memòria del projecte.
- Les decisions substituïdes no s'esborren: passen a "Substituïda" i enllacen la nova.

*Un polsim de Viandox:* Viandox, sí: una cullerada al final per donar color, no per tapar el gust del plat.
