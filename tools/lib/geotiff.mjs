// tools/lib/geotiff.mjs — a small, dependency-free reader for the single-band raster GeoTIFFs digital elevation models
// come in (ICGC MET 2 m / 5 m, Copernicus GLO-30 COGs, anything GDAL writes with the default options), plus the
// Arc/Info ASCII grid (.asc) the ICGC also publishes. Classic & BigTIFF, strips or tiles, compression none / deflate /
// LZW / PackBits, predictors 2 (integer differencing) & 3 (floating point), 8/16/32-bit integers & 32/64-bit floats.
//
// Both readers return the same object:
//   { width, height, data: Float64Array (row-major, north row first), nodata, epsg,
//     toXY(col, row) -> [x, y] of the pixel centre in the raster's CRS,
//     sample(x, y) -> bilinear value at CRS coordinates (NaN outside or on nodata) }
import fs from 'node:fs';
import zlib from 'node:zlib';

const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, stripOffsets: 273, spp: 277, rowsPerStrip: 278, stripBytes: 279,
  planar: 284, predictor: 317, tileW: 322, tileH: 323, tileOffsets: 324, tileBytes: 325, sampleFormat: 339,
  pixelScale: 33550, tiepoint: 33922, transform: 34264, geoKeys: 34735, geoDoubles: 34736, nodata: 42113
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/** Reads one GeoTIFF file (path or Buffer) */
export function readGeoTiff(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const le = buf.toString('latin1', 0, 2) === 'II';
  if (!le && buf.toString('latin1', 0, 2) !== 'MM') throw new Error('not a TIFF (bad byte-order mark)');
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const magic = u16(2);
  const big = magic === 43;
  if (magic !== 42 && !big) throw new Error(`not a TIFF (magic ${magic})`);
  let ifd;
  if (big) {
    if (u16(4) !== 8) throw new Error('BigTIFF with unexpected offset size');
    ifd = u64(8);
  } else ifd = u32(4);

  // ---- the first IFD -------------------------------------------------------------------------------------------
  const readValues = (type, count, at) => {
    const size = TYPE_SIZE[type];
    if (!size) throw new Error(`unknown TIFF field type ${type}`);
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = at + i * size;
      switch (type) {
        case 1: case 7: out.push(buf.readUInt8(o)); break;
        case 2: out.push(buf.readUInt8(o)); break;
        case 6: out.push(buf.readInt8(o)); break;
        case 3: out.push(u16(o)); break;
        case 8: out.push(le ? buf.readInt16LE(o) : buf.readInt16BE(o)); break;
        case 4: out.push(u32(o)); break;
        case 9: out.push(le ? buf.readInt32LE(o) : buf.readInt32BE(o)); break;
        case 5: out.push(u32(o) / u32(o + 4)); break;
        case 10: out.push((le ? buf.readInt32LE(o) : buf.readInt32BE(o)) / (le ? buf.readInt32LE(o + 4) : buf.readInt32BE(o + 4))); break;
        case 11: out.push(le ? buf.readFloatLE(o) : buf.readFloatBE(o)); break;
        case 12: out.push(le ? buf.readDoubleLE(o) : buf.readDoubleBE(o)); break;
        case 16: case 18: out.push(u64(o)); break;
        case 17: out.push(Number(le ? buf.readBigInt64LE(o) : buf.readBigInt64BE(o))); break;
        default: throw new Error(`unhandled TIFF type ${type}`);
      }
    }
    return out;
  };
  const tags = new Map();
  const n = big ? u64(ifd) : u16(ifd);
  const entrySize = big ? 20 : 12;
  let p = ifd + (big ? 8 : 2);
  for (let i = 0; i < n; i++, p += entrySize) {
    const tag = u16(p);
    const type = u16(p + 2);
    const count = big ? u64(p + 4) : u32(p + 4);
    const size = (TYPE_SIZE[type] || 1) * count;
    const inline = big ? 8 : 4;
    const at = size <= inline ? p + (big ? 12 : 8) : big ? u64(p + 12) : u32(p + 8);
    tags.set(tag, type === 2 ? Buffer.from(buf.subarray(at, at + count)).toString('latin1').replace(/\0.*$/s, '') : readValues(type, count, at));
  }
  const one = (t, d) => (tags.has(t) ? tags.get(t)[0] : d);

  const width = one(TAG.width);
  const height = one(TAG.height);
  const bits = one(TAG.bits, 8);
  const spp = one(TAG.spp, 1);
  const format = one(TAG.sampleFormat, 1); // 1 uint, 2 int, 3 float
  const compression = one(TAG.compression, 1);
  const predictor = one(TAG.predictor, 1);
  if (spp !== 1) throw new Error(`expected a single-band raster, got ${spp} samples per pixel`);
  if (one(TAG.planar, 1) !== 1) throw new Error('planar configuration 2 not supported');
  const bps = bits / 8;
  if (![1, 2, 4, 8].includes(bps)) throw new Error(`unsupported bit depth ${bits}`);

  // ---- chunks: strips or tiles -------------------------------------------------------------------------------------
  const tiled = tags.has(TAG.tileOffsets);
  const tw = tiled ? one(TAG.tileW) : width;
  const th = tiled ? one(TAG.tileH) : Math.min(one(TAG.rowsPerStrip, height), height);
  const offsets = tags.get(tiled ? TAG.tileOffsets : TAG.stripOffsets);
  const counts = tags.get(tiled ? TAG.tileBytes : TAG.stripBytes);
  const across = tiled ? Math.ceil(width / tw) : 1;
  const down = Math.ceil(height / th);

  const data = new Float64Array(width * height);
  const rowBytes = tw * bps;
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const k = ty * across + tx;
      if (offsets[k] === undefined) continue;
      const raw = buf.subarray(offsets[k], offsets[k] + counts[k]);
      const rows = tiled ? th : Math.min(th, height - ty * th);
      const expected = tiled ? tw * th * bps : rows * rowBytes;
      let bytes = decompress(raw, compression, expected);
      if (bytes.length < expected) {
        const padded = Buffer.alloc(expected);
        padded.set(bytes);
        bytes = padded;
      }
      if (predictor === 2) undoIntPredictor(bytes, tw, rows, bps, le);
      else if (predictor === 3) bytes = undoFloatPredictor(bytes, tw, rows, bps);
      else if (predictor !== 1) throw new Error(`predictor ${predictor} not supported`);
      const bigEndianFloats = predictor === 3; // the float predictor leaves the bytes in big-endian order
      for (let r = 0; r < rows; r++) {
        const row = ty * th + r;
        if (row >= height) break;
        const cols = Math.min(tw, width - tx * tw);
        for (let c = 0; c < cols; c++) {
          data[row * width + tx * tw + c] = readSample(bytes, (r * tw + c) * bps, bps, format, bigEndianFloats ? false : le);
        }
      }
    }
  }

  // ---- georeferencing ------------------------------------------------------------------------------------------------
  let toXY;
  if (tags.has(TAG.transform)) {
    const m = tags.get(TAG.transform);
    toXY = (col, row) => [m[0] * col + m[1] * row + m[3], m[4] * col + m[5] * row + m[7]];
  } else if (tags.has(TAG.pixelScale) && tags.has(TAG.tiepoint)) {
    const [sx, sy] = tags.get(TAG.pixelScale);
    const [i, j, , x, y] = tags.get(TAG.tiepoint);
    toXY = (col, row) => [x + (col - i) * sx, y - (row - j) * sy];
  } else throw new Error('GeoTIFF without ModelTransformation or ModelPixelScale + ModelTiepoint');
  let epsg = null;
  let rasterType = 1; // 1 PixelIsArea (default), 2 PixelIsPoint
  if (tags.has(TAG.geoKeys)) {
    const g = tags.get(TAG.geoKeys);
    const nKeys = g[3];
    for (let k = 0; k < nKeys; k++) {
      const [id, loc, , value] = g.slice(4 + k * 4, 8 + k * 4);
      if (loc !== 0) continue;
      if (id === 3072 && value !== 32767) epsg = value; // ProjectedCSTypeGeoKey
      else if (id === 2048 && epsg === null && value !== 32767) epsg = value; // GeographicTypeGeoKey
      else if (id === 1025) rasterType = value;
    }
  }
  const half = rasterType === 2 ? 0 : 0.5; // pixel centres
  const centre = (col, row) => toXY(col + half, row + half);
  const nodata = tags.has(TAG.nodata) ? Number(tags.get(TAG.nodata)) : null;
  return makeRaster({ width, height, data, nodata, epsg, toXY: centre });
}

