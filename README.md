# Grand Theft Ègara

> *Terrassa a escala 1:1. Sí, Terrassa. No, Sabadell no hi surt (a la llunyania, de bajísimo detalle, com toca).*

Això és **Frankfurt City** amb motor WebGPU: la ciutat amb més bars de frankfurts per càpita del món conegut, la Manchester catalana, la capital de l'hoquei, el lloc on la Rambla és d'Ègara i no de Barcelona. Un simulador de Terrassa fet amb [three.js](https://threejs.org/), WebGPURenderer i TSL, on pots voltar a peu, en taxi blanc, en bici o en helicòpter de rescat per **tots els carrers de debò**, al seu lloc de debò, amb el seu nom de debò i sense abreviar res: *Carrer de Sant Pere*, *Rambla d'Ègara*, *Plaça Vella*, *Passeig del Comte d'Egara*. Si hi busques "C/ Sant Pere" no el trobaràs. Això és una ciutat seriosa.

Vine a:

- sortir del taxi a la **Plaça Vella** i mirar amunt cap al campanar de la **Catedral del Sant Esperit**;
- baixar la **Rambla d'Ègara** fins al **mNACTEC** (el Vapor Aymerich, Amat i Jover, amb les seves dents de serra) i tornar a pujar perquè t'has passat de llarg, com tothom;
- perdre't pel **Parc de Vallparadís** i trobar-te el **Castell Cartoixa** i la **Seu d'Ègara** com qui no vol la cosa;
- fer-te la foto davant la **Masia Freixa** del Parc de Sant Jordi (aquí no hi ha casaments, però les cúpules hi són);
- comprar al **Mercat de la Independència**, agafar Rodalies a l'**Estació del Nord** i acabar a l'**Estadi Olímpic** mirant hoquei;
- comptar xemeneies: la de la **Bòvila Almirall** fa 63 metres i és la més alta de Catalunya, i al simulador també;
- travessar la **Riera de les Arenes** per un pont, com Déu mana, i no pel mig, que està canalitzada i fa 28 metres;
- enfilar-te amb l'helicòpter i veure **la Mola** i el **Montcau** al nord. Sabadell queda a l'est. Prou.

## D'on surt tot això

És un fork de [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork) ("Slop New York", una simulació de Manhattan) amb tota la ciutat canviada per Terrassa. Manhattan és una quadrícula; Terrassa és un nucli medieval, un Eixample girat 13,7° respecte del nord, barris dels anys setanta i un munt de polígons. Per això la ciutat sencera corre pel sistema de **graf de carrers** que l'original només feia servir a Lower Manhattan: no hi ha avingudes numerades ni Central Park ni costa, hi ha 2.320 illes de cases reals, 4.687 carrers reals, 236 cruïlles amb semàfor reals i 13.000 edificis amb la seva planta real allà on OpenStreetMap la té.

Tota la geografia ve d'**OpenStreetMap**. El que és exacte, el que és aproximat, el que és directament inventat (hi ha coses inventades, no som màgics) i **com millorar cada capa** està documentat fil per randa, en castellà, a [HOW_TO_IMPROVE.md](HOW_TO_IMPROVE.md). Si et pica alguna cosa (les alçades dels edificis, per exemple: només 390 en tenen a OSM), allà s'explica d'on treure-la.

## Engega-ho

És una web estàtica (mòduls ES, three.js des de jsDelivr). Serveix l'arrel del repositori amb qualsevol servidor estàtic i obre-ho amb un navegador amb WebGPU (Chrome, Edge; Safari 26 o Firefox amb WebGPU activat; si no, cau a WebGL2):

```bash
npx serve .
# o bé
python3 -m http.server 8000
```

Tecles: `1`–`4` mode de desplaçament, `W A S D` moure's, `Shift` turbo, `V` canviar de càmera, `M` el plànol sencer de la ciutat (clica on vulguis per teletransportar-t'hi), `H` vista neta, `N` silenci.

## Tests

```bash
node --test tests/
```

Són suites `node:test` sense dependències: càmeres, plànol, controls, trànsit, destins de teletransport (cada arribada cau en un carrer real dins la ciutat) i la llista de precàrrega de mòduls de `index.html`.

## Construir les dades

`js/terrassa-geodata.js` es genera des d'OpenStreetMap amb `tools/build-geodata.mjs`. Els extractes font són a `tools/data/terrassa/` (baixats amb `tools/overpass.sh` i les consultes Overpass de `tools/data/q_*.overpassql`). Per refrescar-los i reconstruir (la baixada necessita xarxa i pega a l'API pública d'Overpass: sigues amable):

```bash
for q in boundary roads landmarks landuse region buildings; do
  bash tools/overpass.sh tools/data/terrassa/osm_$q.json tools/data/q_$q.overpassql 6
done
GEO_DATA=tools/data/terrassa node --max-old-space-size=8192 tools/build-geodata.mjs
```

La pipeline mesura ella mateixa el marc (origen al centre de la Plaça Vella, eixos girats 13,7° a l'oest del nord seguint la trama de l'Eixample), simplifica la geometria, dedueix amples de calçada, solars i usos del sòl, i escriu un sol mòdul. A HOW_TO_IMPROVE.md §1.3 hi ha què conté cada extracte, els forats coneguts i les fonts millors (Cadastre, ICGC) per tapar-los.

## Fes-te'l teu

Forca'l, remena'l, millora'l, trenca'l. Fes-ne jocs, animacions, pel·lícules, experiments o una cosa completament diferent. Afegeix-hi el teu barri si el veus massa buit. Posa-hi els frankfurts. Diverteix-te.

## Llicència i dades

El codi és sota [llicència MIT](LICENSE), com l'original [Slop New York](https://github.com/mrdoob/slop-newyork) de mrdoob i col·laboradors, del qual deriva aquest projecte.

Dades geogràfiques © [col·laboradors d'OpenStreetMap](https://www.openstreetmap.org/copyright), disponibles sota l'[Open Database License](https://opendatacommons.org/licenses/odbl/) (ODbL). Les dades i dependències de tercers conserven les seves llicències.
