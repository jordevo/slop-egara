# VDR-0014 — Lector GeoTIFF / Arc-Info ASCII i projector UTM propis en Node, sense GDAL; el marc es llegeix de `GEO.frame`

- **Data:** 2026-10-25
- **Estat:** Acceptada

## Context

Els models d'elevació de l'ICGC arriben com GeoTIFF (o Arc/Info ASCII) en EPSG:25831 (UTM 31N sobre ETRS89); el
Copernicus GLO-30 com a COG en WGS84. L'eina habitual és GDAL (`gdalwarp`) o `rasterio`, però **cap de les dues és a la
màquina** (verificat: `gdalinfo` no és al PATH, `import rasterio` falla) i el repositori **no té `package.json` ni cap
dependència npm**: les eines són Node pur i un script Python de biblioteca estàndard.

## Decisió

Escriure dos mòduls petits i sense dependències a `tools/lib/`:

- **`tools/lib/geotiff.mjs`** (343 línies): GeoTIFF clàssic i **BigTIFF**, *strips* o *tiles*, compressió cap /
  deflate (zlib de Node) / **LZW** / PackBits, predictors **2** (diferència horitzontal) i **3** (coma flotant), enters de
  8/16/32 bits i flotants de 32/64, `nodata`, geoclaus per a l'EPSG; i el lector d'**Arc/Info ASCII grid**. Tots dos
  retornen el mateix objecte `{ width, height, data, nodata, epsg, toXY, sample }` amb mostreig bilineal.
- **`tools/lib/utm.mjs`** (45 línies): Transverse Mercator directa sobre GRS80/ETRS89 (`lonLatToUtm`) i
  `projectorFor(epsg)` per a les projeccions que pot portar un MDE.

El marc del món **no es torna a mesurar** sobre els carrers d'OSM: `tools/geo-terrain.mjs` importa el
`js/terrassa-geodata.js` generat i reconstrueix el marc amb `frameOf(GEO.frame)` (`bearingDeg`, `lat0`, `lon0`, mateixa
matemàtica que `tools/geo-base.mjs`). Així la pipeline del relleu és independent dels 77 MB d'OSM i no pot divergir
del marc que el runtime fa servir.

Referències: `tools/lib/geotiff.mjs`, `tools/lib/utm.mjs`, `tools/geo-terrain.mjs` (`frameOf`, `build`);
`tests/geo-terrain.test.mjs` (escriptor TIFF mínim que exercita LZW, deflate+predictor 3, BigTIFF, ASCII, UTM 31N).

## Alternatives considerades

- **Instal·lar GDAL (Homebrew) o rasterio**: dependència pesada fora del repositori; cada col·laborador l'hauria de
  tenir; i instal·lar-ho és una petició de xarxa (VDR-0010).
- **`geotiff.js` d'npm**: funciona, però introdueix `package.json` i `node_modules` en un repositori que presumeix de
  no tenir-ne.
- **Preprocessar el MDE a ASCII amb una eina externa i llegir només ASCII**: hauria funcionat, però obliga a un pas
  manual fora del repositori a cada actualització.
- **Recalcular el marc des d'OSM a `geo-terrain.mjs`**: duplicaria la calibració i carregaria els extractes OSM.

## Conseqüències

- Cobertura de format limitada al que escriuen GDAL/ICGC per defecte (una banda, sense JPEG ni ZSTD): si un MDE arriba
  en un altre format, caldrà ampliar el lector o reconvertir-lo.
- Projecció **directa** només (lon/lat → UTM): suficient perquè el mostreig va del grid del món al ràster.
- Els tests cobreixen els camins de codi amb fitxers generats; **no s'ha provat encara amb un GeoTIFF real de l'ICGC**
  (VDR-0018).

*Un polsim de Viandox:* res de pots de salsa industrial: la reducció es fa a casa, amb els ingredients que hi havia al
rebost.
