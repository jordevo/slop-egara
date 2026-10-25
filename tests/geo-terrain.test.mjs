import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { readGeoTiff, readAsciiGrid, lzwDecode } from '../tools/lib/geotiff.mjs';
import { lonLatToUtm, projectorFor } from '../tools/lib/utm.mjs';
import { parseArgs, frameOf, gridFor, resample, fillHoles, gaussianBlur, encodeTerrain, build, HEADER_BYTES } from '../tools/geo-terrain.mjs';

// ---- a tiny TIFF writer (enough to exercise the reader's code paths) ------------------------------------------------
function writeTiff({ width, height, values, bps, format, le = true, big = false, compression = 1, predictor = 1, tile = 0, scale = [10, 10], tiepoint = [0, 0, 0, 400000, 4600000, 0], epsg = 25831, nodata = null }) {
  const sampleBytes = bps;
  const put = (b, o, v, size, signed = false, float = false) => {
    if (float) return size === 4 ? (le ? b.writeFloatLE(v, o) : b.writeFloatBE(v, o)) : (le ? b.writeDoubleLE(v, o) : b.writeDoubleBE(v, o));
    if (size === 1) return signed ? b.writeInt8(v, o) : b.writeUInt8(v, o);
    if (size === 2) return signed ? (le ? b.writeInt16LE(v, o) : b.writeInt16BE(v, o)) : (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
    return signed ? (le ? b.writeInt32LE(v, o) : b.writeInt32BE(v, o)) : (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  };
  // chunks
  const tw = tile || width, th = tile || height;
  const across = Math.ceil(width / tw), down = Math.ceil(height / th);
  const chunks = [];
  for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
    const rows = tile ? th : Math.min(th, height - ty * th);
    let raw = Buffer.alloc(tw * rows * sampleBytes);
    for (let r = 0; r < rows; r++) for (let c = 0; c < tw; c++) {
      const row = ty * th + r, col = tx * tw + c;
      const v = row < height && col < width ? values[row * width + col] : 0;
      put(raw, (r * tw + c) * sampleBytes, v, sampleBytes, format === 2, format === 3);
    }
    if (predictor === 2) {
      for (let r = 0; r < rows; r++) {
        const o = r * tw * sampleBytes;
        const rd = (q) => (sampleBytes === 2 ? (le ? raw.readUInt16LE(q) : raw.readUInt16BE(q)) : raw.readUInt8(q));
        const wr = (q, v) => (sampleBytes === 2 ? (le ? raw.writeUInt16LE(v & 0xffff, q) : raw.writeUInt16BE(v & 0xffff, q)) : raw.writeUInt8(v & 255, q));
        for (let c = tw - 1; c > 0; c--) wr(o + c * sampleBytes, rd(o + c * sampleBytes) - rd(o + (c - 1) * sampleBytes));
      }
    } else if (predictor === 3) {
      // big-endian bytes, planar by byte position, then differenced
      const out = Buffer.alloc(raw.length);
      for (let r = 0; r < rows; r++) {
        const o = r * tw * sampleBytes;
        const be = Buffer.alloc(tw * sampleBytes);
        for (let c = 0; c < tw; c++) {
          const v = le ? raw.readFloatLE(o + c * 4) : raw.readFloatBE(o + c * 4);
          be.writeFloatBE(v, c * 4);
        }
        for (let c = 0; c < tw; c++) for (let b = 0; b < sampleBytes; b++) out[o + b * tw + c] = be[c * sampleBytes + b];
        for (let i = tw * sampleBytes - 1; i > 0; i--) out[o + i] = (out[o + i] - out[o + i - 1]) & 255;
      }
      raw = out;
    }
    if (compression === 8) raw = zlib.deflateSync(raw);
    else if (compression === 5) raw = lzwEncode(raw);
    chunks.push(raw);
  }
  // IFD
  const entries = [];
  const add = (tag, type, vals) => entries.push({ tag, type, vals });
  add(256, 4, [width]); add(257, 4, [height]); add(258, 3, [bps * 8]); add(259, 3, [compression]); add(262, 3, [1]);
  add(277, 3, [1]); add(284, 3, [1]); add(339, 3, [format]);
  if (predictor !== 1) add(317, 3, [predictor]);
  if (tile) { add(322, 3, [tw]); add(323, 3, [th]); add(324, 4, chunks.map(() => 0)); add(325, 4, chunks.map((c) => c.length)); }
  else { add(278, 4, [height]); add(273, 4, chunks.map(() => 0)); add(279, 4, chunks.map((c) => c.length)); }
  add(33550, 12, [scale[0], scale[1], 0]); add(33922, 12, tiepoint);
  add(34735, 3, [1, 1, 0, 2, 1024, 0, 1, 1, epsg < 10000 && epsg !== 4326 ? 3072 : epsg === 4326 ? 2048 : 3072, 0, 1, epsg]);
  if (nodata !== null) add(42113, 2, [...Buffer.from(`${nodata}\0`, 'latin1')]);
  entries.sort((a, b) => a.tag - b.tag);
  const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 12: 8, 16: 8 };
  const headerLen = big ? 16 : 8;
  const entryLen = big ? 20 : 12;
  const ifdLen = (big ? 8 : 2) + entries.length * entryLen + (big ? 8 : 4);
  let dataPos = headerLen + ifdLen;
  const extra = [];
  for (const e of entries) {
    const size = TYPE_SIZE[e.type] * e.vals.length;
    if (size > (big ? 8 : 4)) { e.offset = dataPos; dataPos += size + (size % 2); }
  }
  const chunkOffsets = [];
  for (const c of chunks) { chunkOffsets.push(dataPos); dataPos += c.length + (c.length % 2); }
  const chunkTag = tile ? 324 : 273;
  entries.find((e) => e.tag === chunkTag).vals = chunkOffsets;
  const buf = Buffer.alloc(dataPos);
  buf.write(le ? 'II' : 'MM', 0, 'latin1');
  if (big) { put(buf, 2, 43, 2); put(buf, 4, 8, 2); put(buf, 6, 0, 2); le ? buf.writeBigUInt64LE(16n, 8) : buf.writeBigUInt64BE(16n, 8); }
  else { put(buf, 2, 42, 2); put(buf, 4, 8, 4); }
  let p = headerLen;
  if (big) { le ? buf.writeBigUInt64LE(BigInt(entries.length), p) : buf.writeBigUInt64BE(BigInt(entries.length), p); p += 8; } else { put(buf, p, entries.length, 2); p += 2; }
  const writeVals = (e, at) => e.vals.forEach((v, i) => {
    const o = at + i * TYPE_SIZE[e.type];
    if (e.type === 12) le ? buf.writeDoubleLE(v, o) : buf.writeDoubleBE(v, o);
    else if (e.type === 16) le ? buf.writeBigUInt64LE(BigInt(v), o) : buf.writeBigUInt64BE(BigInt(v), o);
    else put(buf, o, v, TYPE_SIZE[e.type]);
  });
  for (const e of entries) {
    put(buf, p, e.tag, 2); put(buf, p + 2, e.type, 2);
    if (big) { le ? buf.writeBigUInt64LE(BigInt(e.vals.length), p + 4) : buf.writeBigUInt64BE(BigInt(e.vals.length), p + 4); }
    else put(buf, p + 4, e.vals.length, 4);
    if (e.offset) { if (big) { le ? buf.writeBigUInt64LE(BigInt(e.offset), p + 12) : buf.writeBigUInt64BE(BigInt(e.offset), p + 12); } else put(buf, p + 8, e.offset, 4); writeVals(e, e.offset); }
    else writeVals(e, p + (big ? 12 : 8));
    p += entryLen;
  }
  chunks.forEach((c, i) => c.copy(buf, chunkOffsets[i]));
  return buf;
}

