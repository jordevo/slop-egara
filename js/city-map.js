import { GEO } from './terrassa-geodata.js';
import {
  ROADS,
  STREET_INDEX,
  BLOCKS,
  PARKS,
  LANDUSE,
  WATERWAYS,
  RAIL_LINES,
  MUNICIPALITY_RINGS,
  MUNICIPALITIES,
  LAND_RING,
  WORLD_BOUNDS,
  DISTRICTS,
  SQUARES,
  CITY_LANDMARKS,
  LANDMARK_SITES,
  MODELLED_LANDMARKS,
  SPAWN,
  LAND_CLASS,
  UNNAMED,
  getIslandBoundsAtZ,
  getLocationLabel,
  isTypingInField
} from './city-config.js';

// js/city-map.js
// GTA 6-Style Live Radar Minimap + Full-Screen Interactive Cartographic Atlas of Terrassa.
// Synchronized 1:1 with the 3D world (1 unit = 1 m; x = east along the Eixample's street grid, z = grid south, so
// both maps are drawn "grid north up", 13.7° west of true north). They draw the very geography the city is built from
// (GEO, from OpenStreetMap): the detailed urban area over the Vallès countryside, the municipal boundary and the
// neighbouring municipalities, every curb island (block) coloured by its land use with the building footprints
// standing on it, the parks and squares, the rieras and torrents, the railways, the real street centrelines
// (labelled along their course, with the main roads and the motorways & rondes in their own weights) and the
// landmark lots.

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MIN_ZOOM = 0.03; // full map, pixels per metre: Terrassa and the municipalities around it (~60 km across)
const MAX_ZOOM = 3.0; // single lots
const RADAR_SCALE = 0.32; // radar pixels per metre on the ground (zooms out with altitude)
// The grid's north, in degrees east of true north (negative: the Eixample grid leans west of it)
const GRID_BEARING = GEO && GEO.frame && typeof GEO.frame.bearingDeg === 'number' ? GEO.frame.bearingDeg : -13.7;

// The data the maps draw (tolerant of the unit tests' partial stubs)
const list = (v) => (Array.isArray(v) ? v : []);
const LC = LAND_CLASS || { NONE: 0, PARK: 1, SPORTS: 2, WOOD: 3, SCRUB: 4, FARM: 5, INDUSTRIAL: 6, CEMETERY: 7, RAILWAY: 8, PARKING: 9, WATER: 10, CAMPUS: 11, PLAZA: 12, GRASS: 13 };
const NO_NAME = UNNAMED || 'Carrer sense nom';
const BOUNDS = WORLD_BOUNDS || { minX: -4000, maxX: 4500, minZ: -5800, maxZ: 3400 };

// Map palette, shared by the radar & the atlas (in step with css/style.css): a dark atlas with the detailed area's
// roadway a shade lighter than the warm paper tone of the blocks between the streets, open land by its use (parks,
// woods, fields, water, industry), a Terrassa-red GPS route, white landmarks & player, cyan search hits, amber
// motorways and pale yellow main roads
const MAP = {
  base: '#141a18', // the Vallès countryside beyond the detailed area
  neighbourEdge: 'rgba(255, 255, 255, 0.09)', // the neighbouring municipalities' outlines
  municipal: 'rgba(214, 170, 236, 0.55)', // Terrassa's municipal boundary (dashed)
  streets: '#3a414b', // the detailed area: the roadway left between the blocks
  landEdge: '#4a5563',
  block: '#2b2824', // built blocks: warm paper
  blockEdge: '#38332d',
  parkEdge: '#2f6040',
  waterway: '#2d6f9c',
  rail: '#5c636c',
  railTie: '#1b1f24',
  buildings: ['#37312b', '#403932', '#4a423a'],
  buildingEdge: '#1d1a17',
  landmarkFill: 'rgba(255, 255, 255, 0.06)',
  landmarkEdge: 'rgba(255, 255, 255, 0.38)',
  motorway: '#c98a3a',
  mainRoad: '#e2dbb9', // primary & secondary roads, avenues & rondes at low zoom
  mainRoadAxis: 'rgba(226, 219, 185, 0.3)', // their centreline between the blocks at high zoom
  street: 'rgba(150, 159, 171, 0.5)',
  pedestrian: 'rgba(170, 176, 184, 0.75)',
  route: '#e8364a',
  search: '#5fd0ff',
  halo: 'rgba(8, 11, 15, 0.9)'
};
// Open blocks (no buildings) by their dominant land use
const OPEN_FILL = {
  [LC.PARK]: '#1f3b27', [LC.GRASS]: '#243a2a', [LC.SPORTS]: '#1f3d36', [LC.WOOD]: '#172b1c', [LC.SCRUB]: '#34351f',
  [LC.FARM]: '#3e3922', [LC.CEMETERY]: '#2b3a2d', [LC.WATER]: '#143450', [LC.INDUSTRIAL]: '#30283a', [LC.RAILWAY]: '#30333a',
  [LC.PARKING]: '#35363c', [LC.PLAZA]: '#3d382f', [LC.CAMPUS]: '#2c2f2b'
};
// Land-use polygons drawn under the blocks (the countryside: woods, fields, scrub, water, cemeteries)
const LANDUSE_FILL = {
  [LC.WOOD]: '#172b1c', [LC.SCRUB]: '#2c2e1c', [LC.FARM]: '#34301f', [LC.WATER]: '#143450', [LC.CEMETERY]: '#2b3a2d', [LC.PARK]: '#1f3b27'
};

// ---------------------------------------------------------------------------------------------------------------------
// World-space vector layers: built once into Path2D objects (world metres) and drawn through a canvas transform
// ---------------------------------------------------------------------------------------------------------------------

// Point accessors for rings / polylines given as [{x, z}, ...] or flat [x0, z0, x1, z1, ...]
function accessor(pts) {
  const flat = typeof pts[0] === 'number';
  return {
    n: flat ? pts.length >> 1 : pts.length,
    X: flat ? (i) => pts[2 * i] : (i) => pts[i].x,
    Z: flat ? (i) => pts[2 * i + 1] : (i) => pts[i].z
  };
}

function boundsOf(pts) {
  const { n, X, Z } = accessor(pts);
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < n; i++) {
    const x = X(i);
    const z = Z(i);
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

// Area centroid of a ring (its bounds centre for degenerate rings)
function centroidOf(pts) {
  const { n, X, Z } = accessor(pts);
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const c = X(j) * Z(i) - X(i) * Z(j);
    a += c;
    cx += (X(j) + X(i)) * c;
    cz += (Z(j) + Z(i)) * c;
  }
  if (Math.abs(a) < 1e-6) {
    const b = boundsOf(pts);
    return { x: (b.minX + b.maxX) * 0.5, z: (b.minZ + b.maxZ) * 0.5, area: 0 };
  }
  return { x: cx / (3 * a), z: cz / (3 * a), area: Math.abs(a) * 0.5 };
}

