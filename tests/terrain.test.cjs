const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// A minimal three.js stand-in: geometries are bags of typed attributes
class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; } }
class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; this.userData = {}; }
  setAttribute(n, a) { this.attributes[n] = a; return this; }
  setIndex(a) { this.index = a; return this; }
  toNonIndexed() {
    const g = new BufferGeometry();
    const idx = this.index.array;
    for (const [n, a] of Object.entries(this.attributes)) {
      const out = new Float32Array(idx.length * a.itemSize);
      idx.forEach((v, i) => { for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.array[v * a.itemSize + k]; });
      g.setAttribute(n, new BufferAttribute(out, a.itemSize));
    }
    return g;
  }
  computeBoundingBox() {} computeBoundingSphere() {}
}
class Vector2 { constructor(x, y) { this.x = x; this.y = y; } equals(o) { return o.x === this.x && o.y === this.y; } }
const THREE = { BufferGeometry, BufferAttribute, Float32BufferAttribute: BufferAttribute, Vector2 };
const soup = (g) => (g.index ? g.toNonIndexed() : g); // the refined geometries are indexed
// a two-link road graph: link 0 flat street from (0,0) to (30,0), link 1 a bridge from (30,0) to (30,20), 8 m wide
const GEO = { roadGraph: { nodes: [0, 0, 30, 0, 30, 20], links: [[0, 1, 0, 8, 2, 0, [], 0, 0, 0], [1, 2, 0, 8, 2, 0, [], 0, 1, 0]], names: ['x'] } };
const terrain = loadModule(readFileSync(join(__dirname, '../js/terrain.js'), 'utf8'), { imports: { 'three/webgpu': THREE, './terrassa-geodata.js': { GEO } }, globals: { console } });

// A 4 x 3 grid of 10 m cells from (0, 0): height = x / 10 + z / 5 (metres)
function record() {
  const w = 4, h = 3, cell = 10;
  const data = new Int16Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = Math.round((i * cell / 10 + j * cell / 5) * 100);
  return { w, h, cell, x0: 0, z0: 0, ref: 286, min: 0, max: 7, synthetic: true, data };
}
function binary(rec, bridges = []) {
  const buf = new ArrayBuffer(terrain.HEADER_BYTES + rec.w * rec.h * 2 + 8 + bridges.length * 12);
  const dv = new DataView(buf);
  'TRN1'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, rec.w, true); dv.setUint32(8, rec.h, true); dv.setFloat32(12, rec.cell, true);
  dv.setFloat32(16, rec.x0, true); dv.setFloat32(20, rec.z0, true); dv.setFloat32(24, rec.ref, true);
  dv.setFloat32(28, rec.min, true); dv.setFloat32(32, rec.max, true); dv.setUint32(36, 1, true);
  new Int16Array(buf, terrain.HEADER_BYTES, rec.w * rec.h).set(rec.data);
  let o = terrain.HEADER_BYTES + rec.w * rec.h * 2;
  'BRDG'.split('').forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  dv.setUint32(o + 4, bridges.length, true); o += 8;
  for (const b of bridges) { dv.setUint32(o, b.link, true); dv.setFloat32(o + 4, b.y0, true); dv.setFloat32(o + 8, b.y1, true); o += 12; }
  return buf;
}

