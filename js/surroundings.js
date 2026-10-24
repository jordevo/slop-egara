import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  attribute,
  texture,
  positionWorld,
  positionGeometry,
  normalGeometry,
  normalWorld,
  uv,
  sin,
  abs,
  floor,
  fract,
  max,
  clamp,
  mix,
  step,
  smoothstep,
  dot,
  fwidth,
  select
} from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { LAND_RING, pointInPoly } from './city-config.js';
import { GEO } from './terrassa-geodata.js';

// js/surroundings.js
// The Vallès Occidental around the simulated Terrassa, at true 1:1 scale in the world frame (1 unit = 1 m, x = east
// along the Eixample grid, z = grid south, origin at the Plaça Vella), from the detailed area (city-config LAND_RING,
// the turned ~6.6 x 7.8 km rectangle drawn by city-grid.js) out to the fogged horizon, built to read as the real place
// from the street, the roofs and the helicopter while staying cheap:
// - The ground: one flat earthy plain (fields, dry grass, pine copses of the Vallès) out to 30 km, painted with the
//   real settlement polygons of OpenStreetMap (GEO.region.settlements: residential / industrial / commercial / retail)
//   as roofscapes and yards, lit by sodium street lights at night
// - The terrain silhouette: Terrassa sits at ~280 m with the Sant Llorenç del Munt i l'Obac massif rising straight to
//   the north and north-west (la Mola 1104 m, el Montcau 1056 m, the Serra de l'Obac ridge ~900 m) and the lower
//   Serra de Collserola / Llobregat hills to the south-east and west. There is no elevation model in the data: the
//   heightfield is PROCEDURAL, grown from the 220 real named peaks with their elevations (GEO.region.peaks) as smooth
//   cones whose reach scales with their height above the plain, plus low-frequency noise, flattened inside and around
//   the detailed area so the city stays flat. Coloured by height & slope: holm-oak and Aleppo-pine forest on the
//   slopes, the ochre-grey conglomerate cliffs of Sant Llorenç where steep and high
// - Towns: ~80k instanced generic buildings inside the settlement polygons (small-town 2-5 storey blocks, villas,
//   industrial sheds; Sabadell denser and taller with some 10-15 storey blocks), density & height scaled by the
//   population of the nearest town (GEO.region.towns)
// - Major roads (C-58, B-40, C-16, N-150, AP-7...) as asphalt ribbons following the terrain, and the railways (Renfe
//   R4 Barcelona - Manresa, the FGC Barcelona - Vallès metre-gauge line, the high-speed line) as ballast strips with
//   rails (GEO.region.roads / rails); the pieces inside the detailed area are city-grid's
// - Far forest: cheap instanced pines & holm oaks on the mountain slopes, densest next to the city
// Fidelity (HOW_TO_IMPROVE.md §4.9): peaks, settlement polygons, roads and railways are exact OSM data; the terrain
// between them is an approximation (not a DEM); the buildings and the forest are invented.

const SURROUNDINGS_NAME = 'Surroundings';
const REGION = GEO.region || { roads: [], rails: [], settlements: [], towns: [], peaks: [] };
const CITY_ELEVATION = 280; // the Plaça Vella, m above sea level: world y = 0

// =====================================================================================================================
// 1. HELPERS
// =====================================================================================================================

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Colours are authored as sRGB swatches and converted to the linear values the shaders work in
const toLinear = (c) => Math.pow(c, 2.2);
const srgb = (r, g, b) => vec3(toLinear(r), toLinear(g), toLinear(b));
const smooth01 = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
const lerp = (a, b, t) => a + (b - a) * t;
const toPts = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};
function polygonBounds(pts) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of pts) {
    b.minX = Math.min(b.minX, p.x);
    b.maxX = Math.max(b.maxX, p.x);
    b.minZ = Math.min(b.minZ, p.z);
    b.maxZ = Math.max(b.maxZ, p.z);
  }
  return b;
}
function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

// Deterministic CPU value noise (integer-lattice hash), for the terrain and the placement jitter
function hashInt(ix, iz) {
  let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + 1013904223;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function valueNoise2(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hashInt(ix, iz);
  const b = hashInt(ix + 1, iz);
  const c = hashInt(ix, iz + 1);
  const d = hashInt(ix + 1, iz + 1);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return top + (bot - top) * uz;
}
function fbm2(x, z, octaves) {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    s += amp * valueNoise2(x * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return s / norm;
}

// Signed distance to the detailed area (negative inside): LAND_RING is a small convex ring, so the direct test is cheap
function distToDetail(x, z) {
  let d = Infinity;
  const P = LAND_RING;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) d = Math.min(d, distToSegment(x, z, P[j].x, P[j].z, P[i].x, P[i].z));
  return pointInPoly(LAND_RING, x, z) ? -d : d;
}

// TSL shader helpers (the same cheap distant-material toolkit as the original's boroughs)
const hash12 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const valueNoise = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash12(i);
  const b = hash12(i.add(vec2(1.0, 0.0)));
  const c = hash12(i.add(vec2(0.0, 1.0)));
  const d = hash12(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});
// Box-filtered periodic pulse: fraction of a footprint `w` around `x` where fract() lies in [a, b]; settles to the
// mean coverage once a period shrinks below a pixel, so grids never shimmer at distance
const boxPulse = Fn(([x, a, b, w]) => {
  const p = float(x).toVar();
  const lo = float(a).toVar();
  const hi = float(b).toVar();
  const hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
});
// 0 by day, ~0.75 at blue hour, 1 at night (lighting.js drives cityUniforms.uInteriorGlow)
const nightFactorNode = () => smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);

// =====================================================================================================================
// 2. TERRAIN HEIGHTFIELD (procedural, from the real peaks)
// =====================================================================================================================

// Grid: 100 m cells over ±20 km (401 x 401 samples). World y = height above the Plaça Vella (280 m a.s.l.).
const T_HALF = 20000;
const T_CELL = 100;
const T_N = Math.round((2 * T_HALF) / T_CELL) + 1;
const DETAIL_BLEND = 1500; // m beyond the detailed area over which the relief fades in
const HORIZON_FADE0 = 16500; // the peaks were collected within 16 km: the relief settles back to the plain beyond
const HORIZON_FADE1 = 20000;

// Elevation of the Vallès plain itself (m a.s.l.), approximate: the plain tilts down from Terrassa (280 m) towards
// Sabadell (190 m), Rubí (123 m) and Sant Cugat (124 m) to the south-east, and drops into the Llobregat valley
// (Martorell / Olesa, ~100 m) to the west. Only used to measure how far each peak rises above its own surroundings;
// the plain is rendered flat at y = 0 so the detailed area's deck meets it without a step.
function plainElevation(x, z) {
  return Math.max(105, CITY_ELEVATION - 0.014 * Math.max(0, z) - 0.02 * Math.max(0, -x - 4000) - 0.01 * Math.max(0, x - 9000));
}
// The massif's base: the foothills north of the city rise as a whole (Castellar del Vallès 330 m, Sant Llorenç Savall
// 500 m) before the peaks; a gentle plateau the cones stand on
function massifBase(x, z) {
  return 110 * smooth01((-z - 5200) / 4500) * smooth01((9500 - Math.abs(x)) / 3000);
}

// Peaks outside the detailed area, with their height above the local plain and the reach of their cone (a typical
// 15-20° mountainside: ~3.4 m of reach per metre of height, 260 m-3600 m)
const PEAKS = REGION.peaks
  .filter((p) => distToDetail(p.x, p.z) > 0)
  .map((p) => {
    const rel = Math.max(0, p.ele - plainElevation(p.x, p.z) - massifBase(p.x, p.z));
    const r = Math.min(3600, Math.max(260, rel * 3.4));
    return { name: p.name, ele: p.ele, x: p.x, z: p.z, rel, r, r2: r * r };
  })
  .filter((p) => p.rel > 5);
