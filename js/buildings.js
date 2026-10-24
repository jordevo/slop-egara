import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  color,
  uv,
  attribute,
  texture,
  positionWorld,
  normalWorldGeometry,
  abs,
  fract,
  step,
  smoothstep,
  fwidth,
  max,
  min,
  mix,
  length,
  mx_noise_float,
  mx_worley_noise_float
} from 'three/tsl';
import {
  WORLD_BOUNDS,
  BLOCKS,
  SHOPS,
  LAND_CLASS,
  BUILDING_KIND,
  LANDMARK_SITES,
  MODELLED_LANDMARKS,
  SPAWN,
  blockProfile,
  blockAt,
  blocksInRect,
  nearestRoads,
  pointInPoly
} from './city-config.js';
import {
  createPreWarBuildingMaterial,
  createCurtainWallMaterial,
  createFacadeBoxes,
  WALL_KINDS
} from './tsl-materials.js';

// js/buildings.js
// The buildings of Terrassa, on every real block (city-config.js BLOCKS), indexed by a spatial quadtree that streams
// the high-detail architecture (cornices, balcony slabs, rooftop stair bulkheads — the "caixes d'escala" of the flat
// roofs / terrats —, HVAC on the commercial roofs, the awnings & fascia signs of the real shops) around the player.
//
// Two paths per block (HOW_TO_IMPROVE.md §2.5 / §5.4):
//   A. REAL BUILDINGS: every block with buildings in the Spanish Catastro (tools/geo-buildings.mjs: 25 880 cadastral
//      buildings, 101 848 parts; OpenStreetMap footprints only on the blocks the Catastro left empty). Each building
//      is a set of volumes in its own frame, every volume (rect) with its own storey count — a 5-storey body, a
//      1-storey rear extension, a 6-storey àtic — and the building carries its use, its year of construction and its
//      dwellings. Metres per storey come from the use and the era (the Catastro gives no heights), the facade bucket
//      from the era and the use, the roof from OSM's `roof:shape` when it has one, else from era & typology. Walls
//      are party walls, street fronts (shops / entrances) or rear walls by what lies beyond them: the building's
//      own volumes, the neighbours of the block, or the sidewalk & roadway.
//   B. PROCEDURAL: only the blocks with no building at all (fields, half-built estates) are filled with Terrassa's
//      typologies for their barri: the medieval core (oldtown), the Eixample's "cases de cos" row houses with
//      apartment blocks at the corners around a "pati d'illa", the 1960s-70s slab-block estates (blocs), detached
//      houses with gardens (suburban), industrial sheds (naves, with sawtooth roofs and the odd brick vapor chimney),
//      mixed estates and campuses. Real and procedural buildings never share a block.
// Footprints are rectilinear plans built as unions of non-overlapping boxes, instanced per facade material. Shop
// signs carry the real names of city-config.js SHOPS (OpenStreetMap POIs), one awning + fascia at the nearest
// street-facing wall of each; buildings without a shop entry get no sign.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (x, z, salt = 10019) => (Math.imul(Math.round(x * 4), 73856093) ^ Math.imul(Math.round(z * 4), 19349663) ^ salt) >>> 0;
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/**
 * Spatial 2D quadtree for range queries around the active player/camera position.
 */
class Quadtree {
  constructor(bounds, capacity = 6, maxDepth = 6, depth = 0) {
    this.bounds = bounds; // { minX, maxX, minZ, maxZ }
    this.capacity = capacity;
    this.maxDepth = maxDepth;
    this.depth = depth;
    this.items = [];
    this.divided = false;
    this.nw = null;
    this.ne = null;
    this.sw = null;
    this.se = null;
  }

  containsPoint(x, z) {
    const b = this.bounds;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  }

  intersectsCircle(cx, cz, radius) {
    const b = this.bounds;
    const closestX = Math.max(b.minX, Math.min(cx, b.maxX));
    const closestZ = Math.max(b.minZ, Math.min(cz, b.maxZ));
    const dx = cx - closestX;
    const dz = cz - closestZ;
    return (dx * dx + dz * dz) <= (radius * radius);
  }

  subdivide() {
    const b = this.bounds;
    const midX = (b.minX + b.maxX) * 0.5;
    const midZ = (b.minZ + b.maxZ) * 0.5;
    const nextDepth = this.depth + 1;

    this.nw = new Quadtree({ minX: b.minX, maxX: midX, minZ: b.minZ, maxZ: midZ }, this.capacity, this.maxDepth, nextDepth);
    this.ne = new Quadtree({ minX: midX, maxX: b.maxX, minZ: b.minZ, maxZ: midZ }, this.capacity, this.maxDepth, nextDepth);
    this.sw = new Quadtree({ minX: b.minX, maxX: midX, minZ: midZ, maxZ: b.maxZ }, this.capacity, this.maxDepth, nextDepth);
    this.se = new Quadtree({ minX: midX, maxX: b.maxX, minZ: midZ, maxZ: b.maxZ }, this.capacity, this.maxDepth, nextDepth);
    this.divided = true;

    for (const item of this.items) {
      this._insertIntoChildren(item);
    }
    this.items.length = 0;
  }

  _insertIntoChildren(item) {
    if (this.nw.containsPoint(item.cx, item.cz)) return this.nw.insert(item);
    if (this.ne.containsPoint(item.cx, item.cz)) return this.ne.insert(item);
    if (this.sw.containsPoint(item.cx, item.cz)) return this.sw.insert(item);
    if (this.se.containsPoint(item.cx, item.cz)) return this.se.insert(item);
    return false;
  }

  insert(item) {
    if (!this.containsPoint(item.cx, item.cz)) return false;

    if (!this.divided) {
      if (this.items.length < this.capacity || this.depth >= this.maxDepth) {
        this.items.push(item);
        return true;
      }
      this.subdivide();
    }
    return this._insertIntoChildren(item);
  }

  queryRange(cx, cz, radius, found = []) {
    if (!this.intersectsCircle(cx, cz, radius)) return found;

    const rSq = radius * radius;
    if (!this.divided) {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        const dx = item.cx - cx;
        const dz = item.cz - cz;
        if (dx * dx + dz * dz <= rSq) {
          found.push(item);
        }
      }
      return found;
    }

    this.nw.queryRange(cx, cz, radius, found);
    this.ne.queryRange(cx, cz, radius, found);
    this.sw.queryRange(cx, cz, radius, found);
    this.se.queryRange(cx, cz, radius, found);
    return found;
  }
}

// ============================================================================
// RECTILINEAR FOOTPRINTS: plans as unions of non-overlapping axis-aligned rects { x0, x1, z0, z1 }
// (x runs west → east, z north → south, in the frame being built in)
// ============================================================================
const EPS = 0.05;
// Volumes of one cadastral building are rasterised one by one (tools/geo-buildings.mjs, 0.5 m cells), so two touching
// volumes may meet with a gap or an overlap of up to ~0.3 m: within this they count as touching (party wall)
const TOUCH = 0.35;
const OPPOSITE = { n: 's', s: 'n', w: 'e', e: 'w' };
const SIDES = ['w', 'e', 'n', 's']; // createFacadeBoxes `faces` order: the -x, +x, -z & +z walls
const SIDE_IDX = { w: 0, e: 1, n: 2, s: 3 };
const NORMAL = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
const rect = (x0, x1, z0, z1) => ({ x0, x1, z0, z1 });
const rectW = (r) => r.x1 - r.x0;
const rectD = (r) => r.z1 - r.z0;
const insetAll = (r, d) => rect(r.x0 + d, r.x1 - d, r.z0 + d, r.z1 - d);

// Length of side `s` of rect r, and the rect's extent perpendicular to it
const sideLen = (r, s) => (s === 'n' || s === 's' ? r.x1 - r.x0 : r.z1 - r.z0);
const sideDepth = (r, s) => (s === 'n' || s === 's' ? r.z1 - r.z0 : r.x1 - r.x0);

/** Rect in the frame of side `s` of r: `a` runs along that side (from its west / north end), `b` inward from it */
function sideRect(r, s, a0, a1, b0, b1) {
  if (s === 'n') return rect(r.x0 + a0, r.x0 + a1, r.z0 + b0, r.z0 + b1);
  if (s === 's') return rect(r.x0 + a0, r.x0 + a1, r.z1 - b1, r.z1 - b0);
  if (s === 'w') return rect(r.x0 + b0, r.x0 + b1, r.z0 + a0, r.z0 + a1);
  return rect(r.x1 - b1, r.x1 - b0, r.z0 + a0, r.z0 + a1);
}

/** Light court `cw` wide and `cd` deep, cut into the middle of side `s` (shifted `off` along it) */
function courtHole(r, s, cw, cd, off = 0) {
  const L = sideLen(r, s);
  return sideRect(r, s, (L - cw) * 0.5 + off, (L + cw) * 0.5 + off, -1, cd);
}

/** Notches nx (along x) by nz (along z) cut from the given corners of r */
function cornerHoles(r, nx, nz, corners = ['nw', 'ne', 'sw', 'se']) {
  return corners.map((c) => {
    const x0 = c[1] === 'w' ? r.x0 - 1 : r.x1 - nx;
    const z0 = c[0] === 'n' ? r.z0 - 1 : r.z1 - nz;
    return rect(x0, x0 + nx + 1, z0, z0 + nz + 1);
  });
}

/**
 * `r` minus `holes`, as non-overlapping rects: sliced into strips across `axis` ('x': strips running north-south,
 * 'z': strips running east-west) at every hole edge, neighbouring strips with identical spans merged back, so a
 * U-plan comes out as its base bar plus two wings. Slice so the street front stays one piece (one window grid).
 */
function carve(r, holes, axis = 'x') {
  const flip = axis === 'z';
  const U0 = flip ? r.z0 : r.x0;
  const U1 = flip ? r.z1 : r.x1;
  const V0 = flip ? r.x0 : r.z0;
  const V1 = flip ? r.x1 : r.z1;
  const hs = holes.map((h) => (flip ? [h.z0, h.z1, h.x0, h.x1] : [h.x0, h.x1, h.z0, h.z1]));
  const cuts = [U0, U1];
  for (const [u0, u1] of hs) {
    if (u0 > U0 + EPS && u0 < U1 - EPS) cuts.push(u0);
    if (u1 > U0 + EPS && u1 < U1 - EPS) cuts.push(u1);
  }
  cuts.sort((a, b) => a - b);

  const out = [];
  let open = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const ua = cuts[i];
    const ub = cuts[i + 1];
    if (ub - ua < EPS) continue;
    const um = (ua + ub) * 0.5;
    let spans = [[V0, V1]];
    for (const [u0, u1, v0, v1] of hs) {
      if (um <= u0 || um >= u1) continue;
      const next = [];
      for (const [a, b] of spans) {
        if (v1 <= a + EPS || v0 >= b - EPS) {
          next.push([a, b]);
          continue;
        }
        if (v0 > a + EPS) next.push([a, v0]);
        if (v1 < b - EPS) next.push([v1, b]);
      }
      spans = next;
    }
    const nextOpen = [];
    for (const [a, b] of spans) {
      let strip = open.find((o) => Math.abs(o[2] - a) < EPS && Math.abs(o[3] - b) < EPS);
      if (strip) {
        strip[1] = ub;
      } else {
        strip = [ua, ub, a, b];
        out.push(strip);
      }
      nextOpen.push(strip);
    }
    open = nextOpen;
  }
  return out.map(([u0, u1, v0, v1]) => (flip ? rect(v0, v1, u0, u1) : rect(u0, u1, v0, v1)));
}

/**
 * Unit roof prisms (base 1 × 1 at y = 0 centred on the origin, ridge / top at y = 1), scaled per instance:
 * gable (ridge along x, gable ends at ±x), hip (ridge along x shortened to the middle half), saw (one slope rising
 * from -z to a vertical face at +z: a sawtooth bay, or a skillion roof on its own).
 */