// TIFF LZW encoder (MSB-first, early change), the mirror of lzwDecode
function lzwEncode(src) {
  const bits = [];
  let codeLen = 9;
  const emit = (code) => { for (let k = codeLen - 1; k >= 0; k--) bits.push((code >> k) & 1); };
  let table = new Map();
  let next = 258;
  const reset = () => { table = new Map(); next = 258; codeLen = 9; };
  emit(256);
  let w = '';
  for (const byte of src) {
    const wc = w ? `${w},${byte}` : String(byte);
    if (!w || table.has(wc)) { w = wc; continue; }
    emit(w.includes(',') ? table.get(w) : Number(w));
    table.set(wc, next++);
    if (next === (1 << codeLen) - 1) codeLen++;
    if (next >= 4094) { emit(256); reset(); }
    w = String(byte);
  }
  if (w) emit(w.includes(',') ? table.get(w) : Number(w));
  emit(257);
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}

const W = 7, H = 5;
const VALUES = Array.from({ length: W * H }, (_, k) => 300 + (k % W) * 3 - Math.floor(k / W) * 7);

test('LZW round trip including early code-width changes', () => {
  const data = Buffer.alloc(5000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 5)) & 255;
  const dec = lzwDecode(lzwEncode(data), data.length);
  assert.deepEqual([...dec], [...data]);
});