/** Reads an Arc/Info ASCII grid (.asc / .txt, or gzipped .asc.gz): ncols nrows xllcorner|xllcenter yllcorner|yllcenter cellsize NODATA_value */
export function readAsciiGrid(input, { epsg = null } = {}) {
  let buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // gzip magic
  const text = buf.toString('latin1');
  const head = {};
  let pos = 0;
  for (let k = 0; k < 6; k++) {
    const nl = text.indexOf('\n', pos);
    const line = text.slice(pos, nl).trim();
    const m = /^(\w+)\s+(\S+)/.exec(line);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (!['ncols', 'nrows', 'xllcorner', 'xllcenter', 'yllcorner', 'yllcenter', 'cellsize', 'nodata_value', 'dx', 'dy'].includes(key)) break;
    head[key] = Number(m[2]);
    pos = nl + 1;
  }
  const width = head.ncols, height = head.nrows;
  const cell = head.cellsize ?? head.dx;
  if (!width || !height || !cell) throw new Error('ASCII grid without ncols / nrows / cellsize');
  const x0 = head.xllcorner !== undefined ? head.xllcorner + cell * 0.5 : head.xllcenter;
  const y0 = head.yllcorner !== undefined ? head.yllcorner + cell * 0.5 : head.yllcenter; // centre of the bottom-left cell
  const data = new Float64Array(width * height);
  let i = 0;
  const re = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|-?\.\d+/g;
  re.lastIndex = pos;
  let m;
  while (i < data.length && (m = re.exec(text))) data[i++] = Number(m[0]);
  if (i < data.length) throw new Error(`ASCII grid ends after ${i} of ${data.length} values`);
  const nodata = head.nodata_value ?? null;
  const yTop = y0 + (height - 1) * cell;
  return makeRaster({ width, height, data, nodata, epsg, toXY: (col, row) => [x0 + col * cell, yTop - row * cell] });
}

