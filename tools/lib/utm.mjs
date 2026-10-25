// tools/lib/utm.mjs — forward Transverse Mercator (GRS80 / ETRS89, the ellipsoid of the ICGC's EPSG:25831) and the
// other projections an elevation model may come in. All take [lon, lat] in degrees and return [x, y] in metres.
const A = 6378137.0;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const D2R = Math.PI / 180;

/** lon/lat (deg) -> UTM easting/northing (m) in `zone` (northern hemisphere) */
export function lonLatToUtm(lon, lat, zone) {
  const lon0 = ((zone - 1) * 6 - 180 + 3) * D2R;
  const phi = lat * D2R;
  const lam = lon * D2R - lon0;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan;
  const C = EP2 * cos * cos;
  const Aa = cos * lam;
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi));
  const A2 = Aa * Aa, A3 = A2 * Aa, A4 = A3 * Aa, A5 = A4 * Aa, A6 = A5 * Aa;
  const x = K0 * N * (Aa + (1 - T + C) * A3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * A5 / 120) + 500000;
  const y = K0 * (M + N * tan * (A2 / 2 + (5 - T + 9 * C + 4 * C * C) * A4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * A6 / 720));
  return [x, y];
}

/** lon/lat -> Web Mercator (EPSG:3857) */
export function lonLatToWebMercator(lon, lat) {
  const R = 6378137.0;
  return [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
}

/** A projector lon/lat -> raster CRS for the EPSG codes elevation models are published in (null if unknown) */
export function projectorFor(epsg) {
  if (epsg === 4326 || epsg === 4258 || epsg === 4230 || epsg === 4979) return (lon, lat) => [lon, lat];
  if (epsg >= 25828 && epsg <= 25838) { const zone = epsg - 25800; return (lon, lat) => lonLatToUtm(lon, lat, zone); }
  if (epsg >= 32601 && epsg <= 32660) { const zone = epsg - 32600; return (lon, lat) => lonLatToUtm(lon, lat, zone); }
  if (epsg >= 23028 && epsg <= 23038) { const zone = epsg - 23000; return (lon, lat) => lonLatToUtm(lon, lat, zone); } // ED50: ~200 m off, flagged by the tool
  if (epsg === 3857 || epsg === 900913) return lonLatToWebMercator;
  return null;
}