// Coarse buckets so each vertex only tests the peaks whose cones can reach it
const PEAK_BUCKET = 4000;
const PEAK_BUCKETS = new Map();
for (const p of PEAKS) {
  const i0 = Math.floor((p.x - p.r) / PEAK_BUCKET);
  const i1 = Math.floor((p.x + p.r) / PEAK_BUCKET);
  const j0 = Math.floor((p.z - p.r) / PEAK_BUCKET);
  const j1 = Math.floor((p.z + p.r) / PEAK_BUCKET);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const k = i * 10007 + j;
    if (!PEAK_BUCKETS.has(k)) PEAK_BUCKETS.set(k, []);
    PEAK_BUCKETS.get(k).push(p);
  }
}
// Height of the mountains at a point: the tallest cone, slightly fattened where several overlap (the massif's shoulders)
function mountainHeight(x, z) {
  const list = PEAK_BUCKETS.get(Math.floor(x / PEAK_BUCKET) * 10007 + Math.floor(z / PEAK_BUCKET));
  if (!list) return 0;
  let best = 0;
  let acc = 0;
  for (const p of list) {
    const dx = x - p.x;
    const dz = z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= p.r2) continue;
    const t2 = d2 / p.r2;
    const h = p.rel * Math.pow(1 - t2, 1.7);
    if (h > best) best = h;
    acc += h * h * h * h;
  }
  if (!best) return 0;
  return best + Math.min(best * 0.12, (Math.pow(acc, 0.25) - best) * 0.3);
}
// The terrain model at any point (m above the city): mountains + massif base + noise, flattened in and around the
// detailed area and towards the edge of the grid
function terrainModel(x, z) {
  const dr = distToDetail(x, z);
  if (dr <= 0) return 0;
  // flat for the first cell outside the detailed area too, so no triangle straddling its edge rises over the deck
  const mask = smooth01((dr - T_CELL * 1.2) / DETAIL_BLEND);
  const far = 1 - smooth01((Math.hypot(x, z) - HORIZON_FADE0) / (HORIZON_FADE1 - HORIZON_FADE0));
  let h = mountainHeight(x, z) + massifBase(x, z);
  // Ridged detail on the massif (gullies & spurs), only a gentle roll on the plain
  const n = fbm2(x / 1400 + 7.3, z / 1400 + 2.1, 4) - 0.5;
  h += n * 70 * Math.min(1, h / 180) + n * 10;
  return Math.max(0, h) * mask * far;
}

const TERRAIN = (() => {
  const h = new Float32Array(T_N * T_N);
  for (let j = 0; j < T_N; j++) {
    const z = -T_HALF + j * T_CELL;
    for (let i = 0; i < T_N; i++) h[j * T_N + i] = terrainModel(-T_HALF + i * T_CELL, z);
  }
  return h;
})();

/**
 * Terrain height (world y) at (x, z): the surface of the rendered mesh (its triangles, so roads and trees placed with
 * it never sink into it); 0 on the plain, in the detailed area and beyond the grid.
 */
function terrainHeightAt(x, z) {
  const fx = (x + T_HALF) / T_CELL;
  const fz = (z + T_HALF) / T_CELL;
  if (fx < 0 || fz < 0 || fx >= T_N - 1 || fz >= T_N - 1) return 0;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const a = TERRAIN[j * T_N + i];
  const b = TERRAIN[j * T_N + i + 1];
  const d = TERRAIN[(j + 1) * T_N + i];
  const e = TERRAIN[(j + 1) * T_N + i + 1];
  // the mesh splits each cell along the b-d diagonal (triangles a,b,d and b,e,d)
  if (u + v <= 1) return a + (b - a) * u + (d - a) * v;
  return e + (d - e) * (1 - u) + (b - e) * (1 - v);
}
/** Terrain slope at (x, z) as rise over run (0 flat, 1 = 45°) */
function terrainSlopeAt(x, z) {
  const s = T_CELL * 0.5;
  const gx = (terrainHeightAt(x + s, z) - terrainHeightAt(x - s, z)) / (2 * s);
  const gz = (terrainHeightAt(x, z + s) - terrainHeightAt(x, z - s)) / (2 * s);
  return Math.hypot(gx, gz);
}

// =====================================================================================================================
// 3. SETTLEMENT RASTER (the real land-use polygons, for the ground shader and the builders)
// =====================================================================================================================

const LU = { half: 20000, w: 1024 };
LU.scale = LU.w / (2 * LU.half); // px per m
const luData = new Uint8Array(LU.w * LU.w * 4);
// Channels: r = residential, g = industrial, b = commercial / retail, a = unused
const LU_CHANNEL = { residential: 0, industrial: 1, commercial: 2, retail: 2 };

function luPaintPolygon(pts, ch, value) {
  const b = polygonBounds(pts);
  const y0 = Math.max(0, Math.floor((b.minZ + LU.half) * LU.scale));
  const y1 = Math.min(LU.w - 1, Math.ceil((b.maxZ + LU.half) * LU.scale));
  const xs = [];
  for (let py = y0; py <= y1; py++) {
    const z = (py + 0.5) / LU.scale - LU.half;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const c = pts[j];
      if ((a.z > z) !== (c.z > z)) xs.push(a.x + ((z - a.z) * (c.x - a.x)) / (c.z - a.z));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.round((xs[k] + LU.half) * LU.scale));
      const x1 = Math.min(LU.w - 1, Math.round((xs[k + 1] + LU.half) * LU.scale) - 1);
      for (let px = x0; px <= x1; px++) luData[(py * LU.w + px) * 4 + ch] = value;
    }
  }
}

const SETTLEMENTS = REGION.settlements.map((s) => ({ name: s.name, cls: s.cls, area: s.area, pts: toPts(s.ring) }));
for (const s of SETTLEMENTS) {
  const ch = LU_CHANNEL[s.cls];
  if (ch !== undefined) luPaintPolygon(s.pts, ch, 255);
}
// Clear the detailed area (city-grid paints its own ground there) so the texture filtering never bleeds a town's
// roofscape over its edge
{
  const b = polygonBounds(LAND_RING);
  for (let py = Math.max(0, Math.floor((b.minZ + LU.half) * LU.scale)); py <= Math.min(LU.w - 1, Math.ceil((b.maxZ + LU.half) * LU.scale)); py++) {
    const z = (py + 0.5) / LU.scale - LU.half;
    for (let px = Math.max(0, Math.floor((b.minX + LU.half) * LU.scale)); px <= Math.min(LU.w - 1, Math.ceil((b.maxX + LU.half) * LU.scale)); px++) {
      const x = (px + 0.5) / LU.scale - LU.half;
      if (distToDetail(x, z) < 25) luData.fill(0, (py * LU.w + px) * 4, (py * LU.w + px) * 4 + 3);
    }
  }
}
const landUseTexture = new THREE.DataTexture(luData, LU.w, LU.w, THREE.RGBAFormat);
landUseTexture.magFilter = THREE.LinearFilter;
landUseTexture.minFilter = THREE.LinearMipmapLinearFilter;
landUseTexture.generateMipmaps = true;
landUseTexture.wrapS = THREE.ClampToEdgeWrapping;
landUseTexture.wrapT = THREE.ClampToEdgeWrapping;
landUseTexture.needsUpdate = true;

// =====================================================================================================================
// 4. THE GROUND: plain + mountains in one vertex-coloured mesh, the horizon skirt beyond
// =====================================================================================================================

