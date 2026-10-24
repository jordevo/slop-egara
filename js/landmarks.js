import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANDMARK_SITES, MODELLED_LANDMARKS, nearestRoads } from './city-config.js';
import { createPreWarBuildingMaterial } from './tsl-materials.js';

// js/landmarks.js
// Terrassa's landmarks, built from their real OpenStreetMap footprints (city-config.js LANDMARK_SITES: outline `ring`
// in world metres, `h` when OSM knows the height, `kind`). Every landmark named in MODELLED_LANDMARKS is built here, on
// its exact outline, in one of two ways:
//   1. the generic path: the outline extruded to its height (OSM, else a per-kind default) with a ground storey of
//      plain stone pierced by arched portals, windowed upper storeys in a world-space facade material (windows follow
//      positionWorld, like the original's landmark tiers), a string course, cornice(s), a parapet or a tiled roof;
//   2. a bespoke low-poly model in the spirit of the original's Chrysler / Empire State: the Catedral, the Masia Freixa,
//      the Torre del Palau, the Cartoixa, the Mercat, the town halls, the mNACTEC mill, the Teatre Principal, the three
//      churches of the Seu d'Ègara, the Mútua tower, the Estadi Olímpic, the stations, the chimneys & the carillon.
// Roofs follow the real outline too: a pitched (or hipped) roof is the outline clipped into planar facets, each lifted
// by a linear height field, with gable skirts along the walls; the mill's sawtooth is the same trick tooth by tooth.
// All geometry is baked in world space and merged into one mesh per material (scene-culling.js cuts the batches into
// cells), so the whole set costs a few dozen draw calls. Colliders are axis-aligned boxes tiling the outline.
// Fidelity notes per landmark: HOW_TO_IMPROVE.md §4.6.

const GROUP_NAME = 'TerrassaLandmarks';
// The mNACTEC's footprint is tagged with the museum's name in OSM; the mill it occupies is listed under its own name
const VAPOR_NAMES = ['Vapor Aymerich, Amat i Jover', 'Museu Nacional de la Ciència i de la Tècnica de Catalunya'];

// ---------------------------------------------------------------------------------------------------------------------
// 2D outline helpers ({x, z} rings, counter-clockwise so the outward normal of an edge a→b is (dz, -dx))
// ---------------------------------------------------------------------------------------------------------------------
function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}
/** A clean copy of an outline: no repeated points, no closing duplicate, counter-clockwise */
function cleanRing(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.z - q.z) > 0.05) out.push({ x: p.x, z: p.z });
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) <= 0.05) out.pop();
  if (out.length < 3) return null;
  return signedArea(out) < 0 ? out.reverse() : out;
}
function centroidOf(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const c = ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    a += c; cx += (ring[j].x + ring[i].x) * c; cz += (ring[j].z + ring[i].z) * c;
  }
  if (Math.abs(a) < 1e-6) return { x: ring[0].x, z: ring[0].z };
  return { x: cx / (3 * a), z: cz / (3 * a) };
}
function bboxOf(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  return { minX, maxX, minZ, maxZ };
}
function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
/** Distance from (x, z) to the outline's edges */
function distToRing(ring, x, z) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    best = Math.min(best, Math.hypot(a.x + t * dx - x, a.z + t * dz - z));
  }
  return best;
}
/** Clearance of a point inside the outline (0 outside) */
const clearance = (ring, x, z) => (inRing(ring, x, z) ? distToRing(ring, x, z) : 0);
/** The edges of an outline: start, end, length, unit direction & outward normal */
function edgesOf(ring) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1e-9;
    const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
    out.push({ i, a, b, len, dx, dz, nx: dz, nz: -dx, mx: (a.x + b.x) / 2, mz: (a.z + b.z) / 2 });
  }
  return out;
}
/** The outline moved outward by `d` (inward when negative, mitred corners); null when an inward offset collapses it */
function offsetRing(ring, d) {
  const E = edgesOf(ring);
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const e1 = E[(i - 1 + n) % n], e2 = E[i];
    const dot = e1.nx * e2.nx + e1.nz * e2.nz;
    const k = d / Math.max(0.3, 1 + dot);
    out.push({ x: ring[i].x + (e1.nx + e2.nx) * k, z: ring[i].z + (e1.nz + e2.nz) * k });
  }
  if (d < 0) {
    if (signedArea(out) < 0.2 * signedArea(ring)) return null;
    const F = edgesOf(out);
    for (let i = 0; i < n; i++) if (E[i].dx * F[i].dx + E[i].dz * F[i].dz < 0.2) return null;
  }
  return out;
}
/** A convex outline drawn `d` metres towards its centroid at every vertex (terraces of an oval: never collapses) */
function shrinkRing(ring, d) {
  const c = centroidOf(ring);
  return ring.map((p) => {
    const r = Math.hypot(p.x - c.x, p.z - c.z) || 1;
    const k = Math.max(0.05, 1 - d / r);
    return { x: c.x + (p.x - c.x) * k, z: c.z + (p.z - c.z) * k };
  });
}
/** The convex hull of an outline (monotone chain), counter-clockwise */
function convexHull(ring) {
  const pts = ring.slice().sort((p, q) => p.x - q.x || p.z - q.z);
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return cleanRing([...lower.slice(0, -1), ...upper.slice(0, -1)]);
}
/** The part of a polygon on the side nx·x + nz·z ≥ c (Sutherland–Hodgman) */
function clipPoly(pts, nx, nz, c) {
  const out = [];
  const side = (p) => nx * p.x + nz * p.z - c;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out.length >= 3 ? out : [];
}
/**
 * The outline's local frame: its minimum-area bounding rectangle, u along the long side (w), v across (d).
 *   world = c + u·(cos θ, sin θ) + v·(−sin θ, cos θ)
 */
function frameOf(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const th = Math.atan2(b.z - a.z, b.x - a.x);
    const c = Math.cos(th), s = Math.sin(th);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) {
      const u = p.x * c + p.z * s, v = -p.x * s + p.z * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, th, w: u1 - u0, d: v1 - v0, cu: (u0 + u1) / 2, cv: (v0 + v1) / 2 };
  }
  let { th, w, d, cu, cv } = best;
  if (d > w) { // the long side along u
    [w, d] = [d, w];
    [cu, cv] = [cv, -cu];
    th += Math.PI / 2;
  }
  const c = Math.cos(th), s = Math.sin(th);
  const f = {
    th, w, d, c, s,
    cx: cu * c - cv * s,
    cz: cu * s + cv * c,
    toLocal(p) { const dx = p.x - f.cx, dz = p.z - f.cz; return { x: dx * c + dz * s, z: -dx * s + dz * c }; },
    toWorld(u, v) { return { x: f.cx + u * c - v * s, z: f.cz + u * s + v * c }; },
    matrix(u = 0, y = 0, v = 0) {
      const p = f.toWorld(u, v);
      return new THREE.Matrix4().makeTranslation(p.x, y, p.z).multiply(new THREE.Matrix4().makeRotationY(-th));
    }
  };
  return f;
}
/** Placement on an edge: `s` metres from its start, `off` metres outward, local +z pointing out of the wall */
function edgeMatrix(e, s, y, off = 0) {
  return new THREE.Matrix4()
    .makeTranslation(e.a.x + e.dx * s + e.nx * off, y, e.a.z + e.dz * s + e.nz * off)
    .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(e.nx, e.nz)));
}
/** The outline vertex that is the most in a direction (dx, dz): e.g. (−1, −1) the north-west corner */
function extremeVertex(ring, dx, dz) {
  let best = ring[0], bv = -Infinity;
  for (const p of ring) { const v = p.x * dx + p.z * dz; if (v > bv) { bv = v; best = p; } }
  return best;
}
/** A point `inset` metres inside the outline from one of its vertices (towards the centroid) */
function insetPoint(ring, p, inset) {
  const c = centroidOf(ring);
  const L = Math.hypot(c.x - p.x, c.z - p.z) || 1;
  return { x: p.x + ((c.x - p.x) / L) * inset, z: p.z + ((c.z - p.z) / L) * inset };
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometry sink: everything is baked in world space into one geometry per material
// ---------------------------------------------------------------------------------------------------------------------
class Sink {
  constructor() { this.buckets = new Map(); this.colliders = []; }
  add(geo, mat, matrix = null) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (matrix) g.applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!this.buckets.has(mat)) this.buckets.set(mat, []);
    this.buckets.get(mat).push(g);
  }
  box(w, h, d, mat, matrix) { this.add(new THREE.BoxGeometry(w, h, d), mat, matrix); }
  collide(minX, maxX, minZ, maxZ, maxY) { this.colliders.push({ minX, maxX, minZ, maxZ, maxY }); }
  /** Axis-aligned boxes tiling an outline (minus an optional hole) for the collision system */
  collideRing(ring, maxY, cell = 4, hole = null) {
    const b = bboxOf(ring);
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    const fill = signedArea(ring) / (w * d || 1);
    if (!hole && (w * d < 400 || (fill > 0.85 && Math.max(w, d) < 70))) { this.collide(b.minX, b.maxX, b.minZ, b.maxZ, maxY); return; }
    const nx = Math.ceil(w / cell), nz = Math.ceil(d / cell);
    const inside = (ix, iz) => {
      const x = b.minX + (ix + 0.5) * cell, z = b.minZ + (iz + 0.5) * cell;
      return inRing(ring, x, z) && !(hole && inRing(hole, x, z));
    };
    // rows of runs, then equal runs stacked across rows
    const open = new Map(); // key "ix0:ix1" -> { iz0 }
    for (let iz = 0; iz <= nz; iz++) {
      const runs = [];
      if (iz < nz) {
        let start = -1;
        for (let ix = 0; ix <= nx; ix++) {
          const on = ix < nx && inside(ix, iz);
          if (on && start < 0) start = ix;
          if (!on && start >= 0) { runs.push([start, ix]); start = -1; }
        }
      }
      const keys = new Set(runs.map((r) => `${r[0]}:${r[1]}`));
      for (const [k, v] of [...open]) {
        if (!keys.has(k)) {
          const [ix0, ix1] = k.split(':').map(Number);
          this.collide(b.minX + ix0 * cell, Math.min(b.maxX, b.minX + ix1 * cell), b.minZ + v.iz0 * cell, Math.min(b.maxZ, b.minZ + iz * cell), maxY);
          open.delete(k);
        }
      }
      for (const k of keys) if (!open.has(k)) open.set(k, { iz0: iz });
    }
  }
}

