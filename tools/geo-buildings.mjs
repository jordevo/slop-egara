// Part 5: the real buildings of Terrassa as boxes the facade engine can build. Primary source: the Dirección General
// del Catastro's INSPIRE Buildings dataset (tools/data/terrassa/catastro.json, from tools/catastro-to-json.py): every
// cadastral building (25 880) with its parts (101 848 footprints, each with its storeys above ground), its use, its
// year of construction and its dwellings. OpenStreetMap footprints (osm_buildings.json, partial coverage) only fill
// the blocks where the Catastro has nothing. Every building is turned to its own dominant wall direction and each part
// decomposed into axis-aligned rectangles there (≤ 0.25 m error), then attached to the block (curb island) it stands on.
import { Raster, ringArea, bbox, centroid, load, log, elemPolygons, num, toWorld, geo } from './geo-base.mjs';
import { blocks, blockRaster, blockLabels, rasterW, maskRects } from './geo-blocks.mjs';

// Building kinds (codes shared with the runtime)
export const BKIND = { GENERIC: 0, HOUSE: 1, APARTMENTS: 2, INDUSTRIAL: 3, COMMERCIAL: 4, SCHOOL: 5, CHURCH: 6, PUBLIC: 7, LOW: 8 };
function kindOfOsm(t) {
  const b = t.building || 'yes';
  if (/^(house|detached|terrace|semidetached_house|residential|bungalow|farm)$/.test(b)) return BKIND.HOUSE;
  if (/^(apartments|dormitory)$/.test(b)) return BKIND.APARTMENTS;
  if (/^(industrial|warehouse|manufacture|factory)$/.test(b)) return BKIND.INDUSTRIAL;
  if (/^(retail|commercial|office|supermarket|hotel)$/.test(b)) return BKIND.COMMERCIAL;
  if (/^(school|university|college|kindergarten)$/.test(b) || /^(school|university|college|kindergarten)$/.test(t.amenity || '')) return BKIND.SCHOOL;
  if (/^(church|cathedral|chapel|monastery|convent)$/.test(b) || t.amenity === 'place_of_worship') return BKIND.CHURCH;
  if (/^(public|civic|government|hospital|train_station|transportation|fire_station|sports_hall|sports_centre|stadium)$/.test(b) || /^(hospital|townhall|library|courthouse|police|theatre)$/.test(t.amenity || '')) return BKIND.PUBLIC;
  if (/^(shed|roof|garage|garages|carport|hut|service|farm_auxiliary|greenhouse|construction|ruins|kiosk)$/.test(b)) return BKIND.LOW;
  return BKIND.GENERIC;
}
// Catastro currentUse codes (tools/catastro-to-json.py USE_CODE): 1 residential, 2 agriculture, 3 industrial,
// 4 office, 5 retail, 6 public services
function kindOfCatastro(b) {
  if (b.use === 1) return b.dwellings >= 3 ? BKIND.APARTMENTS : BKIND.HOUSE;
  if (b.use === 3) return BKIND.INDUSTRIAL;
  if (b.use === 4 || b.use === 5) return BKIND.COMMERCIAL;
  if (b.use === 6) return BKIND.PUBLIC;
  if (b.use === 2) return BKIND.LOW;
  return BKIND.GENERIC;
}
const ROOF = { flat: 0, gabled: 1, hipped: 2, skillion: 3, pyramidal: 2, half_hipped: 2, gambrel: 1, mansard: 2, dome: 4, round: 1 };