// Ground palette (sRGB): the dry Vallès plain, Mediterranean forest, conglomerate rock
const C_FIELD = [0.63, 0.53, 0.37]; // stubble & ploughed fields
const C_FIELD2 = [0.54, 0.41, 0.29]; // red-brown ploughed earth
const C_DRYGRASS = [0.67, 0.61, 0.43];
const C_SCRUB = [0.47, 0.47, 0.30]; // garrigue / brolla
const C_PINE = [0.30, 0.38, 0.22]; // Aleppo pine canopy
const C_OAK = [0.21, 0.29, 0.16]; // holm oak canopy (darker)
const C_ROCK = [0.61, 0.56, 0.48]; // conglomerate, grey-ochre
const C_ROCK2 = [0.56, 0.46, 0.37]; // its reddish faces
const C_SCREE = [0.52, 0.50, 0.46];
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Base colour of the ground at a vertex, from height & slope with noise: fields on the plain, pine & oak forest on the
// slopes, rock where steep or high (the cliffs of la Mola and el Montcau), scree below the cliffs
function groundColour(x, z, h, slope) {
  const n1 = valueNoise2(x / 650 + 3.1, z / 650 + 9.7); // field / wood patchwork
  const n2 = valueNoise2(x / 190 + 1.7, z / 190 + 4.2); // fine variation
  const n3 = fbm2(x / 2600 + 5.5, z / 2600 + 1.3, 3); // large regional variation
  // The plain: a patchwork of fields, dry grass and pine copses, more wooded towards the hills
  let plain = mix3(C_FIELD, C_DRYGRASS, smooth01((n2 - 0.35) / 0.4));
  plain = mix3(plain, C_FIELD2, smooth01((n1 - 0.62) / 0.12) * 0.8);
  const copse = smooth01((n1 + n2 * 0.4 - 0.78) / 0.14) * 0.9 + smooth01((n3 - 0.55) / 0.2) * 0.4;
  plain = mix3(plain, C_PINE, Math.min(1, copse));
  // The slopes: holm oak in the shady gullies, pine on the sunny spurs, scrub on the lower dry slopes
  let forest = mix3(C_PINE, C_OAK, smooth01((n1 - 0.45) / 0.3));
  forest = mix3(forest, C_SCRUB, smooth01((n2 - 0.6) / 0.25) * smooth01((160 - h) / 160) * 0.7);
  const wooded = smooth01((h - 12) / 50) * 0.85 + smooth01((slope - 0.06) / 0.1) * 0.5;
  let col = mix3(plain, forest, Math.min(1, wooded));
  // Rock: steep faces, and the high crags above ~700 m (980 m a.s.l.) where the conglomerate shows through
  const rockN = valueNoise2(x / 120 + 8.3, z / 120 + 2.9);
  const steep = smooth01((slope - 0.42 - rockN * 0.1) / 0.16);
  const high = smooth01((h - 640 - rockN * 120) / 140) * smooth01((slope - 0.12) / 0.15);
  const rock = mix3(mix3(C_ROCK, C_ROCK2, smooth01((n2 - 0.5) / 0.3)), C_SCREE, smooth01((rockN - 0.6) / 0.2) * 0.5);
  col = mix3(col, rock, Math.min(1, steep + high));
  // Dark shading of the deep gullies, pale sun-bleached tops
  const shade = 0.9 + 0.2 * n2 + 0.04 * Math.min(1, h / 600);
  return [col[0] * shade, col[1] * shade, col[2] * shade];
}

function buildGroundGeometry() {
  const n = T_N;
  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    const z = -T_HALF + j * T_CELL;
    for (let i = 0; i < n; i++) {
      const x = -T_HALF + i * T_CELL;
      const k = j * n + i;
      const h = TERRAIN[k];
      pos[k * 3] = x;
      pos[k * 3 + 1] = h > 0.05 ? h : -0.05; // the flat plain sits just under city-grid's deck (y = 0)
      pos[k * 3 + 2] = z;
      // slope from the neighbouring samples (central differences, clamped at the border)
      const hL = TERRAIN[j * n + Math.max(0, i - 1)];
      const hR = TERRAIN[j * n + Math.min(n - 1, i + 1)];
      const hU = TERRAIN[Math.max(0, j - 1) * n + i];
      const hD = TERRAIN[Math.min(n - 1, j + 1) * n + i];
      const slope = Math.hypot((hR - hL) / (2 * T_CELL), (hD - hU) / (2 * T_CELL));
      const c = groundColour(x, z, h, slope);
      col[k * 3] = toLinear(c[0]);
      col[k * 3 + 1] = toLinear(c[1]);
      col[k * 3 + 2] = toLinear(c[2]);
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const d = a + n;
      const e = d + 1;
      // the same split terrainHeightAt() interpolates: (a, b, d) and (b, e, d), wound to face up (+y)
      idx[o++] = a; idx[o++] = d; idx[o++] = b;
      idx[o++] = b; idx[o++] = d; idx[o++] = e;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// The flat horizon skirt from the edge of the heightfield out to 30 km (a square ring, 8 triangles, plain colour)
function buildSkirtGeometry() {
  const R0 = T_HALF;
  const R1 = 30000;
  const y = -0.05;
  const ring = [[-R1, -R1], [R1, -R1], [R1, R1], [-R1, R1]];
  const inner = [[-R0, -R0], [R0, -R0], [R0, R0], [-R0, R0]];
  const pos = [];
  const col = [];
  const c = [toLinear(C_FIELD[0] * 0.97), toLinear(C_FIELD[1] * 0.97), toLinear(C_FIELD[2] * 0.97)];
  for (const [x, z] of [...ring, ...inner]) {
    pos.push(x, y, z);
    col.push(c[0], c[1], c[2]);
  }
  // 0-3 outer, 4-7 inner; faces wound to face up
  const idx = [0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3, 3, 6, 7, 3, 7, 0, 0, 7, 4];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Ground material: the vertex colours (height / slope / regional noise) with fine procedural detail, overridden on the
 * flat land by the settlement raster: residential roofscapes (terracotta & grey roofs between streets, with yard
 * trees), pale industrial sheds & yards, commercial boxes. Sodium street lights speckle the towns at night.
 * MeshStandardNodeMaterial, so lighting.js' aerial-perspective fog applies.
 */
function createGroundMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0 });
  const wp = positionWorld;
  const base = attribute('color', 'vec3');
  const luUV = vec2(wp.x.add(LU.half).div(2 * LU.half), wp.z.add(LU.half).div(2 * LU.half));
  const lu = texture(landUseTexture, luUV).toVar();
  const flatness = smoothstep(0.86, 0.96, normalWorld.y).toVar(); // towns only on the gentler ground

  // Fine detail: field furrows and canopy clumps that keep the ground from reading as a flat tint up close
  const fine = valueNoise(wp.xz.mul(0.045)).toVar();
  const clump = valueNoise(wp.xz.mul(0.16).add(13.0));
  let col = base.mul(float(0.86).add(fine.mul(0.2)).add(clump.mul(0.08)));

  // Residential: a 16 m cell grid of roofs (terracotta for the small houses, grey for the blocks) split by streets,
  // with garden trees; the grid dissolves into its mean once a cell is below a pixel
  const cellSize = 16.0;
  const gc = wp.xz.div(cellSize).toVar();
  const fw = max(fwidth(gc.x), fwidth(gc.y)).toVar();
  const roofId = floor(gc);
  const rh = hash12(roofId).toVar();
  const street = float(1.0).sub(boxPulse(gc.x, 0.12, 0.92, fw).mul(boxPulse(gc.y, 0.1, 0.9, fw))).toVar();
  const cTile = srgb(0.62, 0.42, 0.31);
  const cTile2 = srgb(0.55, 0.36, 0.27);
  const cGreyRoof = srgb(0.56, 0.55, 0.52);
  const cPaleRoof = srgb(0.72, 0.70, 0.66);
  const roof = mix(mix(cTile, cTile2, step(0.5, rh)), mix(cGreyRoof, cPaleRoof, step(0.8, rh)), step(0.62, rh));
  const cAsphalt = srgb(0.33, 0.33, 0.33);
  const cYard = mix(srgb(0.26, 0.34, 0.17), srgb(0.36, 0.42, 0.22), clump);
  const yard = step(0.86, hash12(roofId.add(vec2(3.1, 7.7)))).mul(float(1.0).sub(street));
  let resi = mix(roof, cAsphalt, street);
  resi = mix(resi, cYard, yard);
  // Industrial: big pale sheds in coarse cells, concrete yards between them
  const ic = wp.xz.div(42.0).toVar();
  const ifw = max(fwidth(ic.x), fwidth(ic.y));
  const ih = hash12(floor(ic)).toVar();
  const shedMask = boxPulse(ic.x, 0.08, 0.88, ifw).mul(boxPulse(ic.y, 0.1, 0.85, ifw));
  const cShed = mix(mix(srgb(0.74, 0.74, 0.72), srgb(0.62, 0.63, 0.63), step(0.55, ih)), srgb(0.50, 0.42, 0.37), step(0.88, ih));
  const indu = mix(srgb(0.47, 0.46, 0.44), cShed, shedMask);
  // Commercial / retail: large flat grey roofs and car parks
  const comm = mix(srgb(0.42, 0.42, 0.42), srgb(0.70, 0.70, 0.69), shedMask);

  const rAmt = lu.r.mul(flatness).toVar();
  const gAmt = lu.g.mul(flatness).toVar();
  const bAmt = lu.b.mul(flatness).toVar();
  col = mix(col, resi, rAmt);
  col = mix(col, indu, gAmt);
  col = mix(col, comm, bAmt);
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.95), float(0.85), max(rAmt, max(gAmt, bAmt)));

  // Night: sodium / warm-white street lights along the towns' streets, faint shed yard floods in the estates
  const lampHash = hash12(floor(wp.xz.div(30.0)));
  const lamps = step(0.45, lampHash).mul(float(0.35).add(lampHash.mul(0.4)));
  const townGlow = rAmt.mul(lamps).mul(0.42).add(gAmt.mul(step(0.6, ih)).mul(0.2)).add(bAmt.mul(0.3));
  mat.emissiveNode = vec3(1.0, 0.64, 0.32).mul(townGlow).mul(nightFactorNode());
  return mat;
}