test('GeoTIFF: uncompressed int16 strips, little-endian', () => {
  const r = readGeoTiff(writeTiff({ width: W, height: H, values: VALUES, bps: 2, format: 2 }));
  assert.equal(r.width, W);
  assert.equal(r.epsg, 25831);
  assert.deepEqual([...r.data].map(Math.round), VALUES);
  assert.deepEqual(r.toXY(0, 0), [400005, 4599995]); // pixel centre
  assert.ok(Math.abs(r.sample(400005, 4599995) - VALUES[0]) < 1e-9);
  assert.ok(Math.abs(r.sample(400010, 4599995) - (VALUES[0] + VALUES[1]) / 2) < 1e-9); // between two centres
  assert.ok(Number.isNaN(r.sample(300000, 4599995)));
});

test('GeoTIFF: deflate float32 tiles with the floating-point predictor, big-endian, nodata', () => {
  const vals = VALUES.map((v) => v + 0.25);
  vals[9] = -9999;
  const r = readGeoTiff(writeTiff({ width: W, height: H, values: vals, bps: 4, format: 3, le: false, compression: 8, predictor: 3, tile: 4, nodata: -9999 }));
  assert.deepEqual([...r.data], vals);
  assert.equal(r.nodata, -9999);
  const [x, y] = r.toXY(2, 1);
  assert.ok(Number.isNaN(r.sample(x, y)), 'a nodata pixel is a hole');
  const [x2, y2] = r.toXY(2.5, 1); // half-way to a valid neighbour: the valid one carries the sample
  assert.ok(Math.abs(r.sample(x2, y2) - vals[10]) < 1e-6, 'nodata is skipped by the bilinear sampler');
});

test('GeoTIFF: LZW uint16 strips with the horizontal predictor, and BigTIFF', () => {
  const r = readGeoTiff(writeTiff({ width: W, height: H, values: VALUES, bps: 2, format: 1, compression: 5, predictor: 2 }));
  assert.deepEqual([...r.data], VALUES);
  const b = readGeoTiff(writeTiff({ width: W, height: H, values: VALUES, bps: 2, format: 1, big: true }));
  assert.deepEqual([...b.data], VALUES);
});

test('Arc/Info ASCII grid', () => {
  const rows = [];
  for (let j = 0; j < H; j++) rows.push(VALUES.slice(j * W, (j + 1) * W).join(' '));
  const txt = `ncols ${W}\nnrows ${H}\nxllcorner 400000\nyllcorner 4600000\ncellsize 10\nNODATA_value -9999\n${rows.join('\n')}\n`;
  const r = readAsciiGrid(Buffer.from(txt), { epsg: 25831 });
  assert.deepEqual([...r.data], VALUES);
  assert.deepEqual(r.toXY(0, 0), [400005, 4600000 + H * 10 - 5]);
  assert.equal(r.epsg, 25831);
});

test('UTM 31N forward projection', () => {
  const [e0, n0] = lonLatToUtm(3, 0, 31);
  assert.ok(Math.abs(e0 - 500000) < 1e-6 && Math.abs(n0) < 1e-6);
  // Plaça Vella de Terrassa (ETRS89 / UTM 31N): about 417.6 km E, 4601.6 km N
  const [e, n] = lonLatToUtm(2.011102, 41.561974, 31);
  assert.ok(Math.abs(e - 417600) < 600, `E ${e}`);
  assert.ok(Math.abs(n - 4601600) < 600, `N ${n}`);
  assert.equal(projectorFor(25831)(2.011102, 41.561974)[0], e);
  assert.deepEqual(projectorFor(4326)(2, 41), [2, 41]);
  assert.equal(projectorFor(1234), null);
});