/** Picks the reader by extension (a .gz suffix is stripped first: the ASCII grids ship gzipped in tools/data/dem/) */
export function readRaster(path, opts) {
  const base = path.replace(/\.gz$/i, '');
  if (/\.(asc|txt|agr|grd)$/i.test(base)) return readAsciiGrid(path, opts);
  let buf = fs.readFileSync(path);
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return readGeoTiff(buf);
}

function makeRaster(r) {
  const { width, height, data, nodata, toXY } = r;
  // Affine inverse from three pixel centres (both readers are affine)
  const [ax, ay] = toXY(0, 0);
  const [bx, by] = toXY(1, 0);
  const [cx, cy] = toXY(0, 1);
  const m00 = bx - ax, m10 = by - ay, m01 = cx - ax, m11 = cy - ay;
  const det = m00 * m11 - m01 * m10;
  const toColRow = (x, y) => {
    const dx = x - ax, dy = y - ay;
    return [(dx * m11 - dy * m01) / det, (dy * m00 - dx * m10) / det];
  };
  const valid = (v) => Number.isFinite(v) && (nodata === null || Math.abs(v - nodata) > 1e-6) && v > -9000;
  const at = (c, rw) => (c < 0 || rw < 0 || c >= width || rw >= height ? NaN : data[rw * width + c]);
  function sample(x, y) {
    const [fc, fr] = toColRow(x, y);
    if (fc < -0.5 || fr < -0.5 || fc > width - 0.5 || fr > height - 0.5) return NaN;
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const u = fc - c0, v = fr - r0;
    const vals = [at(c0, r0), at(c0 + 1, r0), at(c0, r0 + 1), at(c0 + 1, r0 + 1)];
    const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
    let s = 0, ws = 0;
    for (let k = 0; k < 4; k++) if (valid(vals[k])) { s += vals[k] * w[k]; ws += w[k]; }
    return ws > 0.25 ? s / ws : NaN;
  }
  const bounds = (() => {
    const pts = [toXY(-0.5, -0.5), toXY(width - 0.5, -0.5), toXY(-0.5, height - 0.5), toXY(width - 0.5, height - 0.5)];
    return { minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])) };
  })();
  return { ...r, cell: Math.hypot(m00, m10), bounds, sample, toColRow, valid };
}

// ---------------------------------------------------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------------------------------------------------
function decompress(raw, compression, expected) {
  switch (compression) {
    case 1: return raw;
    case 8: case 32946: return zlib.inflateSync(raw);
    case 5: return lzwDecode(raw, expected);
    case 32773: return packBitsDecode(raw, expected);
    default: throw new Error(`TIFF compression ${compression} not supported (convert with gdal_translate -co COMPRESS=DEFLATE)`);
  }
}