// =====================================================================================================================
// 5. ROADS & RAILWAYS (ribbons draped on the terrain)
// =====================================================================================================================

const RIBBON_STEP = 30; // m between ribbon cross-sections (follows the 100 m terrain cells)
const DETAIL_MARGIN = 3; // ribbon points this far inside the detailed area are city-grid's

// Resamples a polyline at ≤ RIBBON_STEP and splits it into runs outside the detailed area
function ribbonRuns(pts) {
  const runs = [];
  let run = [];
  const push = (x, z) => {
    if (distToDetail(x, z) < DETAIL_MARGIN) {
      if (run.length > 1) runs.push(run);
      run = [];
      return;
    }
    run.push([x, z]);
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / RIBBON_STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      push(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    }
  }
  if (pts.length) push(pts[pts.length - 1].x, pts[pts.length - 1].z);
  if (run.length > 1) runs.push(run);
  return runs;
}

// Builds one indexed mesh of ribbons: position, normal (up), uv = (metres along, metres across from the centreline)
function buildRibbonGeometry(items, lift) {
  const pos = [];
  const nrm = [];
  const uvs = [];
  const idx = [];
  for (const { pts, w } of items) {
    for (const run of ribbonRuns(pts)) {
      const base = pos.length / 3;
      let along = 0;
      for (let i = 0; i < run.length; i++) {
        const [x, z] = run[i];
        const [px, pz] = run[Math.max(0, i - 1)];
        const [nx, nz] = run[Math.min(run.length - 1, i + 1)];
        let dx = nx - px;
        let dz = nz - pz;
        const L = Math.hypot(dx, dz) || 1;
        dx /= L;
        dz /= L;
        if (i) along += Math.hypot(x - px, z - pz);
        // across = right of the direction of travel; lifted a little more where the ground slopes (the 100 m terrain
        // triangles cut across the carriageway between samples)
        const y = terrainHeightAt(x, z) + lift + terrainSlopeAt(x, z) * 5;
        const hw = w * 0.5;
        pos.push(x - dz * hw, y, z + dx * hw, x + dz * hw, y, z - dx * hw);
        nrm.push(0, 1, 0, 0, 1, 0);
        uvs.push(along, -hw, along, hw);
        if (i) {
          const a = base + (i - 1) * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// Asphalt with lane paint: motorways get a dashed centre line (the median), solid white edge lines and the lane
// dashes; the other roads a dashed centre line only. uv.x = m along, uv.y = m across.
function createRoadMaterial(motorway) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0.0 });
  const st = uv();
  const along = st.x;
  const across = st.y.toVar();
  const fwA = fwidth(across).toVar();
  const wear = valueNoise(positionWorld.xz.mul(0.07));
  let asphalt = mix(srgb(0.30, 0.30, 0.31), srgb(0.38, 0.38, 0.38), wear);
  const dash = boxPulse(along.div(12.0), 0.0, 0.33, fwidth(along.div(12.0))).toVar(); // 4 m dash every 12 m
  const line = (centre, hw) => float(1.0).sub(smoothstep(hw, hw.add(fwA), abs(across.sub(centre))));
  const white = srgb(0.86, 0.86, 0.84);
  let paint = line(float(0.0), float(0.08)).mul(dash);
  if (motorway) {
    // two carriageways 10.5 m each about a 3 m median: edge lines at ±1.5 and ±11.5 m, lane dashes at ±5 and ±8.3 m
    paint = line(float(1.5), float(0.1)).add(line(float(-1.5), float(0.1))).add(line(float(11.4), float(0.1))).add(line(float(-11.4), float(0.1)));
    paint = paint.add(line(float(5.0), float(0.08)).add(line(float(-5.0), float(0.08))).add(line(float(8.3), float(0.08))).add(line(float(-8.3), float(0.08))).mul(dash));
    const median = float(1.0).sub(smoothstep(1.2, 1.5, abs(across)));
    asphalt = mix(asphalt, srgb(0.46, 0.45, 0.40), median); // gravel / planted median strip
  }
  // paint dissolves to a faint lightening once below a pixel
  const far = smoothstep(0.5, 2.0, fwA);
  mat.colorNode = mix(mix(asphalt, white, clamp(paint, 0.0, 1.0).mul(0.8)), asphalt.mul(1.04), far);
  mat.roughnessNode = mix(float(0.9), float(0.75), paint);
  return mat;
}

// Ballast with two rails & sleepers; gauge in metres (1.668 Iberian for Renfe, 1.435 for the high-speed line, 1.0 FGC)
function createRailMaterial(gauge) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0 });
  const st = uv();
  const along = st.x;
  const across = st.y.toVar();
  const fwA = fwidth(across).toVar();
  const ballastN = valueNoise(positionWorld.xz.mul(0.5));
  const ballast = mix(srgb(0.40, 0.38, 0.35), srgb(0.52, 0.50, 0.47), ballastN);
  const halfGauge = gauge * 0.5;
  const rail = float(1.0).sub(smoothstep(0.06, float(0.06).add(fwA), abs(abs(across).sub(halfGauge))));
  const sleeperU = along.div(0.65);
  const sleeper = boxPulse(sleeperU, 0.0, 0.4, fwidth(sleeperU)).mul(step(abs(across), float(halfGauge + 0.5)));
  const far = smoothstep(0.3, 1.5, fwA);
  let col = mix(ballast, srgb(0.33, 0.30, 0.27), sleeper.mul(float(1.0).sub(far)).mul(0.8));
  col = mix(col, srgb(0.55, 0.55, 0.56), rail.mul(float(1.0).sub(far)));
  mat.colorNode = col;
  return mat;
}