/** Hand-built triangles with per-face normals & simple UVs */
class Poly {
  constructor() { this.p = []; this.n = []; this.uv = []; }
  tri(a, b, c, want = null) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) return;
    nx /= L; ny /= L; nz /= L;
    if (want && nx * want[0] + ny * want[1] + nz * want[2] < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    for (const q of [a, b, c]) {
      this.p.push(q[0], q[1], q[2]);
      this.n.push(nx, ny, nz);
      // metres along the dominant horizontal axis & height: good enough for the plain materials
      this.uv.push(Math.abs(nx) > Math.abs(nz) ? q[2] : q[0], Math.abs(ny) > 0.7 ? q[2] : q[1]);
    }
  }
  quad(a, b, c, d, want = null) { this.tri(a, b, c, want); this.tri(a, c, d, want); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    return g;
  }
}

/** The vertical walls of an outline between two heights (edges listed in `skip` are left open) */
function wallRing(ring, y0, y1, skip = null) {
  const P = new Poly();
  for (const e of edgesOf(ring)) {
    if (skip && skip.has(e.i)) continue;
    P.quad([e.a.x, y0, e.a.z], [e.a.x, y1, e.a.z], [e.b.x, y1, e.b.z], [e.b.x, y0, e.b.z], [e.nx, 0, e.nz]);
  }
  return P.geometry();
}
/** A horizontal cap over an outline (with holes) at height y, or lifted by `hf(p)`, facing up (or down) */
function capRing(ring, y, { holes = [], hf = null, up = true } = {}) {
  const contour = ring.map((p) => new THREE.Vector2(p.x, p.z));
  const holeV = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.z)));
  const all = [...ring, ...holes.flat()];
  const tris = THREE.ShapeUtils.triangulateShape(contour, holeV);
  const P = new Poly();
  const Y = (p) => (hf ? hf(p) : y);
  for (const [i, j, k] of tris) {
    const a = all[i], b = all[j], c = all[k];
    P.tri([a.x, Y(a), a.z], [b.x, Y(b), b.z], [c.x, Y(c), c.z], [0, up ? 1 : -1, 0]);
  }
  return P.geometry();
}
/** A band (cornice, string course, parapet) around an outline: offset `out`, from y0 to y1, with top & underside */
function bandRing(sink, ring, y0, y1, out, mat) {
  const r = offsetRing(ring, out) || ring;
  sink.add(wallRing(r, y0, y1), mat);
  sink.add(capRing(r, y1), mat);
  if (out > 0.02 && y0 > 0.1) sink.add(capRing(r, y0, { up: false }), mat);
}
/** A strip between two outlines with the same vertex count (stadium terraces) */
function stripRings(inner, yi, outer, yo) {
  const P = new Poly();
  const n = inner.length;
  for (let i = 0; i < n; i++) {
    const a = inner[i], b = inner[(i + 1) % n], c = outer[(i + 1) % n], d = outer[i];
    P.quad([a.x, yi, a.z], [b.x, yi, b.z], [c.x, yo, c.z], [d.x, yo, d.z], [0, 1, 0]);
  }
  return P.geometry();
}

/**
 * A roof following the real outline: the outline (in the frame's local coordinates) is clipped into regions where the
 * height field is linear, each region is triangulated at its heights and skirted down to the eave along the walls.
 *   regions: [{ cuts: [[nx, nz, c], ...], hf(u, v) }]; skirtMat(edge) picks the gable material (null: no skirt)
 */
function facetRoof(sink, ring, frame, eaveY, regions, roofMat, skirtMat) {
  const local = ring.map((p) => frame.toLocal(p));
  const M = frame.matrix();
  for (const reg of regions) {
    let poly = local;
    for (const [nx, nz, c] of reg.cuts) { poly = clipPoly(poly, nx, nz, c); if (!poly.length) break; }
    if (!poly.length) continue;
    const H = (p) => Math.max(eaveY, reg.hf(p.x, p.z));
    sink.add(capRing(poly, eaveY, { hf: H }), roofMat, M);
    const P = new Map();
    for (const e of edgesOf(poly)) {
      const mat = skirtMat && skirtMat(e, H, local);
      if (!mat) continue;
      const ya = H(e.a), yb = H(e.b);
      if (Math.max(ya, yb) - eaveY < 0.02) continue;
      if (!P.has(mat)) P.set(mat, new Poly());
      P.get(mat).quad([e.a.x, eaveY, e.a.z], [e.a.x, ya, e.a.z], [e.b.x, yb, e.b.z], [e.b.x, eaveY, e.b.z], [e.nx, 0, e.nz]);
    }
    for (const [mat, poly2] of P) sink.add(poly2.geometry(), mat, M);
  }
}
const onOutline = (e, local) => distToRing(local, e.mx, e.mz) < 0.05;
/** Pitched roof along the frame's long axis (ridge at v = 0), gable skirts on the walls */
function ridgeRoof(sink, ring, frame, eaveY, rise, roofMat, wallMat) {
  const hd = frame.d / 2;
  const hf = (u, v) => eaveY + rise * (1 - Math.abs(v) / hd);
  facetRoof(sink, ring, frame, eaveY, [{ cuts: [[0, 1, 0]], hf }, { cuts: [[0, -1, 0]], hf }], roofMat, (e, H, local) => (onOutline(e, local) ? wallMat : null));
}
/** Hipped roof: four facets meeting at the centre */
function hipRoof(sink, ring, frame, eaveY, rise, roofMat, wallMat) {
  const hw = frame.w / 2, hd = frame.d / 2;
  const hf = (u, v) => eaveY + rise * (1 - Math.max(Math.abs(u) / hw, Math.abs(v) / hd));
  const regions = [];
  for (const s1 of [1, -1]) for (const s2 of [1, -1]) regions.push({ cuts: [[s1 / hw, -s1 / hd, 0], [s2 / hw, s2 / hd, 0]], hf });
  facetRoof(sink, ring, frame, eaveY, regions, roofMat, (e, H, local) => (onOutline(e, local) ? wallMat : null));
}
/** Sawtooth roof: teeth of `period` metres along the long axis, each rising `rise` to a vertical glazed face */
function sawtoothRoof(sink, ring, frame, baseY, rise, period, roofMat, glassMat, wallMat) {
  const hw = frame.w / 2;
  const regions = [];
  for (let u0 = -hw; u0 < hw - 0.5; u0 += period) {
    const u1 = Math.min(hw, u0 + period);
    regions.push({ cuts: [[1, 0, u0], [-1, 0, -u1]], hf: (u) => baseY + rise * Math.min(1, (u - u0) / period), u1 });
  }
  for (const reg of regions) {
    facetRoof(sink, ring, frame, baseY, [reg], roofMat, (e, H, local) => {
      if (Math.abs(e.mx - reg.u1) < 0.01) return glassMat; // the vertical face of the tooth
      return onOutline(e, local) ? wallMat : null;
    });
  }
}