// Appends a closed ring, always wound the same way as Path2D.rect (so overlapping rings of one path union under the
// nonzero fill rule instead of cancelling out)
function addRing(path, pts) {
  if (!pts || pts.length < 3) return;
  const { n, X, Z } = accessor(pts);
  if (n < 3) return;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += X(j) * Z(i) - X(i) * Z(j);
  if (a >= 0) {
    path.moveTo(X(0), Z(0));
    for (let i = 1; i < n; i++) path.lineTo(X(i), Z(i));
  } else {
    path.moveTo(X(n - 1), Z(n - 1));
    for (let i = n - 2; i >= 0; i--) path.lineTo(X(i), Z(i));
  }
  path.closePath();
}

// Appends a closed ring as given (outer ring + holes of one polygon, filled with the evenodd rule)
function addRingRaw(path, pts) {
  if (!pts || pts.length < 3) return;
  const { n, X, Z } = accessor(pts);
  if (n < 3) return;
  path.moveTo(X(0), Z(0));
  for (let i = 1; i < n; i++) path.lineTo(X(i), Z(i));
  path.closePath();
}

function addLine(path, pts) {
  if (!pts || pts.length < 2) return;
  const { n, X, Z } = accessor(pts);
  path.moveTo(X(0), Z(0));
  for (let i = 1; i < n; i++) path.lineTo(X(i), Z(i));
}

/**
 * A vector layer split into square tiles of Path2D, so a view only rasterizes the tiles it overlaps. Every item goes
 * to the tile holding its centre; a tile's bounds grow to cover its items.
 */
class TiledLayer {
  constructor(size = 500) {
    this.size = size;
    this.tiles = new Map();
  }

