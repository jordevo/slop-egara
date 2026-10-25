# VDR-0009 — Documentació exhaustiva a `HOW_TO_IMPROVE.md` després de cada pas

- **Data:** 2026-10-24
- **Estat:** Acceptada

## Context

El projecte barreja dades exactes, derivades, aproximades i inventades, i el propietari vol saber en tot moment quina
capa és què i com millorar-la. També es treballa amb agents en paral·lel i en sessions curtes: sense un registre comú
es perd el fil.

## Decisió

`HOW_TO_IMPROVE.md` (en castellà) és a la vegada **registre de fidelitat** (taules per capa amb les marques
✅ Exacte / 🟡 Derivat / 🟠 Aproximat / 🔴 Inventat / ⚪ Pendent, i "com millorar-ho" a cada fila) i **diari de
desenvolupament** (§3, per sessió). S'actualitza **després de cada pas** de treball, no al final. Les decisions amb
abast arquitectònic tenen, des d'avui, el seu propi registre a `VDR/` (VDR-0019); `HOW_TO_IMPROVE.md` continua
recollint la fidelitat i el diari.

Referències: `HOW_TO_IMPROVE.md` (capçalera i convenció de marques); memòria de l'usuari
"Document everything in HOW_TO_IMPROVE.md".

## Alternatives considerades

- **Comentaris al codi només**: es perd la visió transversal i el "com millorar-ho".
- **Issues de GitHub**: el repositori públic encara no existia en començar; i el registre ha de viure amb el codi.

## Conseqüències

- El document és llarg (≈ 400 línies) i creix; l'índex per seccions (§1 decisions, §2 pipeline, §3 diari, §4 runtime,
  §5 informes) és el que el fa navegable.
- Nota de verificació (2026-10-25): la sessió del relleu encara **no** hi és documentada (el text diu "la ciudad es
  plana"), i `tools/geo-terrain.mjs` cita un "§2.8" que encara no existeix. Cal posar-ho al dia abans del commit.

*Un polsim de Viandox:* la recepta s'escriu mentre es cuina, no quan ja s'ha rentat la cassola.