/** Arch outlines (local XY, centred, base at y = 0): 'round', 'pointed' (equilateral) or 'parabolic' (from the base) */
function archShape(w, h, kind, spring = null) {
  const s = new THREE.Shape();
  const hw = w / 2;
  if (kind === 'parabolic') {
    s.moveTo(-hw, 0);
    for (let i = 0; i <= 16; i++) { const t = -1 + (2 * i) / 16; s.lineTo(t * hw, h * (1 - t * t)); }
    s.lineTo(hw, 0);
  } else if (kind === 'pointed') {
    // equilateral: two arcs of radius w centred on the opposite springing points
    const sp = spring ?? Math.max(0, h - 0.866 * w);
    const k = (h - sp) / (0.866 * w);
    s.moveTo(-hw, 0); s.lineTo(-hw, sp);
    for (let i = 1; i <= 8; i++) { const x = -hw + (hw * i) / 8; s.lineTo(x, sp + k * Math.sqrt(Math.max(0, w * w - (x - hw) * (x - hw)))); }
    for (let i = 1; i <= 8; i++) { const x = (hw * i) / 8; s.lineTo(x, sp + k * Math.sqrt(Math.max(0, w * w - (x + hw) * (x + hw)))); }
    s.lineTo(hw, 0);
  } else if (kind === 'flat') {
    s.moveTo(-hw, 0); s.lineTo(-hw, h); s.lineTo(hw, h); s.lineTo(hw, 0);
  } else {
    const sp = spring ?? Math.max(0, h - hw);
    const r = h - sp;
    s.moveTo(-hw, 0); s.lineTo(-hw, sp);
    for (let i = 0; i <= 12; i++) { const a = Math.PI - (Math.PI * i) / 12; s.lineTo(Math.cos(a) * hw, sp + Math.sin(a) * r); }
    s.lineTo(hw, 0);
  }
  s.closePath();
  return s;
}
/** A flat arched opening drawn just proud of a wall (dark glass with a stone surround) */
function archDecal(sink, e, s, y, w, h, kind, glassMat, trimMat, spring = null) {
  if (trimMat) sink.add(new THREE.ShapeGeometry(archShape(w + 0.36, h + 0.2, kind, spring === null ? null : spring + 0.1)), trimMat, edgeMatrix(e, s, y - 0.1, 0.03));
  sink.add(new THREE.ShapeGeometry(archShape(w, h, kind, spring)), glassMat, edgeMatrix(e, s, y, 0.05));
}
/** Arched openings spaced along the long edges of an outline */
function archesAlong(sink, ring, { minLen = 9, spacing = 5, margin = 2.5, y, w, h, kind = 'round', spring = null }, glassMat, trimMat) {
  for (const e of edgesOf(ring)) {
    if (e.len < minLen) continue;
    const n = Math.max(1, Math.floor((e.len - 2 * margin) / spacing));
    const step = (e.len - 2 * margin) / n;
    for (let i = 0; i < n; i++) archDecal(sink, e, margin + step * (i + 0.5), y, w, h, kind, glassMat, trimMat, spring);
  }
}
/**
 * An arcade replacing a wall between two heights: a pierced screen `thick` deep, the gallery's back wall `depth`
 * behind it and its ceiling. bays: number of arches; archW/archH their size; kind: see archShape
 */
function arcadeEdge(sink, e, y0, y1, { bays, archW, archH, kind = 'round', spring = null, thick = 0.5, depth = 2.4, s0 = 0, len = null, off = 0 }, mat, backMat) {
  const L = len ?? e.len;
  const H = y1 - y0;
  const screen = new THREE.Shape();
  screen.moveTo(-L / 2, 0); screen.lineTo(L / 2, 0); screen.lineTo(L / 2, H); screen.lineTo(-L / 2, H); screen.closePath();
  const bayW = L / bays;
  for (let i = 0; i < bays; i++) {
    const hole = archShape(Math.min(archW, bayW - 0.6), Math.min(archH, H - 0.4), kind, spring);
    const cx = -L / 2 + bayW * (i + 0.5);
    const path = new THREE.Path();
    hole.getPoints(1).forEach((p, k) => (k ? path.lineTo(p.x + cx, p.y) : path.moveTo(p.x + cx, p.y)));
    path.closePath();
    screen.holes.push(path);
  }
  const geo = new THREE.ExtrudeGeometry(screen, { depth: thick, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -thick);
  const M = edgeMatrix(e, s0 + L / 2, y0, off);
  sink.add(geo, mat, M);
  const P = new Poly();
  P.quad([-L / 2, 0, -depth], [L / 2, 0, -depth], [L / 2, H, -depth], [-L / 2, H, -depth], [0, 0, 1]); // back wall
  P.quad([-L / 2, H, -depth], [L / 2, H, -depth], [L / 2, H, -thick], [-L / 2, H, -thick], [0, -1, 0]); // ceiling
  P.quad([-L / 2, 0, -depth], [-L / 2, 0, -thick], [-L / 2, H, -thick], [-L / 2, H, -depth], [-1, 0, 0]);
  P.quad([L / 2, 0, -depth], [L / 2, 0, -thick], [L / 2, H, -thick], [L / 2, H, -depth], [1, 0, 0]);
  sink.add(P.geometry(), backMat, M);
}
/** The longest edge of an outline (a building's main front) */
const longestEdge = (ring) => edgesOf(ring).sort((p, q) => q.len - p.len)[0];
/** Square tower with a parapet, optional battlements & openings, centred at (x, z), turned by θ */
function tower(sink, x, z, th, size, y0, y1, mat, { merlons = false, trim = null, openings = null, glass = null } = {}) {
  const M = new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeRotationY(-th));
  sink.box(size, y1 - y0, size, mat, M.clone().multiply(new THREE.Matrix4().makeTranslation(0, (y0 + y1) / 2, 0)));
  if (trim) sink.box(size + 0.5, 0.5, size + 0.5, trim, M.clone().multiply(new THREE.Matrix4().makeTranslation(0, y1 - 0.25, 0)));
  if (merlons) {
    const n = Math.max(2, Math.round(size / 1.7));
    for (let side = 0; side < 4; side++) {
      const R = new THREE.Matrix4().makeRotationY((side * Math.PI) / 2);
      for (let i = 0; i < n; i++) {
        const t = -size / 2 + 0.45 + (i * (size - 0.9)) / Math.max(1, n - 1);
        sink.box(0.9, 1.3, 0.55, mat, M.clone().multiply(R).multiply(new THREE.Matrix4().makeTranslation(t, y1 + 0.65, size / 2 - 0.27)));
      }
    }
  }
  if (openings && glass) {
    for (let side = 0; side < 4; side++) {
      const R = M.clone().multiply(new THREE.Matrix4().makeRotationY((side * Math.PI) / 2)).multiply(new THREE.Matrix4().makeTranslation(0, openings.y, size / 2 + 0.04));
      sink.add(new THREE.ShapeGeometry(archShape(openings.w, openings.h, openings.kind || 'round')), glass, R);
    }
  }
  sink.collide(x - size * 0.72, x + size * 0.72, z - size * 0.72, z + size * 0.72, y1);
  return M;
}
/** A tapered brick chimney (round or octagonal) with a plinth and a flared crown */
function chimney(sink, x, z, h, brick, dark, round = false) {
  const rb = 1.0 + h * 0.03, rt = rb * 0.5;
  const seg = round ? 16 : 8;
  sink.box(rb * 2.6, 2.2, rb * 2.6, dark, new THREE.Matrix4().makeTranslation(x, 1.1, z));
  sink.box(rb * 2.9, 0.4, rb * 2.9, dark, new THREE.Matrix4().makeTranslation(x, 2.3, z));
  const shaftH = h - 2.5 - 1.6;
  sink.add(new THREE.CylinderGeometry(rt, rb, shaftH, seg), brick, new THREE.Matrix4().makeTranslation(x, 2.5 + shaftH / 2, z));
  sink.add(new THREE.CylinderGeometry(rt * 1.4, rt, 1.6, seg), dark, new THREE.Matrix4().makeTranslation(x, h - 0.8, z));
  sink.add(new THREE.CylinderGeometry(rt * 1.45, rt * 1.45, 0.3, seg), dark, new THREE.Matrix4().makeTranslation(x, h - 0.15, z));
  sink.collide(x - rb * 1.4, x + rb * 1.4, z - rb * 1.4, z + rb * 1.4, h);
}
/** A ribbed white dome on a low drum (Masia Freixa) */
function ribbedDome(sink, x, y, z, r, white, green) {
  sink.add(new THREE.CylinderGeometry(r + 0.25, r + 0.35, 1.1, 24), white, new THREE.Matrix4().makeTranslation(x, y + 0.55, z));
  sink.add(new THREE.TorusGeometry(r + 0.2, 0.14, 6, 28), green, new THREE.Matrix4().makeTranslation(x, y + 1.1, z).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  sink.add(new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), white, new THREE.Matrix4().makeTranslation(x, y + 1.1, z));
  const ribs = Math.max(6, Math.round(r * 2.2));
  for (let i = 0; i < ribs; i++) {
    sink.add(new THREE.TorusGeometry(r + 0.06, 0.09, 4, 14, Math.PI), white, new THREE.Matrix4().makeTranslation(x, y + 1.1, z).multiply(new THREE.Matrix4().makeRotationY((i * Math.PI) / ribs)));
  }
  sink.add(new THREE.SphereGeometry(0.32, 10, 8), green, new THREE.Matrix4().makeTranslation(x, y + 1.1 + r + 0.2, z));
}