  pathFor(b) {
    const ix = Math.floor((b.minX + b.maxX) * 0.5 / this.size);
    const iz = Math.floor((b.minZ + b.maxZ) * 0.5 / this.size);
    const key = `${ix},${iz}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { path: new Path2D(), minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
      this.tiles.set(key, t);
    } else {
      t.minX = Math.min(t.minX, b.minX);
      t.maxX = Math.max(t.maxX, b.maxX);
      t.minZ = Math.min(t.minZ, b.minZ);
      t.maxZ = Math.max(t.maxZ, b.maxZ);
    }
    return t.path;
  }

  ring(pts) {
    if (pts && pts.length > 2) addRing(this.pathFor(boundsOf(pts)), pts);
  }

  line(pts) {
    if (pts && pts.length > 1) addLine(this.pathFor(boundsOf(pts)), pts);
  }

  rect(x0, z0, x1, z1) {
    this.pathFor({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 }).rect(x0, z0, x1 - x0, z1 - z0);
  }

  /** Calls fn(path) for every tile overlapping the view */
  each(v, fn) {
    for (const t of this.tiles.values()) {
      if (t.maxX < v.minX || t.minX > v.maxX || t.maxZ < v.minZ || t.minZ > v.maxZ) continue;
      fn(t.path);
    }
  }
}

let LAYERS = null;
function mapLayers() {
  if (LAYERS) return LAYERS;
  const L = {};

  // The municipalities around Terrassa (outlined), Terrassa's own municipal boundary (dashed) and the detailed area
  L.neighbours = new Path2D();
  for (const m of list(MUNICIPALITIES)) for (const ring of list(m.rings)) addRing(L.neighbours, ring);
  L.municipal = new Path2D();
  for (const ring of list(MUNICIPALITY_RINGS)) addRing(L.municipal, ring);
  L.land = new Path2D();
  addRing(L.land, list(LAND_RING));

  // Countryside land use under the blocks: one path per polygon (outer ring + holes, evenodd)
  L.landuse = [];
  for (const lu of list(LANDUSE)) {
    const fill = LANDUSE_FILL[lu.cls];
    const rings = list(lu.rings);
    if (!fill || !rings.length || rings[0].length < 3) continue;
    const path = new Path2D();
    for (const ring of rings) addRingRaw(path, ring);
    L.landuse.push({ path, fill, ...boundsOf(rings[0]) });
  }

  // The curb islands (blocks: raised sidewalks & lots), by their fill: built blocks in the paper tone, open blocks by
  // their land use (exactly as city-grid.js / buildings.js treat them)
  L.blocks = new Map(); // fill colour -> TiledLayer
  const blockLayer = (fill) => {
    let layer = L.blocks.get(fill);
    if (!layer) L.blocks.set(fill, (layer = new TiledLayer()));
    return layer;
  };
  L.built = blockLayer(MAP.block);
  for (const b of list(BLOCKS)) {
    let fill = MAP.block;
    if (!b.median) {
      if (b.open && OPEN_FILL[b.cls]) fill = OPEN_FILL[b.cls];
      else if (b.park > 0.6) fill = OPEN_FILL[LC.PARK];
    }
    blockLayer(fill).ring(b.poly);
  }

  // Parks & squares (real outlines) for their edge line
  L.parks = new TiledLayer();
  for (const p of list(PARKS)) for (const ring of list(p.rings)) L.parks.ring(ring);

  // Rieras & torrents by width (the Riera de les Arenes is a 28 m canal, the torrents a few metres)
  L.water = new Map(); // width -> Path2D
  for (const w of list(WATERWAYS)) {
    const width = Math.max(2, w.w || 3.5);
    let path = L.water.get(width);
    if (!path) L.water.set(width, (path = new Path2D()));
    addLine(path, w.pts);
  }

  // Railways (Renfe R4 & FGC where they run in the open)
  L.rail = new Path2D();
  for (const r of list(RAIL_LINES)) addLine(L.rail, r.pts);

  // Street network by hierarchy: motorways & rondes, main roads (primary / secondary & the avenues, rambles,
  // passeigs, carreteres), ordinary streets and pedestrian streets & paths
  L.motorways = new Path2D();
  L.mainRoads = new TiledLayer(1000);
  L.streets = new TiledLayer(1000);
  L.pedestrian = new TiledLayer(1000);
  for (const r of list(ROADS)) {
    if (r.cls === 1 || r.highway) addLine(L.motorways, r.pts);
    else if (r.cls === 3 || r.pedestrian) L.pedestrian.line(r.pts);
    else if (r.cls === 2 || r.major) L.mainRoads.line(r.pts);
    else L.streets.line(r.pts);
  }

  // Landmark lots (the sites landmarks.js models on their real OpenStreetMap footprints)
  L.landmarks = new Path2D();
  for (const name of list(MODELLED_LANDMARKS)) {
    const s = LANDMARK_SITES && LANDMARK_SITES[name];
    if (s && s.ring) addRing(L.landmarks, s.ring);
  }

  LAYERS = L;
  return L;
}

// Building footprints as generated by buildings.js, by height: up to 15 m, 30 m, taller
let FOOTPRINTS = null;
function footprintLayers(all) {
  if (!all || !all.length) return null;
  if (FOOTPRINTS && FOOTPRINTS.src === all && FOOTPRINTS.n === all.length) return FOOTPRINTS;
  const tones = [new TiledLayer(), new TiledLayer(), new TiledLayer()];
  for (const blk of all) {
    for (const f of blk.footprints || []) {
      const layer = tones[f.h > 30 ? 2 : f.h > 15 ? 1 : 0];
      if (f.pts) layer.ring(f.pts); // turned to follow a non-grid street
      else layer.rect(f.x0, f.z0, f.x1, f.z1);
    }
  }
  FOOTPRINTS = { src: all, n: all.length, tones, version: FOOTPRINTS ? FOOTPRINTS.version + 1 : 1 };
  return FOOTPRINTS;
}

// Street name labels: anchors every ~260 m along each straight run of a real centreline (fixed in the world, so labels
// never slide while the map pans), with the direction of the street there (never upside down: vertical names read
// upwards)
const ROAD_LABELS = [];
for (const r of list(ROADS)) {
  const text = r.name;
  if (!text || text === NO_NAME) continue;
  const anchors = [];
  const pts = r.pts;
  for (let i = 0; i + 1 < pts.length;) {
    // the straight run from pts[i]: consecutive segments within ~5° of its first one
    const a = pts[i];
    const dir = Math.atan2(pts[i + 1].z - a.z, pts[i + 1].x - a.x);
    let j = i + 1;
    while (j + 1 < pts.length) {
      const d = Math.atan2(pts[j + 1].z - pts[j].z, pts[j + 1].x - pts[j].x);
      let turn = Math.abs(d - dir);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn > 0.09) break;
      j++;
    }
    const c = pts[j];
    i = j;
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    if (len < 20) continue;
    let ang = Math.atan2(c.z - a.z, c.x - a.x);
    if (ang >= Math.PI * 0.5 - 0.01) ang -= Math.PI;
    else if (ang < -Math.PI * 0.5 - 0.01) ang += Math.PI;
    const k = Math.max(1, Math.round(len / 260));
    for (let m = 0; m < k; m++) {
      const t = (m + 0.5) / k;
      anchors.push({ x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t, ang, len: len / k });
    }
  }
  if (!anchors.length) continue;
  ROAD_LABELS.push({
    text,
    lower: text.toLowerCase(),
    raw: (r.raw || text).toLowerCase(),
    road: r,
    major: !!(r.major || r.cls === 1 || r.cls === 2),
    highway: !!(r.highway || r.cls === 1),
    pedestrian: !!(r.pedestrian || r.cls === 3),
    anchors,
    ...boundsOf(r.pts)
  });
}
const STREET_COUNT = list(STREET_INDEX).length || new Set(ROAD_LABELS.map((l) => l.text)).size;

// Area names: the municipalities (kind 0, zoomed out), the barris (kind 2, mid zoom) and the squares (kind 3, close
// up), at their real places (world metres); the parks are labelled by their outlines' size on screen
const AREA_LABELS = [];
for (const m of list(MUNICIPALITIES)) {
  let best = null;
  for (const ring of list(m.rings)) {
    const c = centroidOf(ring);
    if (!best || c.area > best.area) best = c;
  }
  if (best && m.name) AREA_LABELS.push([m.name.toUpperCase(), best.x, best.z, 0]);
}
if (list(MUNICIPALITY_RINGS).length) {
  const c = centroidOf(MUNICIPALITY_RINGS[0]);
  AREA_LABELS.push([(GEO && GEO.city ? GEO.city : 'Terrassa').toUpperCase(), c.x, c.z, 0]);
}
for (const d of list(DISTRICTS)) if (d.name) AREA_LABELS.push([d.name, d.x, d.z, 2]);
for (const sq of list(SQUARES)) if (sq.name) AREA_LABELS.push([sq.name, sq.x, sq.z, 3]);
const PARK_LABELS = (() => {
  const seen = new Set();
  const out = [];
  for (const p of list(PARKS)) {
    if (!p.name || seen.has(p.name) || !p.rings || !p.rings[0]) continue;
    seen.add(p.name);
    const c = centroidOf(p.rings[0]);
    out.push({ name: p.name, x: c.x, z: c.z, area: p.area || c.area, ...boundsOf(p.rings[0]) });
  }
  return out.sort((a, b) => b.area - a.area);
})();

/** A map viewport: centre (cx, cz) in world metres, s pixels per metre, w x h CSS pixels on a canvas of pixel ratio dpr */
class MapView {
  constructor(cx, cz, s, w, h, dpr = 1) {
    this.cx = cx;
    this.cz = cz;
    this.s = s;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.minX = cx - w / (2 * s);
    this.maxX = cx + w / (2 * s);
    this.minZ = cz - h / (2 * s);
    this.maxZ = cz + h / (2 * s);
  }

  /** Canvas transform for world metres */
  world(ctx) {
    const { s, dpr } = this;
    ctx.setTransform(s * dpr, 0, 0, s * dpr, dpr * (this.w * 0.5 - this.cx * s), dpr * (this.h * 0.5 - this.cz * s));
  }

  /** Canvas transform for CSS pixels from the canvas centre (what toX / toY return) */
  screen(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * this.w * 0.5, this.dpr * this.h * 0.5);
  }

  toX(x) {
    return (x - this.cx) * this.s;
  }

  toY(z) {
    return (z - this.cz) * this.s;
  }

  sees(b) {
    return b && b.maxX >= this.minX && b.minX <= this.maxX && b.maxZ >= this.minZ && b.minZ <= this.maxZ;
  }
}

// Player heading arrow at the (already rotated) origin: white, on a dark halo
function drawPlayerArrow(ctx, tipY, halfWidth, tailY) {
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(halfWidth, tailY);
  ctx.lineTo(0, tailY * 0.45);
  ctx.lineTo(-halfWidth, tailY);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// GPS route from the player to the waypoint, as the crow flies (there is no grid to follow): Terrassa red on a dark
// casing
function drawRoute(ctx, x0, y0, x1, y1, width) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = width + 3;
  ctx.stroke();
  ctx.strokeStyle = MAP.route;
  ctx.lineWidth = width;
  ctx.stroke();
}

// Waypoint: a red target
function drawWaypoint(ctx, x, y, r) {
  ctx.fillStyle = MAP.halo;
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MAP.route;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MAP.halo;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.38, 0, Math.PI * 2);
  ctx.fill();
}

const overlaps = (boxes, b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

class CityMapSystem {
  constructor({ controllerManager, cameraSystem, trafficSystem, allBlocks = [], onTeleport, onToggle }) {
    this.controllerManager = controllerManager;
    this.cameraSystem = cameraSystem;
    this.trafficSystem = trafficSystem;
    this.allBlocks = allBlocks;
    this.onTeleport = onTeleport;
    this.onToggle = onToggle;

    this.miniCanvas = document.getElementById('minimap-canvas');
    this.miniCtx = this.miniCanvas ? this.miniCanvas.getContext('2d') : null;
    this.elMiniStreet = document.getElementById('minimap-street-label');
    this.miniStreetText = '';
    this.miniScale = RADAR_SCALE;
    this.miniCache = null; // { canvas, cx, cz, s, version }: the radar's ground layers, twice the radar's size
    const elCounts = document.getElementById('fullmap-counts');
    if (elCounts) elCounts.textContent = `${STREET_COUNT.toLocaleString('en-US')} streets · ${list(BLOCKS).length.toLocaleString('en-US')} blocks`;

    // The map is drawn grid north up; the compass needle points to true north, 13.7° to its right
    const needle = document.getElementById('map-compass-needle');
    if (needle) needle.setAttribute('transform', `rotate(${-GRID_BEARING} 22 22)`);

    this.modal = document.getElementById('fullmap-modal');
    this.fullCanvas = document.getElementById('fullmap-canvas');
    this.fullCanvasWrap = document.getElementById('fullmap-canvas-wrap');
    this.fullCtx = this.fullCanvas ? this.fullCanvas.getContext('2d') : null;
    this.fullDpr = 1;
    this.fullStatic = null; // the full map's ground layers & labels for the current view
    this.fullStaticKey = '';
    this.elHoverInfo = document.getElementById('fullmap-hover-info');
    this.elPlayerInfo = document.getElementById('fullmap-player-info');
    this.elSearchInput = document.getElementById('fullmap-search');
    if (this.elSearchInput) this.elSearchInput.placeholder = `Search ${STREET_COUNT.toLocaleString('en-US')} streets & places — Rambla d'Ègara, Carrer de Sant Pere, Vallparadís…`;

    this.isFullMapOpen = false;
    // Full map viewport state (world metres; zoom in CSS pixels per metre)
    this.viewCenterX = 0;
    this.viewCenterZ = 0;
    this.viewZoom = 0.22;
    this.isPanning = false;
    this.panPointerId = null;
    this.panStart = { x: 0, y: 0, cx: 0, cz: 0 };
    this.dragMoved = false;

    this.hoverWorld = null;
    this.searchHighlight = '';
    this.searchPath = null;
    this.textWidths = new Map();
    // Default GTA 6-style active GPS waypoint: the Plaça Vella, the origin of the world (where everyone spawns)
    const pv = list(CITY_LANDMARKS).find((l) => l.id === 'placavella') || SPAWN || { x: 0, z: 0 };
    this.waypoint = { x: pv.x, z: pv.z, name: 'Plaça Vella' };

    // Street names measured before the web font arrived would be spaced for the fallback font: measure & draw again
    if (document.fonts) {
      document.fonts.ready.then(() => {
        this.textWidths.clear();
        this.miniCache = null;
        this.fullStaticKey = '';
      });
    }

    this.initEvents();
  }

