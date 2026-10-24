// tools/geo-base.mjs
// Frame, data loading & geometry helpers for tools/build-geodata.mjs, which builds js/terrassa-geodata.js: the real
// geography of Terrassa (Vallès Occidental, Catalonia) in the simulation's 1:1 world frame, from OpenStreetMap.
// Frame: 1 unit = 1 m, x = east along the Eixample's street grid, z = south along it (north = -z), origin at the
// centre of the Plaça Vella; the axes are turned to the grid's measured bearing (its "north" runs ~13.7° west of
// true north).
//
// Inputs (tools/data/terrassa/, downloaded by tools/overpass.sh from the queries in tools/data/*.overpassql):
//   osm_boundary.json   municipal boundaries (admin_level 8) of Terrassa and the towns around it
//   osm_roads.json      every highway of the urban area with its tags, plus crossings, signals & stop signs
//   osm_buildings.json  building footprints (Spanish cadastre import) with their storeys / heights
//   osm_landuse.json    parks, squares, pitches, woods, fields, streams, railways, parking & street trees
//   osm_landmarks.json  named buildings & sites, neighbourhood & square place nodes
//   osm_region.json     major roads, railways, settlements & peaks out to the horizon
//
// usage: GEO_DATA=tools/data/terrassa node --max-old-space-size=8192 tools/build-geodata.mjs [outFile]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/terrassa/', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const log = (...a) => console.log('[geodata]', ...a);

// =====================================================================================================================
// 1. FRAME
// =====================================================================================================================
// Origin: the centre of the Plaça Vella (OSM way 27491525), the heart of the old town
const LAT0 = 41.561974;
const LON0 = 2.011102;
// The detail box: the urban area of Terrassa the roads, buildings & land use were downloaded for (q_roads etc.)
const DETAIL = { south: 41.538, west: 1.972, north: 41.608, east: 2.052 };
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;
let THETA = (-13.7 * Math.PI) / 180; // bearing of the grid's north; refined below from the streets

// Local tangent plane (east, north) metres
const enu = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
// Grid frame: u = grid east, v = grid south
function gridUV(lon, lat) {
  const [e, n] = enu(lon, lat);
  const c = Math.cos(THETA);
  const s = Math.sin(THETA);
  return [e * c - n * s, -(e * s + n * c)];
}
const toWorld = (lon, lat) => gridUV(lon, lat);
// World (x, z) back to (lon, lat)
function toLonLat(x, z) {
  const c = Math.cos(THETA);
  const s = Math.sin(THETA);
  const e = x * c - z * s;
  const n = -(x * s + z * c);
  return [LON0 + e / KX, LAT0 + n / KY];
}