// ---------------------------------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------------------------------
function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = GROUP_NAME;
  const sink = new Sink();

  // Plain materials
  const std = (color, roughness = 0.85, metalness = 0.0, extra = {}) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness, ...extra });
  const stonePale = std(0xd9cfb6);      // the Catedral's pale ashlar
  const stoneWarm = std(0xc8b48c);      // Romanesque sandstone of the Seu d'Ègara
  const stoneDark = std(0x8d8068, 0.92); // medieval rubble of the castle & the Torre del Palau
  const stoneTrim = std(0xe5ddcb, 0.7);  // dressed stone: bases, cornices, surrounds
  const cream = std(0xe8e0cf, 0.8);      // stucco plinths of the civic buildings
  const brick = std(0x9c5b3f, 0.9);
  const brickDark = std(0x76432f, 0.9);
  const white = std(0xf4f0e7, 0.75);
  const whiteRoof = std(0xe6e2d8, 0.85);
  const tile = std(0xa8583a, 0.9);        // terracotta
  const slate = std(0x5c6068, 0.6, 0.1);  // zinc / slate spires
  const green = std(0x2e7f5c, 0.35, 0.1); // glazed green tiles
  const glass = std(0x1a2530, 0.3, 0.5);  // dark openings
  const glassLight = std(0x7f9fb8, 0.2, 0.4); // skylights
  const steel = std(0x7c8186, 0.4, 0.7);
  const steelLight = std(0xd9dad6, 0.5, 0.3);
  const concrete = std(0xc6c1b5, 0.9);
  const concreteDark = std(0xa9a49a, 0.9);
  const pitch = std(0x3b8a3c, 0.95);
  const wood = std(0x4d3522, 0.7);
  const bronze = std(0x7d5b2d, 0.45, 0.6);
  const flagYellow = std(0xf0c020, 0.7);
  const flagRed = std(0xc8102e, 0.7);
  const clockFace = new THREE.MeshStandardNodeMaterial({ color: 0xfff6dc, emissive: 0xfff0c0, emissiveIntensity: 0.6, roughness: 0.4 });
  const dark = std(0x2b2a28, 0.6);

  // Windowed facades (world-space pre-war material: windows laid out along positionWorld). The ground floor of these
  // materials is a storefront band, so every building hides it behind a plain ground storey `floorH` tall.
  const facade = (opts) => ({ mat: createPreWarBuildingMaterial(opts), floorH: opts.floorHeight });
  const civic = facade({ stoneColor: 0xd6cbb2, trimColor: 0xa8967a, windowGlassColor: 0x16222e, windowWidth: 2.6, floorHeight: 4.2, windowRatioX: 0.46, windowRatioY: 0.62, litProbability: 0.3, warmth: 0.85, seed: 3.7 });
  const stucco = facade({ stoneColor: 0xe4d6ba, trimColor: 0xb0966e, windowGlassColor: 0x16222e, windowWidth: 2.4, floorHeight: 4.0, windowRatioX: 0.44, windowRatioY: 0.64, litProbability: 0.32, warmth: 0.85, seed: 6.6 });
  const brickFacade = facade({ stoneColor: 0x9e5e42, trimColor: 0x6f4030, windowGlassColor: 0x16222e, windowWidth: 3.2, floorHeight: 3.6, windowRatioX: 0.42, windowRatioY: 0.6, litProbability: 0.22, warmth: 0.8, seed: 8.1 });
  const hospitalTower = facade({ stoneColor: 0xe4dfd3, trimColor: 0xbbb3a4, windowGlassColor: 0x1b2a38, windowWidth: 2.0, floorHeight: 70 / 17, windowRatioX: 0.62, windowRatioY: 0.5, litProbability: 0.55, warmth: 0.6, seed: 11.3 });
  const hospitalLow = facade({ stoneColor: 0xe8e3d8, trimColor: 0xc2bbae, windowGlassColor: 0x1b2a38, windowWidth: 2.4, floorHeight: 3.5, windowRatioX: 0.6, windowRatioY: 0.52, litProbability: 0.5, warmth: 0.6, seed: 5.9 });

  const DEFAULT_HEIGHT = { church: 14, townhall: 16, civic: 16, market: 12, theatre: 15, station: 8, hospital: 21, university: 10, industrial: 10, castle: 18, museum: 14, attraction: 14, building: 12, school: 12, historic: 12, tower: 25, chimney: 30 };
  // OSM's height when it has one (a few tags are the height of a single storey: ignored below 4 m), else the model's
  const knownHeight = (s) => (s.h && s.h >= 4 ? s.h : null);
  const heightOf = (s, fallback) => knownHeight(s) || fallback || DEFAULT_HEIGHT[s.kind] || 12;

  // -------------------------------------------------------------------------------------------------------------------
  // Generic path: the real outline extruded, ground storey + windowed storeys + cornice + flat or tiled roof
  // -------------------------------------------------------------------------------------------------------------------
  function generic(s, o = {}) {
    const ring = cleanRing(s.ring);
    if (!ring) return null;
    const f = o.facade || civic;
    let h = heightOf(s, o.height);
    const baseH = f.floorH; // exactly one storey of the facade material's grid: its storefront band stays hidden
    const frame = frameOf(ring);
    const front = longestEdge(ring);
    const baseMat = o.baseMat || cream;
    const roof = o.roof || 'flat';
    const rise = o.rise || 2.5;
    const parapet = roof === 'flat' ? 1.0 : 0;
    let topY = h - parapet - (roof === 'flat' ? 0 : rise);
    if (!knownHeight(s)) {
      // an assumed height is rounded to whole storeys so the cornice never cuts through the top row of windows
      topY = baseH + Math.max(1, Math.round((topY - baseH) / f.floorH)) * f.floorH;
      h = topY + parapet + (roof === 'flat' ? 0 : rise);
    } else if (topY < baseH + 0.5) {
      topY = baseH + 0.5;
      h = topY + parapet + (roof === 'flat' ? 0 : rise);
    }
    // ground storey, with arched portals on the main front
    const portals = o.portals ?? (front.len > 14 ? 3 : 1);
    const skip = new Set();
    if (portals > 0 && front.len >= 6) {
      skip.add(front.i);
      arcadeEdge(sink, front, 0, baseH, { bays: Math.max(portals, Math.round(front.len / 7)), archW: Math.min(2.6, baseH * 0.7), archH: baseH - 0.6, kind: o.portalKind || 'round', thick: 0.6, depth: 1.4 }, baseMat, wood);
    }
    sink.add(wallRing(ring, 0, baseH, skip), baseMat);
    bandRing(sink, ring, 0, 0.3, 0.06, concreteDark); // plinth
    bandRing(sink, ring, baseH - 0.35, baseH, 0.22, stoneTrim); // string course
    // upper storeys
    sink.add(wallRing(ring, baseH, topY), f.mat);
    if (o.balcony && front.len >= 6) {
      sink.box(front.len - 2, 0.25, 1.1, stoneTrim, edgeMatrix(front, front.len / 2, baseH + 0.12, 0.55));
      sink.box(front.len - 2, 0.9, 0.08, dark, edgeMatrix(front, front.len / 2, baseH + 0.7, 1.06));
    }
    // cornice(s)
    bandRing(sink, ring, topY - 0.8, topY, 0.55, stoneTrim);
    if (o.cornice === 2) bandRing(sink, ring, topY - 1.6, topY - 1.2, 0.3, stoneTrim);
    if (roof === 'flat') {
      sink.add(capRing(ring, topY + 0.05), concrete);
      sink.add(wallRing(ring, topY, h), baseMat); // parapet
      const inner = offsetRing(ring, -0.35);
      if (inner) sink.add(wallRing(inner.slice().reverse(), topY + 0.05, h), concreteDark); // its inner face
      sink.add(capRing(offsetRing(ring, 0.1) || ring, h), stoneTrim);
      if (o.plant) {
        const c = centroidOf(ring);
        if (clearance(ring, c.x, c.z) > 7) { const lc = frame.toLocal(c); sink.box(10, 3.2, 6, concrete, frame.matrix(lc.x, h + 1.6, lc.z)); }
      }
    } else if (roof === 'hip') hipRoof(sink, ring, frame, topY, rise, o.roofMat || tile, f.mat);
    else ridgeRoof(sink, ring, frame, topY, rise, o.roofMat || tile, f.mat);
    // a corner turret (Modernista villas)
    if (o.turret) {
      const v = extremeVertex(ring, 1, 1);
      const p = insetPoint(ring, v, 3.0);
      tower(sink, p.x, p.z, frame.th, 4.2, 0, h + 3.5, baseMat, { trim: stoneTrim });
      sink.add(new THREE.ConeGeometry(3.2, 3.2, 4), tile, new THREE.Matrix4().makeTranslation(p.x, h + 5.1, p.z).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 4 - frame.th)));
    }
    sink.collideRing(ring, h, o.cell || 4);
    return { ring, frame, front, h, topY, baseH };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Bespoke models
  // -------------------------------------------------------------------------------------------------------------------
  function catedral(s) {
    // Catedral Basílica del Sant Esperit: Gothic nave & aisles on the Plaça Vella, the octagonal lantern over the
    // crossing and the 20th-century bell tower with its spire on the north-west corner
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const eave = 15;
    sink.add(wallRing(ring, 0, eave), stonePale);
    bandRing(sink, ring, 0, 0.8, 0.1, stoneTrim);
    bandRing(sink, ring, eave - 0.6, eave, 0.4, stoneTrim);
    // buttresses & lancets along the long walls
    for (const e of edgesOf(ring)) {
      if (e.len < 10) continue;
      const n = Math.max(1, Math.floor(e.len / 5.5));
      const step = e.len / n;
      for (let i = 0; i <= n; i++) {
        const t = Math.min(e.len - 0.6, Math.max(0.6, i * step));
        sink.box(0.9, 13, 1.2, stonePale, edgeMatrix(e, t, 6.5, 0.6));
        if (i < n) archDecal(sink, e, t + step / 2, 7.0, 1.4, 5.2, 'pointed', glass, stoneTrim);
      }
    }
    ridgeRoof(sink, ring, frame, eave, 5.5, tile, stonePale);
    // west front (towards the Plaça Vella): portal & rose window on the edge facing the origin
    const west = edgesOf(ring).filter((e) => e.len >= 8).sort((p, q) => Math.hypot(p.mx, p.mz) - Math.hypot(q.mx, q.mz))[0];
    if (west) {
      archDecal(sink, west, west.len / 2, 0, 3.4, 6.4, 'pointed', wood, stoneTrim);
      sink.add(new THREE.CircleGeometry(2.8, 24), stoneTrim, edgeMatrix(west, west.len / 2, 12.5, 0.03));
      sink.add(new THREE.CircleGeometry(2.3, 24), glass, edgeMatrix(west, west.len / 2, 12.5, 0.05));
    }
    // lantern over the crossing
    const c = centroidOf(ring);
    if (clearance(ring, c.x, c.z) > 6) {
      sink.add(new THREE.CylinderGeometry(5.2, 5.2, 7.5, 8), stonePale, new THREE.Matrix4().makeTranslation(c.x, eave + 1.5 + 3.75, c.z));
      sink.add(new THREE.CylinderGeometry(5.6, 5.6, 0.5, 8), stoneTrim, new THREE.Matrix4().makeTranslation(c.x, eave + 9.0, c.z));
      sink.add(new THREE.ConeGeometry(5.6, 4.2, 8), tile, new THREE.Matrix4().makeTranslation(c.x, eave + 9.25 + 2.1, c.z));
      sink.box(0.25, 2.4, 0.25, bronze, new THREE.Matrix4().makeTranslation(c.x, eave + 12.5, c.z));
    }
    // bell tower, north-west corner
    const nw = insetPoint(ring, extremeVertex(ring, -1, -1), 6.2);
    tower(sink, nw.x, nw.z, frame.th, 9.4, 0, 44, stonePale, { trim: stoneTrim, openings: { y: 35, w: 2.2, h: 6.5, kind: 'pointed' }, glass });
    sink.box(10.2, 0.9, 10.2, stoneTrim, new THREE.Matrix4().makeTranslation(nw.x, 44.45, nw.z).multiply(new THREE.Matrix4().makeRotationY(-frame.th)));
    sink.add(new THREE.ConeGeometry(4.9, 11, 8), slate, new THREE.Matrix4().makeTranslation(nw.x, 44.9 + 5.5, nw.z));
    sink.box(0.3, 2.6, 0.3, bronze, new THREE.Matrix4().makeTranslation(nw.x, 51.5, nw.z));
    sink.box(1.4, 0.3, 0.3, bronze, new THREE.Matrix4().makeTranslation(nw.x, 51.9, nw.z));
    sink.collideRing(ring, eave, 4);
  }

  function masiaFreixa(s) {
    // Masia Freixa (Lluís Muncunill, 1907-1914): the white Modernista masia in the Parc de Sant Jordi, a gallery of
    // parabolic arches round the ground floor, smaller parabolic windows above, ribbed domes on the roof and the
    // slender minaret-like tower; glazed green tile accents
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const galleryH = 4.6, roofY = 8.2;
    const skip = new Set();
    for (const e of edgesOf(ring)) {
      if (e.len < 8.5) continue;
      skip.add(e.i);
      const bays = Math.max(2, Math.round((e.len - 1.2) / 3.4));
      arcadeEdge(sink, e, 0, galleryH, { bays, archW: 2.6, archH: galleryH - 0.5, kind: 'parabolic', thick: 0.5, depth: 2.4, s0: 0.6, len: e.len - 1.2 }, white, white);
      sink.box(0.6, galleryH, 0.5, white, edgeMatrix(e, 0.3, galleryH / 2, -0.25));
      sink.box(0.6, galleryH, 0.5, white, edgeMatrix(e, e.len - 0.3, galleryH / 2, -0.25));
      // the first floor's small parabolic windows above every arch
      const step = (e.len - 1.2) / bays;
      for (let i = 0; i < bays; i++) archDecal(sink, e, 0.6 + step * (i + 0.5), galleryH + 0.8, 1.1, 2.5, 'parabolic', glass, null);
    }
    sink.add(wallRing(ring, 0, galleryH, skip), white);
    sink.add(wallRing(ring, galleryH, roofY), white);
    bandRing(sink, ring, galleryH - 0.3, galleryH, 0.18, white);
    bandRing(sink, ring, roofY, roofY + 0.4, 0.3, white);
    bandRing(sink, ring, roofY + 0.4, roofY + 0.75, 0.32, green);
    sink.add(capRing(ring, roofY + 0.1), whiteRoof);
    // domes along the long axis wherever the outline is wide enough
    const hw = frame.w / 2;
    const spots = [];
    for (let u = -hw + 3; u <= hw - 3; u += 0.5) {
      let v0 = Infinity, v1 = -Infinity;
      for (let v = -frame.d / 2; v <= frame.d / 2; v += 0.25) { const p = frame.toWorld(u, v); if (inRing(ring, p.x, p.z)) { v0 = Math.min(v0, v); v1 = Math.max(v1, v); } }
      if (v1 - v0 < 4) continue;
      const v = (v0 + v1) / 2, p = frame.toWorld(u, v);
      spots.push({ u, v, r: Math.min((v1 - v0) / 2, distToRing(ring, p.x, p.z)) - 0.6 });
    }
    const domes = [];
    const place = (rMax) => {
      let best = null;
      for (const sp of spots) {
        if (sp.r < 1.8 || domes.some((d) => Math.abs(d.u - sp.u) < d.r + Math.min(rMax, sp.r) + 1.2)) continue;
        if (!best || sp.r > best.r) best = sp;
      }
      if (!best) return;
      const r = Math.min(rMax, best.r);
      domes.push({ ...best, r });
      const p = frame.toWorld(best.u, best.v);
      ribbedDome(sink, p.x, roofY + 0.1, p.z, r, white, green);
    };
    place(5.0); place(3.0); place(3.0); place(2.4); place(2.4);
    // the tower, at the far end of the long axis
    let tp = null, tu = -Infinity;
    for (const p of ring) {
      const q = insetPoint(ring, p, 2.2);
      const u = frame.toLocal(q).x;
      if (clearance(ring, q.x, q.z) >= 1.6 && u > tu) { tu = u; tp = q; }
    }
    if (tp) {
      sink.add(new THREE.CylinderGeometry(1.5, 1.6, 19, 16), white, new THREE.Matrix4().makeTranslation(tp.x, 9.5, tp.z));
      sink.add(new THREE.TorusGeometry(1.9, 0.28, 8, 24), white, new THREE.Matrix4().makeTranslation(tp.x, 17, tp.z).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
      sink.add(new THREE.CylinderGeometry(1.15, 1.25, 2.4, 12), white, new THREE.Matrix4().makeTranslation(tp.x, 20.2, tp.z));
      for (let i = 0; i < 4; i++) sink.add(new THREE.ShapeGeometry(archShape(0.6, 1.6, 'parabolic')), glass, new THREE.Matrix4().makeTranslation(tp.x, 19.4, tp.z).multiply(new THREE.Matrix4().makeRotationY((i * Math.PI) / 2)).multiply(new THREE.Matrix4().makeTranslation(0, 0, 1.17)));
      sink.add(new THREE.ConeGeometry(1.55, 3.2, 12), green, new THREE.Matrix4().makeTranslation(tp.x, 21.4 + 1.6, tp.z));
      sink.add(new THREE.SphereGeometry(0.3, 10, 8), green, new THREE.Matrix4().makeTranslation(tp.x, 23.2, tp.z));
      sink.collide(tp.x - 1.7, tp.x + 1.7, tp.z - 1.7, tp.z + 1.7, 23);
    }
    sink.collideRing(ring, roofY + 0.75, 4);
  }

  function torrePalau(s) {
    // Torre del Palau: the 12th-century keep of the castle-palace of Terrassa, 26.7 m (OSM) on its tiny square plan
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const h = heightOf(s, 26.7);
    const size = Math.min(frame.w, frame.d);
    tower(sink, frame.cx, frame.cz, frame.th, size, 0, h - 1.3, stoneDark, { merlons: true, trim: stoneDark });
    sink.box(size + 0.4, 0.5, size + 0.4, stoneDark, frame.matrix(0, 11.5, 0));
    for (let side = 0; side < 4; side++) {
      for (const y of [9, 17]) {
        sink.add(new THREE.ShapeGeometry(archShape(0.35, 1.7, 'flat')), glass, frame.matrix().multiply(new THREE.Matrix4().makeRotationY((side * Math.PI) / 2)).multiply(new THREE.Matrix4().makeTranslation(0, y, size / 2 + 0.04)));
      }
    }
  }

  function cartoixa(s) {
    // Castell Cartoixa de Vallparadís: 12th-century castle turned Carthusian monastery, battlemented stone walls round
    // the cloister with square towers at the corners and tiled roofs behind the parapet, above the Parc de Vallparadís
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const wallH = 12;
    sink.add(wallRing(ring, 0, wallH), stoneDark);
    bandRing(sink, ring, 0, 1.0, 0.15, stoneDark);
    bandRing(sink, ring, wallH - 0.5, wallH, 0.3, stoneDark);
    for (const e of edgesOf(ring)) {
      if (e.len < 3) continue;
      const n = Math.max(1, Math.floor(e.len / 2.4));
      for (let i = 0; i < n; i++) sink.box(1.0, 1.3, 0.6, stoneDark, edgeMatrix(e, (e.len / n) * (i + 0.5), wallH + 0.65, -0.3));
    }
    archesAlong(sink, ring, { minLen: 8, spacing: 6, margin: 3, y: 6.5, w: 1.0, h: 2.2, kind: 'round' }, glass, stoneTrim);
    archesAlong(sink, ring, { minLen: 12, spacing: 6, margin: 3, y: 2.0, w: 0.9, h: 1.9, kind: 'round' }, glass, null);
    const inner = offsetRing(ring, -0.8);
    if (inner) ridgeRoof(sink, inner, frame, wallH - 0.9, 2.8, tile, stoneDark);
    else sink.add(capRing(ring, wallH - 0.5), tile);
    // corner towers at the outline's corners nearest the frame's corners; the first is the keep
    const corners = [];
    for (const [su, sv] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const target = frame.toWorld((su * frame.w) / 2, (sv * frame.d) / 2);
      let best = null, bd = 7;
      for (const p of ring) { const d = Math.hypot(p.x - target.x, p.z - target.z); if (d < bd) { bd = d; best = p; } }
      if (best && !corners.some((q) => Math.hypot(q.x - best.x, q.z - best.z) < 12)) corners.push(best);
    }
    corners.forEach((p, i) => {
      const size = i === 0 ? 7.6 : 6.2;
      const q = insetPoint(ring, p, size * 0.5);
      tower(sink, q.x, q.z, frame.th, size, 0, i === 0 ? 21 : 18, stoneDark, { merlons: true, trim: stoneDark, openings: { y: (i === 0 ? 21 : 18) - 5, w: 0.9, h: 2.0 }, glass });
    });
    sink.collideRing(ring, wallH, 4);
  }

  function mercat(s) {
    // Mercat de la Independència (1908, Antoni Pascual & Melcior Viñals): the Modernista iron-and-brick market hall,
    // tall arched windows all round, a raised central nave with a clerestory and tiled pitched roofs
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const wallH = 9.5;
    sink.add(wallRing(ring, 0, wallH), brick);
    bandRing(sink, ring, 0, 1.2, 0.12, stoneTrim);
    bandRing(sink, ring, wallH - 0.5, wallH, 0.4, brickDark);
    for (const e of edgesOf(ring)) {
      if (e.len < 10) continue;
      const n = Math.max(1, Math.floor((e.len - 2) / 4.6));
      const step = (e.len - 2) / n;
      for (let i = 0; i <= n; i++) sink.box(0.7, wallH - 1.2, 0.35, brickDark, edgeMatrix(e, 1 + i * step, 1.2 + (wallH - 1.2) / 2, 0.17));
      for (let i = 0; i < n; i++) archDecal(sink, e, 1 + step * (i + 0.5), 2.4, Math.min(2.8, step - 1.4), 5.4, 'round', glass, stoneTrim);
    }
    ridgeRoof(sink, ring, frame, wallH, 1.8, tile, brick);
    const nave = offsetRing(ring, -5.5);
    if (nave) {
      const naveFrame = frameOf(nave);
      sink.add(wallRing(nave, wallH, wallH + 4), brick);
      archesAlong(sink, nave, { minLen: 6, spacing: 3, margin: 1.5, y: wallH + 0.9, w: 1.3, h: 2.4, kind: 'round' }, glass, stoneTrim);
      bandRing(sink, nave, wallH + 3.6, wallH + 4, 0.3, brickDark);
      ridgeRoof(sink, nave, naveFrame, wallH + 4, 3.2, tile, brick);
    }
    // the main entrance: a stone frontispiece with one great arch, on the longest front
    const front = longestEdge(ring);
    if (front && front.len > 12) {
      // proud of the wall by 1 m, the doors 0.1 m in front of the brickwork behind the arch
      arcadeEdge(sink, front, 0, wallH + 1.0, { bays: 1, archW: 5.0, archH: 7.6, kind: 'round', thick: 1.0, depth: 0.9, s0: front.len / 2 - 4.5, len: 9, off: 1.0 }, stoneTrim, wood);
      const P = new Poly();
      P.tri([-4.9, wallH + 1.0, 0], [4.9, wallH + 1.0, 0], [0, wallH + 3.4, 0], [0, 0, 1]);
      P.tri([-4.9, wallH + 1.0, -1.0], [4.9, wallH + 1.0, -1.0], [0, wallH + 3.4, -1.0], [0, 0, -1]);
      P.quad([-4.9, wallH + 1.0, -1.0], [-4.9, wallH + 1.0, 0], [0, wallH + 3.4, 0], [0, wallH + 3.4, -1.0], [-0.44, 0.9, 0]);
      P.quad([4.9, wallH + 1.0, -1.0], [4.9, wallH + 1.0, 0], [0, wallH + 3.4, 0], [0, wallH + 3.4, -1.0], [0.44, 0.9, 0]);
      sink.add(P.geometry(), stoneTrim, edgeMatrix(front, front.len / 2, 0, 1.0));
    }
    sink.collideRing(ring, wallH, 4);
  }

  function townHall(s, { height, clock = true }) {
    // Ajuntament de Terrassa & the Antic Ajuntament on the Raval de Montserrat: three civic storeys, a balcony with
    // the flags over the arched portals and a gable with the clock
    const built = generic(s, { height, facade: civic, cornice: 2, balcony: true, portals: 3, plant: false });
    if (!built) return;
    const { front, h } = built;
    if (clock && front.len >= 10) {
      const gable = new THREE.Shape();
      gable.moveTo(-3.2, 0); gable.lineTo(3.2, 0); gable.lineTo(3.2, 1.6);
      for (let i = 0; i <= 12; i++) { const a = (Math.PI * i) / 12; gable.lineTo(Math.cos(a) * 3.2, 1.6 + Math.sin(a) * 2.2); }
      gable.lineTo(-3.2, 0); gable.closePath();
      const geo = new THREE.ExtrudeGeometry(gable, { depth: 0.7, bevelEnabled: false, curveSegments: 1 });
      geo.translate(0, 0, -0.7);
      sink.add(geo, stoneTrim, edgeMatrix(front, front.len / 2, h - 0.6, 0.25));
      sink.add(new THREE.CircleGeometry(1.25, 24), dark, edgeMatrix(front, front.len / 2, h + 1.2, 0.27));
      sink.add(new THREE.CircleGeometry(1.1, 24), clockFace, edgeMatrix(front, front.len / 2, h + 1.2, 0.29));
      sink.box(0.1, 0.9, 0.04, dark, edgeMatrix(front, front.len / 2, h + 1.55, 0.31));
      sink.box(0.7, 0.1, 0.04, dark, edgeMatrix(front, front.len / 2 + 0.3, h + 1.2, 0.31));
    }
    // three flag poles leaning out over the balcony, the flags hanging from their tips
    const baseY = built.baseH;
    [-2.6, 0, 2.6].forEach((dx, i) => {
      const M = edgeMatrix(front, front.len / 2 + dx, baseY + 1.1, 1.0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 3));
      sink.add(new THREE.CylinderGeometry(0.04, 0.05, 4.2, 6), steelLight, M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 2.1, 0)));
      sink.box(0.06, 1.1, 1.3, i === 1 ? flagRed : flagYellow, edgeMatrix(front, front.len / 2 + dx, baseY + 1.1 + 2.1 - 0.5, 1.0 + 3.64 - 0.6));
    });
  }

  function vapor(s) {
    // Vapor Aymerich, Amat i Jover (Lluís Muncunill, 1907-1908), today the mNACTEC: the great textile mill on the Rambla
    // d'Ègara, one single-storey hall of 11 000 m² under the sawtooth roof of parallel skylights, brick walls with arched
    // windows between pilasters and the tall brick chimney
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const wallH = 8.0;
    sink.add(wallRing(ring, 0, wallH), brick);
    bandRing(sink, ring, 0, 0.8, 0.1, stoneTrim);
    bandRing(sink, ring, wallH - 0.45, wallH, 0.3, brickDark);
    for (const e of edgesOf(ring)) {
      if (e.len < 9) continue;
      const n = Math.max(1, Math.floor(e.len / 4.5));
      const step = e.len / n;
      for (let i = 0; i <= n; i++) sink.box(0.5, wallH - 0.8, 0.3, brickDark, edgeMatrix(e, Math.min(e.len - 0.25, Math.max(0.25, i * step)), 0.8 + (wallH - 0.8) / 2, 0.15));
      for (let i = 0; i < n; i++) archDecal(sink, e, step * (i + 0.5), 2.0, Math.min(2.2, step - 1.6), 4.4, 'round', glass, brickDark);
    }
    sawtoothRoof(sink, ring, frame, wallH, 2.6, 6.0, tile, glassLight, brick);
    // the chimney at the north-east corner of the hall
    const ne = insetPoint(ring, extremeVertex(ring, 1, -1), 7);
    chimney(sink, ne.x, ne.z, 42, brick, brickDark, true);
    sink.collideRing(ring, wallH, 8);
  }

  function teatre(s) {
    // Teatre Principal (1911, Enric Catà): Modernista theatre, the auditorium under a pitched roof and the tall fly
    // tower over the stage at the far end from the front
    const built = generic(s, { height: 15, facade: stucco, cornice: 2, balcony: true, portals: 3, roof: 'ridge', rise: 2.4 });
    if (!built) return;
    const { ring, frame, front } = built;
    const uf = frame.toLocal({ x: front.mx, z: front.mz }).x;
    const dir = uf >= 0 ? -1 : 1;
    for (let u = dir * (frame.w / 2 - 7); Math.abs(u) > 2; u -= dir * 1.0) {
      const p = frame.toWorld(u, 0);
      if (clearance(ring, p.x, p.z) >= 6.5) {
        sink.box(13, 26, 12, cream, frame.matrix(u, 13, 0));
        sink.box(13.6, 0.7, 12.6, stoneTrim, frame.matrix(u, 25.65, 0));
        sink.collide(p.x - 8, p.x + 8, p.z - 8, p.z + 8, 26);
        break;
      }
    }
  }

  function santaMaria(s) {
    // Santa Maria (Seu d'Ègara): the Romanesque church (12th c.) with its lantern over the crossing and the bell tower
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const eave = 9;
    sink.add(wallRing(ring, 0, eave), stoneWarm);
    archesAlong(sink, ring, { minLen: 7, spacing: 4.5, margin: 2, y: 5.0, w: 0.7, h: 1.9, kind: 'round' }, glass, null);
    bandRing(sink, ring, eave - 0.3, eave, 0.3, stoneWarm);
    ridgeRoof(sink, ring, frame, eave, 3, tile, stoneWarm);
    const c = centroidOf(ring);
    if (clearance(ring, c.x, c.z) > 3.5) {
      sink.add(new THREE.CylinderGeometry(3.0, 3.0, 4.5, 8), stoneWarm, new THREE.Matrix4().makeTranslation(c.x, eave + 0.5 + 2.25, c.z));
      sink.add(new THREE.ConeGeometry(3.4, 2.4, 8), tile, new THREE.Matrix4().makeTranslation(c.x, eave + 5.0 + 1.2, c.z));
    }
    const nw = insetPoint(ring, extremeVertex(ring, -1, -1), 3.0);
    tower(sink, nw.x, nw.z, frame.th, 4.6, 0, 17, stoneWarm, { trim: stoneWarm, openings: { y: 13.2, w: 0.9, h: 2.0 }, glass });
    sink.add(new THREE.ConeGeometry(3.4, 2.6, 4), tile, new THREE.Matrix4().makeTranslation(nw.x, 17.25 + 1.3, nw.z).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 4 - frame.th)));
    sink.collideRing(ring, eave, 4);
  }

  function santPere(s) {
    // Sant Pere (Seu d'Ègara): the parish church, a plain Romanesque nave with the bell gable over the west end
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const eave = 8;
    sink.add(wallRing(ring, 0, eave), stoneWarm);
    archesAlong(sink, ring, { minLen: 7, spacing: 4.5, margin: 2, y: 4.5, w: 0.7, h: 1.8, kind: 'round' }, glass, null);
    bandRing(sink, ring, eave - 0.3, eave, 0.3, stoneWarm);
    ridgeRoof(sink, ring, frame, eave, 3, tile, stoneWarm);
    // the espadanya: a pierced wall with two bells on the ridge, at the west end (towards the origin: -u or +u)
    const uEnd = frame.toLocal(extremeVertex(ring, -frame.c, -frame.s)).x;
    const u = uEnd < 0 ? uEnd + 1.2 : uEnd - 1.2;
    const M = frame.matrix(u, eave + 2.6, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    const wall = new THREE.Shape();
    wall.moveTo(-1.9, 0); wall.lineTo(1.9, 0); wall.lineTo(1.9, 2.6); wall.lineTo(0, 3.4); wall.lineTo(-1.9, 2.6); wall.closePath();
    for (const dx of [-0.85, 0.85]) {
      const hole = archShape(0.9, 1.8, 'round');
      const path = new THREE.Path();
      hole.getPoints(1).forEach((p, k) => (k ? path.lineTo(p.x + dx, p.y + 0.4) : path.moveTo(p.x + dx, p.y + 0.4)));
      path.closePath();
      wall.holes.push(path);
      sink.add(new THREE.CylinderGeometry(0.22, 0.42, 0.55, 10), bronze, M.clone().multiply(new THREE.Matrix4().makeTranslation(dx, 1.5, 0)));
    }
    const geo = new THREE.ExtrudeGeometry(wall, { depth: 0.6, bevelEnabled: false, curveSegments: 1 });
    geo.translate(0, 0, -0.3);
    sink.add(geo, stoneWarm, M);
    sink.collideRing(ring, eave, 4);
  }

  function santMiquel(s) {
    // Sant Miquel (Seu d'Ègara): the Visigothic baptistery (6th-7th c.), a square chapel with a central lantern
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const eave = 7;
    sink.add(wallRing(ring, 0, eave), stoneWarm);
    archesAlong(sink, ring, { minLen: 6, spacing: 4, margin: 1.8, y: 3.8, w: 0.6, h: 1.5, kind: 'round' }, glass, null);
    hipRoof(sink, ring, frame, eave, 2.0, tile, stoneWarm);
    const c = centroidOf(ring);
    sink.add(new THREE.CylinderGeometry(2.8, 2.8, 4.6, 8), stoneWarm, new THREE.Matrix4().makeTranslation(c.x, eave + 2.3, c.z));
    for (let i = 0; i < 8; i++) sink.add(new THREE.ShapeGeometry(archShape(0.5, 1.4, 'round')), glass, new THREE.Matrix4().makeTranslation(c.x, eave + 2.4, c.z).multiply(new THREE.Matrix4().makeRotationY((i * Math.PI) / 4 + Math.PI / 8)).multiply(new THREE.Matrix4().makeTranslation(0, 0, 2.8 * Math.cos(Math.PI / 8) + 0.04)));
    sink.add(new THREE.ConeGeometry(3.2, 2.5, 8), tile, new THREE.Matrix4().makeTranslation(c.x, eave + 4.6 + 1.25, c.z));
    sink.collideRing(ring, eave, 4);
  }

  function mutua(s) {
    // Hospital Universitari Mútua de Terrassa: the 17-storey, 70 m tower on the Plaça del Doctor Robert (OSM height),
    // one of the tallest buildings in the city
    const ring = cleanRing(s.ring);
    const frame = frameOf(ring);
    const f = hospitalTower;
    // 16 windowed storeys over the ground floor: 70 m, the OSM height
    const h = knownHeight(s) || 70;
    const front = longestEdge(ring);
    sink.add(wallRing(ring, 0, f.floorH, new Set([front.i])), cream);
    arcadeEdge(sink, front, 0, f.floorH, { bays: Math.max(3, Math.round(front.len / 5)), archW: 3.4, archH: f.floorH - 0.6, kind: 'flat', thick: 0.4, depth: 2.0 }, cream, glass);
    sink.box(front.len * 0.6, 0.3, 4.5, steelLight, edgeMatrix(front, front.len / 2, f.floorH - 0.2, 2.2));
    const topY = f.floorH + Math.max(1, Math.round((h - f.floorH) / f.floorH)) * f.floorH;
    sink.add(wallRing(ring, f.floorH, topY), f.mat);
    bandRing(sink, ring, f.floorH - 0.3, f.floorH, 0.25, stoneTrim);
    bandRing(sink, ring, topY, topY + 1.1, 0.15, cream);
    sink.add(capRing(ring, topY + 0.1), concrete);
    const c = centroidOf(ring);
    if (clearance(ring, c.x, c.z) > 9) {
      const lc = frame.toLocal(c);
      sink.box(14, 4, 9, cream, frame.matrix(lc.x, topY + 2.1, lc.z));
      sink.box(0.9, 3.0, 0.9, steel, new THREE.Matrix4().makeTranslation(c.x + 3, topY + 5.6, c.z));
    }
    sink.collideRing(ring, topY + 1.1, 4);
  }

  function estadi(s) {
    // Estadi Municipal Olímpic: the 1992 Olympic hockey stadium, an oval of terraces with a roof over the main stand,
    // floodlight masts at the corners and the pitch inside. The terraces follow the outline's convex hull (the real
    // outline has a notch at the entrance that no inward offset survives)
    const ring = convexHull(cleanRing(s.ring));
    const frame = frameOf(ring);
    const offs = [-23, -17, -11, -5, -1];
    const ys = [1.6, 4.0, 6.4, 8.8, 10.4];
    const rings = offs.map((d) => shrinkRing(ring, -d));
    for (let i = 0; i + 1 < rings.length; i++) sink.add(stripRings(rings[i], ys[i], rings[i + 1], ys[i + 1]), i % 2 ? concreteDark : concrete);
    sink.add(stripRings(rings[rings.length - 1], 10.4, ring, 10.4), concrete); // the top walkway
    sink.add(wallRing(ring, 0, 11.4), concrete);
    bandRing(sink, ring, 0, 1.0, 0.1, concreteDark);
    bandRing(sink, ring, 10.4, 11.4, 0.1, concreteDark);
    sink.add(wallRing(rings[0].slice().reverse(), 0, 1.6), concreteDark); // the terrace front, seen from the pitch
    sink.add(capRing(rings[0], 0.08), pitch);
    sink.add(capRing(rings[0], 1.6, { holes: [shrinkRing(rings[0], 0.6)] }), concreteDark);
    // the canopy over the main stand (the frame's -v side)
    const cv = -(frame.d / 2 - 13.5);
    sink.box(frame.w * 0.4, 0.6, 26, steelLight, frame.matrix(0, 17.5, cv));
    sink.box(frame.w * 0.4, 1.2, 0.4, steel, frame.matrix(0, 16.6, cv + 12.8));
    const nCol = Math.round((frame.w * 0.4) / 8);
    for (let i = 0; i <= nCol; i++) {
      const u = -frame.w * 0.2 + (frame.w * 0.4 * i) / nCol;
      sink.add(new THREE.CylinderGeometry(0.35, 0.4, 17.5, 10), steel, frame.matrix(u, 8.75, cv - 12.5));
    }
    // floodlights
    for (const [su, sv] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const p = frame.toWorld(su * (frame.w / 2 - 9), sv * (frame.d / 2 - 9));
      if (!inRing(ring, p.x, p.z)) continue;
      sink.add(new THREE.CylinderGeometry(0.35, 0.5, 32, 10), steel, new THREE.Matrix4().makeTranslation(p.x, 16, p.z));
      sink.box(4.5, 2.6, 0.8, dark, frame.matrix(su * (frame.w / 2 - 9), 31, sv * (frame.d / 2 - 9)));
      sink.collide(p.x - 0.6, p.x + 0.6, p.z - 0.6, p.z + 0.6, 32);
    }
    sink.collideRing(ring, 11.4, 8, rings[0]);
  }

  function station(s) {
    // Estació del Nord (Rodalies R4) & Terrassa Est: small station buildings with a canopy over the platform on the
    // track side (the side away from the streets)
    const built = generic(s, { height: 7.4, facade: brickFacade, baseMat: cream, portals: 2, roof: 'ridge', rise: 1.8, cornice: 1 });
    if (!built) return;
    const { ring, frame } = built;
    const long = edgesOf(ring).filter((e) => e.len >= frame.w * 0.7);
    let track = null, best = -1;
    for (const e of long) {
      const near = nearestRoads(e.mx + e.nx * 12, e.mz + e.nz * 12, 60);
      const d = near.length ? near[0].dist : 999;
      if (d > best) { best = d; track = e; }
    }
    if (track) {
      const L = track.len + 10;
      sink.box(L, 0.2, 4.6, slate, edgeMatrix(track, track.len / 2, 3.9, 2.9));
      sink.box(L, 0.3, 0.15, slate, edgeMatrix(track, track.len / 2, 3.65, 5.15));
      for (let t = -L / 2 + 2; t <= L / 2 - 2; t += 5) sink.add(new THREE.CylinderGeometry(0.12, 0.12, 3.8, 8), steel, edgeMatrix(track, track.len / 2 + t, 1.9, 4.6));
    }
  }

  function carillon(s) {
    // Carrilló del mNACTEC: the slender carillon tower in the mill's grounds, a brick shaft with an open steel belfry
    const x = s.x, z = s.z;
    sink.box(2.8, 17, 2.8, brick, new THREE.Matrix4().makeTranslation(x, 8.5, z));
    sink.box(3.2, 0.4, 3.2, brickDark, new THREE.Matrix4().makeTranslation(x, 17.2, z));
    for (const dx of [-1.2, 1.2]) for (const dz of [-1.2, 1.2]) sink.box(0.25, 7, 0.25, steel, new THREE.Matrix4().makeTranslation(x + dx, 20.9, z + dz));
    sink.box(3.0, 0.3, 3.0, steel, new THREE.Matrix4().makeTranslation(x, 24.4, z));
    sink.add(new THREE.ConeGeometry(2.3, 1.6, 4), slate, new THREE.Matrix4().makeTranslation(x, 25.35, z).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 4)));
    for (const [dx, dz, r] of [[0, 0, 0.5], [0.8, 0, 0.35], [-0.8, 0, 0.35], [0, 0.8, 0.3], [0, -0.8, 0.3]]) {
      sink.add(new THREE.CylinderGeometry(r * 0.55, r, r * 1.3, 10), bronze, new THREE.Matrix4().makeTranslation(x + dx, 22.6 - r, z + dz));
    }
    sink.collide(x - 1.6, x + 1.6, z - 1.6, z + 1.6, 26);
  }

  const BESPOKE = {
    'Catedral del Sant Esperit': catedral,
    'Masia Freixa': masiaFreixa,
    'Torre del Palau': torrePalau,
    'Castell Cartoixa de Vallparadís': cartoixa,
    'Mercat de la Independència': mercat,
    'Ajuntament de Terrassa': (s) => townHall(s, { height: 14 }),
    'Antic Ajuntament de Terrassa': (s) => townHall(s, { height: 13 }),
    'Teatre Principal': teatre,
    'Santa Maria': santaMaria,
    'Sant Pere': santPere,
    'Sant Miquel': santMiquel,
    'Hospital Mútua de Terrassa': mutua,
    'Estadi Municipal Olímpic': estadi,
    'Estació de Terrassa Estació del Nord (ADIF)': station,
    'Estació de Terrassa Est': station,
    'Carrilló del mNACTEC': carillon,
    'Casa Museu Alegre de Sagrera': (s) => generic(s, { height: 14, facade: stucco, cornice: 2, balcony: true, portals: 1 }),
    'Museu Tèxtil': (s) => generic(s, { height: 14, facade: stucco, cornice: 2, portals: 3 }),
    'Gran Casino': (s) => generic(s, { height: 15, facade: stucco, cornice: 2, balcony: true, portals: 3 }),
    'Casa Baumann': (s) => generic(s, { height: 11, facade: stucco, cornice: 2, balcony: true, portals: 1, turret: true }),
    'Institut Industrial': (s) => generic(s, { height: 15, facade: civic, cornice: 2, balcony: true, portals: 3 }),
    'Hospital de Terrassa': (s) => generic(s, { height: 21, facade: hospitalLow, cornice: 1, portals: 0, plant: true, cell: 8 })
  };
  for (const n of VAPOR_NAMES) BESPOKE[n] = vapor;

  // Which sites to build: everything city-config models here, plus the mill under the museum's OSM name
  const names = new Set(MODELLED_LANDMARKS);
  if (!VAPOR_NAMES.some((n) => names.has(n))) for (const n of VAPOR_NAMES) if (LANDMARK_SITES[n]) { names.add(n); break; }
  for (const name of names) {
    const s = LANDMARK_SITES[name];
    if (!s) continue;
    const ring = s.ring ? cleanRing(s.ring) : null;
    if (s.kind === 'chimney' || /^Xemeneia/.test(name)) {
      chimney(sink, s.x, s.z, heightOf(s, 30), brick, brickDark, (s.h || 0) >= 60 || !!ring);
      continue;
    }
    const build = BESPOKE[name];
    if (build) {
      if (ring || name === 'Carrilló del mNACTEC') build({ ...s, ring }); // the outline models need an outline
    } else if (ring) {
      generic({ ...s, ring }, { facade: s.kind === 'industrial' || s.kind === 'station' ? brickFacade : civic, roof: s.kind === 'church' ? 'ridge' : 'flat' });
    }
  }

  // One mesh per material
  for (const [mat, geos] of sink.buckets) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  scene.add(group);
  return { group, colliders: sink.colliders };
}

export { buildLandmarks, GROUP_NAME as LANDMARKS_GROUP_NAME };