function roofPrism(kind) {
  const tris = [];
  const quad = (a, b, c, d) => tris.push(a, b, c, a, c, d);
  if (kind === 'gable') {
    quad([-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 1, 0]);
    quad([0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0]);
    tris.push([-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0]);
    tris.push([0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0]);
  } else if (kind === 'hip') {
    quad([-0.5, 0, 0.5], [0.5, 0, 0.5], [0.25, 1, 0], [-0.25, 1, 0]);
    quad([0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.25, 1, 0], [0.25, 1, 0]);
    tris.push([-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.25, 1, 0]);
    tris.push([0.5, 0, 0.5], [0.5, 0, -0.5], [0.25, 1, 0]);
  } else {
    quad([-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]);
    quad([0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5]);
    tris.push([-0.5, 0, 0.5], [-0.5, 0, -0.5], [-0.5, 1, 0.5]);
    tris.push([0.5, 0, -0.5], [0.5, 0, 0.5], [0.5, 1, 0.5]);
  }
  const pos = new Float32Array(tris.length * 3);
  tris.forEach((p, i) => pos.set(p, i * 3));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ============================================================================
// ERAS & STOREY HEIGHTS (the Catastro gives storeys, use and year; metres per storey are derived)
// ============================================================================
// 0 unknown, 1 ≤ 1900, 2 1901-1940 (Modernisme / Noucentisme), 3 1941-1960 (plain post-war stucco),
// 4 1961-1985 (the blocs), 5 1986-2005 (beige / white modern), 6 > 2005 (white & glass)
const ERA = { UNKNOWN: 0, OLD: 1, MODERNISME: 2, POSTWAR: 3, BLOCS: 4, MODERN: 5, NEW: 6 };
function eraOf(year) {
  if (!year) return ERA.UNKNOWN;
  if (year <= 1900) return ERA.OLD;
  if (year <= 1940) return ERA.MODERNISME;
  if (year <= 1960) return ERA.POSTWAR;
  if (year <= 1985) return ERA.BLOCS;
  if (year <= 2005) return ERA.MODERN;
  return ERA.NEW;
}
// Catastro currentUse codes (tools/catastro-to-json.py): 1 residential, 2 agriculture, 3 industrial, 4 office,
// 5 retail, 6 public services, 0 unknown (OSM fallback footprints)
const USE = { UNKNOWN: 0, RESIDENTIAL: 1, AGRICULTURE: 2, INDUSTRIAL: 3, OFFICE: 4, RETAIL: 5, PUBLIC: 6 };
// Metres per storey by use & era; `shopGround` / `shopGroundOld` are the taller ground floors under storefronts
const STOREY = { residential: 3.1, old: 3.4, shopGround: 3.6, shopGroundOld: 4.0, nave: 6.5, vapor: 4.2, office: 3.5, retail: 4.2, public: 3.8, shed: 3.0, church: 5.0 };
// Open courts, terraces & porches (parts with 0 storeys): a plinth
const PLINTH_H = 0.6;
const PLINTH_MIN_AREA = 4;

// Shop sign atlas: one 256 × 48 px cell per named shop (city-config.js SHOPS), 16 per row
const SIGN_W = 256;
const SIGN_H = 48;
const SIGN_COLS = 16;
const SIGN_CAP = 768;

function buildCityBlocks(scene) {
  const group = new THREE.Group();
  group.name = 'TerrassaCityBlocks';
  const colliders = [];

  // Frame of what is being built: the lots of a frontage frame (city-config.js BLOCKS frames: lots laid out along the
  // street they front, turned by θ about p) or a real building's own frame (turned by θ about its centroid). The
  // generator works in the frame as on a grid block and everything it emits is turned into place as it is emitted
  // (place), so buildings line up with their street / their real walls.
  let xf = null; // { th, cs, sn, px, pz }
  // The lot rectangle being populated by the procedural generator (frame coords) with the sides of it that face a
  // street: { x0, x1, z0, z1, streets: { n, s, w, e }, major: { n, s, w, e } }
  let cur = null;
  const toWorld = (x, z) => (xf
    ? [xf.px + (x - xf.px) * xf.cs + (z - xf.pz) * xf.sn, xf.pz - (x - xf.px) * xf.sn + (z - xf.pz) * xf.cs]
    : [x, z]);
  // Player collider over the rect [x0, x1] x [z0, z1] (of the current frame): an oriented box inside its world AABB
  function pushCollider(x0, x1, z0, z1, minY, maxY) {
    if (!xf) {
      colliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY, maxY });
      return;
    }
    const [cx, cz] = toWorld((x0 + x1) * 0.5, (z0 + z1) * 0.5);
    const hx = (x1 - x0) * 0.5;
    const hz = (z1 - z0) * 0.5;
    const ex = Math.abs(xf.cs) * hx + Math.abs(xf.sn) * hz;
    const ez = Math.abs(xf.sn) * hx + Math.abs(xf.cs) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY, maxY, obb: { cx, cz, hx, hz, cs: xf.cs, sn: xf.sn } });
  }
  // Turns an emitted item { x, z, (nx, nz: an outward normal) } of the current frame into the world: its position,
  // its turn about +y (ry) and the world normal (ox, oz)
  function place(o) {
    if (xf) {
      [o.x, o.z] = toWorld(o.x, o.z);
      o.ry = xf.th;
    }
    if (o.nx !== undefined) {
      const c = xf ? xf.cs : 1;
      const s = xf ? xf.sn : 0;
      o.ox = o.nx * c + o.nz * s;
      o.oz = -o.nx * s + o.nz * c;
    }
    return o;
  }
  const corners = (x0, x1, z0, z1) => [toWorld(x0, z0), toWorld(x1, z0), toWorld(x1, z1), toWorld(x0, z1)].map(([x, z]) => ({ x, z }));

  // Re-seeded from each block's / building's position, so every one is reproducible on its own
  let rand = mulberry32(10019);
  const range = (a, b) => a + (b - a) * rand();
  const irange = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const chance = (p) => rand() < p;
  const pick = (items) => items[Math.floor(rand() * items.length)];
  // Weighted pick from [[value, weight], ...]
  function pickW(table) {
    let total = 0;
    for (const e of table) total += e[1];
    let r = rand() * total;
    for (const e of table) {
      r -= e[1];
      if (r < 0) return e[0];
    }
    return table[table.length - 1][0];
  }

  // Spatial quadtree over the whole detailed area
  const quadtree = new Quadtree({
    minX: WORLD_BOUNDS.minX - 50,
    maxX: WORLD_BOUNDS.maxX + 50,
    minZ: WORLD_BOUNDS.minZ - 50,
    maxZ: WORLD_BOUNDS.maxZ + 50
  }, 6, 9);
  const allBlocks = [];

  // The eight facade buckets (one TSL material each), by era & use. The storey height baked into each material lays
  // the window rows out; buildings are massed with the storey height of their use (STOREY), so the rows line up
  // exactly where the two agree (3.4 m pre-1940, 3.1 m later housing) and the odd remainder closes as a solid
  // parapet band (tsl-materials.js facadeCell `partial`).
  const MAT = { OCHRE: 0, PINK: 1, BRICK: 2, PLAIN: 3, BLOCS: 4, MODERN: 5, NAVE: 6, GLASS: 7 };
  const facades = [
    // 0: ochre / cream stucco, timber-coloured woodwork, cornices (pre-1940: the old town, cases de cos)
    [createPreWarBuildingMaterial, {
      stoneColor: 0xd9c196,
      trimColor: 0xb59c74,
      windowGlassColor: 0x1a2430,
      windowWidth: 2.3,
      floorHeight: STOREY.old,
      litProbability: 0.5,
      warmth: 0.84,
      seed: 12.4,
      cornerPier: 0.9
    }],
    // 1: pinkish / pale yellow stucco with lighter stone trim (Modernisme / Noucentisme fronts, 1880-1940)
    [createPreWarBuildingMaterial, {
      stoneColor: 0xd7b49c,
      trimColor: 0xe1d6c4,
      windowGlassColor: 0x18222c,
      windowWidth: 2.2,
      floorHeight: STOREY.old,
      litProbability: 0.52,
      warmth: 0.86,
      seed: 27.8,
      cornerPier: 0.9
    }],
    // 2: exposed brick, pale stone lintels: the vapors & multi-storey factories (4.2 m floors), old retail & public
    [createPreWarBuildingMaterial, {
      stoneColor: 0x9e5d44,
      trimColor: 0xcfc1a6,
      windowGlassColor: 0x16222e,
      windowWidth: 2.5,
      floorHeight: STOREY.vapor,
      litProbability: 0.5,
      warmth: 0.82,
      seed: 41.2
    }],
    // 3: plain post-war stucco, 1940-1960: no cornices, small windows
    [createPreWarBuildingMaterial, {
      stoneColor: 0xd3c6ad,
      trimColor: 0xb3a78f,
      windowGlassColor: 0x1a2430,
      windowWidth: 2.4,
      floorHeight: STOREY.residential,
      windowRatioX: 0.5,
      windowRatioY: 0.52,
      litProbability: 0.5,
      warmth: 0.78,
      seed: 55.1,
      cornerPier: 0.5
    }],
    // 4: the blocs, 1960-1985: grey-beige render & brown brick panels, wide windows, flat roofs
    [createPreWarBuildingMaterial, {
      stoneColor: 0xb8aa94,
      trimColor: 0x8c8278,
      windowGlassColor: 0x1c2a36,
      windowWidth: 2.9,
      floorHeight: STOREY.residential,
      windowRatioX: 0.62,
      windowRatioY: 0.54,
      litProbability: 0.56,
      warmth: 0.66,
      seed: 63.5,
      cornerPier: 0.6
    }],
    // 5: beige / white modern apartment blocks, 1985 onwards, aluminium windows
    [createPreWarBuildingMaterial, {
      stoneColor: 0xe6dfd2,
      trimColor: 0xbdb6aa,
      windowGlassColor: 0x1c2a36,
      windowWidth: 2.7,
      floorHeight: STOREY.residential,
      windowRatioX: 0.58,
      windowRatioY: 0.58,
      litProbability: 0.56,
      warmth: 0.7,
      seed: 71.3,
      cornerPier: 0.8
    }],
    // 6: prefab concrete & sandwich panels: the naves, warehouses, supermarkets & retail halls (4.2 m rows: one low
    //    strip of windows and a blank band above on the 6.5 m sheds)
    [createPreWarBuildingMaterial, {
      stoneColor: 0xb3aa9b,
      trimColor: 0x878079,
      windowGlassColor: 0x1e262c,
      windowWidth: 3.4,
      floorHeight: STOREY.retail,
      windowRatioX: 0.66,
      windowRatioY: 0.38,
      litProbability: 0.3,
      warmth: 0.45,
      seed: 81.9,
      cornerPier: 0.8
    }],
    // 7: curtain-wall glass for the newer offices, hospitals & campus pavilions
    [createCurtainWallMaterial, {
      glassTint: 0x25465a,
      frameTint: 0x8c959c,
      windowWidth: 2.4,
      floorHeight: STOREY.office,
      litProbability: 0.55,
      warmth: 0.55,
      reflectivity: 0.9,
      seed: 94.3
    }]
  ];
  const materials = facades.map(([create, opts]) => create({ ...opts, boxLocal: true }));
  // Storey height of each facade bucket (the procedural buildings are massed in whole storeys of it)
  const storeys = facades.map(([, opts]) => opts.floorHeight);
  const buckets = materials.map(() => []);
  // Pitched roofs (static, instanced per shape)
  const roofItems = { gable: [], hip: [], saw: [] };

  // Facade buckets of the housing of each era (real buildings) and of each barri typology (procedural blocks)
  const RES_ERA = {
    [ERA.OLD]: [[MAT.OCHRE, 5], [MAT.PINK, 4]],
    [ERA.MODERNISME]: [[MAT.PINK, 5], [MAT.OCHRE, 4]],
    [ERA.POSTWAR]: [[MAT.PLAIN, 6], [MAT.OCHRE, 1]],
    [ERA.BLOCS]: [[MAT.BLOCS, 6], [MAT.PLAIN, 2]],
    [ERA.MODERN]: [[MAT.MODERN, 6], [MAT.BLOCS, 1]],
    [ERA.NEW]: [[MAT.MODERN, 1]]
  };
  const RES_MATS = {
    oldtown: [[MAT.OCHRE, 5], [MAT.PINK, 3], [MAT.PLAIN, 1]],
    eixample: [[MAT.OCHRE, 3], [MAT.PINK, 3], [MAT.PLAIN, 2], [MAT.BLOCS, 1.5], [MAT.MODERN, 1]],
    blocs: [[MAT.BLOCS, 5], [MAT.MODERN, 3], [MAT.PLAIN, 1]],
    suburban: [[MAT.MODERN, 3], [MAT.OCHRE, 2], [MAT.PLAIN, 2]],
    industrial: [[MAT.BLOCS, 2], [MAT.MODERN, 2], [MAT.PLAIN, 1]],
    mixed: [[MAT.PLAIN, 2], [MAT.BLOCS, 2], [MAT.MODERN, 2], [MAT.OCHRE, 1]],
    campus: [[MAT.MODERN, 3], [MAT.GLASS, 2], [MAT.BLOCS, 2]]
  };
  const resMats = (prof) => RES_MATS[prof.kind] || RES_MATS.eixample;
  // Era of a building the Catastro doesn't date (OSM fallback footprints): the barri's typical one
  const ERA_OF_BARRI = {
    oldtown: [[ERA.OLD, 3], [ERA.MODERNISME, 4], [ERA.POSTWAR, 1], [ERA.BLOCS, 1]],
    eixample: [[ERA.MODERNISME, 3], [ERA.POSTWAR, 2], [ERA.BLOCS, 3], [ERA.MODERN, 1]],
    blocs: [[ERA.BLOCS, 5], [ERA.MODERN, 2]],
    suburban: [[ERA.MODERN, 3], [ERA.NEW, 2], [ERA.BLOCS, 1]],
    industrial: [[ERA.POSTWAR, 1], [ERA.BLOCS, 3], [ERA.MODERN, 3], [ERA.NEW, 1]],
    mixed: [[ERA.POSTWAR, 1], [ERA.BLOCS, 3], [ERA.MODERN, 3], [ERA.NEW, 1]],
    campus: [[ERA.MODERN, 2], [ERA.NEW, 2]]
  };

  // ============================================================================
  // RESERVED GROUND: the landmark sites landmarks.js models (real buildings inside them are skipped, procedural lots
  // keep clear). Oriented boxes { cx, cz, ux, uz, hl, hw } (u = along the box) with their world bounds.
  // ============================================================================
  const landmarkSites = MODELLED_LANDMARKS.map((n) => LANDMARK_SITES[n]).filter(Boolean).map((s) => {
    if (s.ring && s.ring.length >= 3) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of s.ring) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      return { ring: s.ring, x0, x1, z0, z1 };
    }
    const r = s.w > 0 ? Math.max(s.w, s.d) * 0.5 + 2 : 6; // point landmarks (the chimneys): a 6 m radius
    return { ring: null, x0: s.x - r, x1: s.x + r, z0: s.z - r, z1: s.z + r };
  });
  const inLandmark = (x, z) => landmarkSites.some((s) => x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1 && (!s.ring || pointInPoly(s.ring, x, z)));
  const landmarkBoxes = landmarkSites.map((s) => ({
    cx: (s.x0 + s.x1) * 0.5, cz: (s.z0 + s.z1) * 0.5, ux: 1, uz: 0, hl: (s.x1 - s.x0) * 0.5 + 2, hw: (s.z1 - s.z0) * 0.5 + 2,
    x0: s.x0 - 2, x1: s.x1 + 2, z0: s.z0 - 2, z1: s.z1 + 2
  }));
  let reserves = [];
  // Separating-axis test of the rect [x0, x1] x [z0, z1] (of the current frame) against every reserved box
  function hitsReserve(x0, x1, z0, z1) {
    if (!reserves.length) return false;
    const hx = (x1 - x0) * 0.5;
    const hz = (z1 - z0) * 0.5;
    const [cx, cz] = toWorld(x0 + hx, z0 + hz);
    // the rect's axes in the world (R_y(θ) of local x and z)
    const ax = xf ? xf.cs : 1, az = xf ? -xf.sn : 0;
    const bx = xf ? xf.sn : 0, bz = xf ? xf.cs : 1;
    for (const o of reserves) {
      const dx = cx - o.cx;
      const dz = cz - o.cz;
      const vx = -o.uz, vz = o.ux;
      let apart = false;
      for (const [nx, nz] of [[ax, az], [bx, bz], [o.ux, o.uz], [vx, vz]]) {
        const r = hx * Math.abs(ax * nx + az * nz) + hz * Math.abs(bx * nx + bz * nz) +
          o.hl * Math.abs(o.ux * nx + o.uz * nz) + o.hw * Math.abs(vx * nx + vz * nz);
        if (Math.abs(dx * nx + dz * nz) >= r) { apart = true; break; }
      }
      if (!apart) return true;
    }
    return false;
  }

  // ============================================================================
  // BUILDING MASSING TOOLKIT
  // A building is a list of non-overlapping parts { x0, x1, z0, z1, y0, y1 } on one lot: footprints carved into
  // plans, extruded storey by storey, tiers stacked on whole storeys
  // ============================================================================
  function building(blk, mat, lot, sh = storeys[mat]) {
    const S = cur ? cur.streets : { n: false, s: false, w: false, e: false };
    return {
      mat,
      sh, // metres per storey (balcony rows, bulkhead thresholds, awning heights)
      lot,
      parts: [],
      real: false,
      // Lot sides facing a street (the lot reaches the edge of the rect being populated and that edge fronts a
      // street); the others are party walls / rear lot lines shared with neighbours
      street: {
        n: S.n && lot.z0 - cur.z0 < EPS,
        s: S.s && cur.z1 - lot.z1 < EPS,
        w: S.w && lot.x0 - cur.x0 < EPS,
        e: S.e && cur.x1 - lot.x1 < EPS
      }
    };
  }

  // Extrude footprint `rects` from storey f0 up to storey f1
  function mass(b, rects, f0, f1) {
    if (f1 <= f0) return;
    massH(b, rects, f0 * b.sh, f1 * b.sh);
  }
  // Extrude footprint `rects` between two heights (metres)
  function massH(b, rects, y0, y1) {
    if (y1 <= y0 + EPS) return;
    for (const r of rects) {
      if (r.x1 - r.x0 < 0.5 || r.z1 - r.z0 < 0.5) continue;
      b.parts.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0, y1 });
    }
  }

  // `r` pulled back `d` from the lot's street sides (and `party` from its party walls): setbacks, attic terraces
  function streetInset(b, r, d, party = 0) {
    const s = b.street;
    return rect(r.x0 + (s.w ? d : party), r.x1 - (s.e ? d : party), r.z0 + (s.n ? d : party), r.z1 - (s.s ? d : party));
  }

  // How far part p's cornice reaches past its `side` wall: `oh` out into open air, flush against parts of the same
  // building rising past it, tucked just inside party walls (a neighbour's own ledge may run at the same height)
  function corniceReach(b, p, side, oh) {
    if (p.faces && p.faces[SIDE_IDX[side]] === WALL_KINDS.lotLine) return -0.03;
    const alongX = side === 'n' || side === 's';
    const c = side === 'n' ? p.z0 : side === 's' ? p.z1 : side === 'w' ? p.x0 : p.x1;
    for (const q of b.parts) {
      if (q === p || q.plinth || q.y1 < p.y1 - EPS || q.y0 > p.y1 - EPS) continue;
      const qc = side === 'n' ? q.z1 : side === 's' ? q.z0 : side === 'w' ? q.x1 : q.x0;
      if (Math.abs(qc - c) > TOUCH) continue;
      if (alongX ? (q.x0 < p.x1 - EPS && q.x1 > p.x0 + EPS) : (q.z0 < p.z1 - EPS && q.z1 > p.z0 + EPS)) return 0;
    }
    return oh;
  }

  // The spans of [a0, a1] left after removing the `cuts` ([c0, c1] pairs)
  function spanMinus(a0, a1, cuts) {
    let spans = [[a0, a1]];
    for (const [c0, c1] of cuts) {
      const next = [];
      for (const [s0, s1] of spans) {
        if (c1 <= s0 + EPS || c0 >= s1 - EPS) {
          next.push([s0, s1]);
          continue;
        }
        if (c0 > s0 + EPS) next.push([s0, c0]);
        if (c1 < s1 - EPS) next.push([c1, s1]);
      }
      spans = next;
    }
    return spans;
  }
  const spanLen = (spans) => spans.reduce((t, [s0, s1]) => t + s1 - s0, 0);

  // What part p's `side` wall looks out on: the spans of it not hidden by parts of the same building built flush
  // against it (touching within TOUCH) and rising to its roof line — a lower volume (the 1-storey rear of a 5-storey
  // body) only hides the base, the wall above it keeps its windows —, and how much of those the building's own
  // wings screen across a court or light well
  function wallView(b, p, side) {
    const alongX = side === 'n' || side === 's';
    const c = side === 'n' ? p.z0 : side === 's' ? p.z1 : side === 'w' ? p.x0 : p.x1;
    const out = side === 'n' || side === 'w' ? -1 : 1; // outward direction along the wall's axis
    const flush = [];
    const across = [];
    for (const q of b.parts) {
      if (q === p || q.plinth || q.y1 < p.y1 - 1.0 || q.y0 > p.y1 - EPS) continue;
      // q's faces along the wall's axis: `near` the one towards p, `far` the one beyond
      const qa = side === 'n' || side === 's' ? [q.z0, q.z1] : [q.x0, q.x1];
      const near = out < 0 ? qa[1] : qa[0];
      const far = out < 0 ? qa[0] : qa[1];
      const gap = (near - c) * out; // > 0: q stands clear of the wall, ≤ 0: q touches / overlaps it
      const reach = (far - c) * out; // how far q extends past the wall
      if (reach < TOUCH) continue; // beside or behind the wall
      (gap <= TOUCH ? flush : across).push(alongX ? [q.x0, q.x1] : [q.z0, q.z1]);
    }
    const visible = spanMinus(alongX ? p.x0 : p.z0, alongX ? p.x1 : p.z1, flush);
    const open = visible.flatMap(([s0, s1]) => spanMinus(s0, s1, across));
    return { visible, screened: spanLen(visible) - spanLen(open) };
  }

  // Facade treatment of each wall of a procedural part p, in `faces` order (w, e, n, s). Street fronts (the lot fronts
  // a street there and the building's own wings don't screen most of the wall) get storefronts (`shops[side]`) or a
  // residential entrance, and so do the side walls of courts open to the street; walls on the lot lines shared with
  // neighbours stay windowless; the rest are rear yard, court & patio walls. A `freestanding` building (slabs on open
  // ground, detached houses, naves) fronts every way; `o.walls` forces one WALL_KINDS everywhere.
  function wallKinds(b, p, shops, o) {
    if (o.walls !== undefined) return [o.walls, o.walls, o.walls, o.walls];
    const front = (side) => (shops[side] ? WALL_KINDS.shop : WALL_KINDS.entry);
    return SIDES.map((side) => {
      if (o.freestanding) return front(side);
      const { visible, screened } = wallView(b, p, side);
      if (b.street[side] && screened < spanLen(visible) * 0.5) return front(side);
      const c = side === 'w' ? p.x0 : side === 'e' ? p.x1 : side === 'n' ? p.z0 : p.z1;
      const edge = side === 'w' ? b.lot.x0 : side === 'e' ? b.lot.x1 : side === 'n' ? b.lot.z0 : b.lot.z1;
      if (!b.street[side] && Math.abs(c - edge) < EPS) return WALL_KINDS.lotLine;
      // A court wall reaching the street line belongs to a court open to the street
      const alongX = side === 'n' || side === 's';
      const [e0, e1, s0, s1] = alongX ? [b.lot.x0, b.lot.x1, b.street.w, b.street.e] : [b.lot.z0, b.lot.z1, b.street.n, b.street.s];
      const onStreet = visible.some(([a, z]) => (s0 && a - e0 < EPS) || (s1 && e1 - z < EPS));
      return screened > EPS && onStreet ? WALL_KINDS.entry : WALL_KINDS.rear;
    });
  }

  // Is (x, z) (world) inside one of the `near` neighbouring buildings' volumes?
  function otherFootprintAt(near, x, z) {
    for (const f of near) {
      const dx = x - f.cx;
      const dz = z - f.cz;
      if (dx * dx + dz * dz > f.r2) continue;
      const u = dx * f.cs - dz * f.sn;
      const v = dx * f.sn + dz * f.cs;
      const bb = f.bb;
      if (u < bb[0] || u > bb[1] || v < bb[2] || v > bb[3]) continue;
      for (const r of f.rects) if (u >= r[0] && u <= r[1] && v >= r[2] && v <= r[3]) return true;
    }
    return false;
  }
  // Is the world point on this block (its curb island)?
  const onBlock = (src, x, z) => x >= src.minX && x <= src.maxX && z >= src.minZ && z <= src.maxZ && (src.rect || pointInPoly(src.poly, x, z));

  // Facade treatment of each wall of a real building's part by what lies beyond it: another building of the block
  // within ~1.5 m → party wall; the sidewalk & the roadway (off this block) within ~9 m → street front (storefront or
  // entrance); anything else (patios, the inside of the block) → rear wall. Only the spans of the wall the building's
  // own volumes leave visible are probed.
  const PROBES = [0.8, 1.5, 2.5, 4, 6.5, 9];
  function realWallKinds(blk, b, p, shops) {
    const src = blk.src;
    const near = b.src.near;
    return SIDES.map((side) => {
      const { visible } = wallView(b, p, side);
      if (!visible.length) return WALL_KINDS.lotLine; // hidden behind the building's own parts
      const alongX = side === 'n' || side === 's';
      const c = side === 'n' ? p.z0 : side === 's' ? p.z1 : side === 'w' ? p.x0 : p.x1;
      const [nx, nz] = NORMAL[side];
      const samples = [];
      for (const [s0, s1] of visible) {
        const L = s1 - s0;
        if (L < 0.4) continue;
        if (L > 4) samples.push(s0 + L * 0.25, s0 + L * 0.5, s0 + L * 0.75);
        else samples.push(s0 + L * 0.5);
      }
      if (!samples.length) return WALL_KINDS.lotLine;
      let party = 0;
      let street = 0;
      // the frame → world turn, inlined (toWorld) for the many probes
      const cs = xf ? xf.cs : 1;
      const sn = xf ? xf.sn : 0;
      const px = xf ? xf.px : 0;
      const pz = xf ? xf.pz : 0;
      for (const a of samples) {
        const ax = alongX ? a : c;
        const az = alongX ? c : a;
        for (const d of PROBES) {
          const lx = ax + nx * d - px;
          const lz = az + nz * d - pz;
          const wx = px + lx * cs + lz * sn;
          const wz = pz - lx * sn + lz * cs;
          if (otherFootprintAt(near, wx, wz)) {
            if (d <= 1.5) party++;
            break;
          }
          if (d >= 2.5 && !onBlock(src, wx, wz)) { street++; break; }
        }
      }
      const n = samples.length;
      if (party * 2 >= n) return WALL_KINDS.lotLine;
      if (street * 2 >= n) return shops[side] ? WALL_KINDS.shop : WALL_KINDS.entry;
      return WALL_KINDS.rear;
    });
  }

  // A pitched roof over part p: 'gable' / 'hip' (terracotta tiles) or 'saw' (one slope, fibre-cement) with its ridge
  // along `ridge` ('x', 'z' or 'auto': the longer side), overhanging the walls by `eave`
  function pitchedRoof(p, kind, ridge = 'auto', eave = 0.3) {
    const w = p.x1 - p.x0 + eave * 2;
    const d = p.z1 - p.z0 + eave * 2;
    const alongX = ridge === 'x' || (ridge === 'auto' && w >= d);
    const short = alongX ? d : w;
    const h = Math.min(kind === 'saw' ? 2.6 : 3.6, Math.max(1.0, short * (kind === 'saw' ? 0.22 : 0.28)));
    const item = place({ x: (p.x0 + p.x1) * 0.5, y: p.y1 - 0.02, z: (p.z0 + p.z1) * 0.5, w: alongX ? w : d, h, d: alongX ? d : w });
    if (!alongX) item.ry = (item.ry || 0) + Math.PI * 0.5;
    roofItems[kind].push(item);
  }
  // Sawtooth roof over a nave: bays of one slope across the shorter side
  function sawtoothRoof(p) {
    const w = p.x1 - p.x0;
    const d = p.z1 - p.z0;
    const alongX = w >= d; // the bays run along the long side
    const across = alongX ? d : w;
    const n = Math.max(1, Math.round(across / 6.5));
    const tw = across / n;
    const h = Math.min(2.4, tw * 0.34);
    for (let k = 0; k < n; k++) {
      const c = (alongX ? p.z0 : p.x0) + (k + 0.5) * tw;
      const item = place({ x: alongX ? (p.x0 + p.x1) * 0.5 : c, y: p.y1 - 0.02, z: alongX ? c : (p.z0 + p.z1) * 0.5, w: alongX ? w : d, h, d: tw });
      if (!alongX) item.ry = (item.ry || 0) + Math.PI * 0.5;
      roofItems.saw.push(item);
    }
  }

  function addYard(blk, r) {
    if (rectW(r) < 1 || rectD(r) < 1) return;
    const [cx, cz] = toWorld((r.x0 + r.x1) * 0.5, (r.z0 + r.z1) * 0.5);
    const hw = rectW(r) * 0.5;
    const hd = rectD(r) * 0.5;
    blk.yards.push({ x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd, ry: xf ? xf.th : 0 });
  }

  /**
   * Emits building `b`: facade boxes, map footprints, colliders matching each part, cornices under the masonry roof
   * lines, the roof (a terrat with its stair bulkhead, a mechanical roof, a sawtooth or a pitched tile roof), balcony
   * slabs on the street fronts and the record of its ground-floor street walls (where the real shops hang their
   * awnings & signs). Parts flagged `plinth` (open courts & terraces of the Catastro) are blank 0.6 m kerbs.
   * o: { cornice, corniceH, roof: 'terrat' | 'mech' | 'saw' | 'none', bulkheadP, hvacP, hvacH, pitched: null |
   *      'gable' | 'hip' | 'saw', ridge, eave, shops: 'all' | 'none' | probability of 'all' (street fronts with
   *      storefronts on the ground floor, the others get a residential entrance), balconies: probability, longOnly
   *      (balconies on the long sides only), freestanding, walls (see wallKinds) }
   */
  function commit(blk, b, o = {}) {
    const parts = b.parts;
    if (!parts.length) return false;
    if (!b.real && parts.some((p) => hitsReserve(p.x0, p.x1, p.z0, p.z1))) return false;
    const mat = b.mat;
    const storey = b.sh;
    const tone = rand();
    let shopsOn = o.shops ?? 'all';
    if (typeof shopsOn === 'number') shopsOn = tone < shopsOn ? 'all' : 'none';
    const shops = { w: shopsOn === 'all', e: shopsOn === 'all', n: shopsOn === 'all', s: shopsOn === 'all' };
    let top = null;
    for (const p of parts) {
      const w = p.x1 - p.x0;
      const d = p.z1 - p.z0;
      const h = p.y1 - p.y0;
      if (p.plinth) p.faces = [WALL_KINDS.blankStone, WALL_KINDS.blankStone, WALL_KINDS.blankStone, WALL_KINDS.blankStone];
      else p.faces = o.walls !== undefined ? [o.walls, o.walls, o.walls, o.walls] : b.real ? realWallKinds(blk, b, p, shops) : wallKinds(b, p, shops, o);
      const box = place({ x: p.x0 + w * 0.5, y: p.y0 + h * 0.5, z: p.z0 + d * 0.5, w, h, d, faces: p.faces, tone });
      buckets[mat].push(box);
      pushCollider(p.x0, p.x1, p.z0, p.z1, p.y0, p.y1);
      if (p.plinth) continue;
      const fp = { x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, h: p.y1, tone };
      if (xf) {
        fp.pts = corners(p.x0, p.x1, p.z0, p.z1);
        fp.x0 = Math.min(...fp.pts.map((q) => q.x));
        fp.x1 = Math.max(...fp.pts.map((q) => q.x));
        fp.z0 = Math.min(...fp.pts.map((q) => q.z));
        fp.z1 = Math.max(...fp.pts.map((q) => q.z));
      }
      blk.footprints.push(fp);
      if (p.y1 > blk.maxH) blk.maxH = p.y1;
      if (!top || p.y1 > top.y1 + EPS || (p.y1 > top.y1 - EPS && w * d > rectW(top) * rectD(top))) top = p;
      // Ground-floor street walls, as world segments: the real shops (SHOPS) are hung on the nearest of them
      if (p.y0 <= EPS && blk.fronts) {
        for (const side of SIDES) {
          if (p.faces[SIDE_IDX[side]] > WALL_KINDS.entry) continue;
          const alongX = side === 'n' || side === 's';
          const L = alongX ? w : d;
          if (L < 2.5) continue;
          const c = side === 'n' ? p.z0 : side === 's' ? p.z1 : side === 'w' ? p.x0 : p.x1;
          const [ax, az] = toWorld(alongX ? p.x0 : c, alongX ? c : p.z0);
          const [bx, bz] = toWorld(alongX ? p.x1 : c, alongX ? c : p.z1);
          const [nx, nz] = NORMAL[side];
          const cs = xf ? xf.cs : 1;
          const sn = xf ? xf.sn : 0;
          blk.fronts.push({ ax, az, bx, bz, L, ox: nx * cs + nz * sn, oz: -nx * sn + nz * cs, alongX, ry: xf ? xf.th : 0, storey: Math.min(p.y1, b.ground ?? storey), box, side: SIDE_IDX[side] });
        }
      }
    }
    if (!top) return true; // plinths only

    // 1. Cornices under the masonry roof lines (and the ledges of set-back attics)
    if (o.cornice ?? mat <= MAT.BRICK) {
      const ch = o.corniceH ?? 0.5;
      for (const p of parts) {
        if (p.plinth) continue;
        const x0 = p.x0 - corniceReach(b, p, 'w', 0.35);
        const x1 = p.x1 + corniceReach(b, p, 'e', 0.35);
        const z0 = p.z0 - corniceReach(b, p, 'n', 0.35);
        const z1 = p.z1 + corniceReach(b, p, 's', 0.35);
        blk.cornices.push(place({ x: (x0 + x1) * 0.5, y: p.y1, z: (z0 + z1) * 0.5, w: x1 - x0, h: ch, d: z1 - z0 }));
      }
    }

    // 2. The roof
    const roof = o.roof ?? 'terrat';
    if (o.pitched) {
      // Tile roofs over the parts at the roof line (a lower rear extension keeps its terrat)
      const pitchedKind = o.pitched;
      for (const p of parts) {
        if (p.plinth || p.y1 < top.y1 - EPS) continue;
        if (Math.min(p.x1 - p.x0, p.z1 - p.z0) > (o.maxRoofSpan ?? 16)) continue;
        pitchedRoof(p, pitchedKind, o.ridge ?? 'auto', o.eave ?? 0.3);
      }
    } else if (roof === 'saw') {
      for (const p of parts) if (!p.plinth && p.y1 >= top.y1 - EPS && Math.min(p.x1 - p.x0, p.z1 - p.z0) >= 5) sawtoothRoof(p);
    } else if (roof !== 'none') {
      const tw = rectW(top);
      const td = rectD(top);
      if (roof === 'mech') {
        // Mechanical roof: a big plant room / HVAC box, as on the original's post-war buildings
        const hw = Math.min(tw - 1.2, Math.max(2.4, tw * range(0.3, 0.55)));
        const hd = Math.min(td - 1.2, Math.max(2.4, td * range(0.3, 0.55)));
        if (hw >= 1.8 && hd >= 1.8) {
          const jx = (tw - hw) * 0.5 - 0.6;
          const jz = (td - hd) * 0.5 - 0.6;
          blk.hvacUnits.push(place({
            x: (top.x0 + top.x1) * 0.5 + range(-jx, jx), y: top.y1, z: (top.z0 + top.z1) * 0.5 + range(-jz, jz),
            w: hw, h: o.hvacH ?? range(2.4, 3.4), d: hd
          }));
        }
      } else if (tw >= 3.4 && td >= 3.4 && top.y1 >= storey * 1.9 && chance(o.bulkheadP ?? 0.85)) {
        // Terrat: the stair bulkhead (caixa d'escala) against the back of the roof, away from the street front
        const bw = Math.min(3.2, tw - 1.2);
        const bd = Math.min(2.6, td - 1.2);
        const frontN = top.faces[SIDE_IDX.n] <= WALL_KINDS.entry;
        const frontS = top.faces[SIDE_IDX.s] <= WALL_KINDS.entry;
        const atN = frontS && !frontN ? true : frontN && !frontS ? false : chance(0.5);
        blk.bulkheads.push(place({
          x: top.x0 + 0.6 + bw * 0.5 + range(0, Math.max(0, tw - 1.2 - bw)),
          y: top.y1,
          z: atN ? top.z0 + 0.6 + bd * 0.5 : top.z1 - 0.6 - bd * 0.5,
          w: bw, h: range(2.4, 2.8), d: bd
        }));
        // the odd air-conditioning unit or solar heater on the bigger terrats
        if (o.hvacP && tw >= 6 && td >= 6 && chance(o.hvacP)) {
          blk.hvacUnits.push(place({
            x: top.x0 + range(1.2, tw - 1.2 - 1.6) + 0.8, y: top.y1,
            z: atN ? top.z1 - range(1.0, td * 0.4) - 0.8 : top.z0 + range(1.0, td * 0.4) + 0.8,
            w: range(1.2, 1.8), h: range(0.9, 1.3), d: range(1.0, 1.4)
          }));
        }
      }
    }

    // 3. Balcony slabs along the street fronts, one per upper floor (the "balconades" of the Catalan fronts)
    if (o.balconies && chance(o.balconies)) {
      const depth = o.balconyDepth ?? 0.9;
      for (const p of parts) {
        if (p.plinth || p.y0 > EPS) continue;
        const nf = Math.round((p.y1 - p.y0) / storey);
        if (nf < 2) continue;
        const longest = Math.max(p.x1 - p.x0, p.z1 - p.z0);
        for (const side of SIDES) {
          if (p.faces[SIDE_IDX[side]] > WALL_KINDS.entry) continue;
          const alongX = side === 'n' || side === 's';
          const len = alongX ? p.x1 - p.x0 : p.z1 - p.z0;
          if (len < 3 || (o.longOnly && len < longest - EPS)) continue;
          const [nx, nz] = NORMAL[side];
          const c = side === 'n' ? p.z0 : side === 's' ? p.z1 : side === 'w' ? p.x0 : p.x1;
          const ins = Math.min(0.5, len * 0.1);
          const ground = b.ground ?? storey;
          for (let k = 1; k < Math.min(nf, 9); k++) {
            blk.balconies.push(place({
              x: alongX ? (p.x0 + p.x1) * 0.5 : c + nx * depth * 0.45,
              y: ground + (k - 1) * storey + 0.08,
              z: alongX ? c + nz * depth * 0.45 : (p.z0 + p.z1) * 0.5,
              w: alongX ? len - ins * 2 : depth,
              d: alongX ? depth : len - ins * 2
            }));
          }
        }
      }
    }
    return true;
  }

  // ============================================================================
  // PROCEDURAL TYPOLOGIES (path B: blocks with no building at all)
  // ============================================================================

  // Row house on a street lot: an old-town house or an Eixample "casa de cos" (5-7 m wide, 12-20 m deep, 2-3 storeys,
  // terrat with its stair bulkhead), the body on the street with a one-storey extension into the rear patio
  function rowHouse(blk, lot, side, k) {
    const b = building(blk, k.mat, lot);
    const L = sideLen(lot, side);
    const D = sideDepth(lot, side);
    const dep = Math.max(Math.min(D, 6), Math.min(D, k.depth * range(0.72, 1)));
    mass(b, [sideRect(lot, side, 0, L, 0, dep)], 0, k.floors);
    const ext = Math.min(range(2.5, 5), D - dep - 0.5);
    if (ext > 1.8 && chance(0.5)) {
      const ew = L * range(0.45, 1);
      const ea = chance(0.5) ? 0 : L - ew;
      mass(b, [sideRect(lot, side, ea, ea + ew, dep, dep + ext)], 0, 1);
    }
    const cfg = k.cfg;
    commit(blk, b, {
      cornice: k.mat <= MAT.BRICK, corniceH: 0.45, roof: 'terrat', bulkheadP: k.floors >= 2 ? 0.8 : 0.2,
      pitched: k.floors <= 3 && chance(1 - cfg.flatRoof) ? 'gable' : null, ridge: side === 'n' || side === 's' ? 'x' : 'z', eave: 0.25,
      shops: k.major ? Math.min(1, cfg.shops * 1.2) : cfg.shops * 0.6, balconies: 0.6
    });
  }

  // Apartment block on a corner or along an avenue: 4-6 storeys (more on the tall ones) filling its lot around a rear
  // court or a light well on a party wall, often an "àtic" set back behind a terrace, shops below
  function apartmentHouse(blk, lot, side, k) {
    const b = building(blk, k.mat, lot);
    const L = sideLen(lot, side);
    const D = sideDepth(lot, side);
    const f = k.floors + (chance(k.cfg.tall) ? irange(1, 2) : 0);
    const holes = [];
    if (L >= 14 && D >= 12 && chance(0.5)) {
      holes.push(courtHole(lot, OPPOSITE[side], L * range(0.25, 0.35), D * range(0.3, 0.45)));
    } else if (L >= 12 && D >= 10 && chance(0.3)) {
      const sw = range(1.5, 2.5);
      const sd = range(3, 5);
      const sb = D * range(0.3, 0.5);
      holes.push(sideRect(lot, side, -1, sw, sb, sb + sd));
    }
    const axis = side === 'n' || side === 's' ? 'z' : 'x';
    mass(b, carve(lot, holes, axis), 0, f);
    if (D >= 10 && chance(0.4)) {
      const attic = streetInset(b, lot, range(2.4, 3.2));
      if (rectW(attic) >= 5 && rectD(attic) >= 5) mass(b, carve(attic, holes, axis), f, f + 1);
    }
    commit(blk, b, { cornice: k.mat <= MAT.BRICK, corniceH: 0.6, roof: 'terrat', bulkheadP: 0.9, hvacP: 0.25, shops: k.cfg.shops, balconies: 0.8 });
  }

  // One-storey garages, workshops & small shops
  function lowRow(blk, lot, side, k) {
    const b = building(blk, k.mat, lot);
    massH(b, [sideRect(lot, side, 0, sideLen(lot, side), 0, Math.min(sideDepth(lot, side), k.depth))], 0, 3.4);
    commit(blk, b, { cornice: false, roof: 'none', shops: 0.3 });
  }

  // Detached house ("torre") in the middle of its garden plot: 1-2 storeys, hipped tile roof or a flat terrat
  function villa(blk, lot, side, k) {
    const L = sideLen(lot, side);
    const D = sideDepth(lot, side);
    const hw = Math.min(L - 4, range(7, 11));
    const hd = Math.min(D - 5, range(8, 12));
    addYard(blk, lot);
    if (hw < 5 || hd < 5) return;
    const front = Math.min(range(3, 5), D - hd - 1);
    const off = range(1.5, L - hw - 1.5);
    const b = building(blk, k.mat, lot);
    mass(b, [sideRect(lot, side, off, off + hw, front, front + hd)], 0, k.floors);
    commit(blk, b, {
      cornice: false, roof: 'terrat', bulkheadP: k.floors >= 2 ? 0.35 : 0,
      pitched: chance(1 - k.cfg.flatRoof) ? 'hip' : null, ridge: 'auto', eave: 0.5,
      shops: 'none', freestanding: true, balconies: 0
    });
  }

  // Industrial shed (nave) on its lot: 6-9 m tall (the old brick vapors a little more), sawtooth, mechanical or plain
  // flat roof; freestanding, so its walls carry the industrial strip windows and a door
  function nave(blk, r, prof, old = false) {
    const mat = old ? MAT.BRICK : pickW([[MAT.NAVE, 6], [MAT.BLOCS, 1.5], [MAT.BRICK, 1]]);
    const b = building(blk, mat, r, mat === MAT.BLOCS ? STOREY.residential : STOREY.vapor);
    const small = Math.min(rectW(r), rectD(r)) < 24;
    let H;
    if (mat === MAT.BLOCS) H = irange(2, 3) * STOREY.residential;
    else if (old) H = range(7, 10);
    else H = small && chance(0.25) ? STOREY.vapor * 2 : range(6, 9);
    massH(b, [r], 0, H);
    const roof = pickW([['saw', old ? 5 : 4], ['mech', 3], ['none', 3]]);
    return commit(blk, b, { cornice: false, roof, hvacH: range(1.6, 2.8), shops: 'none', freestanding: true, balconies: 0 });
  }

  // Brick chimney of an old vapor
  function chimney(blk, x, z) {
    const r = rect(x - 1.2, x + 1.2, z - 1.2, z + 1.2);
    const b = building(blk, MAT.BRICK, r);
    massH(b, [r], 0, range(22, 32));
    commit(blk, b, { cornice: false, roof: 'none', walls: WALL_KINDS.blankStone, balconies: 0 });
  }

  // Slab block of the 1960s-70s estates: 12-16 m deep, 30-80 m long, 5-11 storeys, on open ground
  function slab(blk, r, prof) {
    const mat = pickW([[MAT.BLOCS, 6], [MAT.MODERN, 2.5], [MAT.PLAIN, 1]]);
    const b = building(blk, mat, r);
    const f = irange(prof.floors[0], prof.floors[1]);
    mass(b, [r], 0, f);
    const major = cur.major.n || cur.major.s || cur.major.w || cur.major.e;
    commit(blk, b, { cornice: false, roof: 'mech', hvacH: range(2.4, 3.2), shops: major ? 0.5 : 'none', freestanding: true, balconies: 0.6, longOnly: true });
  }

  // H / T / cruciform tower of the same estates
  function tower(blk, r, prof) {
    const mat = pickW([[MAT.BLOCS, 5], [MAT.MODERN, 2], [MAT.PLAIN, 1]]);
    const b = building(blk, mat, r);
    const tw = rectW(r);
    const td = rectD(r);
    const shape = pickW([['plus', 3], ['H', 2], ['T', 1.5]]);
    let holes;
    if (shape === 'plus') holes = cornerHoles(r, tw * range(0.27, 0.31), td * range(0.26, 0.3));
    else if (shape === 'H') {
      const cd = td * range(0.28, 0.36);
      holes = [courtHole(r, 'n', tw * range(0.3, 0.4), cd), courtHole(r, 's', tw * range(0.3, 0.4), cd)];
    } else holes = cornerHoles(r, tw * 0.32, td * range(0.4, 0.5), pick([['sw', 'se'], ['nw', 'ne']]));
    mass(b, carve(r, holes, 'x'), 0, irange(prof.floors[1] - 2, prof.floors[1] + 3));
    commit(blk, b, { cornice: false, roof: 'mech', hvacH: 2.8, shops: 'none', freestanding: true, balconies: 0 });
  }

  // Campus pavilion: 2-4 storeys on a lawn
  function pavilion(blk, r, prof) {
    const mat = pickW([[MAT.MODERN, 3], [MAT.GLASS, 2], [MAT.BLOCS, 2]]);
    const b = building(blk, mat, r);
    mass(b, [r], 0, irange(prof.floors[0], prof.floors[1]));
    commit(blk, b, { cornice: false, roof: 'mech', hvacH: 2.4, shops: 'none', freestanding: true, balconies: 0 });
  }

  // Lot kinds of the street rows: lot width (m), run (identical neighbours built together), storeys, facade weights
  const ROW_KINDS = {
    casa: { w: [5, 9], run: [2, 5], floors: null, mats: null, build: rowHouse },
    cos: { w: [5, 7.5], run: [3, 8], floors: [2, 3], mats: null, build: rowHouse },
    apt: { w: [10, 18], run: [1, 2], floors: [4, 6], mats: [[MAT.OCHRE, 2], [MAT.PINK, 2], [MAT.MODERN, 3], [MAT.BLOCS, 2]], build: apartmentHouse },
    low: { w: [6, 12], run: [1, 1], floors: [1, 1], mats: [[MAT.OCHRE, 1], [MAT.NAVE, 1], [MAT.PLAIN, 1]], build: lowRow },
    villa: { w: [12, 20], run: [1, 3], floors: [1, 2], mats: null, build: villa }
  };

  // Fill the frontage [a0, a1] along `side` of rect R with a row of lots `dep` deep. `perp` = the two streets the row
  // can start / end at (corner lots there take an apartment block where the typology has them)
  function fillRow(blk, R, side, a0, a1, dep, cfg) {
    const perp = side === 'n' || side === 's' ? ['w', 'e'] : ['n', 's'];
    const extent = side === 'n' || side === 's' ? rectW(R) : rectD(R);
    const major = cur.major[side];
    const rows = major && cfg.majorRows ? cfg.majorRows : cfg.rows;
    let a = a0;
    while (a1 - a > 0.5) {
      const atStart = a < EPS && cur.streets[perp[0]];
      const endsAtCorner = cfg.corner && cur.streets[perp[1]] && Math.abs(a1 - extent) < EPS;
      let kindName = atStart && cfg.corner ? pickW(cfg.corner) : pickW(rows);
      // the last lot of the row reaches the other corner
      const cornerW = ROW_KINDS.apt.w;
      if (endsAtCorner && a1 - a < cornerW[1] * 1.4 && a1 - a >= 7) kindName = pickW(cfg.corner);
      const kind = ROW_KINDS[kindName];
      const fl = kind.floors || cfg.floors;
      const run = irange(kind.run[0], kind.run[1]);
      const lotW = range(kind.w[0], kind.w[1]);
      const mat = pickW(kind.mats || cfg.mats);
      const floorsRun = irange(fl[0], fl[1]);
      for (let i = 0; i < run && a1 - a > 0.5; i++) {
        let w = lotW * range(0.96, 1.04);
        if (a1 - a - w < kind.w[0] * 0.6) w = a1 - a;
        const lot = sideRect(R, side, a, a + w, 0, dep);
        const corner = (a < EPS && cur.streets[perp[0]]) || (Math.abs(a + w - extent) < EPS && cur.streets[perp[1]]);
        kind.build(blk, lot, side, {
          mat,
          floors: Math.max(1, floorsRun + (chance(0.2) ? pick([-1, 1]) : 0)),
          depth: dep,
          corner,
          major,
          cfg
        });
        a += w;
      }
    }
  }

  // A lot with no street at all (the inside of a block): a patio, sometimes with a low workshop in it
  function interiorLot(blk, R, cfg) {
    addYard(blk, R);
    if (rectW(R) >= 12 && rectD(R) >= 12 && chance(0.35)) {
      const r = insetAll(R, range(2, 4));
      const b = building(blk, pickW([[MAT.OCHRE, 1], [MAT.NAVE, 1]]), r);
      massH(b, [r], 0, range(3.4, 4.5));
      commit(blk, b, { cornice: false, roof: 'none', shops: 'none', freestanding: true, balconies: 0 });
    }
  }

  // Rows of lots along every street side of rect R around a courtyard (the Eixample's pati d'illa, the old town's
  // patios, the suburban gardens): rows along the longer street sides take the corners, the others fill between them
  function ringFill(blk, R, cfg) {
    const S = cur.streets;
    const W = rectW(R);
    const D = rectD(R);
    if (!(S.n || S.s || S.w || S.e)) { interiorLot(blk, R, cfg); return; }
    const horiz = (S.n || S.s) && (W >= D || !(S.w || S.e));
    const [A0, A1, B0, B1] = horiz ? ['n', 's', 'w', 'e'] : ['w', 'e', 'n', 's'];
    const extA = horiz ? W : D;
    const extB = horiz ? D : W;
    const pickDepth = () => range(cfg.depth[0], cfg.depth[1]);
    let d0 = S[A0] ? pickDepth() : 0;
    let d1 = S[A1] ? pickDepth() : 0;
    if (d0 && d1) {
      if (extB < 14) { d0 = extB; d1 = 0; } // too shallow for two rows: through lots
      else if (d0 + d1 > extB) { const k = extB / (d0 + d1); d0 *= k; d1 *= k; }
    } else {
      d0 = Math.min(d0, extB);
      d1 = Math.min(d1, extB);
      if (d0 && extB - d0 < 4) d0 = extB;
      if (d1 && extB - d1 < 4) d1 = extB;
    }
    if (d0 >= 4) fillRow(blk, R, A0, 0, extA, d0, cfg);
    if (d1 >= 4) fillRow(blk, R, A1, 0, extA, d1, cfg);
    let e0 = 0;
    let e1 = 0;
    if (extB - d0 - d1 >= cfg.rowWidth[0]) {
      e0 = S[B0] ? Math.min(pickDepth(), extA * 0.5) : 0;
      e1 = S[B1] ? Math.min(pickDepth(), extA * 0.5) : 0;
      if (e0 >= 4) fillRow(blk, R, B0, d0, extB - d1, e0, cfg);
      if (e1 >= 4) fillRow(blk, R, B1, d0, extB - d1, e1, cfg);
    }
    const yard = horiz ? rect(R.x0 + e0, R.x1 - e1, R.z0 + d0, R.z1 - d1) : rect(R.x0 + d0, R.x1 - d1, R.z0 + e0, R.z1 - e1);
    if (rectW(yard) >= 3 && rectD(yard) >= 3) addYard(blk, yard);
  }

  // Slab blocks & towers set back from the streets on open ground (blocs), or campus pavilions on a lawn
  function openGroundLayout(blk, R, prof, campus) {
    const W = rectW(R);
    const D = rectD(R);
    addYard(blk, insetAll(R, 0.5));
    if (W < 12 || D < 12) return;
    const horiz = W >= D;
    const long = horiz ? W : D;
    const across = horiz ? D : W;
    let depth = campus ? range(14, 20) : range(12, 16);
    let sb = campus ? range(5, 9) : range(4, 8);
    if (across - 2 * sb < depth) { depth = Math.min(depth, across - 4); sb = (across - depth) * 0.5; }
    const spacing = campus ? 22 : 16;
    const rows = Math.max(1, Math.min(3, Math.floor((across - 2 * sb + spacing) / (depth + spacing))));
    const pitch = rows > 1 ? (across - 2 * sb - depth) / (rows - 1) : 0;
    for (let r = 0; r < rows; r++) {
      const c = rows === 1 ? across * 0.5 : sb + depth * 0.5 + r * pitch;
      let a = sb;
      while (long - sb - a > 12) {
        let len = campus ? range(25, 60) : range(30, 80);
        if (long - sb - a - len < 20) len = long - sb - a;
        len = Math.min(len, 90);
        const rct = horiz
          ? rect(R.x0 + a, R.x0 + a + len, R.z0 + c - depth * 0.5, R.z0 + c + depth * 0.5)
          : rect(R.x0 + c - depth * 0.5, R.x0 + c + depth * 0.5, R.z0 + a, R.z0 + a + len);
        if (campus) pavilion(blk, rct, prof);
        else if (len >= 18 && len <= 30 && depth >= 12 && chance(0.4)) {
          const t = Math.min(len, depth + 8);
          tower(blk, horiz ? rect(rct.x0, rct.x0 + t, rct.z0 - 4, rct.z1 + 4) : rect(rct.x0 - 4, rct.x1 + 4, rct.z0, rct.z0 + t), prof);
        } else slab(blk, rct, prof);
        a += len + (campus ? range(14, 26) : range(8, 14));
      }
    }
  }

  // Industrial estate: naves tiled over the lot behind a loading strip along the streets, the odd old vapor with its
  // brick chimney
  function navesLayout(blk, R, prof) {
    const S = cur.streets;
    const set = 3;
    const inner = rect(R.x0 + (S.w ? set : 0.5), R.x1 - (S.e ? set : 0.5), R.z0 + (S.n ? set : 0.5), R.z1 - (S.s ? set : 0.5));
    const IW = rectW(inner);
    const ID = rectD(inner);
    if (IW < 10 || ID < 10) return;
    const nz = ID > 70 ? Math.max(2, Math.round(ID / 50)) : 1;
    const gapZ = 6;
    const cellD = (ID - gapZ * (nz - 1)) / nz;
    const vapor = chance(0.12);
    let first = true;
    for (let j = 0; j < nz; j++) {
      const z0 = inner.z0 + j * (cellD + gapZ);
      const z1 = z0 + cellD;
      let x = inner.x0;
      while (inner.x1 - x > 8) {
        let w = range(18, 50);
        if (inner.x1 - x - w < 14) w = inner.x1 - x;
        const d = Math.min(cellD, range(25, 60));
        const front = S.n || !S.s ? z0 : z1 - d;
        const r = rect(x + 0.6, x + w - 0.6, front, front + d);
        const old = vapor && first;
        if (nave(blk, r, prof, old) && old && d + 6 < cellD) chimney(blk, r.x0 + 3, r.z1 + 3.5);
        first = false;
        x += w;
      }
    }
  }

  // The procedural configurations per barri typology (city-config.js DISTRICT_PROFILES)
  function rowConfig(prof) {
    const base = { rowWidth: prof.rowWidth, floors: prof.floors, tall: prof.tall, shops: prof.shops, flatRoof: prof.flatRoof, mats: resMats(prof) };
    switch (prof.kind) {
      case 'oldtown':
        return { ...base, depth: [10, 16], rows: [['casa', 6], ['apt', 1], ['low', 0.3]], majorRows: [['casa', 4], ['apt', 3]], corner: [['apt', 3], ['casa', 2]] };
      case 'suburban':
        return { ...base, depth: [20, 30], rows: [['villa', 1]], corner: null };
      case 'mixed':
        return { ...base, depth: [14, 24], rows: [['cos', 3], ['apt', 2], ['low', 1]], majorRows: [['apt', 3], ['cos', 2]], corner: [['apt', 3], ['cos', 1]] };
      default: // eixample
        return { ...base, depth: [12, 20], rows: [['cos', 6], ['apt', 1.2], ['low', 0.4]], majorRows: [['apt', 4], ['cos', 3]], corner: [['apt', 3], ['cos', 1]] };
    }
  }
  function layoutRect(blk, R, prof) {
    switch (prof.kind) {
      case 'blocs': openGroundLayout(blk, R, prof, false); break;
      case 'campus': openGroundLayout(blk, R, prof, true); break;
      case 'industrial': navesLayout(blk, R, prof); break;
      case 'mixed': if (chance(0.45)) navesLayout(blk, R, prof); else ringFill(blk, R, rowConfig(prof)); break;
      default: ringFill(blk, R, rowConfig(prof));
    }
  }

  // The streets a lot rectangle (frame coords) fronts: probes a few metres beyond each side land off this block (on
  // the roadway, or across a passage on another block) rather than further inside it; and whether that street is a
  // major one (avenues, ramblas, main roads: more apartment blocks & shops)
  function lotContext(blk, x0, x1, z0, z1) {
    const streets = {};
    const major = {};
    for (const side of SIDES) {
      const [nx, nz] = NORMAL[side];
      let st = false;
      for (const f of [0.2, 0.5, 0.8]) {
        for (const d of [3.5, 7.5, 11]) {
          const px = side === 'n' || side === 's' ? x0 + f * (x1 - x0) : (side === 'w' ? x0 : x1) + nx * d;
          const pz = side === 'w' || side === 'e' ? z0 + f * (z1 - z0) : (side === 'n' ? z0 : z1) + nz * d;
          const [wx, wz] = toWorld(px, pz);
          if (blockAt(wx, wz) !== blk.src) { st = true; break; }
        }
        if (st) break;
      }
      streets[side] = st;
      if (st) {
        const mx = side === 'n' || side === 's' ? (x0 + x1) * 0.5 : (side === 'w' ? x0 : x1) + nx * 6;
        const mz = side === 'w' || side === 'e' ? (z0 + z1) * 0.5 : (side === 'n' ? z0 : z1) + nz * 6;
        const [wx, wz] = toWorld(mx, mz);
        major[side] = nearestRoads(wx, wz, 16).some((r) => r.road.major && !r.road.highway);
      } else major[side] = false;
    }
    return { x0, x1, z0, z1, streets, major };
  }

  // Superblocks are cut into strips about a street block deep with a ~9 m passage between them, so no lot (and no
  // building) runs 100+ m deep
  const DEEP_LOT = 95;
  function splitDeep(r, axis) {
    const [x0, x1, z0, z1] = r;
    const d = axis === 'z' ? z1 - z0 : x1 - x0;
    if (d <= DEEP_LOT) return [r];
    const gap = 9;
    const n = Math.max(2, Math.round((d + gap) / (64 + gap)));
    const s = (d - gap * (n - 1)) / n;
    const out = [];
    for (let k = 0; k < n; k++) {
      const a = (axis === 'z' ? z0 : x0) + k * (s + gap);
      out.push(axis === 'z' ? [x0, x1, a, a + s] : [a, a + s, z0, z1]);
    }
    return out;
  }

  // ============================================================================
  // REAL BUILDINGS (path A): one cadastral building (or OSM footprint) → its volumes in its own frame
  //   bd: [θ, cx, cz, storeys (max of the parts), height (OSM, 0 unknown), kind (BUILDING_KIND), roof (-1 unknown,
  //        else OSM roof code), rects [u0, u1, v0, v1, storeys], area, year (0 unknown), use (USE), dwellings, ref]
  // ============================================================================
  const isMajorAt = (x, z) => nearestRoads(x, z, 26).some((r) => r.road.major && !r.road.highway);
  function buildFootprint(blk, f, prof) {
    const [th, cx, cz, storeysMax, height, kind, roofCode, rects, area, year, use, dwellings, ref] = f.bd;
    if (inLandmark(cx, cz)) return;
    rand = mulberry32(seedOf(cx, cz, 7919));
    xf = Math.abs(th) > 1e-4 ? { th, cs: Math.cos(th), sn: Math.sin(th), px: cx, pz: cz } : null;
    cur = null;
    const K = BUILDING_KIND;
    const catastro = ref !== '';
    const era = eraOf(year) || pickW(ERA_OF_BARRI[prof.kind] || ERA_OF_BARRI.eixample);
    const old = era <= ERA.MODERNISME;
    const [lo, hi] = prof.floors;
    let k = kind;
    // OSM fallback footprints: untagged buildings on industrial land are naves, big untagged ones commercial halls
    if (!catastro) {
      const industrialArea = prof.kind === 'industrial' || (prof.kind === 'mixed' && area > 900);
      if (k === K.GENERIC && industrialArea && storeysMax <= 2) k = K.INDUSTRIAL;
      if (k === K.GENERIC && area > 2500) k = K.COMMERCIAL;
    }
    // The roof OSM gives it (flat / gabled / hipped / skillion), else the era & typology decide
    const osmRoof = roofCode === 1 ? 'gable' : roofCode === 2 ? 'hip' : roofCode === 3 ? 'saw' : null;
    const roofKnown = roofCode >= 0;
    const tiled = (p, shape) => (roofKnown ? osmRoof : chance(p) ? shape : null);

    let mat;
    let sh; // metres per storey
    let ground = 0; // ground floor height when it differs (shops)
    let fallback = 0; // storeys of the parts whose count is unknown (OSM footprints without levels)
    let o;
    switch (k) {
      case K.INDUSTRIAL: {
        const multi = storeysMax >= 2;
        if (multi) {
          // the vapors & multi-storey factories: brick, 4.2 m floors; newer ones in panels
          mat = era <= ERA.BLOCS ? MAT.BRICK : pickW([[MAT.NAVE, 3], [MAT.BLOCS, 1]]);
          sh = STOREY.vapor;
        } else {
          mat = era <= ERA.POSTWAR ? pickW([[MAT.BRICK, 3], [MAT.NAVE, 1]]) : pickW([[MAT.NAVE, 6], [MAT.BLOCS, 1]]);
          sh = STOREY.nave;
        }
        if (!storeysMax) fallback = chance(0.8) ? 1 : 2;
        const roof = era <= ERA.POSTWAR ? 'saw' : pickW([['none', 4], ['mech', 3], ['saw', 1]]);
        o = { cornice: false, roof, hvacH: range(1.6, 2.8), pitched: roofKnown ? osmRoof : null, shops: 'none', balconies: 0 };
        break;
      }
      case K.COMMERCIAL: {
        const office = use === USE.OFFICE || (!catastro && storeysMax > 3);
        if (office) {
          sh = STOREY.office;
          mat = era >= ERA.MODERN ? pickW([[MAT.GLASS, 3], [MAT.MODERN, 2]]) : old ? pickW([[MAT.PINK, 2], [MAT.OCHRE, 1], [MAT.BRICK, 1]]) : era === ERA.POSTWAR ? MAT.PLAIN : MAT.BLOCS;
          if (!storeysMax) fallback = irange(3, 6);
          o = { cornice: old, corniceH: 0.5, roof: era >= ERA.BLOCS ? 'mech' : 'terrat', hvacH: range(2, 3.2), bulkheadP: 0.6, pitched: roofKnown ? osmRoof : null, shops: chance(0.5) ? 'all' : 'none', balconies: old ? 0.5 : 0 };
        } else if (storeysMax <= 1) {
          // retail halls, supermarkets, car dealers: one tall storey
          sh = STOREY.retail;
          mat = era <= ERA.POSTWAR ? MAT.BRICK : MAT.NAVE;
          if (!storeysMax) fallback = 1;
          o = { cornice: false, roof: chance(0.6) ? 'mech' : 'none', hvacH: range(1.6, 2.6), pitched: roofKnown ? osmRoof : null, shops: 'all', balconies: 0 };
        } else {
          sh = STOREY.office;
          mat = pickW(RES_ERA[era]);
          o = { cornice: old, corniceH: 0.5, roof: era >= ERA.BLOCS ? 'mech' : 'terrat', hvacH: range(2, 3.2), bulkheadP: 0.7, pitched: roofKnown ? osmRoof : null, shops: 'all', balconies: old ? 0.5 : 0.2 };
        }
        break;
      }
      case K.SCHOOL:
      case K.PUBLIC:
        sh = STOREY.public;
        mat = era >= ERA.NEW ? pickW([[MAT.GLASS, 2], [MAT.MODERN, 2]]) : era === ERA.MODERN ? MAT.MODERN : era === ERA.BLOCS ? pickW([[MAT.BLOCS, 3], [MAT.BRICK, 1]]) : era === ERA.POSTWAR ? MAT.PLAIN : pickW([[MAT.PINK, 2], [MAT.BRICK, 2], [MAT.OCHRE, 1]]);
        if (!storeysMax) fallback = irange(2, 4);
        o = { cornice: old, corniceH: 0.5, roof: era >= ERA.BLOCS ? 'mech' : 'terrat', hvacH: 2.4, bulkheadP: 0.5, pitched: roofKnown ? osmRoof : null, shops: 'none', balconies: 0 };
        break;
      case K.CHURCH:
        sh = STOREY.church;
        mat = pickW([[MAT.OCHRE, 2], [MAT.BRICK, 1]]);
        if (!storeysMax) fallback = irange(2, 4);
        o = { cornice: true, corniceH: 0.5, roof: 'none', walls: WALL_KINDS.blankStone, pitched: tiled(0.7, 'gable'), maxRoofSpan: 26, eave: 0.4, shops: 'none', balconies: 0 };
        break;
      case K.LOW:
        // farm buildings & sheds (Catastro agriculture), garages, huts: low, tile roofs on the rural ones
        sh = STOREY.shed;
        mat = pickW([[MAT.OCHRE, 2], [MAT.NAVE, 2], [MAT.PLAIN, 1]]);
        if (!storeysMax) fallback = 1;
        o = { cornice: false, roof: 'none', walls: WALL_KINDS.rear, pitched: use === USE.AGRICULTURE ? tiled(0.7, 'gable') : roofKnown ? osmRoof : null, eave: 0.4, shops: 'none', balconies: 0 };
        break;
      default: {
        // Housing (HOUSE / APARTMENTS / GENERIC): the era picks the bucket, the storey height & the ornament
        mat = pickW(RES_ERA[era]);
        sh = old ? STOREY.old : STOREY.residential;
        const flats = k === K.APARTMENTS || dwellings >= 3;
        if (!storeysMax) {
          fallback = k === K.HOUSE ? Math.min(3, irange(Math.max(1, lo - 1), hi))
            : flats ? irange(Math.max(lo, 3), hi) + (chance(prof.tall) ? irange(1, 2) : 0)
              : area < 70 ? irange(Math.max(1, lo), lo + 1) : irange(lo, hi) + (chance(prof.tall) ? irange(1, 2) : 0);
        }
        const st = storeysMax || fallback;
        // Shops on the ground floor: retail use, else the older fronts on the main streets & in the old town
        let shops = 'none';
        if (use === USE.RETAIL) shops = 'all';
        else if (st >= 2 && era <= ERA.BLOCS) shops = chance(prof.shops * (isMajorAt(cx, cz) ? 1.0 : 0.45)) ? 'all' : 'none';
        else if (st >= 3 && prof.shops >= 0.45) shops = chance(prof.shops * 0.3) ? 'all' : 'none';
        if (shops === 'all') ground = old ? STOREY.shopGroundOld : STOREY.shopGround;
        const single = !flats && st <= 2;
        const detached = prof.kind === 'suburban' || (dwellings <= 1 && area > 160 && prof.kind !== 'oldtown');
        let pitched = null;
        if (roofKnown) pitched = osmRoof;
        else if (old && single) pitched = chance(0.6) ? (detached ? 'hip' : 'gable') : null;
        else if (prof.kind === 'suburban' && single) pitched = chance(1 - prof.flatRoof) ? 'hip' : null;
        o = {
          cornice: old || (era === ERA.POSTWAR && chance(0.3)), corniceH: old ? 0.55 : 0.35,
          roof: 'terrat', bulkheadP: st >= 2 ? 0.85 : 0.15, hvacP: st >= 4 ? 0.2 : 0,
          pitched, ridge: 'auto', eave: 0.3, shops,
          balconies: old ? 0.85 : era === ERA.POSTWAR ? 0.5 : era === ERA.BLOCS ? 0.6 : 0.5,
          balconyDepth: old ? 0.9 : era === ERA.BLOCS ? 0.7 : 1.0
        };
      }
    }
    // Only OSM footprints without `building:levels` take the barri's typical storeys: a cadastral building whose
    // every part has 0 storeys is open ground (a court, a yard, a car park) and stays a plinth
    if (catastro) fallback = 0;
    // Height of a volume of `st` storeys; OSM `height` beats everything (scaled to the volume's share of storeys)
    const heightOf = (st) => {
      if (height > 0) return storeysMax ? (height * st) / storeysMax : height;
      return st * sh + (ground && st > 0 ? ground - sh : 0);
    };
    const b = building(blk, mat, null, sh);
    b.real = true;
    b.src = f;
    if (ground) b.ground = ground;
    for (const [u0, u1, v0, v1, stPart] of rects) {
      const r = rect(cx + u0, cx + u1, cz + v0, cz + v1);
      if (r.x1 - r.x0 < 0.5 || r.z1 - r.z0 < 0.5) continue;
      const st = stPart || (storeysMax ? 0 : fallback);
      if (st <= 0) {
        // open court, terrace or porch: a plinth
        if ((r.x1 - r.x0) * (r.z1 - r.z0) < PLINTH_MIN_AREA) continue;
        b.parts.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0: 0, y1: PLINTH_H, plinth: true });
        continue;
      }
      b.parts.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0: 0, y1: heightOf(st) });
    }
    b.lot = rect(
      Math.min(...b.parts.map((p) => p.x0)), Math.max(...b.parts.map((p) => p.x1)),
      Math.min(...b.parts.map((p) => p.z0)), Math.max(...b.parts.map((p) => p.z1))
    );
    commit(blk, b, o);
    xf = null;
  }

  // ============================================================================
  // A. EVERY REAL BLOCK OF TERRASSA (city-config.js BLOCKS)
  // ============================================================================
  for (const src of BLOCKS) {
    if (src.median) continue;
    const prof = blockProfile(src);
    const blk = {
      id: src.id,
      src,
      cx: src.cx,
      cz: src.cz,
      minX: src.minX,
      maxX: src.maxX,
      minZ: src.minZ,
      maxZ: src.maxZ,
      district: src.district,
      cornices: [],
      balconies: [],
      bulkheads: [],
      hvacUnits: [],
      awnings: [],
      fronts: [], // ground-floor street walls (world segments) for the real shops; dropped once they are placed
      footprints: [], // { x0, x1, z0, z1, h, tone } per building part, lowest first (maps; + pts: its world corners when turned)
      yards: [], // rear patios, courts & lawns { x0, x1, z0, z1, ry } (turned about their centre)
      maxH: 0
    };
    const nReal = src.buildings.length;
    const parking = src.cls === LAND_CLASS.PARKING && src.clsShare > 0.5;
    // Path B only where there is no building at all: real and procedural buildings never share a block
    const procedural = nReal === 0 && !src.open && src.park <= 0.6 && !parking && (src.rects.length > 0 || !!src.frames);

    // Path A: the real buildings
    if (nReal) {
      const real = src.buildings.map((bd) => {
        const [th, cx, cz, , , , , rects] = bd;
        let r2 = 0;
        for (const [u0, u1, v0, v1] of rects) r2 = Math.max(r2, u0 * u0 + v0 * v0, u1 * u1 + v1 * v1, u0 * u0 + v1 * v1, u1 * u1 + v0 * v0);
        const r = Math.sqrt(r2) + 1;
        const bb = [Infinity, -Infinity, Infinity, -Infinity]; // local bounds of its volumes
        for (const [u0, u1, v0, v1] of rects) { bb[0] = Math.min(bb[0], u0); bb[1] = Math.max(bb[1], u1); bb[2] = Math.min(bb[2], v0); bb[3] = Math.max(bb[3], v1); }
        return { bd, cx, cz, cs: Math.cos(th), sn: Math.sin(th), rects, bb, r, r2: r * r, near: null };
      });
      // the neighbours each building's walls may touch (for the party-wall probes)
      for (const f of real) {
        f.near = real.filter((g) => g !== f && Math.hypot(g.cx - f.cx, g.cz - f.cz) < f.r + g.r + 2);
      }
      for (const f of real) buildFootprint(blk, f, prof);
    }

    // Path B: the procedural lots
    if (procedural) {
      reserves = landmarkBoxes.filter((o) => o.x0 < src.maxX && o.x1 > src.minX && o.z0 < src.maxZ && o.z1 > src.minZ);
      rand = mulberry32(seedOf(src.cx, src.cz, src.id));
      const ring = prof.kind !== 'blocs' && prof.kind !== 'campus' && prof.kind !== 'industrial';
      for (const [th, px, pz, rects] of src.frames || [[0, 0, 0, src.rects]]) {
        xf = th ? { th, cs: Math.cos(th), sn: Math.sin(th), px, pz } : null;
        for (const r of rects) {
          const pieces = ring ? splitDeep(r, 'z').flatMap((p) => splitDeep(p, 'x')) : [r];
          for (const [x0, x1, z0, z1] of pieces) {
            if (x1 - x0 < 7 || z1 - z0 < 7) continue;
            cur = lotContext(blk, x0, x1, z0, z1);
            layoutRect(blk, rect(x0, x1, z0, z1), prof);
          }
        }
        xf = null;
      }
      cur = null;
      reserves = [];
    }

    delete blk.src;
    if (!blk.footprints.length && !blk.yards.length) { delete blk.fronts; continue; }
    blk.footprints.sort((a, b) => a.h - b.h);
    quadtree.insert(blk);
    allBlocks.push(blk);
  }

  // ============================================================================
  // B. THE REAL SHOPS (city-config.js SHOPS, OpenStreetMap POIs with their names): each one hangs its awning & fascia
  //    sign on the nearest ground-floor street wall within 14 m, whose ground floor becomes a storefront
  // ============================================================================
  const SHOP_REACH = 14;
  const SHOP_REACH_FAR = 20; // second chance for the POIs mapped inside a deep building or on the roadway
  const blkById = new Map(allBlocks.map((b) => [b.id, b]));
  const signs = []; // atlas cells: { name, kind }
  // awning colour (awningPalette index) by shop kind: 0 shop, 1 bar / restaurant, 2 bank, 3 pharmacy, 4 office, 5 hotel, 6 fuel, 7 other
  const awningColorOf = (name, kind) => (kind === 1 ? 0 : kind === 3 ? 1 : kind === 2 || kind === 4 ? 2 : kind === 6 ? 3 : kind === 5 ? 4 : hashStr(name) % 5);
  function placeShop(s, reach) {
    let best = null;
    let bestD = reach;
    for (const src of blocksInRect(s.x - reach, s.x + reach, s.z - reach, s.z + reach)) {
      const blk = blkById.get(src.id);
      if (!blk || !blk.fronts) continue;
      for (const fr of blk.fronts) {
        const dx = fr.bx - fr.ax;
        const dz = fr.bz - fr.az;
        const t = Math.max(0, Math.min(1, ((s.x - fr.ax) * dx + (s.z - fr.az) * dz) / (fr.L * fr.L)));
        const d = Math.hypot(fr.ax + t * dx - s.x, fr.az + t * dz - s.z);
        if (d < bestD) { bestD = d; best = { fr, t, blk }; }
      }
    }
    if (!best) return false;
    const { fr, blk } = best;
    const len = Math.min(6.5, fr.L - 1.0);
    const margin = (len * 0.5 + 0.4) / fr.L;
    const t = Math.max(margin, Math.min(1 - margin, best.t));
    const px = fr.ax + t * (fr.bx - fr.ax);
    const pz = fr.az + t * (fr.bz - fr.az);
    const sign = signs.length < SIGN_CAP ? signs.push({ name: s.name, kind: s.kind }) - 1 : -1;
    blk.awnings.push({
      x: px + fr.ox * 0.9, y: fr.storey * 0.72, z: pz + fr.oz * 0.9, len, alongX: fr.alongX, ry: fr.ry, storey: fr.storey,
      colorIdx: awningColorOf(s.name, s.kind), ox: fr.ox, oz: fr.oz, kind: s.kind, sign
    });
    fr.box.faces[fr.side] = WALL_KINDS.shop;
    return true;
  }
  let pending = SHOPS.slice();
  for (const reach of [SHOP_REACH, SHOP_REACH_FAR]) pending = pending.filter((s) => !placeShop(s, reach));
  for (const blk of allBlocks) delete blk.fronts;

  // ============================================================================
  // C. STATIC CITY-WIDE MASSING (8 TSL facade materials, instanced) & PITCHED ROOFS
  // ============================================================================
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const dummy = new THREE.Object3D();

  buckets.forEach((items, matIdx) => {
    if (items.length === 0) return;
    const inst = createFacadeBoxes(materials[matIdx], items);
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  });

  // Terracotta tile roofs (gable / hip) & fibre-cement sawtooth / skillion roofs
  const tileMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide });
  tileMat.colorNode = Fn(() => {
    const p = positionWorld;
    const px = length(fwidth(p.xz));
    const fine = smoothstep(0.7, 0.1, px);
    const course = step(0.55, fract(p.y.mul(3.4))).mul(fine).mul(0.16); // a tile course every ~0.3 m of rise
    const n = mx_noise_float(p.xz.mul(0.9)).mul(0.5).add(0.5);
    const weather = mx_noise_float(p.xz.mul(0.12).add(3.1)).mul(0.5).add(0.5);
    const tile = mix(color(0xa9562f), color(0xcb8a5a), n);
    return mix(tile, color(0x8d7a66), weather.mul(0.35)).mul(float(1.0).sub(course));
  })();
  const sheetMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.15, side: THREE.DoubleSide });
  sheetMat.colorNode = Fn(() => {
    const p = positionWorld;
    const n = mx_noise_float(p.xz.mul(0.3)).mul(0.5).add(0.5);
    return mix(color(0x8f9089), color(0xaaa9a0), n);
  })();
  for (const [kind, items] of Object.entries(roofItems)) {
    if (!items.length) continue;
    const inst = new THREE.InstancedMesh(roofPrism(kind), kind === 'saw' ? sheetMat : tileMat, items.length);
    items.forEach((r, i) => {
      dummy.position.set(r.x, r.y, r.z);
      dummy.rotation.set(0, r.ry || 0, 0);
      dummy.scale.set(r.w, r.h, r.d);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    dummy.rotation.set(0, 0, 0);
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.name = `Roofs_${kind}`;
    group.add(inst);
  }

  // Patios, courtyards & lawns: one thin slab per patch just above the sidewalk (buildings standing on it hide the
  // rest). Lawn, paving and tree canopies come from world-space noise; detail finer than a pixel fades to its average
  // so the gardens don't shimmer from the air
  const yardMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.0 });
  yardMat.colorNode = Fn(() => {
    const p = positionWorld.xz;
    const px = length(fwidth(p)); // metres per pixel
    const fine = smoothstep(0.9, 0.12, px);
    const crownLOD = smoothstep(8.0, 3.0, px); // crowns a few pixels wide or more are drawn, smaller ones averaged
    const grain = mx_noise_float(p.mul(1.9)).mul(fine).mul(0.5).add(0.5);
    const clump = mx_noise_float(p.mul(0.7).add(5.3)).mul(smoothstep(2.0, 0.4, px)).mul(0.5).add(0.5);

    // Dry Mediterranean lawns with beige / terracotta patio paving
    const patch = mx_noise_float(p.mul(0.21)).mul(smoothstep(12.0, 4.0, px));
    const lawn = mix(color(0x6a7d3c), color(0x8d9a52), grain);
    const paving = mix(color(0x9a8f7c), color(0xb5a892), grain);
    const ground = mix(lawn, paving, smoothstep(0.1, 0.4, patch));

    // Garden-tree-sized (~10 m) & small (~5 m) crowns, domed: sunlit crowns, softer & darker towards their rims
    const w1 = mx_worley_noise_float(p.mul(0.095));
    const w2 = mx_worley_noise_float(p.mul(0.18).add(17.0));
    const crowns = max(smoothstep(0.55, 0.3, w1), smoothstep(0.45, 0.25, w2).mul(0.85));
    const rim = smoothstep(0.0, 1.0, min(w1.div(0.55), w2.div(0.45)));
    const leaves = mix(color(0x3f5a2a), color(0x5f7c3b), clump.mul(0.6).add(grain.mul(0.4))).mul(mix(float(1.08), float(0.78), rim));
    const leavesMean = mix(color(0x3f5a2a), color(0x5f7c3b), 0.5).mul(0.93);
    return mix(ground, mix(leavesMean, leaves, crownLOD), mix(float(0.4), crowns, crownLOD));
  })();
  const yardRects = [];
  for (const blk of allBlocks) yardRects.push(...blk.yards);
  if (yardRects.length) {
    const yardInst = new THREE.InstancedMesh(unitBox, yardMat, yardRects.length);
    yardRects.forEach((r, i) => {
      dummy.position.set((r.x0 + r.x1) * 0.5, 0.225, (r.z0 + r.z1) * 0.5);
      dummy.rotation.set(0, r.ry || 0, 0);
      dummy.scale.set(r.x1 - r.x0, 0.05, r.z1 - r.z0);
      dummy.updateMatrix();
      yardInst.setMatrixAt(i, dummy.matrix);
    });
    dummy.rotation.set(0, 0, 0);
    yardInst.receiveShadow = true;
    group.add(yardInst);
  }

  // ============================================================================
  // D. QUADTREE-STREAMED HIGH-DETAIL ARCHITECTURAL POOLS (LOD0 around player)
  // ============================================================================
  const STREAM_RADIUS = 560; // High-detail architectural radius around player in meters
  // Pool capacities from the data: the most items of each kind any STREAM_RADIUS neighbourhood holds (measured at
  // every block's centre), never more than the city has
  const POOL_KEYS = ['cornices', 'balconies', 'bulkheads', 'hvacUnits', 'awnings'];
  const poolSize = Object.fromEntries(POOL_KEYS.map((k) => [k, 0]));
  {
    const totals = Object.fromEntries(POOL_KEYS.map((k) => [k, 0]));
    for (const blk of allBlocks) for (const k of POOL_KEYS) totals[k] += blk[k].length;
    const near = [];
    for (const blk of allBlocks) {
      near.length = 0;
      quadtree.queryRange(blk.cx, blk.cz, STREAM_RADIUS, near);
      for (const k of POOL_KEYS) {
        let n = 0;
        for (const o of near) n += o[k].length;
        if (n > poolSize[k]) poolSize[k] = n;
      }
    }
    for (const k of POOL_KEYS) poolSize[k] = Math.max(1, Math.min(totals[k], Math.ceil(poolSize[k] * 1.15) + 32));
  }
  const MAX_CORNICES = poolSize.cornices;
  const MAX_BALCONIES = poolSize.balconies;
  const MAX_BULKHEADS = poolSize.bulkheads;
  const MAX_HVAC = poolSize.hvacUnits;
  const MAX_AWNINGS = poolSize.awnings;

  // 1. Projecting cornices & ledges
  const corniceMat = new THREE.MeshStandardNodeMaterial({ color: 0xd3c7ae, roughness: 0.8, metalness: 0.05 });
  const corniceInst = new THREE.InstancedMesh(unitBox, corniceMat, MAX_CORNICES);
  corniceInst.castShadow = true;
  corniceInst.receiveShadow = true;
  corniceInst.frustumCulled = false;
  group.add(corniceInst);

  // 2. Balcony slabs
  const balconyMat = new THREE.MeshStandardNodeMaterial({ color: 0xcdc4b2, roughness: 0.85, metalness: 0.02 });
  const balconyInst = new THREE.InstancedMesh(unitBox, balconyMat, MAX_BALCONIES);
  balconyInst.castShadow = true;
  balconyInst.receiveShadow = true;
  balconyInst.frustumCulled = false;
  group.add(balconyInst);

  // 3. Stair bulkheads on the terrats (caixes d'escala): stuccoed boxes with a door
  const bulkheadMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.0 });
  bulkheadMat.colorNode = Fn(() => {
    const u = uv();
    const isTop = step(0.7, normalWorldGeometry.y);
    const door = step(0.36, u.x).mul(step(u.x, 0.64)).mul(step(u.y, 0.82)).mul(float(1.0).sub(isTop));
    const wall = mix(color(0xd6cbb6), color(0xe2d9c7), fract(positionWorld.x.mul(0.37)).mul(0.5));
    return mix(mix(wall, color(0x4a3f33), door.mul(0.6)), color(0x9c9284), isTop);
  })();
  const bulkheadInst = new THREE.InstancedMesh(unitBox, bulkheadMat, MAX_BULKHEADS);
  bulkheadInst.castShadow = bulkheadInst.receiveShadow = true;
  bulkheadInst.frustumCulled = false;
  group.add(bulkheadInst);

  // 4. Rooftop plant rooms & HVAC chillers with top exhaust fans & side louvers
  const hvacMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.52, metalness: 0.45 });
  hvacMat.colorNode = Fn(() => {
    const u = uv();
    const isTop = step(0.7, normalWorldGeometry.y);
    const fan1 = length(u.sub(vec2(0.3, 0.5)));
    const fan2 = length(u.sub(vec2(0.7, 0.5)));
    const fanDist = min(fan1, fan2);
    const inFanWell = smoothstep(0.19, 0.17, fanDist);
    const fanRing = smoothstep(0.025, 0.008, abs(fract(fanDist.mul(16.0)).sub(0.5))).mul(inFanWell);
    const topCol = mix(color(0x889098), color(0x1b2026), inFanWell.mul(0.82).sub(fanRing.mul(0.45)));

    const inLouverBox = step(0.12, u.x).mul(step(u.x, 0.88)).mul(step(0.18, u.y)).mul(step(u.y, 0.82));
    const louverSlat = step(0.45, fract(u.y.mul(14.0))).mul(inLouverBox);
    const panelSeam = smoothstep(0.03, 0.0, abs(fract(u.x.mul(3.0)).sub(0.5)));
    const sideCol = mix(color(0x7c848c), color(0x282e36), max(louverSlat.mul(0.72), panelSeam.mul(0.35)));
    return mix(sideCol, topCol, isTop);
  })();
  const hvacInst = new THREE.InstancedMesh(unitBox, hvacMat, MAX_HVAC);
  hvacInst.castShadow = hvacInst.receiveShadow = true;
  hvacInst.frustumCulled = false;
  group.add(hvacInst);

  // 5. Shop awnings (canvas, coloured by the kind of business) & fascia signs with the real names
  const awningMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.65 });
  const awningPalette = [
    new THREE.Color(0x9e222e), // bars & restaurants: red
    new THREE.Color(0x1f593b), // pharmacies: green
    new THREE.Color(0x213d68), // banks & offices: blue
    new THREE.Color(0xd9912b), // fuel: orange
    new THREE.Color(0xe9e2d2) // hotels: cream
  ];
  const awningInst = new THREE.InstancedMesh(unitBox, awningMat, MAX_AWNINGS);
  awningInst.castShadow = awningInst.receiveShadow = true;
  awningInst.frustumCulled = false;
  // Pre-initialize instanceColor buffer so dynamic updates work cleanly
  for (let i = 0; i < MAX_AWNINGS; i++) {
    awningInst.setColorAt(i, awningPalette[i % awningPalette.length]);
  }
  group.add(awningInst);

  // The sign atlas: one cell per named shop, drawn in the colour scheme of its kind (bars red / dark, pharmacies a
  // green cross on white, banks blue, hotels dark & gold, shops varied by name)
  const SHOP_SCHEMES = [
    { bg: '#1d1a16', border: '#c9a24f', color: '#ffe9b8' },
    { bg: '#12223d', border: '#9cc4ff', color: '#ffffff' },
    { bg: '#3a2a10', border: '#f0c060', color: '#fff3d0' },
    { bg: '#f1ece2', border: '#5b4636', color: '#2b241e' },
    { bg: '#17433f', border: '#8fd7c6', color: '#eafaf5' },
    { bg: '#5a1e3a', border: '#f2b5d4', color: '#ffeef7' }
  ];
  const BAR_SCHEMES = [
    { bg: '#2a1410', border: '#e0623a', color: '#ffd9c2' },
    { bg: '#7a1b22', border: '#f2c14e', color: '#fff3dd' },
    { bg: '#1d1a16', border: '#c0392b', color: '#ffdede' }
  ];
  function signScheme(name, kind) {
    const h = hashStr(name);
    switch (kind) {
      case 1: return BAR_SCHEMES[h % BAR_SCHEMES.length];
      case 2: return { bg: '#123a7a', border: '#cfe0ff', color: '#ffffff' };
      case 3: return { bg: '#ffffff', border: '#1e8f4e', color: '#1e8f4e', cross: true };
      case 4: return { bg: '#2d3744', border: '#9fb0c2', color: '#eef3f8' };
      case 5: return { bg: '#1b1f2a', border: '#d4af37', color: '#f5e7b8' };
      case 6: return { bg: '#f4f4f0', border: '#e2531b', color: '#1f2a37' };
      default: return SHOP_SCHEMES[h % SHOP_SCHEMES.length];
    }
  }
  const signRows = Math.max(1, Math.ceil(signs.length / SIGN_COLS));
  const signCanvas = document.createElement('canvas');
  signCanvas.width = SIGN_COLS * SIGN_W;
  signCanvas.height = signRows * SIGN_H;
  {
    const ctx = signCanvas.getContext('2d');
    ctx.fillStyle = '#1d1a16';
    ctx.fillRect(0, 0, signCanvas.width, signCanvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    signs.forEach((s, i) => {
      const x0 = (i % SIGN_COLS) * SIGN_W;
      const y0 = Math.floor(i / SIGN_COLS) * SIGN_H;
      const sc = signScheme(s.name, s.kind);
      ctx.fillStyle = sc.bg;
      ctx.fillRect(x0, y0, SIGN_W, SIGN_H);
      ctx.strokeStyle = sc.border;
      ctx.lineWidth = 3;
      ctx.strokeRect(x0 + 3, y0 + 3, SIGN_W - 6, SIGN_H - 6);
      let tx0 = x0 + 10;
      if (sc.cross) {
        // the green cross of the farmàcies
        ctx.fillStyle = sc.border;
        ctx.fillRect(x0 + 14, y0 + 20, 26, 8);
        ctx.fillRect(x0 + 23, y0 + 11, 8, 26);
        tx0 = x0 + 46;
      }
      const avail = x0 + SIGN_W - 10 - tx0;
      let size = 22;
      ctx.font = `700 ${size}px Inter, Arial, sans-serif`;
      let w = ctx.measureText(s.name).width;
      if (w > avail) {
        size = Math.max(11, Math.floor((size * avail) / w));
        ctx.font = `700 ${size}px Inter, Arial, sans-serif`;
        w = ctx.measureText(s.name).width;
      }
      let text = s.name;
      while (w > avail && text.length > 4) {
        text = `${text.slice(0, -2).trimEnd()}…`;
        w = ctx.measureText(text).width;
      }
      ctx.fillStyle = sc.color;
      ctx.fillText(text, tx0 + avail * 0.5, y0 + SIGN_H * 0.5 + 1);
    });
  }
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  signTex.anisotropy = 4;
  const signMat = new THREE.MeshBasicNodeMaterial();
  signMat.colorNode = texture(signTex, uv().mul(vec2(1 / SIGN_COLS, 1 / signRows)).add(attribute('signCell', 'vec2')));
  const signGeom = new THREE.BoxGeometry(1, 1, 1);
  const signCells = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AWNINGS * 2), 2);
  signGeom.setAttribute('signCell', signCells);
  const signInst = new THREE.InstancedMesh(signGeom, signMat, MAX_AWNINGS);
  signInst.frustumCulled = false;
  group.add(signInst);

  // 6. Ground-floor shopfront clustered SpotLights (awnings / fascia signs), coloured by the kind of business
  const storeLightGroup = new THREE.Group();
  storeLightGroup.name = 'StoreClusteredLights';
  scene.add(storeLightGroup);

  const storeKindColors = [
    new THREE.Color(0xffd896), // shops: warm gold
    new THREE.Color(0xffbe88), // bars: warm orange-gold
    new THREE.Color(0xdce8ff), // banks: cool white
    new THREE.Color(0xd8ffe8), // pharmacies: crisp green-white
    new THREE.Color(0xf2f4ff), // offices: cool white
    new THREE.Color(0xfff2d6), // hotels: warm ivory
    new THREE.Color(0xffffff), // fuel: white
    new THREE.Color(0xffe6b8) // other: warm
  ];

  const STORE_SPOT_POOL = 28;
  const storeSpotPool = [];
  for (let i = 0; i < STORE_SPOT_POOL; i++) {
    const spot = new THREE.SpotLight(0xffd896, 0, 12.0, 0.84, 0.80, 1.30);
    spot.castShadow = false;
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    storeLightGroup.add(spot);
    storeLightGroup.add(spot.target);
    storeSpotPool.push(spot);
  }

  const activeAwnings = [];
  const spotCandidates = [];

  // ============================================================================
  // E. DYNAMIC QUADTREE STREAMING UPDATE AROUND PLAYER / CAMERA
  // ============================================================================
  let lastStreamX = Infinity;
  let lastStreamZ = Infinity;

  // Streaming rewrites only the active prefix; unused pool capacity need not cross the GPU queue.
  function flagRange(attr, count) {
    if (count === 0) return;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count * attr.itemSize);
    attr.needsUpdate = true;
  }
  // Every streamed item carries its own turn about +y (ry: its frontage frame's or its building's)
  function setBox(inst, idx, o, y, w, h, d) {
    dummy.position.set(o.x, y, o.z);
    dummy.rotation.set(0, o.ry || 0, 0);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    inst.setMatrixAt(idx, dummy.matrix);
  }

  function update(focusX, focusZ, force = false) {
    const dx = focusX - lastStreamX;
    const dz = focusZ - lastStreamZ;
    if (!force && (dx * dx + dz * dz) < 324) {
      // Player moved less than 18m since last Quadtree stream update
      return;
    }
    lastStreamX = focusX;
    lastStreamZ = focusZ;

    const nearbyBlocks = quadtree.queryRange(focusX, focusZ, STREAM_RADIUS);
    // Sort closest blocks first so if any pool hits capacity, closest blocks around the player always win
    nearbyBlocks.sort((a, b) => {
      const da = (a.cx - focusX) * (a.cx - focusX) + (a.cz - focusZ) * (a.cz - focusZ);
      const db = (b.cx - focusX) * (b.cx - focusX) + (b.cz - focusZ) * (b.cz - focusZ);
      return da - db;
    });
    activeAwnings.length = 0;

    let corniceCount = 0;
    let balconyCount = 0;
    let bulkheadCount = 0;
    let hvacCount = 0;
    let awningCount = 0;
    let signCount = 0;

    for (let bIdx = 0; bIdx < nearbyBlocks.length; bIdx++) {
      const blk = nearbyBlocks[bIdx];
      const collectNearLights = bIdx < 20;

      // 1. Cornices & ledges, hung just below their roof line (top 0.1h under it, so no two ledges or roofs share a
      //    plane) so roofs & terraces keep their own roofing instead of a stone lid
      for (let i = 0; i < blk.cornices.length && corniceCount < MAX_CORNICES; i++) {
        const c = blk.cornices[i];
        setBox(corniceInst, corniceCount++, c, c.y - c.h * 0.6, c.w, c.h, c.d);
      }

      // 2. Balcony slabs
      for (let i = 0; i < blk.balconies.length && balconyCount < MAX_BALCONIES; i++) {
        const s = blk.balconies[i];
        setBox(balconyInst, balconyCount++, s, s.y, s.w, 0.16, s.d);
      }

      // 3. Stair bulkheads on the terrats
      for (let i = 0; i < blk.bulkheads.length && bulkheadCount < MAX_BULKHEADS; i++) {
        const u = blk.bulkheads[i];
        setBox(bulkheadInst, bulkheadCount++, u, u.y + u.h * 0.5, u.w, u.h, u.d);
      }

      // 4. Rooftop HVAC & plant rooms
      for (let i = 0; i < blk.hvacUnits.length && hvacCount < MAX_HVAC; i++) {
        const u = blk.hvacUnits[i];
        setBox(hvacInst, hvacCount++, u, u.y + u.h * 0.5, u.w, u.h, u.d);
      }

      // 5. Shop awnings & fascia signs
      for (let i = 0; i < blk.awnings.length && awningCount < MAX_AWNINGS; i++) {
        const a = blk.awnings[i];
        if (a.alongX) setBox(awningInst, awningCount, a, a.y, a.len, 0.7, 1.8);
        else setBox(awningInst, awningCount, a, a.y, 1.8, 0.7, a.len);
        awningInst.setColorAt(awningCount, awningPalette[a.colorIdx % awningPalette.length]);

        if (a.sign >= 0) {
          // the fascia sits on the wall, 0.76 m behind the awning's centre
          dummy.position.set(a.x - a.ox * 0.76, a.storey - 0.3, a.z - a.oz * 0.76);
          dummy.rotation.set(0, a.ry || 0, 0);
          if (a.alongX) dummy.scale.set(a.len * 0.92, 0.6, 0.28);
          else dummy.scale.set(0.28, 0.6, a.len * 0.92);
          dummy.updateMatrix();
          signInst.setMatrixAt(signCount, dummy.matrix);
          signCells.setXY(signCount, (a.sign % SIGN_COLS) / SIGN_COLS, 1 - (Math.floor(a.sign / SIGN_COLS) + 1) / signRows);
          signCount++;
        }
        if (collectNearLights) {
          activeAwnings.push(a);
        }
        awningCount++;
      }
    }
    dummy.rotation.set(0, 0, 0);

    corniceInst.count = corniceCount;
    flagRange(corniceInst.instanceMatrix, corniceCount);

    balconyInst.count = balconyCount;
    flagRange(balconyInst.instanceMatrix, balconyCount);

    bulkheadInst.count = bulkheadCount;
    flagRange(bulkheadInst.instanceMatrix, bulkheadCount);

    hvacInst.count = hvacCount;
    flagRange(hvacInst.instanceMatrix, hvacCount);

    awningInst.count = awningCount;
    flagRange(awningInst.instanceMatrix, awningCount);
    if (awningInst.instanceColor) flagRange(awningInst.instanceColor, awningCount);

    signInst.count = signCount;
    flagRange(signInst.instanceMatrix, signCount);
    flagRange(signCells, signCount);
  }

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function updateLights(camera) {
    const glow = 0.85;
    const glowFactor = Math.max(0, (glow - 0.15) / 0.90);
    if (!camera || glowFactor <= 0.001) {
      for (let i = 0; i < STORE_SPOT_POOL; i++) {
        storeSpotPool[i].intensity = 0;
        storeSpotPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const e = camera.matrixWorld.elements;
    const fwdLen = Math.hypot(e[8], e[10]) || 1;
    const fwdX = -e[8] / fwdLen;
    const fwdZ = -e[10] / fwdLen;
    const STORE_MAX_DIST = 115;

    spotCandidates.length = 0;
    for (let i = 0; i < activeAwnings.length; i++) {
      const a = activeAwnings[i];
      const dx = a.x - camX;
      const dz = a.z - camZ;
      const d2 = dx * dx + dz * dz + camY * camY;
      if (d2 > STORE_MAX_DIST * STORE_MAX_DIST) continue;
      const d = Math.sqrt(d2);
      const forwardDot = dx * fwdX + dz * fwdZ;
      const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
      if (effDist >= STORE_MAX_DIST) continue;
      spotCandidates.push({ a, effDist });
    }
    spotCandidates.sort((a, b) => a.effDist - b.effDist);

    const storeCutoff = spotCandidates.length > STORE_SPOT_POOL
      ? Math.min(STORE_MAX_DIST, spotCandidates[STORE_SPOT_POOL].effDist)
      : STORE_MAX_DIST;
    const activeSpots = Math.min(STORE_SPOT_POOL, spotCandidates.length);
    const spotIntensity = 46 * glowFactor;
    for (let i = 0; i < STORE_SPOT_POOL; i++) {
      const spot = storeSpotPool[i];
      if (i < activeSpots) {
        const cand = spotCandidates[i];
        const a = cand.a;
        const fade = smoothFade(cand.effDist, storeCutoff * 0.62, storeCutoff);
        spot.position.set(a.x + a.ox * 0.45, a.storey + 0.1, a.z + a.oz * 0.45);
        spot.target.position.set(a.x + a.ox * 1.85, 0.0, a.z + a.oz * 1.85);
        spot.target.updateMatrixWorld();
        spot.color.copy(storeKindColors[a.kind % storeKindColors.length] || storeKindColors[0]);
        spot.intensity = spotIntensity * fade;
      } else {
        spot.intensity = 0;
        spot.position.set(0, -1000, 0);
      }
    }
  }

  // Initial quadtree stream centred on the spawn (the Plaça Vella)
  update(SPAWN.x, SPAWN.z, true);

  scene.add(group);
  return {
    group,
    colliders,
    quadtree,
    allBlocks,
    update,
    updateLights
  };
}

export { Quadtree, buildCityBlocks };
