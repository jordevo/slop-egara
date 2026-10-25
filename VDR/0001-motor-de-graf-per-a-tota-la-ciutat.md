# VDR-0001 — El motor de graf de carrers mou tota la ciutat (adéu a la retícula de Manhattan)

- **Data:** 2026-10-24
- **Estat:** Acceptada

## Context

L'original (*Slop New York*, de mrdoob) construeix Manhattan amb dos sistemes: la **retícula** (carrers numerats per
`z`, avingudes per `x`, Central Park, costa de l'illa; ~60 % de `city-grid.js`, `street-details.js`, `buildings.js` i
tota la configuració de `city-config.js`) i el **graf de carrers** (`GEO.roadGraph`, `js/road-network.js`), que només
feia servir a Lower Manhattan, Broadway i els carrers corbs del nord.

Terrassa és una ciutat interior, sense costa ni illa, amb un nucli medieval irregular, un Eixample en retícula girada
13,7° a l'oest del nord i barris perifèrics amb traçats propis. No hi ha cap manera honesta de descriure-la amb taules
de carrers i avingudes.

## Decisió

**Tota la ciutat corre pel sistema de graf.** Les taules de carrers/avingudes queden buides i els mòduls que en
depenien es generalitzen: `road-network.js` tracta totes les vies com a arestes "generals" del graf i comprova les
vorades contra el **polígon real** de cada illa (`blockAt`), els semàfors surten dels nodes OSM `highway=traffic_signals`,
els passos de vianants es tracen en qualsevol angle (`pedestrian-routes.js`), i `boroughs.js`, `fire-escapes.js` i
`nyc-geodata.js` s'eliminen (`surroundings.js` substitueix els boroughs).

Referències: `HOW_TO_IMPROVE.md` §1.1 i §4; `js/road-network.js`, `js/city-config.js`, `js/pedestrian-routes.js`.

## Alternatives considerades

- **Mantenir la retícula i encabir-hi Terrassa**: descartada; només l'Eixample s'hi assembla, i encara girat.
- **Dos motors convivint** (retícula per a l'Eixample, graf per a la resta): descartada per duplicar camins de codi i
  perquè el graf ja cobreix qualsevol traçat; les illes no alineades reben el seu propi *frontage frame* (VDR-0006).

## Conseqüències

- Un sol camí de codi per a carrers, cruïlles, semàfors i passos: més senzill de raonar i de provar.
- Es perden les optimitzacions específiques de retícula de l'original (p. ex. la ruta GPS pel traçat rectilini: ara és
  una línia recta, `HOW_TO_IMPROVE.md` §5.3).
- Els tests que depenien dels noms d'exportació de Nova York es mantenen amb *stubs* a `tests/helpers/`.

*Un polsim de Viandox:* la retícula era el brou de cub; el graf és el fons de cocció fet a casa, i a Terrassa no es
negocia.
