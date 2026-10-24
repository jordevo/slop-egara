// Part 4: the real blocks of Terrassa ("curb islands") from the street centrelines, by rasterising every at-grade
// roadway at its curb-to-curb width over the land (the detail box), then labelling what's left. Each block: curb outline
// polygon, axis-aligned lot rects inside its property line (curb minus sidewalk), frontage frames for the blocks that
// don't follow the frame's axes, its land-use shares (park, wood, farm, industry...) and its neighbourhood.
import { geo, Raster, rdpRing, ringArea, bbox, log } from './geo-base.mjs';
import { pieces } from './geo-roads.mjs';
import { landuse, water, rail, CLS } from './geo-features.mjs';

export const SIDEWALK = 2.4; // property line in from the curb (m): Terrassa's sidewalks run 1.5-3 m
const RES = 1;

// --- Roadways that bound blocks: every at-grade (and bridge-level, see HOW_TO_IMPROVE.md §2.2) street, plus the
// railways at grade, which split blocks like streets do
const roads = pieces.filter((p) => p.bounds).map((p) => ({ x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, r: p.w / 2, name: p.name }));
for (const r of rail) {
  if (r.bridge) continue;
  for (let i = 0; i + 1 < r.pts.length; i++) roads.push({ x0: r.pts[i][0], z0: r.pts[i][1], x1: r.pts[i + 1][0], z1: r.pts[i + 1][1], r: 4, name: 'rail' });
}
log(`${roads.length} block-bounding roadway pieces`);

// --- Land: the detail box -------------------------------------------------------------------------------------------
const landRing = geo.detailBox;
const mb = bbox(landRing);
const X0 = Math.floor(mb.x0) - 4, X1 = Math.ceil(mb.x1) + 4;
const Z0 = Math.floor(mb.z0) - 4, Z1 = Math.ceil(mb.z1) + 4;
const R = new Raster(X0, Z0, X1, Z1, RES);
R.fillRing(landRing, 1);
const W = R.w, H = R.h, D = R.d;
log(`buildable raster ${W} x ${H} cells at ${RES} m`);
for (const s of roads) R.stampCapsule(s.x0, s.z0, s.x1, s.z1, s.r, 0, 1);

// --- Land-use class raster (2 m): big polygons first, smaller ones override; streams & railways stamped on top --------
const CR = 2;
const C = new Raster(X0, Z0, X1, Z1, CR);
const CI = new Raster(X0, Z0, X1, Z1, CR, Int32Array); // index + 1 of the named polygon under each cell
landuse.forEach((l, i) => {
  C.fillPolygon([l.outer, ...l.inners], l.cls);
  if (l.name) CI.fillPolygon([l.outer, ...l.inners], i + 1);
});
for (const s of water) for (let i = 0; i + 1 < s.pts.length; i++) C.stampCapsule(s.pts[i][0], s.pts[i][1], s.pts[i + 1][0], s.pts[i + 1][1], s.w / 2, CLS.WATER);
for (const r of rail) for (let i = 0; i + 1 < r.pts.length; i++) C.stampCapsule(r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1], 5, CLS.RAILWAY);