// =====================================================================================================================
// 2. GEOMETRY HELPERS
// =====================================================================================================================
const r1 = (x) => Math.round(x * 10) / 10;
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
const centroid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];
// Ramer-Douglas-Peucker on an open polyline
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
// RDP on a closed ring (split at the two farthest-apart vertices)
function rdpRing(ring, eps) {
  if (ring.length < 4) return ring.slice();
  let i0 = 0;
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[i0][0], ring[i][1] - ring[i0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(i0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[i0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// Closed ring without a repeated last point, wound clockwise in (x, z) (negative shoelace area), simplified
function cleanRing(r, eps = 0) {
  let ring = r.slice();
  if (ring.length > 1 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-6) ring.pop();
  if (eps > 0) ring = rdpRing(ring, eps);
  if (ringArea(ring) > 0) ring.reverse();
  return ring;
}

// ---------------------------------------------------------------------------------------------------------------------
// Raster tools (block labelling, land-use shares)
// ---------------------------------------------------------------------------------------------------------------------
class Raster {
  constructor(x0, z0, x1, z1, res, Type = Uint8Array) {
    this.res = res;
    this.x0 = Math.floor(x0 / res) * res;
    this.z0 = Math.floor(z0 / res) * res;
    this.w = Math.ceil((x1 - this.x0) / res) + 1;
    this.h = Math.ceil((z1 - this.z0) / res) + 1;
    this.d = new Type(this.w * this.h);
  }
  // Scanline fill of a ring (even-odd) with `val`
  fillRing(ring, val = 1) {
    const { res, x0, z0, w, h, d } = this;
    const bb = bbox(ring);
    const jy0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const jy1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = jy0; j <= jy1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k];
        const [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) d[j * w + i] = val;
      }
    }
  }
  // Fill of a polygon with holes (outer ring + inner rings, even-odd)
  fillPolygon(rings, val = 1) {
    if (rings.length === 1) return this.fillRing(rings[0], val);
    const { res, x0, z0, w, h, d } = this;
    const all = rings.flat();
    const bb = bbox(all);
    const jy0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const jy1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = jy0; j <= jy1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
          const [xa, za] = ring[k];
          const [xb, zb] = ring[i];
          if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
        }
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) d[j * w + i] = val;
      }
    }
  }
  // Stamp a capsule (segment with radius r) with `val`
  stampCapsule(xa, za, xb, zb, r, val = 0, only = null) {
    const { res, w, h, d } = this;
    const ix0 = Math.max(0, Math.floor((Math.min(xa, xb) - r - this.x0) / res));
    const ix1 = Math.min(w - 1, Math.ceil((Math.max(xa, xb) + r - this.x0) / res));
    const iz0 = Math.max(0, Math.floor((Math.min(za, zb) - r - this.z0) / res));
    const iz1 = Math.min(h - 1, Math.ceil((Math.max(za, zb) + r - this.z0) / res));
    if (ix0 > ix1 || iz0 > iz1) return;
    const dx = xb - xa, dz = zb - za;
    const L2 = dx * dx + dz * dz || 1e-9;
    const r2 = r * r;
    for (let j = iz0; j <= iz1; j++) {
      const pz = this.z0 + (j + 0.5) * res;
      for (let i = ix0; i <= ix1; i++) {
        const k = j * w + i;
        if (only !== null && d[k] !== only) continue;
        const px = this.x0 + (i + 0.5) * res;
        let t = ((px - xa) * dx + (pz - za) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = xa + t * dx - px, ez = za + t * dz - pz;
        if (ex * ex + ez * ez <= r2) d[k] = val;
      }
    }
  }
  at(x, z) {
    const i = Math.floor((x - this.x0) / this.res), j = Math.floor((z - this.z0) / this.res);
    return i >= 0 && j >= 0 && i < this.w && j < this.h ? this.d[j * this.w + i] : 0;
  }
  // Squared Euclidean distance (in cells) from every cell to the nearest cell where mask(v) is true (Felzenszwalb)
  edt(isSource) {
    const { w, h, d } = this;
    const INF = 1e20;
    const f = new Float64Array(Math.max(w, h));
    const out = new Float32Array(w * h);
    const v = new Int32Array(Math.max(w, h));
    const zz = new Float64Array(Math.max(w, h) + 1);
    const dt1 = (n, get, set) => {
      for (let q = 0; q < n; q++) f[q] = get(q);
      let k = 0;
      v[0] = 0;
      zz[0] = -INF;
      zz[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= zz[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        zz[k] = s;
        zz[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (zz[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
      }
    };
    for (let i = 0; i < w * h; i++) out[i] = isSource(d[i]) ? 0 : INF;
    for (let i = 0; i < w; i++) dt1(h, (q) => out[q * w + i], (q, val) => (out[q * w + i] = val));
    for (let j = 0; j < h; j++) dt1(w, (q) => out[j * w + q], (q, val) => (out[j * w + q] = val));
    return out;
  }
  // Keep only the 4-connected component containing the most cells
  keepLargest() {
    const { w, h, d } = this;
    const lab = new Int32Array(w * h);
    let best = 0, bestN = 0, cur = 0;
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!d[s] || lab[s]) continue;
      cur++;
      let n = 0;
      stack.push(s);
      lab[s] = cur;
      while (stack.length) {
        const p = stack.pop();
        n++;
        const i = p % w, j = (p - i) / w;
        if (i > 0 && d[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack.push(p - 1); }
        if (i < w - 1 && d[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack.push(p + 1); }
        if (j > 0 && d[p - w] && !lab[p - w]) { lab[p - w] = cur; stack.push(p - w); }
        if (j < h - 1 && d[p + w] && !lab[p + w]) { lab[p + w] = cur; stack.push(p + w); }
      }
      if (n > bestN) { bestN = n; best = cur; }
    }
    for (let i = 0; i < w * h; i++) d[i] = lab[i] === best ? 1 : 0;
  }
}

// =====================================================================================================================
// 3. OPENSTREETMAP HELPERS (Overpass JSON with `out geom`)
// =====================================================================================================================
const wayPts = (e) => (e.geometry || []).map((g) => toWorld(g.lon, g.lat));
const isClosedWay = (e) => e.type === 'way' && e.nodes && e.nodes.length > 3 && e.nodes[0] === e.nodes[e.nodes.length - 1];
// Chain the member ways of a multipolygon relation with a given role into closed rings
function relationRings(e, role = 'outer') {
  const parts = (e.members || []).filter((m) => m.type === 'way' && m.role === role && m.geometry && m.geometry.length > 1)
    .map((m) => m.geometry.map((g) => toWorld(g.lon, g.lat)));
  const rings = [];
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 2000 && !close(ring[0], ring[ring.length - 1]); guard++) {
      const i = parts.findIndex((p) => close(p[0], ring[ring.length - 1]) || close(p[p.length - 1], ring[ring.length - 1]));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(close(p[0], ring[ring.length - 1]) ? p.slice(1) : p.reverse().slice(1));
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}
// Every area of an element as { outer, inners } polygons (a closed way, or a multipolygon's outers with the inners
// they contain)
function elemPolygons(e) {
  if (e.type === 'way') return isClosedWay(e) || (e.geometry && e.geometry.length > 3) ? [{ outer: cleanRing(wayPts(e)), inners: [] }] : [];
  if (e.type !== 'relation') return [];
  const outers = relationRings(e, 'outer').map((r) => cleanRing(r));
  const inners = relationRings(e, 'inner').map((r) => cleanRing(r));
  return outers.map((outer) => ({ outer, inners: inners.filter((r) => r.length && pointInRing(r[0][0], r[0][1], outer)) }));
}
// The biggest outer ring of an element, or []
function elemRing(e) {
  const polys = elemPolygons(e);
  let best = [];
  for (const p of polys) if (Math.abs(ringArea(p.outer)) > Math.abs(ringArea(best))) best = p.outer;
  return best;
}
const num = (v) => {
  if (v === undefined || v === null) return NaN;
  const m = /-?\d+(\.\d+)?/.exec(String(v).replace(',', '.'));
  return m ? parseFloat(m[0]) : NaN;
};

// =====================================================================================================================
// 4. FRAME CALIBRATION FROM THE STREETS
// =====================================================================================================================
const osmRoads = load('osm_roads.json');
{
  // Bearing: length-weighted orientation histogram (mod 90°) of the streets within 1.5 km of the Plaça Vella, refined
  // around its peak (the Eixample's grid; the old town & the Rambla run ~16° off it and get their own frames)
  const GRID = new Set(['residential', 'tertiary', 'secondary', 'primary', 'living_street', 'pedestrian', 'unclassified']);
  const bins = new Float64Array(90);
  for (const w of osmRoads.elements) {
    if (w.type !== 'way' || !w.geometry || !GRID.has((w.tags || {}).highway)) continue;
    const g = w.geometry;
    for (let i = 0; i + 1 < g.length; i++) {
      const [e0, n0] = enu(g[i].lon, g[i].lat);
      const [e1, n1] = enu(g[i + 1].lon, g[i + 1].lat);
      if (Math.hypot((e0 + e1) / 2, (n0 + n1) / 2) > 1500) continue;
      const L = Math.hypot(e1 - e0, n1 - n0);
      if (L < 5) continue;
      let a = (Math.atan2(e1 - e0, n1 - n0) * 180) / Math.PI;
      a = ((a % 90) + 90) % 90;
      bins[Math.round(a) % 90] += L;
    }
  }
  let peak = 0;
  for (let i = 0; i < 90; i++) if (bins[i] > bins[peak]) peak = i;
  let sx = 0, sy = 0;
  for (let i = 0; i < 90; i++) {
    const d = ((((i - peak + 45) % 90) + 90) % 90) - 45;
    if (Math.abs(d) <= 6) {
      sx += bins[i] * Math.cos((4 * i * Math.PI) / 180);
      sy += bins[i] * Math.sin((4 * i * Math.PI) / 180);
    }
  }
  let deg = (((Math.atan2(sy, sx) * 180) / Math.PI / 4) + 90) % 90; // 0..90
  if (deg > 45) deg -= 90; // the grid's north: the orientation nearest true north
  THETA = (deg * Math.PI) / 180;
  log(`grid bearing ${deg.toFixed(2)}° (grid north ${deg < 0 ? 'west' : 'east'} of true north), origin at the Plaça Vella`);
}

// =====================================================================================================================
// 5. LAND: the detail box (the urban area) as a ring in the world frame; the municipality & its neighbours
// =====================================================================================================================
const detailBox = cleanRing([
  toWorld(DETAIL.west, DETAIL.north), toWorld(DETAIL.east, DETAIL.north), toWorld(DETAIL.east, DETAIL.south), toWorld(DETAIL.west, DETAIL.south)
]);
const inDetail = (lon, lat) => lon >= DETAIL.west && lon <= DETAIL.east && lat >= DETAIL.south && lat <= DETAIL.north;

const osmBoundary = load('osm_boundary.json');
const municipalities = [];
for (const e of osmBoundary.elements) {
  if (e.type !== 'relation' || !e.tags || !e.tags.name) continue;
  const rings = relationRings(e, 'outer').map((r) => cleanRing(r, 4)).filter((r) => r.length > 3);
  if (!rings.length) continue;
  rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  municipalities.push({ name: e.tags.name, population: parseInt(e.tags.population || '0', 10) || 0, rings });
}
const terrassa = municipalities.find((m) => m.name === 'Terrassa');
if (!terrassa) throw new Error('Terrassa boundary missing from osm_boundary.json');
log(`${municipalities.length} municipalities; Terrassa ${terrassa.rings.length} rings, ${terrassa.rings[0].length} pts, ${(Math.abs(ringArea(terrassa.rings[0])) / 1e6).toFixed(1)} km²`);

const geo = { get THETA() { return THETA; }, DETAIL, detailBox, inDetail, municipalities, terrassa };
export {
  geo, toWorld, toLonLat, enu, gridUV, rdp, rdpRing, ringArea, bbox, pointInRing, cleanRing, Raster, r1, load, log, centroid,
  wayPts, isClosedWay, relationRings, elemPolygons, elemRing, num, osmRoads
};