  initEvents() {
    const closeBtn = document.getElementById('close-fullmap-btn');
    const miniCard = document.getElementById('minimap-card');
    const zoomInBtn = document.getElementById('map-zoom-in');
    const zoomOutBtn = document.getElementById('map-zoom-out');
    const centerPlayerBtn = document.getElementById('map-center-player');
    const viewAllBtn = document.getElementById('map-view-all');

    if (miniCard) {
      miniCard.addEventListener('click', () => this.toggleFullMap(true));
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggleFullMap(false));
    }

    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        this.viewZoom = Math.min(MAX_ZOOM, this.viewZoom * 1.45);
        this.renderFullMap();
      });
    }
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        this.viewZoom = Math.max(MIN_ZOOM, this.viewZoom / 1.45);
        this.renderFullMap();
      });
    }
    if (centerPlayerBtn) {
      centerPlayerBtn.addEventListener('click', () => {
        const ent = this.controllerManager.getActiveEntity();
        this.viewCenterX = ent.position.x;
        this.viewCenterZ = ent.position.z;
        this.viewZoom = 0.9; // Street-by-street detail zoom
        this.renderFullMap();
      });
    }
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', () => this.fitBounds(BOUNDS, 1.08, 1.06));
    }

    if (this.elSearchInput) {
      this.elSearchInput.addEventListener('input', () => this.search(this.elSearchInput.value));
    }

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isFullMapOpen) {
        this.toggleFullMap(false);
      } else if (e.code === 'KeyM' && !isTypingInField(e)) {
        this.toggleFullMap(!this.isFullMapOpen);
      }
    });

    if (this.fullCanvas) {
      this.fullCanvas.style.touchAction = 'none';
      this.fullCanvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this.isFullMapOpen || this.panPointerId !== null) return;
        e.preventDefault();
        this.panPointerId = e.pointerId;
        this.fullCanvas.setPointerCapture(e.pointerId);
        this.isPanning = true;
        this.dragMoved = false;
        this.panStart.x = e.clientX;
        this.panStart.y = e.clientY;
        this.panStart.cx = this.viewCenterX;
        this.panStart.cz = this.viewCenterZ;
        if (this.fullCanvasWrap) this.fullCanvasWrap.classList.add('is-panning');
      });

      this.fullCanvas.addEventListener('pointermove', (e) => {
        if (!this.isFullMapOpen || !this.fullCanvas) return;
        if (this.isPanning ? e.pointerId !== this.panPointerId : e.pointerType !== 'mouse') return;
        const rect = this.fullCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (this.isPanning) {
          e.preventDefault();
          const dx = e.clientX - this.panStart.x;
          const dy = e.clientY - this.panStart.y;
          if (Math.hypot(dx, dy) > 5) this.dragMoved = true;
          this.viewCenterX = this.panStart.cx - dx / this.viewZoom;
          this.viewCenterZ = this.panStart.cz - dy / this.viewZoom;
          this.renderFullMap();
          return;
        }

        if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
          const wPos = this.screenToWorld(mx, my, rect.width, rect.height);
          this.hoverWorld = wPos;
          if (this.elHoverInfo) {
            this.elHoverInfo.textContent = `${getLocationLabel(wPos.x, wPos.z)} · Click to teleport here`;
          }
        }
      });

      this.fullCanvas.addEventListener('pointerup', (e) => {
        if (e.pointerId !== this.panPointerId) return;
        const clicked = !this.dragMoved && Math.hypot(e.clientX - this.panStart.x, e.clientY - this.panStart.y) <= 5;
        this.cancelPan();
        if (clicked && this.isFullMapOpen && this.fullCanvas) {
          const rect = this.fullCanvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
            const wPos = this.clampToWorld(this.screenToWorld(mx, my, rect.width, rect.height));
            this.waypoint = {
              x: wPos.x,
              z: wPos.z,
              name: getLocationLabel(wPos.x, wPos.z)
            };
            if (this.onTeleport) {
              this.onTeleport(wPos.x, wPos.z);
            }
            this.renderFullMap();
          }
        }
      });
      for (const type of ['pointercancel', 'lostpointercapture']) {
        this.fullCanvas.addEventListener(type, (e) => {
          if (e.pointerId === this.panPointerId) this.cancelPan();
        });
      }
      window.addEventListener('blur', () => this.cancelPan());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.cancelPan();
      });

      // Wheel zoom about the cursor (the place under it stays put)
      this.fullCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = this.fullCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const before = this.screenToWorld(mx, my, rect.width, rect.height);
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        this.viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * factor));
        this.viewCenterX = before.x - (mx - rect.width * 0.5) / this.viewZoom;
        this.viewCenterZ = before.z - (my - rect.height * 0.5) / this.viewZoom;
        this.renderFullMap();
      }, { passive: false });
    }
  }

  /** Frames a world rectangle in the full map (padX / padZ: margins as a share of its size) */
  fitBounds(b, padX = 1.3, padZ = 1.3, maxZoom = MAX_ZOOM) {
    const { w, h } = this.fullSize();
    this.viewCenterX = (b.minX + b.maxX) * 0.5;
    this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
    const fit = Math.min(w / ((b.maxX - b.minX) * padX + 1), h / ((b.maxZ - b.minZ) * padZ + 1));
    this.viewZoom = Math.max(MIN_ZOOM, Math.min(maxZoom, fit));
    this.renderFullMap();
  }

  /**
   * Street & place search: highlights every stretch of the matching streets and frames them, or flies to the matching
   * landmark, park or barri
   */
  search(text) {
    const q = String(text || '').trim().toLowerCase();
    this.searchHighlight = q;
    this.searchPath = null;
    if (q.length > 0) {
      const lmMatch = list(CITY_LANDMARKS).find((l) => l.name.toLowerCase().includes(q) || l.short.toLowerCase().includes(q));
      const streets = list(STREET_INDEX).filter((e) => e.name.toLowerCase().includes(q));
      const park = PARK_LABELS.find((p) => p.name.toLowerCase().includes(q));
      const district = list(DISTRICTS).find((d) => d.name.toLowerCase().includes(q));
      if (streets.length) {
        this.searchPath = new Path2D();
        const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (const e of streets) {
          for (const r of e.roads) addLine(this.searchPath, r.pts);
          b.minX = Math.min(b.minX, e.minX);
          b.maxX = Math.max(b.maxX, e.maxX);
          b.minZ = Math.min(b.minZ, e.minZ);
          b.maxZ = Math.max(b.maxZ, e.maxZ);
        }
        this.searchBounds = b;
      }
      if (lmMatch) {
        this.viewCenterX = lmMatch.x;
        this.viewCenterZ = lmMatch.z;
        this.viewZoom = Math.max(this.viewZoom, 0.9);
      } else if (streets.length) {
        this.fitBounds(this.searchBounds, 1.3, 1.3, 1.2);
        if (this.viewZoom < 0.05) this.viewZoom = 0.05;
      } else if (park) {
        this.fitBounds(park, 1.6, 1.6, 1.2);
      } else if (district) {
        this.viewCenterX = district.x;
        this.viewCenterZ = district.z;
        this.viewZoom = Math.max(Math.min(this.viewZoom, 0.6), 0.3);
      }
    }
    this.renderFullMap();
  }

  cancelPan() {
    const id = this.panPointerId;
    this.panPointerId = null;
    this.isPanning = false;
    if (this.fullCanvasWrap) this.fullCanvasWrap.classList.remove('is-panning');
    if (id !== null && this.fullCanvas && this.fullCanvas.hasPointerCapture(id)) this.fullCanvas.releasePointerCapture(id);
  }

  toggleFullMap(open) {
    this.isFullMapOpen = Boolean(open);
    if (!this.isFullMapOpen) this.cancelPan();
    if (this.onToggle) this.onToggle(this.isFullMapOpen);
    if (!this.modal) return;
    this.modal.classList.toggle('hidden', !this.isFullMapOpen);
    if (this.isFullMapOpen) {
      // the HUD's popovers live in the top layer, above the map
      for (const pop of document.querySelectorAll('.popover[popover]')) {
        if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) pop.hidePopover();
      }
      const ent = this.controllerManager.getActiveEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.resizeFullCanvas();
      this.renderFullMap();
    }
  }

  resizeFullCanvas() {
    if (!this.fullCanvas) return;
    // Layout size (the opening animation's transforms don't change it), at most ~6 megapixels however large the screen
    const w = this.fullCanvas.clientWidth || window.innerWidth;
    const h = this.fullCanvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6e6 / Math.max(1, w * h)));
    this.fullDpr = dpr;
    this.fullCanvas.width = Math.max(1, Math.floor(w * dpr));
    this.fullCanvas.height = Math.max(1, Math.floor(h * dpr));
  }

  // Full map size in CSS pixels
  fullSize() {
    const dpr = this.fullDpr || 1;
    if (!this.fullCanvas) return { w: 1200, h: 800 };
    return { w: this.fullCanvas.width / dpr, h: this.fullCanvas.height / dpr };
  }

  screenToWorld(sx, sy, width, height) {
    return {
      x: this.viewCenterX + (sx - width * 0.5) / this.viewZoom,
      z: this.viewCenterZ + (sy - height * 0.5) / this.viewZoom
    };
  }

  // Teleports land in the detailed area: inside the world bounds and the land's extent at that z
  clampToWorld(p) {
    const z = Math.max(BOUNDS.minZ + 25, Math.min(BOUNDS.maxZ - 25, p.z));
    let x = Math.max(BOUNDS.minX + 12, Math.min(BOUNDS.maxX - 12, p.x));
    if (typeof getIslandBoundsAtZ === 'function') {
      const edge = getIslandBoundsAtZ(z);
      if (Number.isFinite(edge.westX) && Number.isFinite(edge.eastX)) x = Math.max(edge.westX + 12, Math.min(edge.eastX - 12, x));
    }
    return { x, z };
  }

  textWidth(ctx, text) {
    const key = `${ctx.font}|${ctx.letterSpacing || ''}|${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.textWidths.set(key, w);
    }
    return w;
  }

  /**
   * The ground: the Vallès, the municipalities, the detailed area, land use, blocks, parks, rieras, railways,
   * building footprints, landmark lots, the street hierarchy and the search highlight (world transform of view v)
   */
  drawWorld(ctx, v, isMinimap) {
    const L = mapLayers();
    const s = v.s;
    const px = (n) => n / s; // screen pixels -> metres (line widths)
    v.world(ctx);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 1. The neighbouring municipalities (faint outlines) and the detailed area (roadway colour: the streets are the
    //    gaps between the blocks)
    if (!isMinimap) {
      ctx.lineWidth = px(1);
      ctx.strokeStyle = MAP.neighbourEdge;
      ctx.stroke(L.neighbours);
    }
    ctx.fillStyle = MAP.streets;
    ctx.fill(L.land);

    // 2. Countryside land use (woods, fields, water) under the blocks
    for (const lu of L.landuse) {
      if (!v.sees(lu)) continue;
      ctx.fillStyle = lu.fill;
      ctx.fill(lu.path, 'evenodd');
    }

    // 3. Blocks (curb islands) by their fill, open blocks by land use; the built blocks outlined when close
    for (const [fill, layer] of L.blocks) {
      ctx.fillStyle = fill;
      layer.each(v, (p) => ctx.fill(p));
    }
    if (s >= 0.22) {
      ctx.strokeStyle = MAP.blockEdge;
      ctx.lineWidth = px(Math.min(1.2, 0.5 + s));
      L.built.each(v, (p) => ctx.stroke(p));
    }

    // 4. Park & square outlines
    if (s >= 0.1) {
      ctx.strokeStyle = MAP.parkEdge;
      ctx.lineWidth = px(1);
      L.parks.each(v, (p) => ctx.stroke(p));
    }

    // 5. The edge of the detailed area and the municipal boundary (dashed)
    ctx.strokeStyle = MAP.landEdge;
    ctx.lineWidth = px(isMinimap ? 1.4 : 1.8);
    ctx.stroke(L.land);
    ctx.strokeStyle = MAP.municipal;
    ctx.lineWidth = px(1.5);
    ctx.setLineDash([px(9), px(5)]);
    ctx.stroke(L.municipal);
    ctx.setLineDash([]);

    // 6. Building footprints, lowest first
    if (s >= 0.18) {
      const fp = footprintLayers(this.allBlocks);
      if (fp) {
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = MAP.buildings[i];
          fp.tones[i].each(v, (p) => ctx.fill(p));
        }
        if (s >= 0.6) {
          ctx.strokeStyle = MAP.buildingEdge;
          ctx.lineWidth = px(0.8);
          for (let i = 0; i < 3; i++) fp.tones[i].each(v, (p) => ctx.stroke(p));
        }
      }
    }

    // 7. Landmark lots (real OpenStreetMap outlines)
    if (s >= 0.05) {
      ctx.fillStyle = MAP.block;
      ctx.fill(L.landmarks);
      ctx.fillStyle = MAP.landmarkFill;
      ctx.fill(L.landmarks);
      ctx.strokeStyle = MAP.landmarkEdge;
      ctx.lineWidth = px(Math.max(0.9, Math.min(1.6, 1.4 * s)));
      ctx.stroke(L.landmarks);
    }

    // 8. Rieras & torrents to their real width, railways as a hatched grey line
    ctx.strokeStyle = MAP.waterway;
    for (const [width, path] of L.water) {
      ctx.lineWidth = Math.max(px(1), width);
      ctx.stroke(path);
    }
    ctx.lineCap = 'butt';
    ctx.strokeStyle = MAP.rail;
    ctx.lineWidth = Math.max(px(1.6), 4);
    ctx.stroke(L.rail);
    if (s >= 0.08) {
      ctx.strokeStyle = MAP.railTie;
      ctx.lineWidth = Math.max(px(1.6), 4) * 0.5;
      ctx.setLineDash([Math.max(px(4), 8), Math.max(px(4), 8)]);
      ctx.stroke(L.rail);
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'round';

    // 9. Street hierarchy: streets & main roads as lines once the gaps between blocks are under a pixel, the main
    //    roads' axes between the blocks when close, pedestrian streets dotted, the motorways & rondes always
    if (s < 0.16) {
      if (s >= 0.045) {
        ctx.strokeStyle = MAP.street;
        ctx.lineWidth = px(0.6);
        L.streets.each(v, (p) => ctx.stroke(p));
      }
      ctx.strokeStyle = MAP.mainRoad;
      ctx.lineWidth = px(s < 0.06 ? 0.9 : 1.3);
      L.mainRoads.each(v, (p) => ctx.stroke(p));
    } else {
      ctx.strokeStyle = MAP.mainRoadAxis;
      ctx.lineWidth = Math.max(px(1), 1.2);
      L.mainRoads.each(v, (p) => ctx.stroke(p));
      if (s >= 0.25) {
        ctx.strokeStyle = MAP.pedestrian;
        ctx.lineWidth = px(1.2);
        ctx.setLineDash([px(2.5), px(3.5)]);
        L.pedestrian.each(v, (p) => ctx.stroke(p));
        ctx.setLineDash([]);
      }
    }
    ctx.strokeStyle = MAP.motorway;
    ctx.lineWidth = Math.max(px(isMinimap ? 2.4 : 1.6), 14);
    ctx.stroke(L.motorways);

    // 10. Search highlight: every stretch of the matching streets
    if (this.searchPath && !isMinimap) {
      ctx.strokeStyle = MAP.search;
      ctx.lineWidth = Math.max(px(3), 9);
      ctx.stroke(this.searchPath);
    }
  }

  /**
   * Street names along the streets (screen transform of view v): the best anchor of each street that fits its name,
   * one label per street per `sameNameGap` pixels, none overlapping another (or the boxes already in `placed`)
   */
  drawRoadLabels(ctx, v, { fontPx = 10, maxLabels = 400, sameNameGap = 260, placed = [], majorOnly = false } = {}) {
    const s = v.s;
    const q = this.searchHighlight;
    ctx.font = `600 ${fontPx}px ${FONT}`;
    const inset = (fontPx * 2.5) / s;
    const minX = v.minX + inset;
    const maxX = v.maxX - inset;
    const minZ = v.minZ + inset;
    const maxZ = v.maxZ - inset;
    const cands = [];
    for (const l of ROAD_LABELS) {
      if (l.maxX < minX || l.minX > maxX || l.maxZ < minZ || l.minZ > maxZ) continue;
      const hit = q.length > 0 && (l.lower.includes(q) || l.raw.includes(q));
      if (majorOnly && !l.major && !hit) continue;
      const width = this.textWidth(ctx, l.text);
      const need = (width + 14) / s;
      for (const a of l.anchors) {
        if (a.len < need || a.x < minX || a.x > maxX || a.z < minZ || a.z > maxZ) continue;
        const d = Math.hypot(a.x - v.cx, a.z - v.cz) * s;
        cands.push({ l, a, width, hit, score: (hit ? 1e6 : 0) + (l.highway ? 3000 : 0) + (l.major ? 2000 : 0) - (l.pedestrian ? 500 : 0) + Math.min(a.len * s, 400) - d * 0.5 });
      }
    }
    cands.sort((a, b) => b.score - a.score);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    const byName = new Map();
    let n = 0;
    for (const c of cands) {
      if (n >= maxLabels) break;
      const X = v.toX(c.a.x);
      const Y = v.toY(c.a.z);
      const same = byName.get(c.l.text);
      if (same && same.some(([x, y]) => Math.hypot(x - X, y - Y) < sameNameGap)) continue;
      const hw = c.width * 0.5 + 3;
      const hh = fontPx * 0.5 + 2;
      const ca = Math.abs(Math.cos(c.a.ang));
      const sa = Math.abs(Math.sin(c.a.ang));
      const bx = hw * ca + hh * sa;
      const by = hw * sa + hh * ca;
      const box = [X - bx, Y - by, X + bx, Y + by];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      if (same) same.push([X, Y]);
      else byName.set(c.l.text, [[X, Y]]);
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(c.a.ang);
      ctx.fillStyle = c.hit ? MAP.search : c.l.highway ? '#e3a857' : c.l.major ? '#efe9d2' : c.l.pedestrian ? '#8f979f' : '#9ba5b3';
      ctx.strokeText(c.l.text, 0, 0);
      ctx.fillText(c.l.text, 0, 0);
      ctx.restore();
      n++;
    }
    ctx.textBaseline = 'alphabetic';
  }

  update() {
    // The full map covers the whole screen, radar included
    if (this.isFullMapOpen) {
      this.renderFullMap();
    } else {
      this.renderMinimap();
    }
  }

  // =========================================================================
  // 1. GTA 6-STYLE LIVE RADAR MINIMAP (BOTTOM-LEFT HUD)
  // =========================================================================
  renderMinimap() {
    if (!this.miniCtx || !this.miniCanvas) return;
    // Nothing to draw while the radar is hidden (narrow screens, clean view)
    if (!this.miniCanvas.offsetParent || document.body.classList.contains('hud-minimized')) return;
    const ctx = this.miniCtx;
    // Radar size in CSS pixels, backed at the device pixel ratio (crisp street names on HiDPI screens)
    const w = this.miniCanvas.clientWidth;
    const h = this.miniCanvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.miniCanvas.width !== bw || this.miniCanvas.height !== bh) {
      this.miniCanvas.width = bw;
      this.miniCanvas.height = bh;
      this.miniCache = null;
    }

    const ent = this.controllerManager.getActiveEntity();
    const px = ent.position.x;
    const pz = ent.position.z;
    // Ground-level radar shows ~800 m of the city; it zooms out as the camera climbs (helicopter)
    const target = Math.max(0.05, RADAR_SCALE / (1 + Math.max(0, ent.position.y - 25) / 180));
    this.miniScale += (target - this.miniScale) * 0.08;
    const scale = this.miniScale;

    if (this.elMiniStreet) {
      const label = getLocationLabel(px, pz);
      if (label !== this.miniStreetText) {
        this.miniStreetText = label;
        this.elMiniStreet.textContent = label;
      }
    }

    // Ground layers & street names come from a cached render twice the radar's size, redrawn when the player nears its
    // edge or the zoom drifts (or the buildings arrive)
    const fp = footprintLayers(this.allBlocks);
    const version = fp ? fp.version : 0;
    let c = this.miniCache;
    if (!c || c.version !== version || Math.abs(scale / c.s - 1) > 0.12 ||
      Math.abs(px - c.cx) > w / c.s - w / (2 * scale) - 8 / scale ||
      Math.abs(pz - c.cz) > h / c.s - h / (2 * scale) - 8 / scale) {
      if (!c) {
        c = this.miniCache = { canvas: document.createElement('canvas') };
        c.canvas.width = bw * 2;
        c.canvas.height = bh * 2;
        c.ctx = c.canvas.getContext('2d');
      }
      c.cx = px;
      c.cz = pz;
      c.s = scale;
      c.version = version;
      c.ctx.setTransform(1, 0, 0, 1, 0, 0);
      c.ctx.fillStyle = MAP.base;
      c.ctx.fillRect(0, 0, bw * 2, bh * 2);
      const cv = new MapView(px, pz, scale, w * 2, h * 2, dpr);
      this.drawWorld(c.ctx, cv, true);
      cv.screen(c.ctx);
      this.drawRoadLabels(c.ctx, cv, { fontPx: 9.5, maxLabels: 28, sameNameGap: 180 });
    }

    const v = new MapView(px, pz, scale, w, h, dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP.base;
    ctx.fillRect(0, 0, bw, bh);
    const k = scale / c.s;
    ctx.drawImage(c.canvas, dpr * ((c.cx - w / c.s - px) * scale + w * 0.5), dpr * ((c.cz - h / c.s - pz) * scale + h * 0.5),
      dpr * w * 2 * k, dpr * h * 2 * k);

    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    // Live moving traffic blips on radar
    if (this.trafficSystem && this.trafficSystem.cars) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.34)';
      for (let i = 0; i < this.trafficSystem.cars.length; i += 2) {
        const car = this.trafficSystem.cars[i];
        const cx = toX(car.x);
        const cy = toY(car.z);
        if (Math.abs(cx) < w * 0.5 && Math.abs(cy) < h * 0.5) {
          ctx.fillRect(cx - 1, cy - 1, 2, 2);
        }
      }
    }

    // GPS route to the active waypoint
    if (this.waypoint) {
      const wx = toX(this.waypoint.x);
      const wy = toY(this.waypoint.z);
      drawRoute(ctx, 0, 0, wx, wy, 3);
      drawWaypoint(ctx, wx, wy, 4.5);
    }

    // Landmark blips
    for (const lm of list(CITY_LANDMARKS)) {
      const lx = toX(lm.x);
      const ly = toY(lm.z);
      if (Math.abs(lx) < w * 0.48 && Math.abs(ly) < h * 0.48) {
        ctx.fillStyle = MAP.halo;
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(lx, ly, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Camera FOV Cone & Player Arrow at center (0, 0)
    const camDir = this.cameraSystem.currentLookAt.clone().sub(this.cameraSystem.currentPos);
    const camAngle = Math.atan2(camDir.x, camDir.z);

    ctx.save();
    ctx.rotate(-camAngle + Math.PI);
    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 58);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 58, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Player heading arrow
    ctx.save();
    ctx.rotate(-ent.heading + Math.PI);
    drawPlayerArrow(ctx, -9, 6.5, 7);
    ctx.restore();

    ctx.restore();
  }

  // =========================================================================
  // 2. FULL TERRASSA INTERACTIVE STREET MAP MODAL ([M])
  // =========================================================================
  renderFullMap() {
    if (!this.fullCtx || !this.fullCanvas || !this.isFullMapOpen) return;
    const ctx = this.fullCtx;
    const dpr = this.fullDpr || 1;
    const { w, h } = this.fullSize();
    const v = new MapView(this.viewCenterX, this.viewCenterZ, this.viewZoom, w, h, dpr);

    const ent = this.controllerManager.getActiveEntity();
    if (this.elPlayerInfo) {
      const text = `You are at ${getLocationLabel(ent.position.x, ent.position.z)}`;
      if (text !== this.playerInfoText) {
        this.playerInfoText = text;
        this.elPlayerInfo.textContent = text;
      }
    }

    // Ground layers, names & landmark pins: re-rendered only when the view, the search or the buildings change
    const fp = footprintLayers(this.allBlocks);
    const key = `${v.cx}|${v.cz}|${v.s}|${this.fullCanvas.width}|${this.fullCanvas.height}|${this.searchHighlight}|${fp ? fp.version : 0}`;
    if (!this.fullStatic) this.fullStatic = document.createElement('canvas');
    if (key !== this.fullStaticKey) {
      this.fullStaticKey = key;
      const sc = this.fullStatic;
      if (sc.width !== this.fullCanvas.width || sc.height !== this.fullCanvas.height) {
        sc.width = this.fullCanvas.width;
        sc.height = this.fullCanvas.height;
      }
      this.renderFullMapStatic(sc.getContext('2d'), v);
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.fullStatic, 0, 0);
    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    // GPS route on the full map
    if (this.waypoint) {
      const wx = toX(this.waypoint.x);
      const wy = toY(this.waypoint.z);
      drawRoute(ctx, toX(ent.position.x), toY(ent.position.z), wx, wy, 4);
      drawWaypoint(ctx, wx, wy, 7);
    }

    // Live Player Blip & Heading Arrow, with a slow pulse to find it at a glance
    const px = toX(ent.position.x);
    const py = toY(ent.position.z);

    ctx.save();
    ctx.translate(px, py);
    const pulse = (performance.now() % 1800) / 1800;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.24 * (1 - pulse)})`;
    ctx.beginPath();
    ctx.arc(0, 0, 10 + pulse * 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(-ent.heading + Math.PI);
    drawPlayerArrow(ctx, -11, 7.5, 8);
    ctx.restore();

    ctx.restore();
  }

  renderFullMapStatic(ctx, v) {
    const { w, h, s } = v;
    ctx.save();
    // 1. The Vallès countryside as the base
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP.base;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // 2. The ground: municipalities, the detailed area, blocks, parks, rieras, footprints, streets & motorways
    this.drawWorld(ctx, v, false);

    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    // 3. Landmark pins & collision-free labels (placed first: their boxes keep the other names clear)
    ctx.font = `700 11px ${FONT}`;
    const placed = [];
    const pins = [];
    for (const lm of list(CITY_LANDMARKS)) {
      const lx = toX(lm.x);
      const ly = toY(lm.z);
      if (Math.abs(lx) > w * 0.48 || Math.abs(ly) > h * 0.48) continue;
      const labelW = this.textWidth(ctx, lm.short) + 6;
      const box = [lx + 6, ly - 8, lx + 8 + labelW, ly + 7];
      const showLabel = !overlaps(placed, box);
      placed.push([lx - 6, ly - 6, lx + 6, ly + 6]);
      if (showLabel) placed.push(box);
      pins.push({ lm, lx, ly, showLabel });
    }

    // 4. Municipality, barri, park & square names (wherever they fit), letter-spaced like a printed atlas
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tracking = 'letterSpacing' in ctx;
    const placeLabel = (label, x, z, pad = 8) => {
      const dx = toX(x);
      const dy = toY(z);
      if (Math.abs(dx) > w * 0.47 || Math.abs(dy) > h * 0.47) return;
      const half = this.textWidth(ctx, label) * 0.5 + 4;
      const box = [dx - half, dy - pad, dx + half, dy + pad];
      if (overlaps(placed, box)) return;
      placed.push(box);
      ctx.fillText(label, dx, dy);
    };
    for (const [label, x, z, kind] of AREA_LABELS) {
      if (kind === 0 && s > 0.075) continue;
      if (kind === 2 && (s < 0.055 || s > 1.2)) continue;
      if (kind === 3 && s < 0.45) continue;
      if (kind === 0) {
        ctx.font = `700 15px ${FONT}`;
        ctx.fillStyle = 'rgba(168, 178, 192, 0.5)';
        if (tracking) ctx.letterSpacing = '3px';
      } else if (kind === 2) {
        ctx.font = `700 10.5px ${FONT}`;
        ctx.fillStyle = 'rgba(168, 178, 192, 0.5)';
        if (tracking) ctx.letterSpacing = '1.8px';
      } else {
        ctx.font = `italic 600 10.5px ${FONT}`;
        ctx.fillStyle = 'rgba(214, 206, 180, 0.72)';
        if (tracking) ctx.letterSpacing = '0.4px';
      }
      placeLabel(label, x, z);
    }
    // Parks by their size on screen (a park is named once it covers a few thousand pixels)
    if (s >= 0.045) {
      ctx.font = `italic 600 11px ${FONT}`;
      ctx.fillStyle = 'rgba(132, 196, 150, 0.8)';
      if (tracking) ctx.letterSpacing = '0.6px';
      for (const p of PARK_LABELS) {
        if (p.area * s * s < 3000 || !v.sees(p)) continue;
        placeLabel(p.name, p.x, p.z, 7);
      }
    }
    if (tracking) ctx.letterSpacing = '0px';
    ctx.textBaseline = 'alphabetic';

    // 5. Street names along their real course (collision-free at all zoom levels)
    const fontPx = Math.max(9, Math.min(12, Math.round(9.5 * Math.sqrt(Math.max(s, 0.4)))));
    this.drawRoadLabels(ctx, v, { fontPx, maxLabels: 420, sameNameGap: 300, placed, majorOnly: s < 0.3 });

    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    for (const { lm, lx, ly, showLabel } of pins) {
      ctx.fillStyle = MAP.halo;
      ctx.beginPath();
      ctx.arc(lx, ly, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
      ctx.fill();
      if (showLabel) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = MAP.halo;
        ctx.strokeText(lm.short, lx + 9, ly + 4);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(lm.short, lx + 9, ly + 4);
      }
    }

    // 6. Scale bar (true metres); the true-north compass sits with the map controls (index.html)
    this.drawScaleBar(ctx, v);
    ctx.restore();
  }

  drawScaleBar(ctx, v) {
    const target = 120 / v.s; // metres in ~120 px
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const step = [1, 2, 5, 10].map((m) => m * pow).filter((m) => m <= target).pop() || pow;
    const len = step * v.s;
    const x0 = -v.w * 0.5 + 24;
    const y0 = v.h * 0.5 - 26;
    const label = step >= 1000 ? `${step / 1000} km` : `${step} m`;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 6);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + len, y0);
    ctx.lineTo(x0 + len, y0 - 6);
    ctx.strokeStyle = MAP.halo;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(236, 239, 244, 0.92)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `650 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    ctx.strokeText(label, x0 + len + 8, y0 + 3);
    ctx.fillStyle = 'rgba(236, 239, 244, 0.95)';
    ctx.fillText(label, x0 + len + 8, y0 + 3);
  }
}

export { CityMapSystem };