// --- Label curb islands (4-connected) --------------------------------------------------------------------------------
const lab = new Int32Array(W * H);
const comps = [];
{
  const stack = new Int32Array(Math.min(W * H, 6e7));
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!D[s0] || lab[s0]) continue;
    const id = comps.length + 1;
    let sp = 0, n = 0, i0 = W, i1 = -1, j0 = H, j1 = -1;
    stack[sp++] = s0;
    lab[s0] = id;
    while (sp) {
      const p = stack[--sp];
      n++;
      const i = p % W, j = (p - i) / W;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      if (i > 0 && D[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (i < W - 1 && D[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (j > 0 && D[p - W] && !lab[p - W]) { lab[p - W] = id; stack[sp++] = p - W; }
      if (j < H - 1 && D[p + W] && !lab[p + W]) { lab[p + W] = id; stack[sp++] = p + W; }
    }
    comps.push({ id, n, i0, i1, j0, j1, start: s0 });
  }
}
log(`${comps.length} curb islands labelled`);

// --- Contour of one component (corner walk keeping the component on the right) --------------------------------------
function traceComponent(c) {
  const at = (i, j) => (i >= 0 && j >= 0 && i < W && j < H && lab[j * W + i] === c.id ? 1 : 0);
  const si = c.start % W, sj = (c.start - si) / W;
  const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
  let cx = si, cz = sj, dir = 0;
  const pts = [];
  const start = cx + ',' + cz + ',' + dir;
  let guard = 0;
  do {
    pts.push([R.x0 + cx * RES, R.z0 + cz * RES]);
    cx += DX[dir];
    cz += DZ[dir];
    let left, right;
    if (dir === 0) { left = at(cx, cz - 1); right = at(cx, cz); }
    else if (dir === 1) { left = at(cx, cz); right = at(cx - 1, cz); }
    else if (dir === 2) { left = at(cx - 1, cz); right = at(cx - 1, cz - 1); }
    else { left = at(cx - 1, cz - 1); right = at(cx, cz - 1); }
    if (left && right) dir = (dir + 3) % 4;
    else if (!right) dir = (dir + 1) % 4;
    if (++guard > 2e7) break;
  } while (cx + ',' + cz + ',' + dir !== start);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length];
    if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q);
  }
  return destair(out, RES * 1.5);
}
// Raster stairs -> lines: short edges (stair steps) are replaced by their midpoints, true corners are kept
export function destair(out, short) {
  const n = out.length;
  const len = (i) => { const a = out[i], b = out[(i + 1) % n]; return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]); };
  const res = [];
  for (let i = 0; i < n; i++) {
    const prevLong = len((i + n - 1) % n) > short;
    const nextLong = len(i) > short;
    if (prevLong && nextLong) res.push(out[i]);
    if (!nextLong) { const a = out[i], b = out[(i + 1) % n]; res.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
  }
  return res;
}

// --- Property line: square erosion of each island by the sidewalk width ----------------------------------------------
const ER = Math.round(SIDEWALK / RES);
const prop = new Uint8Array(W * H);
{
  const tmp = new Uint8Array(W * H);
  const left = new Int32Array(W), right = new Int32Array(W);
  for (let j = 0; j < H; j++) {
    const row = j * W;
    let run = 0;
    for (let i = 0; i < W; i++) {
      const L = lab[row + i];
      run = L && i > 0 && lab[row + i - 1] === L ? run + 1 : L ? 1 : 0;
      left[i] = run;
    }
    run = 0;
    for (let i = W - 1; i >= 0; i--) {
      const L = lab[row + i];
      run = L && i < W - 1 && lab[row + i + 1] === L ? run + 1 : L ? 1 : 0;
      right[i] = run;
    }
    for (let i = 0; i < W; i++) tmp[row + i] = lab[row + i] && left[i] > ER && right[i] > ER ? 1 : 0;
  }
  const up = new Int32Array(H), dn = new Int32Array(H);
  for (let i = 0; i < W; i++) {
    let run = 0;
    for (let j = 0; j < H; j++) {
      const k = j * W + i, L = lab[k];
      run = L && j > 0 && lab[k - W] === L ? run + 1 : L ? 1 : 0;
      up[j] = run;
    }
    run = 0;
    for (let j = H - 1; j >= 0; j--) {
      const k = j * W + i, L = lab[k];
      run = L && j < H - 1 && lab[k + W] === L ? run + 1 : L ? 1 : 0;
      dn[j] = run;
    }
    for (let j = 0; j < H; j++) prop[j * W + i] = tmp[j * W + i] && up[j] > ER && dn[j] > ER ? 1 : 0;
  }
}

