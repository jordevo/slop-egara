// Part 2: the streets of Terrassa from OpenStreetMap highways, in the world frame: straight pieces (for the block
// raster), merged polylines per way (maps, labels, nearest-road lookups) and the street centreline graph (the drivable
// network, js/road-network.js), with the traffic signals, stop signs & pedestrian crossings on it.
import { osmRoads, toWorld, rdp, log, num, geo } from './geo-base.mjs';

// Roadway (curb-to-curb) width model, metres. OSM rarely carries `width` here (120 of 12 900 ways), so it comes from
// the class, the lanes and the kerbside parking typical of each kind of street in Terrassa: one-way residential
// streets of the Eixample run a travel lane plus a parking lane (~5.5 m), two-way ones park on one side (~8 m),
// tertiary & secondary streets park on both.
const LANE = { motorway: 3.5, motorway_link: 3.5, trunk: 3.5, trunk_link: 3.5, primary: 3.25, primary_link: 3.25, secondary: 3.1, secondary_link: 3.1, tertiary: 3.0, tertiary_link: 3.0, residential: 2.9, unclassified: 2.9, living_street: 2.8, service: 2.8, pedestrian: 2.5 };
const DEFAULT_LANES = { motorway: 2, motorway_link: 1, trunk: 2, trunk_link: 1, primary: 2, primary_link: 1, secondary: 2, secondary_link: 1, tertiary: 2, tertiary_link: 1, residential: 2, unclassified: 2, living_street: 1, service: 1, pedestrian: 1 };
const EXTRA = { motorway: 2.5, motorway_link: 1.0, trunk: 2.0, trunk_link: 1.0, primary: 1.5, primary_link: 0.8, secondary: 3.0, secondary_link: 0.8, tertiary: 3.5, tertiary_link: 0.8, residential: 3.0, unclassified: 2.5, living_street: 1.2, service: 0.6, pedestrian: 1.5 };
// Classes that bound blocks (`bounds`) and carry traffic (`drive`)
const BOUNDS = new Set(Object.keys(LANE));
const DRIVE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service']);
// Highway class code kept with every road polyline (maps): 0 street, 1 motorway / trunk, 2 primary / secondary, 3 pedestrian / living street, 4 service
const CLASS_CODE = (h) => (/^(motorway|trunk)/.test(h) ? 1 : /^(primary|secondary)/.test(h) ? 2 : h === 'pedestrian' || h === 'living_street' ? 3 : h === 'service' ? 4 : 0);

function roadTags(t) {
  const h = t.highway;
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout' || t.junction === 'circular' ? 1 : t.oneway === '-1' ? -1 : 0;
  let lanes = parseInt(t.lanes || '0', 10);
  if (!lanes) lanes = DEFAULT_LANES[h] || 1;
  if (!t.lanes && oneway && (h === 'residential' || h === 'unclassified')) lanes = 1;
  let w = num(t.width);
  if (!(w > 1.5)) {
    w = lanes * (LANE[h] || 3) + (EXTRA[h] || 1);
    if (h === 'residential' && !oneway) w = Math.max(w, 7.5);
  }
  const level = t.tunnel && t.tunnel !== 'no' ? 'tunnel' : t.covered === 'yes' ? 'tunnel' : (parseInt(t.layer || '0', 10) < 0 && !t.bridge) ? 'tunnel' : t.bridge && t.bridge !== 'no' ? 'bridge' : '13';
  const service = t.service || '';
  // Driveways, parking aisles & private tracks neither bound blocks nor carry traffic
  const minor = h === 'service' && (service === 'driveway' || service === 'parking_aisle' || service === 'drive-through' || service === 'emergency_access' || t.access === 'private');
  return { h, oneway, lanes, w: Math.round(w * 10) / 10, level, minor, maxspeed: parseInt(t.maxspeed || '0', 10) || 0 };
}

