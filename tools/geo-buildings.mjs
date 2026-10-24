// Part 5: the real building footprints of Terrassa (OpenStreetMap, partial coverage: see HOW_TO_IMPROVE.md §2.5) as
// boxes the facade engine can build: each footprint is turned to its own dominant wall direction and decomposed into
// axis-aligned rectangles there (≤ 0.25 m error), with its storeys / height when OSM knows them, its kind and roof.
// Every building is attached to the block (curb island) it stands on.
import { Raster, ringArea, bbox, centroid, load, log, elemPolygons, num } from './geo-base.mjs';
import { blocks, blockRaster, blockLabels, rasterW, maskRects } from './geo-blocks.mjs';

// Building kinds (codes shared with the runtime)
export const BKIND = { GENERIC: 0, HOUSE: 1, APARTMENTS: 2, INDUSTRIAL: 3, COMMERCIAL: 4, SCHOOL: 5, CHURCH: 6, PUBLIC: 7, LOW: 8 };
function kindOf(t) {
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
const ROOF = { flat: 0, gabled: 1, hipped: 2, skillion: 3, pyramidal: 2, half_hipped: 2, gambrel: 1, mansard: 2, dome: 4, round: 1 };

const osm = load('osm_buildings.json');
const RES = 0.5;
const wrap90 = (a) => ((((a + Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4;
let total = 0, placed = 0, tiny = 0, offBlock = 0, noRect = 0;
const W = rasterW;
const labelAt = (x, z) => {
  const i = Math.floor((x - blockRaster.x0) / blockRaster.res), j = Math.floor((z - blockRaster.z0) / blockRaster.res);
  return i >= 0 && j >= 0 && i < blockRaster.w && j < blockRaster.h ? blockLabels[j * W + i] : 0;
};
const blockById = new Map(); // raster label -> block (labels are 1-based component ids; blocks keep their own ids)
// blocks were pushed in component order but specks were dropped: rebuild the mapping by looking up each block's first
// lot / centroid cell
for (const b of blocks) {
  const [cx, cz] = centroid(b.poly);
  let id = labelAt(cx, cz);
  if (!id) for (const [x0, x1, z0, z1] of b.rects) { id = labelAt((x0 + x1) / 2, (z0 + z1) / 2); if (id) break; }
  if (!id) {
    // sample the outline just inside its edges
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

for (const e of osm.elements) {
  const t = e.tags || {};
  if (!t.building || t['building:part']) continue;
  for (const poly of elemPolygons(e)) {
    const outer = poly.outer;
    if (outer.length < 3) continue;
    const area = Math.abs(ringArea(outer));
    total++;
    if (area < 18) { tiny++; continue; }
    // dominant wall direction (length-weighted, mod 90°) -> the building's own frame
    let sx = 0, sy = 0;
    for (let i = 0; i < outer.length; i++) {
      const [ax, az] = outer[i], [bx, bz] = outer[(i + 1) % outer.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.3) continue;
      const phi = wrap90(Math.atan2(bz - az, bx - ax));
      sx += L * Math.cos(4 * phi);
      sy += L * Math.sin(4 * phi);
    }
    const phi = Math.atan2(sy, sx) / 4;
    const th = -phi;
    const cs = Math.cos(th), sn = Math.sin(th);
    const [cx, cz] = centroid(outer);
    const toLocal = ([x, z]) => [(x - cx) * cs - (z - cz) * sn, (x - cx) * sn + (z - cz) * cs];
    const rings = [outer, ...poly.inners].map((r) => r.map(toLocal));
    const bb = bbox(rings[0]);
    const ras = new Raster(bb.x0 - RES, bb.z0 - RES, bb.x1 + RES, bb.z1 + RES, RES);
    ras.fillPolygon(rings, 1);
    const minSide = area < 60 ? 3 : 4; // 1.5 / 2 m
    const { rects } = maskRects(ras.d, ras.w, ras.h, area > 2000 ? 10 : 6, minSide, area < 60 ? 16 : 40, 0.94);
    if (!rects.length) { noRect++; continue; }
    const local = rects.map(([i0, i1, j0, j1]) => [ras.x0 + i0 * RES, ras.x0 + (i1 + 1) * RES, ras.z0 + j0 * RES, ras.z0 + (j1 + 1) * RES].map((v) => Math.round(v * 10) / 10));
    // the block it stands on: the label under its centroid, else under most of its rects
    const toWorldXZ = (u, v) => [cx + u * cs + v * sn, cz - u * sn + v * cs];
    const votes = new Map();
    const vote = (x, z, w) => { const id = labelAt(x, z); if (id) votes.set(id, (votes.get(id) || 0) + w); };
    vote(cx, cz, 2);
    for (const [u0, u1, v0, v1] of local) vote(...toWorldXZ((u0 + u1) / 2, (v0 + v1) / 2), (u1 - u0) * (v1 - v0) / 20);
    let best = 0, bestW = 0;
    for (const [id, w] of votes) if (w > bestW) { bestW = w; best = id; }
    const block = blockById.get(best);
    if (!block) { offBlock++; continue; }
    const levels = parseInt(t['building:levels'] || '0', 10) || 0;
    let h = num(t.height);
    if (!(h > 0)) h = 0;
    const roof = ROOF[t['roof:shape']] ?? -1;
    block.buildings.push([Math.round(th * 1e4) / 1e4, Math.round(cx * 10) / 10, Math.round(cz * 10) / 10, levels, Math.round(h * 10) / 10, kindOf(t), roof, local, Math.round(area)]);
    placed++;
  }
}
for (const b of blocks) {
  const covered = b.buildings.reduce((s, bd) => s + bd[8], 0);
  b.cover = b.propArea ? Math.min(1, Math.round((covered / b.propArea) * 100) / 100) : 0;
}
const withBuildings = blocks.filter((b) => b.buildings.length).length;
const wellCovered = blocks.filter((b) => b.cover >= 0.4).length;
log(`buildings: ${placed} of ${total} footprints placed on ${withBuildings} blocks (${wellCovered} blocks ≥ 40 % covered); ${tiny} tiny, ${noRect} too thin, ${offBlock} off any block`);
export { blocks };
