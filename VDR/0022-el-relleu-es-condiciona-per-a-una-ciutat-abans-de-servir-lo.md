# VDR-0022 — El relleu es condiciona per a una ciutat a l'eina (`tools/geo-terrain.mjs`) abans de servir-lo, i es verifica amb un informe procedimental

- **Data:** 2026-10-25 (revisat el mateix dia després de la segona ronda del propietari)
- **Estat:** Acceptada (en curs: queda un 2,1 % de montículs de vorera, els passos superiors sense etiqueta, els túnels
  i el que una cel·la de 10 m no pot representar)

## Context

Un model de terreny de sòl nu no és el sòl per on es condueix: baixa als torrents embovedats, conserva la vall sota
els ponts, i porta soroll (montículs, forats) allà on es van treure els edificis per generar-lo. Amb el MDE real de
l'ICGC (VDR-0018) i la versió ingènua del condicionament, l'informe donava **pendents p99 del 38 %**, **graons de 17 m
a les vorades** i **11.900 volums enterrats > 2 m** (`HOW_TO_IMPROVE.md` §3, sessió 3, punt 7). El propietari va demanar
**verificació procedimental** sobre tota la ciutat, no captures de pantalla (Terrassa és massa gran per mirar-la), i va
veure **montículs a les voreres** que no existeixen a la realitat; a la segona ronda, **crestes curtes als carrers** i
un montícul a una porta (Carrer de Colom – Carretera de Montcada) (§3, sessió 3, punt 10). El runtime té una sola
alçada per (x, z) tret dels ponts (VDR-0023), així que el relleu que es serveix ja ha de ser el relleu urbà.

## Decisió

`tools/geo-terrain.mjs` (`build`, tret que es passi `--raw`) transforma el model en aquest ordre, llegint carrers del
`GEO.roadGraph` i illes i petjades del `GEO.blocks` generat (VDR-0005):