const RES = 0.5;
const wrap90 = (a) => ((((a + Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4;
const W = rasterW;
const labelAt = (x, z) => {
  const i = Math.floor((x - blockRaster.x0) / blockRaster.res), j = Math.floor((z - blockRaster.z0) / blockRaster.res);
  return i >= 0 && j >= 0 && i < blockRaster.w && j < blockRaster.h ? blockLabels[j * W + i] : 0;
};
// raster label -> block (specks were dropped, so look each block up by a cell inside it)
const blockById = new Map();
for (const b of blocks) {
  const [cx, cz] = centroid(b.poly);
  let id = labelAt(cx, cz);
  if (!id) for (const [x0, x1, z0, z1] of b.rects) { id = labelAt((x0 + x1) / 2, (z0 + z1) / 2); if (id) break; }
  if (!id) {
    for (let i = 0; i < b.poly.length && !id; i++) {
      const p = b.poly[i], q = b.poly[(i + 1) % b.poly.length];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      const nx = -(q[1] - p[1]), nz = q[0] - p[0];
      const L = Math.hypot(nx, nz) || 1;
      id = labelAt(mx + (nx / L) * 0.7, mz + (nz / L) * 0.7) || labelAt(mx - (nx / L) * 0.7, mz - (nz / L) * 0.7);
    }
  }
  if (id && !blockById.has(id)) blockById.set(id, b);
}

// Dominant wall direction (length-weighted, mod 90°) of a set of rings -> the frame angle θ (world = c + R_y(θ)·local)
function frameAngle(rings) {
  let sx = 0, sy = 0;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.3) continue;
      const phi = wrap90(Math.atan2(bz - az, bx - ax));
      sx += L * Math.cos(4 * phi);
      sy += L * Math.sin(4 * phi);
    }
  }
  return -Math.atan2(sy, sx) / 4;
}
// Axis-aligned rects (local metres about (cx, cz)) covering a polygon (outer + holes) in the frame θ
function boxes(polys, th, cx, cz, area) {
  const cs = Math.cos(th), sn = Math.sin(th);
  const toLocal = ([x, z]) => [(x - cx) * cs - (z - cz) * sn, (x - cx) * sn + (z - cz) * cs];
  const rings = polys.map((r) => r.map(toLocal));
  const bb = bbox(rings[0]);
  const ras = new Raster(bb.x0 - RES, bb.z0 - RES, bb.x1 + RES, bb.z1 + RES, RES);
  ras.fillPolygon(rings, 1);
  const minSide = area < 60 ? 3 : 4; // 1.5 / 2 m
  const { rects } = maskRects(ras.d, ras.w, ras.h, area > 2000 ? 10 : 6, minSide, area < 60 ? 16 : 40, 0.94);
  return rects.map(([i0, i1, j0, j1]) => [ras.x0 + i0 * RES, ras.x0 + (i1 + 1) * RES, ras.z0 + j0 * RES, ras.z0 + (j1 + 1) * RES].map((v) => Math.round(v * 10) / 10));
}
// The block under a building: the label under its centroid, else under most of its rects (area-weighted votes)
function blockOf(cx, cz, th, rects) {
  const cs = Math.cos(th), sn = Math.sin(th);
  const votes = new Map();
  const vote = (x, z, w) => { const id = labelAt(x, z); if (id) votes.set(id, (votes.get(id) || 0) + w); };
  vote(cx, cz, 2);
  for (const [u0, u1, v0, v1] of rects) {
    const u = (u0 + u1) / 2, v = (v0 + v1) / 2;
    vote(cx + u * cs + v * sn, cz - u * sn + v * cs, ((u1 - u0) * (v1 - v0)) / 20);
  }
  let best = 0, bestW = 0;
  for (const [id, w] of votes) if (w > bestW) { bestW = w; best = id; }
  return blockById.get(best) || null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Catastro: one building per cadastral reference, its parts as rects with their own storeys
//   entry: [θ, cx, cz, storeys (max), height (0: unknown), kind, roof (-1: unknown), rects [u0, u1, v0, v1, storeys],
//          footprint area, year, use, dwellings, cadastral reference]
// ---------------------------------------------------------------------------------------------------------------------
let catastro = null;
try { catastro = load('catastro.json').buildings; } catch (err) { log(`no catastro.json (${err.message.split('\n')[0]}): buildings from OpenStreetMap only`); }
let placedC = 0, totalC = 0, offBlockC = 0, tinyC = 0, ruinsC = 0;
if (catastro) {
  for (const [ref, b] of Object.entries(catastro)) {
    totalC++;
    if (b.condition === 'ruin' || b.condition === 'declined' || b.condition === 'demolished') { ruinsC++; continue; }
    const parts = [];
    for (const p of b.parts) {
      const rings = p.rings.map((flat) => { const r = []; for (let i = 0; i < flat.length; i += 2) r.push(toWorld(flat[i], flat[i + 1])); return r; });
      if (rings[0].length < 3) continue;
      const area = Math.abs(ringArea(rings[0]));
      if (area < 6) continue;
      parts.push({ rings, area, floors: p.floors });
    }
    if (!parts.length) continue;
    const built = parts.filter((p) => p.floors > 0);
    const useParts = built.length ? built : parts; // floors 0: open courts, terraces, porches -> a plinth
    const area = useParts.reduce((s, p) => s + p.area, 0);
    if (area < 12) { tinyC++; continue; }
    // one frame for the whole building, about the area-weighted centroid of its parts
    let cx = 0, cz = 0;
    for (const p of useParts) { const [x, z] = centroid(p.rings[0]); cx += x * p.area; cz += z * p.area; }
    cx /= area; cz /= area;
    const th = frameAngle(useParts.map((p) => p.rings[0]));
    const rects = [];
    for (const p of useParts) {
      for (const r of boxes(p.rings, th, cx, cz, p.area)) rects.push([...r, p.floors]);
    }
    if (!rects.length) { tinyC++; continue; }
    const block = blockOf(cx, cz, th, rects);
    if (!block) { offBlockC++; continue; }
    const storeys = Math.max(...useParts.map((p) => p.floors));
    block.buildings.push([Math.round(th * 1e4) / 1e4, Math.round(cx * 10) / 10, Math.round(cz * 10) / 10, storeys, 0, kindOfCatastro(b), -1, rects, Math.round(area), b.year || 0, b.use || 0, b.dwellings || 0, ref]);
    placedC++;
  }
  log(`Catastro: ${placedC} of ${totalC} buildings placed (${offBlockC} off any block, ${tinyC} tiny, ${ruinsC} ruins)`);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenStreetMap footprints: only on blocks the Catastro left empty (and their kinds / roof shapes where it did not)
// ---------------------------------------------------------------------------------------------------------------------
const osm = load('osm_buildings.json');
let placedO = 0, totalO = 0;
const catastroBlocks = new Set(blocks.filter((b) => b.buildings.length).map((b) => b.id));
for (const e of osm.elements) {
  const t = e.tags || {};
  if (!t.building || t['building:part']) continue;
  for (const poly of elemPolygons(e)) {
    const outer = poly.outer;
    if (outer.length < 3) continue;
    const area = Math.abs(ringArea(outer));
    totalO++;
    if (area < 18) continue;
    const th = frameAngle([outer]);
    const [cx, cz] = centroid(outer);
    const rects = boxes([outer, ...poly.inners], th, cx, cz, area);
    if (!rects.length) continue;
    const block = blockOf(cx, cz, th, rects);
    if (!block || catastroBlocks.has(block.id)) continue;
    const levels = parseInt(t['building:levels'] || '0', 10) || 0;
    let h = num(t.height);
    if (!(h > 0)) h = 0;
    block.buildings.push([Math.round(th * 1e4) / 1e4, Math.round(cx * 10) / 10, Math.round(cz * 10) / 10, levels, Math.round(h * 10) / 10, kindOfOsm(t), ROOF[t['roof:shape']] ?? -1, rects.map((r) => [...r, levels]), Math.round(area), 0, 0, 0, '']);
    placedO++;
  }
}
log(`OpenStreetMap: ${placedO} of ${totalO} footprints placed on blocks without Catastro buildings`);

for (const b of blocks) {
  const covered = b.buildings.reduce((s, bd) => s + bd[8], 0);
  b.cover = b.propArea ? Math.min(1, Math.round((covered / b.propArea) * 100) / 100) : 0;
}
const withBuildings = blocks.filter((b) => b.buildings.length).length;
const wellCovered = blocks.filter((b) => b.cover >= 0.4).length;
const totalBoxes = blocks.reduce((s, b) => s + b.buildings.reduce((t, bd) => t + bd[7].length, 0), 0);
log(`buildings on ${withBuildings} blocks (${wellCovered} blocks ≥ 40 % covered), ${totalBoxes} boxes`);
export { blocks };