function buildRoadsAndRails(group) {
  const motorways = [];
  const roads = [];
  for (const [, cls, link, flat] of REGION.roads) {
    const pts = toPts(flat);
    if (pts.length < 2) continue;
    if (cls === 1 && !link) motorways.push({ pts, w: 24 });
    else roads.push({ pts, w: 9 });
  }
  const railsStd = [];
  const railsNarrow = [];
  for (const [, narrow, flat] of REGION.rails) {
    const pts = toPts(flat);
    if (pts.length < 2) continue;
    (narrow ? railsNarrow : railsStd).push({ pts, w: narrow ? 5.5 : 7 });
  }
  const add = (items, mat, lift, name) => {
    if (!items.length) return;
    const mesh = new THREE.Mesh(buildRibbonGeometry(items, lift), mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  };
  add(motorways, createRoadMaterial(true), 0.16, 'Autopistes');
  add(roads, createRoadMaterial(false), 0.12, 'Carreteres');
  add(railsStd, createRailMaterial(1.668), 0.14, 'FerrocarrilRodalies');
  add(railsNarrow, createRailMaterial(1.0), 0.14, 'FerrocarrilFGC');
  return { motorways: motorways.length, roads: roads.length, rails: railsStd.length + railsNarrow.length };
}

// Occupancy of the motorways & railways on a coarse grid (40 m cells), so no building or tree stands on them
const OCC = { half: T_HALF, cell: 40 };
OCC.n = Math.ceil((2 * OCC.half) / OCC.cell);
const occupancy = new Uint8Array(OCC.n * OCC.n);
function occupyPolyline(pts, radius) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / (OCC.cell * 0.5)));
    for (let k = 0; k <= n; k++) {
      const x = a.x + (b.x - a.x) * (k / n);
      const z = a.z + (b.z - a.z) * (k / n);
      const i0 = Math.floor((x - radius + OCC.half) / OCC.cell);
      const i1 = Math.floor((x + radius + OCC.half) / OCC.cell);
      const j0 = Math.floor((z - radius + OCC.half) / OCC.cell);
      const j1 = Math.floor((z + radius + OCC.half) / OCC.cell);
      for (let jj = Math.max(0, j0); jj <= Math.min(OCC.n - 1, j1); jj++) for (let ii = Math.max(0, i0); ii <= Math.min(OCC.n - 1, i1); ii++) occupancy[jj * OCC.n + ii] = 1;
    }
  }
}
for (const [, cls, link, flat] of REGION.roads) occupyPolyline(toPts(flat), cls === 1 && !link ? 22 : 8);
for (const [, , flat] of REGION.rails) occupyPolyline(toPts(flat), 8);
function occupied(x, z) {
  const i = Math.floor((x + OCC.half) / OCC.cell);
  const j = Math.floor((z + OCC.half) / OCC.cell);
  if (i < 0 || j < 0 || i >= OCC.n || j >= OCC.n) return false;
  return occupancy[j * OCC.n + i] === 1;
}

// =====================================================================================================================
// 6. TOWNS: generic instanced buildings in the settlement polygons
// =====================================================================================================================

// Unit box with its base at y = 0 and no bottom face
const BOX_GEO = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  const src = g.index.array;
  const keep = [];
  for (let i = 0; i < src.length; i++) if (i < 18 || i >= 24) keep.push(src[i]);
  g.setIndex(keep);
  g.clearGroups();
  return g;
})();

// Facade swatches (sRGB): the rendered & painted plaster of Catalan towns, brick, the white and pale grey of the sheds
const PALETTE = {
  plaster: [[0.86, 0.78, 0.64], [0.82, 0.72, 0.58], [0.88, 0.84, 0.74], [0.80, 0.66, 0.50], [0.74, 0.60, 0.46], [0.84, 0.74, 0.66], [0.90, 0.88, 0.82], [0.70, 0.52, 0.42]],
  brick: [[0.60, 0.40, 0.30], [0.66, 0.46, 0.34], [0.56, 0.36, 0.28], [0.72, 0.56, 0.42]],
  bloc: [[0.76, 0.72, 0.64], [0.68, 0.64, 0.58], [0.80, 0.78, 0.74], [0.62, 0.48, 0.38], [0.72, 0.68, 0.60], [0.58, 0.58, 0.56]],
  tower: [[0.74, 0.72, 0.68], [0.64, 0.62, 0.60], [0.56, 0.44, 0.36], [0.70, 0.66, 0.58]],
  villa: [[0.92, 0.90, 0.84], [0.88, 0.80, 0.66], [0.84, 0.74, 0.58], [0.90, 0.86, 0.76], [0.78, 0.62, 0.48]],
  shed: [[0.84, 0.84, 0.82], [0.74, 0.76, 0.76], [0.90, 0.90, 0.88], [0.62, 0.64, 0.66], [0.80, 0.74, 0.62], [0.56, 0.60, 0.64]],
  commercial: [[0.78, 0.78, 0.76], [0.62, 0.64, 0.66], [0.70, 0.52, 0.40], [0.86, 0.86, 0.84]]
};
// Facade styles of the shader: 0 punched windows & terracotta roof (houses), 1 blocks with balcony bands & flat roof,
// 2 industrial sheds (ribbon windows, grey roof), 3 villas (few windows, tile roof), 4 towers (regular grid)
const STYLE = { HOUSE: 0, BLOC: 1, SHED: 2, VILLA: 3, TOWER: 4 };
const pickFrom = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];