// --- Greedy axis-aligned rects in a 0/1 mask (largest rectangle in a histogram), cleared as it goes -------------------
// Up to maxRects rects [i0, i1, j0, j1] (cells, inclusive) of at least minSide x minSide cells and minArea cells, until
// `cover` of the mask is covered
export function maskRects(m, w, h, maxRects = 8, minSide = 8, minArea = 120, cover = 0.93) {
  let total = 0;
  for (let k = 0; k < w * h; k++) total += m[k];
  const rects = [];
  const hist = new Int32Array(w);
  const stack = new Int32Array(w + 1);
  let covered = 0;
  for (let it = 0; it < maxRects; it++) {
    hist.fill(0);
    let best = 0, bi0 = 0, bi1 = 0, bj0 = 0, bj1 = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) hist[i] = m[j * w + i] ? hist[i] + 1 : 0;
      let sp = 0;
      for (let i = 0; i <= w; i++) {
        const hh = i < w ? hist[i] : 0;
        while (sp && hist[stack[sp - 1]] >= hh) {
          const top = stack[--sp];
          const height = hist[top];
          const left = sp ? stack[sp - 1] + 1 : 0;
          const width = i - left;
          if (height >= minSide && width >= minSide) {
            const area = height * width;
            if (area > best) { best = area; bi0 = left; bi1 = i - 1; bj0 = j - height + 1; bj1 = j; }
          }
        }
        stack[sp++] = i;
      }
    }
    if (best < minArea || (rects.length && best < total * 0.06)) break;
    rects.push([bi0, bi1, bj0, bj1]);
    covered += best;
    for (let j = bj0; j <= bj1; j++) for (let i = bi0; i <= bi1; i++) m[j * w + i] = 0;
    if (covered > total * cover) break;
  }
  return { rects, total, covered };
}
function lotRects(c, maxRects = 8) {
  const w = c.i1 - c.i0 + 1, h = c.j1 - c.j0 + 1;
  const m = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (c.j0 + j) * W + c.i0 + i;
    if (prop[k] && lab[k] === c.id) m[j * w + i] = 1;
  }
  const { rects, total, covered } = maskRects(m, w, h, maxRects);
  return {
    rects: rects.map(([i0, i1, j0, j1]) => [R.x0 + (c.i0 + i0) * RES, R.x0 + (c.i0 + i1 + 1) * RES, R.z0 + (c.j0 + j0) * RES, R.z0 + (c.j0 + j1 + 1) * RES]),
    propArea: total,
    covered
  };
}