test('world frame round trip and grid layout', () => {
  const f = frameOf({ bearingDeg: -13.7, lat0: 41.561974, lon0: 2.011102 });
  const [lon, lat] = f.toLonLat(1234.5, -987.6);
  const [x, z] = f.toWorld(lon, lat);
  assert.ok(Math.abs(x - 1234.5) < 1e-6 && Math.abs(z + 987.6) < 1e-6);
  const g = gridFor({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, 5, 0);
  assert.deepEqual(g, { x0: -10, z0: -10, cell: 5, w: 5, h: 5 });
  assert.equal(parseArgs(['--cell', '8', 'a.tif']).cell, 8);
  assert.ok(parseArgs(['--synthetic']).synthetic);
});

test('resampling, hole filling, blur and encoding', () => {
  const f = frameOf({ bearingDeg: 0, lat0: 41.561974, lon0: 2.011102 });
  // a raster in lon/lat whose value is the latitude in metres-ish: height = (lat - lat0) * 1e5
  const w = 21, h = 21, cell = 0.001;
  const data = new Float64Array(w * h);
  const lat0 = 41.561974 + 10 * cell, lon0 = 2.011102 - 10 * cell;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = (lat0 - j * cell - 41.561974) * 1e5;
  data[5 * w + 5] = -9999;
  const raster = readAsciiGrid(Buffer.from(`ncols ${w}\nnrows ${h}\nxllcenter ${lon0}\nyllcenter ${lat0 - (h - 1) * cell}\ncellsize ${cell}\nNODATA_value -9999\n${[...data].join(' ')}\n`), { epsg: 4326 });
  const grid = gridFor({ minX: -400, maxX: 400, minZ: -400, maxZ: 400 }, 50, 0);
  const { heights, holes } = resample(grid, [{ ...raster, project: projectorFor(4326) }], f);
  assert.ok(holes >= 0);
  fillHoles(heights, grid.w, grid.h);
  // north (-z) is higher: height grows ~0.9 per metre of latitude here (1e5 per degree / 111 km)
  const at = (x, z) => heights[Math.round((z - grid.z0) / 50) * grid.w + Math.round((x - grid.x0) / 50)];
  assert.ok(at(0, -300) > at(0, 300) + 400, `${at(0, -300)} vs ${at(0, 300)}`);
  assert.ok(Math.abs(at(0, 0)) < 2);
  const copy = Float32Array.from(heights);
  gaussianBlur(copy, grid.w, grid.h, 1);
  assert.ok(Math.abs(copy[8 * grid.w + 8] - heights[8 * grid.w + 8]) < 1, 'a plane is unchanged by the blur away from the edges');
  const buf = encodeTerrain(grid, heights, { ref: 286.5, synthetic: true, smooth: 0 });
  assert.equal(buf.length, HEADER_BYTES + grid.w * grid.h * 2 + 8); // + the empty bridge table
  assert.equal(buf.toString('latin1', 0, 4), 'TRN1');
  assert.equal(buf.readUInt32LE(4), grid.w);
  assert.equal(buf.readUInt32LE(36), 1);
  assert.ok(buf.readInt16LE(HEADER_BYTES + (8 * grid.w + 8) * 2) === Math.round(heights[8 * grid.w + 8] * 100));
});

test('end to end: builds a synthetic relief from the real geodata frame', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terrain-'));
  try {
    const out = path.join(dir, 'terrain.bin');
    const res = await build(parseArgs(['--synthetic', '--cell', '40', '--margin', '0', '--smooth', '0', '--out', out]));
    const buf = fs.readFileSync(out);
    assert.equal(buf.readUInt32LE(4), res.grid.w);
    assert.ok(buf.readFloatLE(24) > 250 && buf.readFloatLE(24) < 320, 'origin elevation is plausible');
    assert.ok(buf.readFloatLE(28) < -5 && buf.readFloatLE(32) > 50, 'relief spans the box');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