// Town profiles by population of the nearest place (GEO.region.towns): floors range, tower share & height, lot pitch,
// share of the lots built
function townProfile(town) {
  const pop = town ? town.population : 0;
  if (pop >= 150000) return { kind: 'ciutat gran', floors: [4, 8], towers: 0.05, towerFloors: [10, 15], pitch: 25, keep: 0.9, core: 1800 }; // Sabadell
  if (pop >= 60000) return { kind: 'ciutat', floors: [3, 6], towers: 0.02, towerFloors: [9, 13], pitch: 26, keep: 0.85, core: 1200 }; // Rubí, Sant Cugat
  if (pop >= 15000) return { kind: 'vila gran', floors: [2, 5], towers: 0.008, towerFloors: [8, 11], pitch: 27, keep: 0.8, core: 800 };
  if (pop >= 5000) return { kind: 'vila', floors: [2, 4], towers: 0, towerFloors: [6, 8], pitch: 28, keep: 0.72, core: 500 };
  return { kind: 'poble', floors: [1, 2], towers: 0, towerFloors: [4, 5], pitch: 34, keep: 0.55, core: 300 }; // villas: Matadepera, Ullastrell...
}
const TOWNS = REGION.towns.filter((t) => t.name !== (GEO.city || 'Terrassa')).map((t) => ({ ...t, profile: townProfile(t) }));
function nearestTown(x, z) {
  let best = null;
  let bd = Infinity;
  for (const t of TOWNS) {
    const d = Math.hypot(t.x - x, t.z - z);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return { town: best, dist: bd };
}

const MAX_BUILD_DIST = 11000; // m from the detailed area; the ground shader carries the towns beyond
const BUILD_MARGIN = 40; // m clear of the detailed area's edge (its own blocks stand there)

// Footprint on the terrain: y from the lowest corner so nothing floats on a slope; skipped where too steep
function groundBox(x, z, w, d, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
    const h = terrainHeightAt(x + (u * w * c - v * d * s), z + (u * w * s + v * d * c));
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  if (hi - lo > Math.min(6, 2 + Math.max(w, d) * 0.12)) return null;
  return lo - 0.15;
}

function generateTownBuildings() {
  const list = [];
  const rand = mulberry32(20261024);
  const stats = { residential: 0, industrial: 0, commercial: 0, towers: 0, skipped: 0 };
  for (const s of SETTLEMENTS) {
    const ch = LU_CHANNEL[s.cls];
    if (ch === undefined) continue;
    const b = polygonBounds(s.pts);
    if (b.maxX < -T_HALF || b.minX > T_HALF || b.maxZ < -T_HALF || b.minZ > T_HALF) continue;
    const industrial = s.cls === 'industrial';
    const commercial = s.cls === 'commercial' || s.cls === 'retail';
    // One lot grid per polygon, turned a little at random (towns' own street directions)
    const rot = (rand() - 0.5) * 0.9 + (industrial ? 0 : (Math.round(rand() * 3) * Math.PI) / 2);
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const pitch = industrial ? 58 : commercial ? 46 : null;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const reach = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) * 0.5;
    const { town } = nearestTown(cx, cz);
    const prof = town ? town.profile : townProfile(null);
    const p = pitch || prof.pitch;
    const nu = Math.ceil(reach / p);
    for (let i = -nu; i <= nu; i++) {
      for (let j = -nu; j <= nu; j++) {
        const ju = (i + 0.5 + (rand() - 0.5) * 0.3) * p;
        const jv = (j + 0.5 + (rand() - 0.5) * 0.3) * p;
        const x = cx + ju * cr - jv * sr;
        const z = cz + ju * sr + jv * cr;
        if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
        if (!pointInPoly(s.pts, x, z)) continue;
        const dd = distToDetail(x, z);
        if (dd < BUILD_MARGIN || dd > MAX_BUILD_DIST) continue;
        if (occupied(x, z)) continue;
        // Thin out with distance (the far towns are carried by the ground shader), and by the town's build share
        const keep = (industrial ? 0.8 : commercial ? 0.7 : prof.keep) * (1 - smooth01((dd - 2500) / (MAX_BUILD_DIST - 2500)) * 0.75);
        if (rand() > keep) continue;
        const dTown = town ? Math.hypot(town.x - x, town.z - z) : Infinity;
        let w;
        let d;
        let h;
        let tint;
        let style;
        if (industrial) {
          // Naus: big sheds, 1-2 storeys, a few taller warehouses
          w = 24 + rand() * 40;
          d = 18 + rand() * 28;
          h = rand() < 0.15 ? 11 + rand() * 6 : 6 + rand() * 4;
          tint = pickFrom(PALETTE.shed, rand);
          style = STYLE.SHED;
          stats.industrial++;
        } else if (commercial) {
          w = 24 + rand() * 30;
          d = 18 + rand() * 24;
          h = 5 + rand() * 7;
          tint = pickFrom(PALETTE.commercial, rand);
          style = STYLE.SHED;
          stats.commercial++;
        } else {
          const core = smooth01(1 - dTown / prof.core); // 1 at the town centre
          const villas = prof.kind === 'poble' || (prof.kind === 'vila' && rand() < 0.35 && core < 0.3);
          if (villas) {
            w = 9 + rand() * 6;
            d = 8 + rand() * 6;
            h = (1 + Math.round(rand() * 0.7)) * 3.1 + 0.6;
            tint = pickFrom(PALETTE.villa, rand);
            style = STYLE.VILLA;
          } else if (prof.towers > 0 && rand() < prof.towers * (0.4 + core)) {
            w = 16 + rand() * 12;
            d = 14 + rand() * 10;
            h = (prof.towerFloors[0] + Math.round(rand() * (prof.towerFloors[1] - prof.towerFloors[0]))) * 3.0 + 1.0;
            tint = pickFrom(PALETTE.tower, rand);
            style = STYLE.TOWER;
            stats.towers++;
          } else {
            const f0 = prof.floors[0];
            const f1 = prof.floors[1];
            const floors = Math.max(1, Math.round(f0 + (f1 - f0) * Math.pow(rand(), 1.2) + core * 1.5));
            const bloc = floors >= 4 || rand() < 0.2;
            w = bloc ? 14 + rand() * 12 : 7 + rand() * 7;
            d = bloc ? 11 + rand() * 9 : 9 + rand() * 7;
            h = floors * 3.1 + (bloc ? 1.0 : 0.4);
            tint = pickFrom(bloc ? PALETTE.bloc : rand() < 0.25 ? PALETTE.brick : PALETTE.plaster, rand);
            style = bloc ? STYLE.BLOC : STYLE.HOUSE;
          }
          stats.residential++;
        }
        w = Math.min(w, p * 0.9);
        d = Math.min(d, p * 0.9);
        const y = groundBox(x, z, w, d, rot);
        if (y === null) {
          stats.skipped++;
          continue;
        }
        list.push({ x, y, z, w, h, d, rot, tint, style, seed: rand() * 100 });
      }
    }
  }
  return { list, stats };
}

/**
 * Town facades (instanced unit boxes): punched windows on plaster or brick with persianes, balcony bands on the
 * blocks, ribbon windows and a grey roof on the sheds, terracotta tile roofs on the houses & villas, lit windows at
 * night. Instance attributes: bInfo = (width, height, depth, seed), bTint = (r, g, b, style).
 */
function createTownBuildingMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 });
  const info = attribute('bInfo', 'vec4');
  const tint = attribute('bTint', 'vec4');
  const pG = positionGeometry;
  const nG = normalGeometry;
  const style = tint.w;

  const isRoof = step(0.5, nG.y).toVar();
  const faceX = step(0.5, abs(nG.x));
  const wallW = mix(info.x, info.z, faceX);
  const u = mix(pG.x, pG.z, faceX).add(0.5).mul(wallW).add(info.w.mul(3.7)).toVar();
  const y = pG.y.mul(info.y).toVar();

  const s0 = style.lessThan(0.5);
  const s1 = style.lessThan(1.5);
  const s2 = style.lessThan(2.5);
  const s3 = style.lessThan(3.5);
  const pick = (a, b, c, d, e) => select(s0, float(a), select(s1, float(b), select(s2, float(c), select(s3, float(d), float(e)))));
  const bay = pick(2.6, 3.2, 6.0, 3.4, 3.0);
  const floorH = pick(3.1, 3.1, 4.5, 3.1, 3.0);
  const winW = pick(0.36, 0.55, 0.7, 0.3, 0.5);
  const winH = pick(0.5, 0.6, 0.3, 0.4, 0.55);
  const litProb = pick(0.3, 0.34, 0.08, 0.25, 0.3);

  const gu = u.div(bay).toVar();
  const gv = y.div(floorH).toVar();
  const fwU = fwidth(gu).toVar();
  const fwV = fwidth(gv).toVar();
  const wall = float(1.0).sub(isRoof).mul(float(1.0).sub(step(info.y.sub(0.9), y))).toVar();
  const winMask = boxPulse(gu, float(0.5).sub(winW.mul(0.5)), float(0.5).add(winW.mul(0.5)), fwU)
    .mul(boxPulse(gv, float(0.45).sub(winH.mul(0.5)), float(0.45).add(winH.mul(0.5)), fwV))
    .mul(wall)
    .mul(step(0.35, gv))
    .toVar();
  const cellHash = hash12(floor(vec2(gu, gv)).add(vec2(info.w.mul(0.61), info.w.mul(1.37)))).toVar();
  const far = smoothstep(0.35, 1.2, max(fwU, fwV)).toVar();
  const lit = mix(step(cellHash, litProb), litProb, far).toVar();

  const bHash = fract(info.w.mul(0.1373));
  const grime = valueNoise(vec2(u.mul(0.45), y.mul(0.05).add(info.w))).toVar();
  const wallBase = tint.rgb.mul(float(0.88).add(bHash.mul(0.24))).mul(mix(float(0.8), float(1.0), smoothstep(0.0, 6.0, y)));
  const wallCol = wallBase.mul(mix(float(0.88), float(1.06), grime)).toVar();
  // Balcony bands on the blocks & towers: a darker slab line under every floor's windows
  const band = float(1.0).sub(boxPulse(gv, 0.08, 0.96, fwV)).mul(pick(0.0, 1.0, 0.0, 0.0, 0.6)).mul(wall).mul(step(0.5, gv));
  const cBand = wallBase.mul(0.6);
  // Windows: dark glass, many with the persiana (roller blind) down: pale slats
  const winHash = hash12(floor(vec2(gu, gv)).add(vec2(info.w.mul(1.91), 5.3)));
  const blinds = mix(step(0.55, winHash), float(0.45), far).mul(pick(1.0, 1.0, 0.1, 0.8, 0.25));
  const cGlass = mix(vec3(0.015, 0.017, 0.02), srgb(0.70, 0.66, 0.56), blinds);
  // Ground floor: shop fronts & garage doors on the houses and blocks, loading bays on the sheds (none on the villas)
  const ground = float(1.0).sub(step(3.4, y)).mul(wall);
  const shopHash = hash12(vec2(floor(gu), info.w));
  const shop = ground.mul(step(0.45, shopHash)).mul(pick(1.0, 1.0, 1.0, 0.0, 1.0));
  // Roofs: terracotta tiles on houses & villas, grey gravel / terrat on the blocks, pale corrugated sheet on the sheds
  const tileN = valueNoise(positionWorld.xz.mul(0.9));
  const cTile = mix(srgb(0.64, 0.42, 0.30), srgb(0.52, 0.34, 0.26), tileN);
  const cTerrat = mix(srgb(0.58, 0.56, 0.52), srgb(0.70, 0.68, 0.64), step(0.6, bHash));
  const cSheet = mix(srgb(0.74, 0.74, 0.72), srgb(0.60, 0.62, 0.64), step(0.5, bHash));
  const roofCol = select(s0, cTile, select(s1, cTerrat, select(s2, cSheet, select(s3, cTile, cTerrat))));
  // Shed ribbon windows & the corrugated panels' faint stripes
  const corrug = boxPulse(u.div(1.1), 0.0, 0.5, fwidth(u.div(1.1))).mul(0.06).mul(pick(0.0, 0.0, 1.0, 0.0, 0.0)).mul(wall);

  let col = mix(wallCol, cBand, band);
  col = mix(col, cGlass, winMask);
  col = mix(col, vec3(0.08, 0.075, 0.07), shop.mul(0.6));
  col = col.mul(float(1.0).sub(corrug));
  col = mix(col, roofCol, isRoof);
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.86), float(0.2), winMask.mul(float(1.0).sub(blinds)));

  const night = nightFactorNode();
  const warm = mix(vec3(1.0, 0.7, 0.4), vec3(0.95, 0.9, 0.8), step(0.7, cellHash));
  const dimmer = mix(fract(cellHash.mul(13.7)).mul(0.7).add(0.3), float(0.6), far);
  const shopGlow = shop.mul(step(0.5, shopHash)).mul(0.7);
  mat.emissiveNode = warm.mul(winMask.mul(lit).mul(dimmer).add(shopGlow)).mul(night.mul(0.9).add(cityUniforms.uInteriorGlow.mul(0.08)));
  return mat;
}

// Spatially chunked InstancedMeshes (frustum culled per chunk) sharing one facade material
function buildBuildingChunks(list, material, chunkSize, name) {
  const chunks = new Map();
  for (const b of list) {
    const key = Math.floor(b.x / chunkSize) + ',' + Math.floor(b.z / chunkSize);
    let arr = chunks.get(key);
    if (!arr) chunks.set(key, (arr = []));
    arr.push(b);
  }
  const meshes = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (const [key, arr] of chunks) {
    const geo = new THREE.BufferGeometry();
    geo.setIndex(BOX_GEO.index);
    geo.setAttribute('position', BOX_GEO.attributes.position);
    geo.setAttribute('normal', BOX_GEO.attributes.normal);
    const info = new Float32Array(arr.length * 4);
    const tint = new Float32Array(arr.length * 4);
    const mesh = new THREE.InstancedMesh(geo, material, arr.length);
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      q.setFromAxisAngle(yAxis, b.rot);
      m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d));
      mesh.setMatrixAt(i, m);
      info[i * 4] = b.w;
      info[i * 4 + 1] = b.h;
      info[i * 4 + 2] = b.d;
      info[i * 4 + 3] = b.seed;
      tint[i * 4] = toLinear(b.tint[0]);
      tint[i * 4 + 1] = toLinear(b.tint[1]);
      tint[i * 4 + 2] = toLinear(b.tint[2]);
      tint[i * 4 + 3] = b.style;
    }
    geo.setAttribute('bInfo', new THREE.InstancedBufferAttribute(info, 4));
    geo.setAttribute('bTint', new THREE.InstancedBufferAttribute(tint, 4));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = name + ':' + key;
    meshes.push(mesh);
  }
  return meshes;
}

// =====================================================================================================================
// 7. FAR FOREST (cheap instanced pines & holm oaks on the slopes)
// =====================================================================================================================

const TREE_BUDGET = 50000;
const TREE_CHUNK = 4000;

// Minimal unit-height tree shapes (crown + trunk in one non-indexed geometry, flat shaded), tinted per instance:
// Aleppo pine = an umbrella crown (a 6-sided cone with its underside closed, 12 triangles) on a tall thin trunk (two
// crossed quads, 4 triangles); holm oak = a rounded dome (icosahedron, 20 triangles) on a short trunk.
function treeGeometry(triangles) {
  const pos = new Float32Array(triangles.length * 9);
  let o = 0;
  for (const tri of triangles) for (const v of tri) {
    pos[o++] = v[0];
    pos[o++] = v[1];
    pos[o++] = v[2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
function trunkTriangles(h, w) {
  // two crossed vertical quads (the material is double-sided)
  const tris = [];
  for (const [ax, az] of [[w * 0.5, 0], [0, w * 0.5]]) {
    const a = [-ax, 0, -az];
    const b = [ax, 0, az];
    const c = [ax, h, az];
    const d = [-ax, h, -az];
    tris.push([a, b, c], [a, c, d]);
  }
  return tris;
}
function makePineGeometry() {
  const tris = trunkTriangles(0.62, 0.07);
  const n = 6;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // a little irregularity, so a stand of pines does not read as identical cones
    const r = 0.5 * (0.85 + 0.15 * Math.sin(i * 2.4));
    ring.push([Math.cos(a) * r, 0.58 + 0.06 * Math.sin(i * 1.7), Math.sin(a) * r]);
  }
  const apex = [0, 1, 0];
  const under = [0, 0.5, 0];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    tris.push([apex, p, q], [under, q, p]);
  }
  return treeGeometry(tris);
}
function makeOakGeometry() {
  const tris = trunkTriangles(0.3, 0.1);
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map(([x, y, z]) => {
      const L = Math.hypot(x, y, z);
      return [(x / L) * 0.5, (y / L) * 0.42 + 0.62, (z / L) * 0.5];
    });
  const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (const [a, b, c] of f) tris.push([v[a], v[b], v[c]]);
  return treeGeometry(tris);
}

function createFarTreeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide });
  const tint = attribute('tTint', 'vec3');
  // darker trunk (the lowest part of the unit shape), lighter sunlit crown tops
  const lp = positionGeometry;
  const trunk = float(1.0).sub(smoothstep(0.28, 0.42, lp.y));
  const light = smoothstep(0.3, 1.05, lp.y).mul(0.35).add(0.75);
  const clump = valueNoise(positionWorld.xz.mul(0.9).add(positionWorld.y.mul(0.7)));
  mat.colorNode = mix(tint.mul(light).mul(clump.mul(0.3).add(0.85)), srgb(0.30, 0.25, 0.20), trunk);
  return mat;
}