// --- Frontage frames of islands that don't follow the frame's axes (the old town, the Rambla, the outer barris) -----
// (unchanged from the original: see the comment there) Returns [[θ, px, pz, rects], ...] with
// world = p + R_y(θ)·(local − p), or null for an island fronting the grid alone.
const DEG = Math.PI / 180;
const wrap90 = (a) => ((((a + Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4;
function blockFrames(c, poly) {
  const edges = [];
  let per = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    edges.push({ ax, az, bx, bz, L, phi: wrap90(Math.atan2(bz - az, bx - ax)), k: -1 });
    per += L;
  }
  const clusters = [];
  for (let n = 0; n < 3; n++) {
    let seed = null, seedW = 0;
    for (const e of edges) {
      if (e.k >= 0 || e.L < 4) continue;
      let w = 0;
      for (const f of edges) if (f.k < 0 && Math.abs(wrap90(f.phi - e.phi)) <= 7 * DEG) w += f.L;
      if (w > seedW) { seedW = w; seed = e; }
    }
    if (!seed || seedW < 14 || (n > 0 && seedW < per * 0.12)) break;
    const members = edges.filter((f) => f.k < 0 && Math.abs(wrap90(f.phi - seed.phi)) <= 7 * DEG);
    let sx = 0, sy = 0;
    for (const f of members) { sx += f.L * Math.cos(4 * f.phi); sy += f.L * Math.sin(4 * f.phi); }
    for (const f of members) f.k = clusters.length;
    clusters.push({ phi: Math.atan2(sy, sx) / 4 });
  }
  if (!clusters.length || (clusters.length === 1 && Math.abs(clusters[0].phi) < 2 * DEG)) return null;
  for (const e of edges) {
    if (e.k >= 0) continue;
    let bd = Infinity;
    clusters.forEach((cl, k) => { const d = Math.abs(wrap90(e.phi - cl.phi)); if (d < bd) { bd = d; e.k = k; } });
  }
  const w = c.i1 - c.i0 + 1, h = c.j1 - c.j0 + 1;
  const owner = new Int8Array(w * h).fill(-1);
  for (let j = 0; j < h; j++) {
    const pz = R.z0 + (c.j0 + j + 0.5) * RES;
    for (let i = 0; i < w; i++) {
      if (lab[(c.j0 + j) * W + c.i0 + i] !== c.id) continue;
      if (clusters.length === 1) { owner[j * w + i] = 0; continue; }
      const px = R.x0 + (c.i0 + i + 0.5) * RES;
      let bd = Infinity, bk = 0;
      for (const e of edges) {
        const dx = e.bx - e.ax, dz = e.bz - e.az;
        let t = ((px - e.ax) * dx + (pz - e.az) * dz) / (e.L * e.L);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = e.ax + t * dx - px, ez = e.az + t * dz - pz;
        const d = ex * ex + ez * ez;
        if (d < bd) { bd = d; bk = e.k; }
      }
      owner[j * w + i] = bk;
    }
  }
  const px = R.x0 + ((c.i0 + c.i1 + 1) * RES) / 2;
  const pz = R.z0 + ((c.j0 + c.j1 + 1) * RES) / 2;
  const views = clusters.map((cl, k) => {
    const th = -cl.phi;
    const cs = Math.cos(th), sn = Math.sin(th);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of [[c.i0, c.j0], [c.i1 + 1, c.j0], [c.i0, c.j1 + 1], [c.i1 + 1, c.j1 + 1]]) {
      const dx = R.x0 + x * RES - px, dz = R.z0 + z * RES - pz;
      const u = px + dx * cs - dz * sn, v = pz + dx * sn + dz * cs;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    u0 = Math.floor(u0); v0 = Math.floor(v0);
    const lw = Math.ceil(u1 - u0) + 1, lh = Math.ceil(v1 - v0) + 1;
    const isl = new Uint8Array(lw * lh);
    const reg = new Uint8Array(lw * lh);
    const cell = new Int32Array(lw * lh).fill(-1);
    for (let j = 0; j < lh; j++) {
      const dv = v0 + j + 0.5 - pz;
      for (let i = 0; i < lw; i++) {
        const du = u0 + i + 0.5 - px;
        const x = px + du * cs + dv * sn, z = pz - du * sn + dv * cs;
        const gi = Math.floor((x - R.x0) / RES) - c.i0, gj = Math.floor((z - R.z0) / RES) - c.j0;
        if (gi < 0 || gj < 0 || gi >= w || gj >= h) continue;
        const o = owner[gj * w + gi];
        if (o < 0) continue;
        isl[j * lw + i] = 1;
        cell[j * lw + i] = gj * w + gi;
        if (o === k) reg[j * lw + i] = 1;
      }
    }
    const tmp = new Uint8Array(lw * lh);
    for (let j = 0; j < lh; j++) {
      let run = 0;
      const left = new Int32Array(lw);
      for (let i = 0; i < lw; i++) { run = isl[j * lw + i] ? run + 1 : 0; left[i] = run; }
      run = 0;
      for (let i = lw - 1; i >= 0; i--) { run = isl[j * lw + i] ? run + 1 : 0; tmp[j * lw + i] = left[i] > ER && run > ER ? 1 : 0; }
    }
    const prop = new Uint8Array(lw * lh);
    for (let i = 0; i < lw; i++) {
      let run = 0;
      const up = new Int32Array(lh);
      for (let j = 0; j < lh; j++) { run = isl[j * lw + i] ? run + 1 : 0; up[j] = run; }
      run = 0;
      for (let j = lh - 1; j >= 0; j--) {
        run = isl[j * lw + i] ? run + 1 : 0;
        prop[j * lw + i] = tmp[j * lw + i] && up[j] > ER && run > ER ? 1 : 0;
      }
    }
    return { th, u0, v0, lw, lh, prop, reg, cell, rects: [] };
  });
  const used = new Uint8Array(w * h);
  const markUsed = (k) => {
    const gi = k % w, gj = (k - gi) / w;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = gi + di, j = gj + dj;
      if (i >= 0 && j >= 0 && i < w && j < h) used[j * w + i] = 1;
    }
  };
  for (const pass of [1, 2]) {
    for (const vw of views) {
      const { lw, lh, prop, reg, cell } = vw;
      const m = new Uint8Array(lw * lh);
      for (let k = 0; k < lw * lh; k++) m[k] = prop[k] && (pass === 2 || reg[k]) && cell[k] >= 0 && !used[cell[k]] ? 1 : 0;
      const { rects } = maskRects(m, lw, lh, pass === 1 ? 6 : 4, 10);
      for (const [i0, i1, j0, j1] of rects) {
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (cell[j * lw + i] >= 0) markUsed(cell[j * lw + i]);
        vw.rects.push([vw.u0 + i0, vw.u0 + i1 + 1, vw.v0 + j0, vw.v0 + j1 + 1]);
      }
    }
  }
  const frames = views.filter((vw) => vw.rects.length).map((vw) => [vw.th, px, pz, vw.rects]);
  return frames.length ? frames : null;
}

// --- Land-use shares of a component ------------------------------------------------------------------------------------
function landUseOf(c) {
  const counts = new Float64Array(16);
  const names = new Map();
  let n = 0;
  for (let j = c.j0; j <= c.j1; j++) {
    for (let i = c.i0; i <= c.i1; i++) {
      if (lab[j * W + i] !== c.id) continue;
      n++;
      const x = R.x0 + (i + 0.5) * RES, z = R.z0 + (j + 0.5) * RES;
      const cls = C.at(x, z);
      counts[cls]++;
      if (cls) {
        const id = CI.at(x, z);
        if (id) names.set(id, (names.get(id) || 0) + 1);
      }
    }
  }
  let dom = 0;
  for (let k = 1; k < 16; k++) if (counts[k] > counts[dom]) dom = k;
  let bestName = '', bestN = 0;
  for (const [id, m] of names) if (m > bestN) { bestN = m; bestName = landuse[id - 1].name; }
  const share = (k) => counts[k] / n;
  const green = share(CLS.PARK) + share(CLS.PLAZA) + share(CLS.GRASS) + share(CLS.CEMETERY);
  return { cls: dom, clsShare: counts[dom] / n, park: green, parkName: bestN > n * 0.3 ? bestName : '', shares: Array.from(counts, (v) => Math.round((v / n) * 100) / 100) };
}
const BUILDABLE = new Set([CLS.NONE, CLS.INDUSTRIAL, CLS.CAMPUS, CLS.PARKING, CLS.GRASS, CLS.SPORTS]);

// --- Assemble blocks ---------------------------------------------------------------------------------------------------
const blocks = [];
let small = 0;
for (const c of comps) {
  const area = c.n * RES * RES;
  if (area < 40) { small++; continue; }
  let poly = traceComponent(c);
  poly = rdpRing(poly, 0.5);
  if (poly.length < 3) continue;
  if (ringArea(poly) > 0) poly.reverse();
  const bw = (c.i1 - c.i0 + 1) * RES, bd = (c.j1 - c.j0 + 1) * RES;
  const rectness = area / (bw * bd);
  const lu = landUseOf(c);
  const buildable = BUILDABLE.has(lu.cls) || lu.clsShare < 0.5;
  const { rects, propArea, covered } = area >= 200 && buildable && area < 600000 ? lotRects(c) : { rects: [], propArea: 0, covered: 0 };
  const frames = rectness <= 0.985 && area >= 200 && buildable && area < 150000 && lu.park < 0.6 ? blockFrames(c, poly) : null;
  blocks.push({
    id: blocks.length,
    label: c.id, // its component id in the label raster (geo-buildings.mjs)
    poly,
    area: Math.round(area),
    bbox: [R.x0 + c.i0 * RES, R.x0 + (c.i1 + 1) * RES, R.z0 + c.j0 * RES, R.z0 + (c.j1 + 1) * RES],
    rect: rectness > 0.985,
    rects,
    frames,
    propArea,
    fill: propArea ? Math.round((covered / propArea) * 100) / 100 : 0,
    ...lu,
    buildings: []
  });
}
log(`${blocks.length} blocks (${blocks.filter((b) => b.rect).length} rectangular, ${blocks.filter((b) => !b.rects.length).length} without lots, ${blocks.filter((b) => b.frames).length} with frontage frames); ${small} specks dropped`);
{
  const byCls = {};
  for (const b of blocks) byCls[b.cls] = (byCls[b.cls] || 0) + 1;
  log(`blocks by dominant land use: ${JSON.stringify(byCls)}`);
}

export { blocks, landRing, roads, R as blockRaster, lab as blockLabels, W as rasterW };
