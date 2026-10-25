# VDR-0011 — Cada millora darrere d'un interruptor i en un commit aïllat; dades abans que codi

- **Data:** 2026-10-24
- **Estat:** Acceptada

## Context

`NEXT_STEPS.md` recull una quinzena de millores grans (relleu, física, trànsit, semàfors…) sobre un motor que ja
funciona i que el propietari fa servir. El risc principal és trencar el que va bé.

## Decisió

Principis de treball de `NEXT_STEPS.md`, que es fan vinculants:

1. **Cada millora és un commit aïllat amb un commutador**: una constant de `FEATURES` a `js/city-config.js` o una dada
   opcional a `GEO` (si falta, el codi es comporta com avui). Desactivable en segons.
2. **Dades abans que codi**: primer s'aconsegueix la dada, s'incorpora a `tools/`, es regenera; només llavors es
   toca el runtime.
3. **Verificació en tres nivells**: `node --test` (suites `node:test` sense dependències), arnès *headless* dels
   mòduls de construcció, i recàrrega al navegador amb consola oberta i recorregut fix (Plaça Vella → Rambla →
   Vallparadís → Mútua).
4. **Comparar amb la realitat amb captures** abans/després.
5. **Branca per millora gran** (relleu, física) i `main` sempre arrencable.

Referències: `NEXT_STEPS.md` ("Principios de trabajo", "Eje 4"); `README.md` ("Tests").

## Alternatives considerades

- **Commits grans per sessió** (com a les sessions 1 i 2, forçats per l'abast de la conversió): acceptable per a la
  conversió inicial, no per a millores incrementals.
- **Flags en temps d'execució (query string / localStorage)**: més còmode per a l'usuari, però afegeix superfície; es
  pot afegir més endavant sobre les mateixes constants.

## Conseqüències

- `FEATURES` passa a ser l'únic lloc de commutadors (encara no existeix a `js/city-config.js` en el moment d'escriure;
  el primer serà `FEATURES.terrain`, VDR-0012).
- L'arnès *headless* encara viu al *scratchpad* d'una sessió: cal portar-lo a `tools/harness/` (`NEXT_STEPS.md` Eix 4).

*Un polsim de Viandox:* s'afegeix una espècie cada vegada, i es tasta; si no agrada, es pot treure sense llençar el
guisat.