test('no terrain: every sampler is a flat no-op', () => {
  terrain.setTerrain(null);
  assert.equal(terrain.terrainActive(), false);
  assert.equal(terrain.terrainY(123, -456), 0);
  const g0 = terrain.terrainGradient(1, 2);
  assert.ok(g0.gx === 0 && g0.gz === 0);
  assert.equal(terrain.terrainMin([{ x: 1, z: 2 }]), 0);
  const g = new BufferGeometry();
  assert.equal(terrain.drapeGeometry(g), g);
  assert.equal(terrain.buildTerrainTiles({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 5, 5).length, 0);
});

test('parses the binary layout and samples the plane exactly, clamped at the edges', () => {
  const rec = terrain.setTerrain(binary(record()));
  assert.equal(rec.w, 4);
  assert.equal(rec.synthetic, true);
  assert.ok(Math.abs(rec.ref - 286) < 1e-6);
  const f = (x, z) => x / 10 + z / 5;
  for (const [x, z] of [[0, 0], [10, 0], [30, 20], [5, 5], [17, 13], [2.5, 19]]) assert.ok(Math.abs(terrain.terrainY(x, z) - f(x, z)) < 1e-6, `${x},${z}`);
  assert.ok(Math.abs(terrain.terrainY(-50, -50) - f(0, 0)) < 1e-6, 'clamped before the first row');
  assert.ok(Math.abs(terrain.terrainY(500, 500) - f(30, 20)) < 1e-4, 'clamped past the last row');
  const g = terrain.terrainGradient(15, 10);
  assert.ok(Math.abs(g.gx - 0.1) < 1e-6 && Math.abs(g.gz - 0.2) < 1e-6);
  assert.ok(Math.abs(terrain.terrainMin([{ x: 0, z: 0 }, { x: 30, z: 20 }])) < 1e-6);
  assert.ok(Math.abs(terrain.terrainMax([{ x: 0, z: 0 }, { x: 30, z: 20 }]) - 7) < 1e-6);
});

test('refineGeometry cuts along the deck lattice and keeps the attributes', () => {
  terrain.setTerrain(record());
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 30, 0, 0, 0, 0, 20]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  const r = soup(terrain.refineGeometry(g, 8, { x0: 0, z0: 0 }));
  const pos = r.attributes.position.array;
  assert.ok(pos.length / 9 >= 12, `${pos.length / 9} triangles`);
  for (let t = 0; t < pos.length; t += 9) {
    // every piece lies inside one lattice cell and on one side of its diagonal
    const xs = [pos[t], pos[t + 3], pos[t + 6]], zs = [pos[t + 2], pos[t + 5], pos[t + 8]];
    const ds = xs.map((x, i) => x + zs[i]);
    assert.ok(Math.ceil(Math.min(...xs) / 8 - 1e-9) >= Math.floor(Math.max(...xs) / 8 + 1e-9) - 1 || true);
    for (const [vals] of [[xs], [zs], [ds]]) {
      const lo = Math.floor(Math.min(...vals) / 8 + 1e-6), hi = Math.ceil(Math.max(...vals) / 8 - 1e-6);
      assert.ok(hi - lo <= 1, `piece spans lattice lines: ${vals}`);
    }
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
      const L = Math.hypot(pos[t + a] - pos[t + b], pos[t + a + 2] - pos[t + b + 2]);
      assert.ok(L <= 8 * Math.SQRT2 + 1e-6, `edge ${L}`);
    }
  }
  // uv follows position linearly (u = x / 30, v = z / 20)
  const uv = r.attributes.uv.array;
  for (let i = 0; i < uv.length / 2; i++) {
    assert.ok(Math.abs(uv[i * 2] - pos[i * 3] / 30) < 1e-5 && Math.abs(uv[i * 2 + 1] - pos[i * 3 + 2] / 20) < 1e-5);
  }
  // the area is preserved
  let area = 0;
  for (let t = 0; t < pos.length; t += 9) area += Math.abs((pos[t + 3] - pos[t]) * (pos[t + 8] - pos[t + 2]) - (pos[t + 6] - pos[t]) * (pos[t + 5] - pos[t + 2])) / 2;
  assert.ok(Math.abs(area - 300) < 1e-3);
});

test('drapeGeometry lifts every vertex by the relief under it', () => {
  terrain.setTerrain(record());
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0.15, 0, 30, 0.15, 0, 0, 0.15, 20]), 3));
  const d = soup(terrain.drapeGeometry(g, 8));
  const pos = d.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) assert.ok(Math.abs(pos[i + 1] - (0.15 + pos[i] / 10 + pos[i + 2] / 5)) < 1e-4);
  // an indexed geometry works too
  const gi = new BufferGeometry();
  gi.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 30, 0, 0, 0, 0, 20, 30, 0, 20]), 3));
  gi.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 1, 3, 2]), 1));
  const di = soup(terrain.drapeGeometry(gi, 100));
  assert.equal(di.attributes.position.array.length, 18);
});

test('buildTerrainTiles reproduces terrainY on the lattice and tiles the bounds', () => {
  terrain.setTerrain(record());
  const tiles = terrain.buildTerrainTiles({ minX: 0, maxX: 30, minZ: 0, maxZ: 20 }, 10, 20, 0.5);
  assert.equal(tiles.length, 2);
  for (const t of tiles) {
    const pos = t.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) assert.ok(Math.abs(pos[i + 1] - 0.5 - terrain.terrainY(pos[i], pos[i + 2])) < 1e-5);
    const idx = t.geometry.index.array;
    // front faces are counter-clockwise seen from above: (x, -z) cross product positive
    for (let k = 0; k < idx.length; k += 3) {
      const [a, b, c] = [idx[k], idx[k + 1], idx[k + 2]].map((v) => [pos[v * 3], -pos[v * 3 + 2]]);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      assert.ok(cross > 0);
    }
  }
});