function generateForestSites() {
  const rand = mulberry32(7331);
  const sites = []; // [x, y, z, scale, pine (1) / oak (0)]
  for (let j = 1; j < T_N - 1; j++) {
    const z0 = -T_HALF + j * T_CELL;
    for (let i = 1; i < T_N - 1; i++) {
      const x0 = -T_HALF + i * T_CELL;
      const h = TERRAIN[j * T_N + i];
      const dd = distToDetail(x0, z0);
      if (dd < 30) continue;
      // Forest cover: the slopes & the massif, plus the pine copses of the plain
      const n1 = valueNoise2(x0 / 650 + 3.1, z0 / 650 + 9.7);
      const slope = terrainSlopeAt(x0, z0);
      let cover = smooth01((h - 12) / 50) * 0.9 + smooth01((slope - 0.06) / 0.1) * 0.5;
      cover += smooth01((n1 - 0.78) / 0.14) * 0.6; // copses on the plain
      cover *= 1 - smooth01((slope - 0.45) / 0.15); // bare rock
      cover *= 1 - smooth01((h - 700) / 250) * 0.6; // thinner on the crags
      if (cover < 0.15) continue;
      // Density: a cell is 1 ha; dense near the city where single trees still read, sparser with distance
      const near = 1 - smooth01((dd - 1500) / 6000);
      const perCell = cover * (1.5 + 12 * near * near);
      const count = Math.floor(perCell + rand());
      for (let k = 0; k < count; k++) {
        const x = x0 + (rand() - 0.5) * T_CELL;
        const z = z0 + (rand() - 0.5) * T_CELL;
        if (occupied(x, z) || distToDetail(x, z) < 30) continue;
        const lu = luAt(x, z);
        if (lu > 0.3) continue; // not in the towns & estates
        const y = terrainHeightAt(x, z);
        const pine = rand() < 0.55 + 0.25 * smooth01((n1 - 0.45) / 0.3) ? 1 : 0;
        sites.push([x, y, z, pine ? 7 + rand() * 6 : 5 + rand() * 4, pine]);
      }
    }
  }
  if (sites.length > TREE_BUDGET) {
    // Over budget: thin uniformly (deterministic)
    const keep = TREE_BUDGET / sites.length;
    const out = [];
    for (const s of sites) if (rand() < keep) out.push(s);
    return out;
  }
  return sites;
}
// Settlement coverage (0-1) at a point from the raster
function luAt(x, z) {
  const px = Math.floor((x + LU.half) * LU.scale);
  const py = Math.floor((z + LU.half) * LU.scale);
  if (px < 0 || py < 0 || px >= LU.w || py >= LU.w) return 0;
  const o = (py * LU.w + px) * 4;
  return Math.max(luData[o], luData[o + 1], luData[o + 2]) / 255;
}

function buildForest(group) {
  const sites = generateForestSites();
  const pineGeo = makePineGeometry();
  const oakGeo = makeOakGeometry();
  const material = createFarTreeMaterial();
  const chunks = new Map();
  for (const s of sites) {
    const key = Math.floor(s[0] / TREE_CHUNK) + ',' + Math.floor(s[2] / TREE_CHUNK) + ':' + s[4];
    let arr = chunks.get(key);
    if (!arr) chunks.set(key, (arr = []));
    arr.push(s);
  }
  const rand = mulberry32(99);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  let meshes = 0;
  for (const [key, arr] of chunks) {
    const pine = key.endsWith(':1');
    const src = pine ? pineGeo : oakGeo;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', src.attributes.position);
    geo.setAttribute('normal', src.attributes.normal);
    const tint = new Float32Array(arr.length * 3);
    const mesh = new THREE.InstancedMesh(geo, material, arr.length);
    for (let i = 0; i < arr.length; i++) {
      const [x, y, z, h] = arr[i];
      q.setFromAxisAngle(yAxis, rand() * Math.PI * 2);
      const wd = pine ? h * (0.8 + rand() * 0.3) : h * (1.0 + rand() * 0.3);
      m.compose(p.set(x, y, z), q, sc.set(wd, h, wd));
      mesh.setMatrixAt(i, m);
      // Aleppo pine: grey-green; holm oak: dark green; a little variation
      const v = rand();
      const c = pine ? [0.34 + v * 0.08, 0.42 + v * 0.06, 0.26 + v * 0.04] : [0.20 + v * 0.06, 0.28 + v * 0.06, 0.15 + v * 0.04];
      tint[i * 3] = toLinear(c[0]);
      tint[i * 3 + 1] = toLinear(c[1]);
      tint[i * 3 + 2] = toLinear(c[2]);
    }
    geo.setAttribute('tTint', new THREE.InstancedBufferAttribute(tint, 3));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = (pine ? 'PinsBlancs' : 'Alzines') + ':' + key;
    group.add(mesh);
    meshes++;
  }
  return { trees: sites.length, meshes };
}

// =====================================================================================================================
// 8. ASSEMBLY
// =====================================================================================================================

/**
 * Builds everything around the detailed area: the Vallès plain, the Sant Llorenç del Munt massif, the towns' generic
 * buildings, the major roads & railways and the far forest. Call after buildCityGrid() (whose deck at y = 0 covers the
 * detailed area; the plain sits just under it). Options: { buildings = true, forest = true, roads = true }.
 * Returns { group, colliders: [] (nothing here stands in the drivable area), heightAt, slopeAt, stats }.
 */
function buildSurroundings(scene, { buildings = true, forest = true, roads = true } = {}) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = SURROUNDINGS_NAME;
  const stats = { peaks: PEAKS.length, settlements: SETTLEMENTS.length };

  // The ground: plain + mountains, and the flat horizon skirt beyond the heightfield
  const groundMat = createGroundMaterial();
  const ground = new THREE.Mesh(buildGroundGeometry(), groundMat);
  ground.name = 'Terreny';
  ground.castShadow = false;
  ground.receiveShadow = false;
  ground.frustumCulled = false; // one mesh spanning the world: always in view
  const skirt = new THREE.Mesh(buildSkirtGeometry(), groundMat);
  skirt.name = 'Horitzó';
  skirt.frustumCulled = false;
  group.add(ground, skirt);

  if (roads) Object.assign(stats, buildRoadsAndRails(group));

  if (buildings) {
    const { list, stats: bs } = generateTownBuildings();
    Object.assign(stats, bs, { buildings: list.length });
    const material = createTownBuildingMaterial();
    for (const mesh of buildBuildingChunks(list, material, 1500, 'Edificis')) group.add(mesh);
  }

  if (forest) Object.assign(stats, buildForest(group));

  scene.add(group);
  console.info(`[surroundings] ${JSON.stringify(stats)} built in ${(performance.now() - t0).toFixed(0)} ms`);
  return { group, colliders: [], heightAt: terrainHeightAt, slopeAt: terrainSlopeAt, stats };
}

export { buildSurroundings, terrainHeightAt, terrainSlopeAt, SURROUNDINGS_NAME };