// Every highway way of the urban area as straight world-frame pieces with attributes
const pieces = [];
const ways = [];
const nodeUse = new Map(); // OSM node id -> number of drivable ways through it
const nodeXY = new Map();
for (const e of osmRoads.elements) {
  if (e.type !== 'way' || !e.geometry || !e.tags || !e.tags.highway) continue;
  const t = e.tags;
  if (!BOUNDS.has(t.highway)) continue;
  if (t.area === 'yes') continue; // pedestrian squares: areas, not roads (land use)
  if (t.highway === 'proposed' || t.highway === 'construction') continue;
  const a = roadTags(t);
  if (a.minor) continue;
  const name = (t.name || t.ref || '').trim();
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
  const way = { id: e.id, name, h: t.highway, cls: CLASS_CODE(t.highway), w: a.w, lanes: a.lanes, dir: a.oneway, level: a.level, maxspeed: a.maxspeed,
    drive: DRIVE.has(t.highway) && a.level !== 'tunnel', bounds: a.level !== 'tunnel', nodes: e.nodes, pts, roundabout: t.junction === 'roundabout' || t.junction === 'circular' };
  ways.push(way);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 0.3) continue;
    pieces.push({ way, name, h: way.h, w: way.w, lanes: way.lanes, dir: way.dir, x0, z0, x1, z1, L, level: way.level, bounds: way.bounds, drive: way.drive });
  }
  if (way.drive) {
    e.nodes.forEach((id, i) => {
      nodeUse.set(id, (nodeUse.get(id) || 0) + (i === 0 || i === e.nodes.length - 1 ? 2 : 1)); // way ends always split
      nodeXY.set(id, pts[i]);
    });
  }
}
log(`${ways.length} highway ways, ${pieces.length} pieces (${pieces.filter((p) => p.drive).length} drivable, ${pieces.filter((p) => p.level === 'bridge').length} on bridges, tunnels dropped)`);

// ---------------------------------------------------------------------------------------------------------------------
// Road polylines, one per way (simplified): [name, width, dir, lanes, class code, flat pts]
// ---------------------------------------------------------------------------------------------------------------------
const roadLines = ways.filter((w) => w.bounds && (w.drive || w.h === 'pedestrian' || w.h === 'living_street')).map((w) => ({ name: w.name, w: w.w, dir: w.dir, lanes: w.lanes, cls: w.cls, pts: rdp(w.pts, 0.6) }));
log(`${roadLines.length} road polylines`);