/** TIFF LZW (MSB-first codes, "early change" width switching) */
export function lzwDecode(src, expected) {
  const out = new Uint8Array(expected);
  let op = 0;
  let dict, codeLen, prev;
  const reset = () => {
    dict = new Array(258);
    for (let i = 0; i < 256; i++) dict[i] = Uint8Array.of(i);
    codeLen = 9;
    prev = null;
  };
  reset();
  let bitPos = 0;
  const totalBits = src.length * 8;
  const next = () => {
    let code = 0;
    for (let k = 0; k < codeLen; k++) {
      const byte = src[bitPos >> 3];
      const bit = (byte >> (7 - (bitPos & 7))) & 1;
      code = (code << 1) | bit;
      bitPos++;
    }
    return code;
  };
  while (bitPos + codeLen <= totalBits && op < expected) {
    const code = next();
    if (code === 257) break;
    if (code === 256) { reset(); continue; }
    let entry;
    if (code < dict.length) {
      entry = dict[code];
      if (!entry) throw new Error('LZW: reference to an empty table slot');
      if (prev) dict.push(concat(prev, entry[0]));
    } else if (code === dict.length && prev) {
      entry = concat(prev, prev[0]);
      dict.push(entry);
    } else throw new Error(`LZW: code ${code} out of table (${dict.length})`);
    const take = Math.min(entry.length, expected - op);
    out.set(take === entry.length ? entry : entry.subarray(0, take), op);
    op += take;
    prev = entry;
    if (dict.length + 1 >= (1 << codeLen) - 1 && codeLen < 12) codeLen++;
  }
  return out;
}
function concat(a, b) {
  const o = new Uint8Array(a.length + 1);
  o.set(a);
  o[a.length] = b;
  return o;
}

function packBitsDecode(src, expected) {
  const out = new Uint8Array(expected);
  let ip = 0, op = 0;
  while (ip < src.length && op < expected) {
    const n = (src[ip++] << 24) >> 24; // signed
    if (n >= 0) { for (let k = 0; k <= n && op < expected; k++) out[op++] = src[ip++]; }
    else if (n !== -128) { const v = src[ip++]; for (let k = 0; k < 1 - n && op < expected; k++) out[op++] = v; }
  }
  return out;
}

function undoIntPredictor(bytes, w, rows, bps, le) {
  for (let r = 0; r < rows; r++) {
    const o = r * w * bps;
    if (bps === 1) for (let c = 1; c < w; c++) bytes[o + c] = (bytes[o + c] + bytes[o + c - 1]) & 255;
    else if (bps === 2) {
      let acc = le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1];
      for (let c = 1; c < w; c++) {
        const q = o + c * 2;
        const d = le ? bytes[q] | (bytes[q + 1] << 8) : (bytes[q] << 8) | bytes[q + 1];
        acc = (acc + d) & 0xffff;
        if (le) { bytes[q] = acc & 255; bytes[q + 1] = acc >> 8; } else { bytes[q] = acc >> 8; bytes[q + 1] = acc & 255; }
      }
    } else if (bps === 4) {
      const rd = (q) => (le ? (bytes[q] | (bytes[q + 1] << 8) | (bytes[q + 2] << 16) | (bytes[q + 3] << 24)) >>> 0 : ((bytes[q] << 24) | (bytes[q + 1] << 16) | (bytes[q + 2] << 8) | bytes[q + 3]) >>> 0);
      const wr = (q, v) => { if (le) { bytes[q] = v & 255; bytes[q + 1] = (v >>> 8) & 255; bytes[q + 2] = (v >>> 16) & 255; bytes[q + 3] = (v >>> 24) & 255; } else { bytes[q] = (v >>> 24) & 255; bytes[q + 1] = (v >>> 16) & 255; bytes[q + 2] = (v >>> 8) & 255; bytes[q + 3] = v & 255; } };
      let acc = rd(o);
      for (let c = 1; c < w; c++) { const q = o + c * 4; acc = (acc + rd(q)) >>> 0; wr(q, acc); }
    } else throw new Error('predictor 2 on 64-bit samples not supported');
  }
}

// Floating-point predictor: per row, the bytes are differenced then stored planar (all first bytes of every sample,
// then all second bytes...), big-endian. Returns the row-interleaved big-endian bytes.
function undoFloatPredictor(bytes, w, rows, bps) {
  const out = new Uint8Array(bytes.length);
  const rowLen = w * bps;
  for (let r = 0; r < rows; r++) {
    const o = r * rowLen;
    for (let i = 1; i < rowLen; i++) bytes[o + i] = (bytes[o + i] + bytes[o + i - 1]) & 255;
    for (let c = 0; c < w; c++) for (let b = 0; b < bps; b++) out[o + c * bps + b] = bytes[o + b * w + c];
  }
  return out;
}

function readSample(bytes, o, bps, format, le) {
  const dv = readSample.dv && readSample.dv.buffer === bytes.buffer && readSample.dv.byteOffset === bytes.byteOffset
    ? readSample.dv : (readSample.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (format === 3) return bps === 4 ? dv.getFloat32(o, le) : dv.getFloat64(o, le);
  if (format === 2) return bps === 1 ? dv.getInt8(o) : bps === 2 ? dv.getInt16(o, le) : dv.getInt32(o, le);
  return bps === 1 ? dv.getUint8(o) : bps === 2 ? dv.getUint16(o, le) : dv.getUint32(o, le);
}