1. **Cotes de cruïlla** (`nodeHeights`): per a cada calçada que arriba a un node, la **recta ajustada per mínims
   quadrats al seu tram de 10–40 m, avaluada al node** (el que faria el carrer si continués; els primers metres del
   model a una cruïlla són els més sorollosos: passos elevats, clots i bonys d'on hi havia edificis); si el carrer és
   curt o la recta té pendent ≥ 20 %, la mediana dels primers 10 m. El node pren la **mediana entre les seves
   calçades**; camins, escales i vials de servei (`cls` 3 i 4) només si no hi arriba cap calçada. A un **estrep de
   pont** mana el **punt més alt dels primers 30 m** dels carrers que hi arriben. Els nodes **només de pont** s'assenten
   amb la mitjana dels veïns solucionats (fins a 8 passades), i si no, amb la mediana dels propis trams de pont.
2. **Perfil de cada carrer** (`roadProfile`): mostres cada 5 m, **mitjana mòbil de 40 m**, correcció lineal perquè els
   **extrems clavin a les seves cruïlles**, **aplanat de crestes i clots curts** (tota mostra a més de **0,3 m de la
   corda** entre les seves veïnes a ±15 m es posa sobre la corda, fins a 3 passades: un carrer no té corbes verticals
   tan curtes) i **limitador de pendent** (`MAX_GRADE`: **18 %** calçades, **45 %** vianants/escales, `cls` 3) en dues
   passades i en els dos sentits. Un pont és una recta entre els seus estreps.
3. **Gravat** (`carveRoads`): **tota cel·la que toqui en algun punt la calçada o el seu voral de 2 m és sencera del
   carrer** (`dEff = d − cell/2`; una cel·la a mig pes vora l'eix deixava passar el soroll del model com a cresta);
   8 m més de transició suau cap enfora. Les cel·les que **comparteixen dues calçades** (cruïlles) **es barregen per
   proximitat a cada eix** (`1 / (d + 2)`), ni "guanya el més proper" ni mitjana plana, perquè els perfils es trobin
   sense graó. Les cel·les amb pes ≥ 0,5 queden marcades a **`grid.roadMask`** i les de calçada (no camins ni vials
   de servei) a **`grid.carriagewayMask`**; cap pas posterior les toca. Es fa **dues vegades**, i la segona (mitjana
   mòbil de 20 m) **és l'últim pas**, després de membranes i plataformes: el que facin les illes a les vores, la
   calçada sempre mana, i una cruïlla a nivells diferents sense etiqueta de pont es converteix en rampa limitada. Els
   trams `bridge=yes` **no es graven** (VDR-0023).
4. **Illes urbanes com a membranes** (`membraneBlocks`): tota illa edificable de **≤ 260 m** d'extensió es reomple
   amb la **mitjana ponderada per inversa de la distància a la 4a potència** de mostres cada 4 m de la línia de vorada
   (el gravat): l'interior no pot tenir bonys ni forats respecte dels seus carrers. Les illes més grans (polígons,
   vessants amb cases disperses) conserven el model excepte una **franja de 24 m** darrere la vorada; els parcs i el
   sòl obert conserven el model.
5. **Plataforma per edifici** (`flattenBuildings`), **només a les illes grans (> 260 m) que conserven el model**: en una
   illa urbana la membrana ja és llisa i una plataforma només posa graons entre veïns o un montícul a una porta (el
   cas de Colom – Carretera de Montcada). Sota la **part interior** de la petjada del Catastro (mai a les cel·les
   veïnes de `roadMask`, que són vorera i han de ser planes en tota l'amplada), el terreny s'iguala a la cota de la
   **vorera més baixa de les seves façanes al carrer** (`Math.min(...fronts)`: **mai per sobre del carrer de la
   porta**) o, sense carrer, a la mediana de les cantonades; transició de 3 m. És el nivell on `js/buildings.js`
   assenta el volum (VDR-0024).
6. **Ponts**: `raiseBridgeAbutments` i `clearUnderBridges` (VDR-0023); el rebaix sota els taulers **no toca cap cel·la
   de `roadMask`**.
7. **Informe procedimental** (`report`) sobre tota la ciutat, a cada regeneració: pendents per classe (p50 / p90 /
   p99 / màx), trams de calçada > 18 %, graons > 1 m dins de 5 m de calçada, **crestes i clots curts** (mostres de
   calçada a > 0,3 m de la corda de 30 m), taulers (nombre, longituds, pendent extrem a extrem), **graó de vorada** per
   illa (1,5 m dins vs fora de la línia), i **montículs de vorera** (línia de façana 4 m endins contra la vorada,
   mostres cada 6 m, umbral 0,5 m).

Xifres del fitxer actual (`HOW_TO_IMPROVE.md` §2.8, punt 6): pendents de calçada p50 2,7 %, p90 7,3 %, **p99 14,5 %**;
**107 trams > 18 %** (quasi tots enllaços d'autopista a dos nivells sense etiqueta de pont); **124 graons**; **1.232
crestes curtes** (eren 2.204; 612 en enllaços d'autopista); **140 taulers**; 37 illes amb graó de vorada > 1 m (màx.
2,9 m); **2.548 de 124.161 mostres de vorera > 0,5 m (2,1 %), des de 9.727** abans de les membranes; 1.551
illes-membrana, 155 grans; 1.082 plataformes (eren ~6.700 quan es feien a totes les illes).

Referències: `tools/geo-terrain.mjs` (`nodeHeights`, `roadProfile`, `MAX_GRADE`, `carveRoads`, `membraneBlocks`,
`flattenBuildings`, `raiseBridgeAbutments`, `clearUnderBridges`, `report`, `build`, opció `--raw`);
`HOW_TO_IMPROVE.md` §2.8 (punts 1, 2, 4, 5, 6) i §3 (sessió 3, punts 5, 7, 9, 10 i 11); `NEXT_STEPS.md` (estat
2026-10-25).

## Alternatives considerades

- **Servir el model nu i arreglar-ho al runtime**: el runtime té una alçada per (x, z) i cap informació de carrers
  al nivell del ràster; i cada arrencada repetiria el càlcul.
- **Captures de pantalla com a verificació**: no escalen a 4.600 trams i 1.700 illes; el propietari va demanar números.
- **Cota de cruïlla = mediana dels primers 10 m** (la primera versió): llegia el soroll del model just a la cruïlla i
  deixava crestes als carrers; la recta de 10–40 m extrapolada les evita.
- **Cel·les a pes parcial vora l'eix i "guanya el pes més alt"** (la primera versió de `carveRoads`): deixava passar el
  model a mig pes (crestes) i feia graons on dues calçades es trobaven; **mitjana plana** a les cruïlles tampoc no
  serveix (un carrer en pendent n'estiraria l'altre).
- **Illes com a plans de mínims quadrats** (`flattenBlocks`, la primera versió, conservada al fitxer "kept for
  reference"): un pla no segueix una illa que fa cantonada en pendent; la membrana sí.
- **Plataforma a tota la petjada i a totes les illes** (les dues primeres versions): aixecava la vorera davant de
  l'edifici (montículs) i, a les illes urbanes, posava graons entre veïns i un montícul a la porta de Colom.
- **Ponts com a terraplens** (`carveRoads` encara ho pot fer amb `embank: true`): descartat per VDR-0023.
- **Un sol gravat, o el segon abans de les illes**: deixava un esglaó allà on dos carrers es creuen a nivells
  diferents, i les membranes i plataformes podien retocar la vora de la calçada.

## Conseqüències

- `js/terrassa-terrain.bin` **ja no és el MDE**: és un producte derivat del MDE + carrers d'OSM + petjades del
  Catastro. **Cal regenerar-lo quan canvia `terrassa-geodata.js`** (noves carreteres, nous edificis).
- Dins de la ciutat es renuncia deliberadament a fidelitat al model (carrers i illes ≤ 260 m reescrits); fora, el
  model mana.
- Pendent (🟠 a §2.8): passos superiors sense etiqueta `bridge` (C-58, N-150: avui rampes al 18 %), túnels, trams curts
  entre cruïlles a cota diferent, i el que la malla de 10 m no pot representar (la vorera d'un carrer de 6 m i
  l'interior de la seva illa cauen a la mateixa cel·la): el 2,1 % de montículs restant.
- L'informe surt per consola en regenerar; no s'ha convertit encara en test de regressió.

*Un polsim de Viandox:* el brou es desgreixa i es cola abans de servir-lo; i es tasta amb cullera, no mirant-lo.