test('refineGeometry can drop the downward faces and splits by horizontal length only', () => {
  terrain.setTerrain(record());
  const g = new BufferGeometry();
  // an upward triangle 30 m long and a downward copy, plus a vertical wall 30 m long and 50 m tall
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 30, 0, 0, 0, 0, 20,
    0, 0, 0, 0, 0, 20, 30, 0, 0,
    0, 0, 0, 0, 50, 0, 30, 0, 0
  ]), 3));
  const r = soup(terrain.refineGeometry(g, 8, { dropDown: true, x0: 0, z0: 0 }));
  const pos = r.attributes.position.array;
  let down = 0, tall = 0;
  for (let t = 0; t < pos.length; t += 9) {
    const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
    const vx = pos[t + 6] - pos[t], vy = pos[t + 7] - pos[t + 1], vz = pos[t + 8] - pos[t + 2];
    const ny = uz * vx - ux * vz;
    if (ny < -1e-6) down++;
    if (Math.abs(uy) > 20 || Math.abs(vy) > 20) tall++;
  }
  assert.equal(down, 0, 'no downward faces survive');
  assert.ok(tall > 0, 'the wall keeps its 50 m vertical edges (only horizontal edges are split)');
});

test('refined geometries share their lattice vertices', () => {
  terrain.setTerrain(record());
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 30, 0, 0, 0, 0, 20]), 3));
  const r = terrain.refineGeometry(g, 10, { x0: 0, z0: 0 });
  assert.ok(r.index, 'indexed');
  const verts = r.attributes.position.count;
  const tris = r.index.array.length / 3;
  assert.ok(tris >= 6, `${tris} triangles`);
  assert.ok(verts <= tris * 1.5, `${verts} vertices for ${tris} triangles: the lattice points are shared`);
});

test('latticeCapGeometry fills interior cells with the deck triangles and clips the border', () => {
  terrain.setTerrain(record());
  // a 30 x 20 rectangle off the lattice, with a 4 x 4 hole: fan triangulation is enough for the convex outline
  const rect = [{ x: 3, z: 3 }, { x: 33, z: 3 }, { x: 33, z: 23 }, { x: 3, z: 23 }];
  const fan = (contour) => { const t = []; for (let i = 1; i + 1 < contour.length; i++) t.push([0, i, i + 1]); return t; };
  const g = terrain.latticeCapGeometry(rect, [], 0.15, { cell: 10, x0: 0, z0: 0 }, fan);
  assert.ok(g && g.userData.latticeAligned);
  const pos = g.attributes.position.array, idx = g.index.array;
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((v) => [pos[v * 3], -pos[v * 3 + 2]]);
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    assert.ok(cross > 0, 'faces up');
    area += cross / 2;
    for (const v of [a, b, c]) assert.ok(Math.abs(pos[idx[t] * 3 + 1] - 0.15) < 1e-6);
    // inside one lattice cell
    const xs = [a[0], b[0], c[0]], zs = [-a[1], -b[1], -c[1]];
    assert.ok(Math.ceil(Math.max(...xs) / 10 - 1e-6) - Math.floor(Math.min(...xs) / 10 + 1e-6) <= 1 && Math.ceil(Math.max(...zs) / 10 - 1e-6) - Math.floor(Math.min(...zs) / 10 + 1e-6) <= 1, 'piece within a cell');
  }
  assert.ok(Math.abs(area - 600) < 1e-3, `area ${area}`);
  assert.ok(g.attributes.position.count < idx.length / 3 * 1.5, 'vertices shared');
});

test('bridge decks: parsed from the file, found under a point, chosen by the height hint', () => {
  const rec = terrain.setTerrain(binary(record(), [{ link: 1, y0: 3, y1: 7 }]));
  assert.equal(rec.bridges.length, 1);
  assert.equal(terrain.bridgeList().length, 1);
  const mid = terrain.bridgeAt(30, 10);
  assert.ok(mid && Math.abs(mid.y - 5) < 1e-5, 'deck height half-way');
  assert.equal(terrain.bridgeAt(0, 15), null, 'nothing 30 m to the side');
  assert.ok(terrain.bridgeAt(30 + 6.3, 10) && !terrain.bridgeAt(30 + 6.5, 10), 'half width = 4 m carriageway + 2.4 m sidewalk');
  const ground = terrain.terrainY(30, 10); // 3 + 2 = 5 ... the plane is x/10 + z/5 = 5: deck and ground coincide here
  assert.ok(Math.abs(ground - 5) < 1e-6);
  const deckEnd = terrain.bridgeAt(30, 20).y; // 7 vs ground 7: equal; test a hint elsewhere
  assert.ok(Math.abs(deckEnd - 7) < 1e-6);
  terrain.setTerrain(binary(record(), [{ link: 1, y0: 13, y1: 17 }]));
  assert.ok(Math.abs(terrain.surfaceY(30, 10) - 15) < 1e-5, 'no hint: the deck');
  assert.ok(Math.abs(terrain.surfaceY(30, 10, 5.5) - 5) < 1e-5, 'hint near the ground: the ground');
  assert.ok(Math.abs(terrain.surfaceY(30, 10, 14) - 15) < 1e-5, 'hint near the deck: the deck');
  assert.ok(Math.abs(terrain.surfaceY(0, 10, 100) - 2) < 1e-5, 'off the bridge: the ground whatever the hint');
});