// ---------------------------------------------------------------------------------------------------------------------
// Street centreline graph: a node at every OSM node shared by two or more drivable ways (and at every way's ends), a
// link per stretch of way between nodes, with the way's name, roadway width, lanes & direction (1: a -> b, -1: b -> a,
// 0: both) and the stretch's inner shape points
// ---------------------------------------------------------------------------------------------------------------------
function buildRoadGraph() {
  const nodeId = new Map(); // OSM node id -> graph node index
  const nodes = [];
  const names = [];
  const nameIds = new Map();
  const nameId = (n) => {
    if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); }
    return nameIds.get(n);
  };
  const idOf = (osm) => {
    if (!nodeId.has(osm)) {
      const [x, z] = nodeXY.get(osm);
      nodeId.set(osm, nodes.length / 2);
      nodes.push(Math.round(x * 10) / 10, Math.round(z * 10) / 10);
    }
    return nodeId.get(osm);
  };
  const links = [];
  const linkWay = []; // way of each link, for the signals & crossings below
  for (const w of ways) {
    if (!w.drive) continue;
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const last = i === w.nodes.length - 1;
      if (!last && (nodeUse.get(w.nodes[i]) || 0) < 2) continue;
      const a = idOf(w.nodes[start]);
      const b = idOf(w.nodes[i]);
      if (a !== b) {
        const line = rdp(w.pts.slice(start, i + 1), 0.4);
        const inner = line.slice(1, -1).flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
        links.push([a, b, nameId(w.name), w.w, w.lanes, w.dir, inner, w.cls, w.level === 'bridge' ? 1 : 0, w.roundabout ? 1 : 0]);
        linkWay.push(w);
      }
      start = i;
    }
  }
  // Traffic signals, stop & give-way signs: graph nodes within 12 m of the OSM node (signals on the stop lines of a
  // junction's approaches are mapped a few metres before it)
  const cells = new Map();
  for (let i = 0; i < nodes.length; i += 2) {
    const k = Math.floor(nodes[i] / 32) * 100000 + Math.floor(nodes[i + 1] / 32);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i / 2);
  }
  const nearNodes = (x, z, r) => {
    const out = [];
    for (let ix = Math.floor((x - r) / 32); ix <= Math.floor((x + r) / 32); ix++) {
      for (let iz = Math.floor((z - r) / 32); iz <= Math.floor((z + r) / 32); iz++) {
        for (const id of cells.get(ix * 100000 + iz) || []) if (Math.hypot(nodes[2 * id] - x, nodes[2 * id + 1] - z) <= r) out.push(id);
      }
    }
    return out;
  };
  const signals = new Set();
  const stops = new Set();
  const crossings = []; // [x, z, ux, uz, roadway width, kind] kind 0: zebra / uncontrolled, 1: signals, 2: unmarked
  // Direction of the road through an OSM node: the tangent of a way passing it
  const wayAtNode = new Map();
  for (const w of ways) if (w.bounds) w.nodes.forEach((id, i) => { if (!wayAtNode.has(id)) wayAtNode.set(id, [w, i]); });
  for (const e of osmRoads.elements) {
    if (e.type !== 'node' || !e.tags) continue;
    const t = e.tags;
    const [x, z] = toWorld(e.lon, e.lat);
    if (t.highway === 'traffic_signals' && t['traffic_signals'] !== 'no') {
      const near = nearNodes(x, z, 12);
      for (const id of near) signals.add(id);
      if (!near.length) {
        const at = wayAtNode.get(e.id);
        if (at) crossings.push(...crossingAt(at, x, z, 1)); // a signalled mid-block crossing
      }
    } else if (t.highway === 'stop' || t.highway === 'give_way') {
      for (const id of nearNodes(x, z, 12)) stops.add(id);
    } else if (t.highway === 'crossing') {
      const kind = t.crossing === 'traffic_signals' ? 1 : t.crossing === 'unmarked' ? 2 : 0;
      const at = wayAtNode.get(e.id);
      if (at) crossings.push(...crossingAt(at, x, z, kind));
    }
  }
  function crossingAt([w, i], x, z, kind) {
    const p = w.pts[Math.max(0, i - 1)];
    const q = w.pts[Math.min(w.pts.length - 1, i + 1)];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [[Math.round(x * 10) / 10, Math.round(z * 10) / 10, Math.round(((q[0] - p[0]) / L) * 1000) / 1000, Math.round(((q[1] - p[1]) / L) * 1000) / 1000, w.w, kind]];
  }
  log(`road graph: ${nodes.length / 2} nodes, ${links.length} links, ${names.length} names; ${signals.size} signalled nodes, ${stops.size} with stop / give-way signs, ${crossings.length} pedestrian crossings`);
  return { nodes, links, names, signals: [...signals].sort((a, b) => a - b), stops: [...stops].sort((a, b) => a - b), crossings };
}

export { pieces, ways, roadLines, buildRoadGraph, CLASS_CODE };

if (process.argv[1] && process.argv[1].endsWith('geo-roads.mjs')) {
  const g = buildRoadGraph();
  const byClass = {};
  for (const p of pieces) byClass[p.h] = (byClass[p.h] || 0) + p.L;
  for (const [h, L] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) console.log(`${h.padEnd(16)} ${(L / 1000).toFixed(1)} km`);
  console.log('widths:', ['residential', 'tertiary', 'secondary', 'primary', 'pedestrian', 'living_street'].map((h) => {
    const ws = pieces.filter((p) => p.h === h).map((p) => p.w).sort((a, b) => a - b);
    return `${h} median ${ws[ws.length >> 1]}`;
  }).join(', '));
  console.log('sample names:', [...new Set(g.names)].slice(0, 20).join(' | '));
}
