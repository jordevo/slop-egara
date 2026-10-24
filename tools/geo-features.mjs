// Part 3: the features of Terrassa besides its streets & blocks, from OpenStreetMap: land use (parks, squares,
// pitches, woods, fields, industry, railways, parking, water), the streams (rieres & torrents), street trees,
// railways, the named buildings & sites (landmarks), the neighbourhoods (place nodes), and the region around the
// city for the low-detail horizon (towns, major roads, railways, settlements, peaks).
import { geo, toWorld, rdp, cleanRing, ringArea, bbox, centroid, load, log, elemPolygons, elemRing, wayPts, num } from './geo-base.mjs';

// Land-use classes (codes shared with the runtime, see js/city-config.js LAND_CLASS)
export const CLS = { NONE: 0, PARK: 1, SPORTS: 2, WOOD: 3, SCRUB: 4, FARM: 5, INDUSTRIAL: 6, CEMETERY: 7, RAILWAY: 8, PARKING: 9, WATER: 10, CAMPUS: 11, PLAZA: 12, GRASS: 13 };
const CLS_NAME = Object.fromEntries(Object.entries(CLS).map(([k, v]) => [v, k.toLowerCase()]));
function classOf(t) {
  if (t.leisure) {
    if (/^(park|garden|village_green|recreation_ground|dog_park|nature_reserve)$/.test(t.leisure)) return CLS.PARK;
    if (/^(pitch|sports_centre|stadium|track|playground|golf_course|fitness_station)$/.test(t.leisure)) return CLS.SPORTS;
  }
  if (t.landuse) {
    if (t.landuse === 'grass') return CLS.GRASS;
    if (/^(forest|wood)$/.test(t.landuse)) return CLS.WOOD;
    if (/^(meadow|greenfield|brownfield|scrub|heath|grassland)$/.test(t.landuse)) return CLS.SCRUB;
    if (/^(farmland|orchard|vineyard|allotments|farmyard)$/.test(t.landuse)) return CLS.FARM;
    if (t.landuse === 'industrial') return CLS.INDUSTRIAL;
    if (t.landuse === 'cemetery') return CLS.CEMETERY;
    if (t.landuse === 'railway') return CLS.RAILWAY;
    if (/^(village_green|recreation_ground)$/.test(t.landuse)) return CLS.PARK;
  }
  if (t.natural) {
    if (t.natural === 'wood') return CLS.WOOD;
    if (/^(scrub|heath|grassland)$/.test(t.natural)) return CLS.SCRUB;
    if (t.natural === 'water') return CLS.WATER;
    if (/^(bare_rock|scree)$/.test(t.natural)) return CLS.SCRUB;
  }
  if (t.amenity) {
    if (t.amenity === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey') return CLS.PARKING;
    if (/^(school|university|college|hospital|kindergarten)$/.test(t.amenity)) return CLS.CAMPUS;
    if (t.amenity === 'grave_yard') return CLS.CEMETERY;
  }
  if (t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes')) return CLS.PLAZA;
  if (t.railway === 'platform') return CLS.RAILWAY;
  return CLS.NONE;
}

const osmLU = load('osm_landuse.json');
const landuse = []; // { cls, name, outer, inners, area }
const trees = [];
const water = []; // streams: { name, w, pts }
const rail = []; // railway lines at grade: { name, pts }
for (const e of osmLU.elements) {
  const t = e.tags || {};
  if (e.type === 'node') {
    if (t.natural === 'tree') trees.push(toWorld(e.lon, e.lat));
    continue;
  }
  if (t.waterway && e.type === 'way' && e.geometry) {
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.covered === 'yes' || /cobert/i.test(t.name || '')) continue;
    let w = num(t.width);
    if (!(w > 0)) w = /^Riera de les Arenes/i.test(t.name || '') ? 28 : /^Riera/i.test(t.name || '') ? 10 : t.waterway === 'river' ? 10 : t.waterway === 'stream' ? 3.5 : 2;
    water.push({ name: t.name || '', w, pts: rdp(wayPts(e), 0.8) });
    continue;
  }
  if (t.railway === 'rail' && e.type === 'way' && e.geometry) {
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.service === 'siding' || t.service === 'yard' || t.service === 'spur') continue;
    rail.push({ name: t.name || '', bridge: !!(t.bridge && t.bridge !== 'no'), pts: rdp(wayPts(e), 0.8) });
    continue;
  }
  const cls = classOf(t);
  if (!cls) continue;
  for (const p of elemPolygons(e)) {
    if (p.outer.length < 3) continue;
    const area = Math.abs(ringArea(p.outer));
    if (area < 30) continue;
    landuse.push({ cls, name: t.name || '', outer: cleanRing(p.outer, 0.6), inners: p.inners.map((r) => cleanRing(r, 0.6)), area });
  }
}
landuse.sort((a, b) => b.area - a.area); // big first: later (smaller) polygons override in the class raster
{
  const km2 = {};
  for (const l of landuse) km2[CLS_NAME[l.cls]] = (km2[CLS_NAME[l.cls]] || 0) + l.area / 1e6;
  log(`${landuse.length} land-use polygons: ${Object.entries(km2).map(([k, v]) => `${k} ${v.toFixed(2)} km²`).join(', ')}`);
  log(`${trees.length} street trees, ${water.length} stream pieces, ${rail.length} railway pieces`);
}
// Named parks, gardens & squares (the maps, labels & the runtime's park builder)
const parks = landuse.filter((l) => (l.cls === CLS.PARK || l.cls === CLS.PLAZA || l.cls === CLS.CEMETERY) && l.name).map((l) => ({ name: l.name, cls: l.cls, area: Math.round(l.area), rings: [l.outer, ...l.inners] }));
log(`${parks.length} named parks, gardens, squares & cemeteries`);

// ---------------------------------------------------------------------------------------------------------------------
// Landmarks: named buildings & sites with their real outlines and heights (storeys x 3.2 m when only the storeys are
// known), plus the point landmarks (factory chimneys, stations) as points with a height
// ---------------------------------------------------------------------------------------------------------------------
const osmLM = load('osm_landmarks.json');
const landmarks = {};
const places = [];
const squares = [];
function landmarkKind(t) {
  if (t.amenity === 'place_of_worship' || /^(church|cathedral|chapel|monastery|convent)$/.test(t.building || '')) return 'church';
  if (t.historic === 'castle' || t.historic === 'tower') return 'castle';
  if (t.man_made === 'chimney') return 'chimney';
  if (t.man_made === 'tower' || t.man_made === 'water_tower') return 'tower';
  if (t.railway === 'station' || t.building === 'train_station') return 'station';
  if (t.tourism === 'museum') return 'museum';
  if (t.amenity === 'townhall') return 'townhall';
  if (t.amenity === 'theatre' || t.amenity === 'cinema' || t.amenity === 'arts_centre') return 'theatre';
  if (t.amenity === 'marketplace') return 'market';
  if (t.amenity === 'hospital' || t.building === 'hospital') return 'hospital';
  if (t.amenity === 'university' || t.amenity === 'college' || t.building === 'university') return 'university';
  if (t.amenity === 'school' || t.building === 'school') return 'school';
  if (t.amenity === 'library' || t.amenity === 'courthouse' || t.amenity === 'police' || t.amenity === 'post_office' || /^(public|civic|government)$/.test(t.building || '')) return 'civic';
  if (t.leisure === 'stadium' || t.leisure === 'sports_centre') return 'sports';
  if (t.historic) return 'historic';
  if (t.tourism === 'attraction') return 'attraction';
  if (t.building === 'industrial' || /vapor|f[àa]brica/i.test(t.name || '')) return 'industrial';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  return 'building';
}
for (const e of osmLM.elements) {
  const t = e.tags || {};
  if (t.place) {
    if (e.type === 'node' && /^(neighbourhood|quarter|suburb)$/.test(t.place) && t.name) places.push({ name: t.name, xz: toWorld(e.lon, e.lat) });
    if (t.place === 'square' && t.name) {
      const xz = e.type === 'node' ? toWorld(e.lon, e.lat) : centroid(elemRing(e));
      if (xz && xz.length) squares.push({ name: t.name, xz });
    }
    continue;
  }
  if (!t.name) continue;
  if (t.historic === 'memorial' || t.historic === 'wayside_cross' || t.tourism === 'artwork' || t.historic === 'monument') continue; // statues & plaques
  const kind = landmarkKind(t);
  const levels = parseInt(t['building:levels'] || '0', 10) || 0;
  let h = num(t.height);
  if (!(h > 0)) h = levels ? levels * 3.2 : null;
  const key = t.name.trim();
  if (e.type === 'node') {
    if (!/^(chimney|tower|station|castle)$/.test(kind) && !h) continue;
    const [x, z] = toWorld(e.lon, e.lat);
    if (!landmarks[key]) landmarks[key] = { kind, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, w: 0, d: 0, h, levels, area: 0, ring: null, point: true };
    continue;
  }
  const r = elemRing(e);
  if (r.length < 3) continue;
  const b = bbox(r);
  const area = Math.abs(ringArea(r));
  const prev = landmarks[key];
  if (prev && prev.area >= area) continue;
  const ring = cleanRing(r, 0.4);
  landmarks[key] = { kind, x: Math.round((b.x0 + b.x1) * 5) / 10, z: Math.round((b.z0 + b.z1) * 5) / 10, w: Math.round((b.x1 - b.x0) * 10) / 10, d: Math.round((b.z1 - b.z0) * 10) / 10, h, levels, area: Math.round(area), ring: ring.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]), point: false };
}
// Neighbourhoods also come as place nodes in the regional download (most of Terrassa's 50 barris are there)
const osmRegion = load('osm_region.json');
for (const e of osmRegion.elements) {
  if (e.type !== 'node' || !e.tags || !/^(neighbourhood|quarter|suburb)$/.test(e.tags.place || '') || !e.tags.name) continue;
  if (!geo.inDetail(e.lon, e.lat)) continue;
  if (places.some((p) => p.name === e.tags.name)) continue;
  places.push({ name: e.tags.name, xz: toWorld(e.lon, e.lat) });
}
log(`${Object.keys(landmarks).length} named landmarks (${Object.values(landmarks).filter((l) => l.point).length} points), ${places.length} neighbourhoods, ${squares.length} squares`);

// ---------------------------------------------------------------------------------------------------------------------
// Region: the low-detail surroundings out to the horizon
// ---------------------------------------------------------------------------------------------------------------------
const RANGE = 16000; // m from the Plaça Vella
const near = (pts) => pts.some(([x, z]) => Math.hypot(x, z) < RANGE);
const region = { roads: [], rails: [], settlements: [], towns: [], peaks: [] };
for (const e of osmRegion.elements) {
  const t = e.tags || {};
  if (e.type === 'node') {
    const [x, z] = toWorld(e.lon, e.lat);
    if (Math.hypot(x, z) > RANGE) continue;
    if (/^(city|town|village)$/.test(t.place || '') && t.name) region.towns.push({ name: t.name, place: t.place, x: Math.round(x), z: Math.round(z), population: parseInt(t.population || '0', 10) || 0 });
    else if (t.natural === 'peak' && t.name && num(t.ele) > 0) region.peaks.push({ name: t.name, ele: Math.round(num(t.ele)), x: Math.round(x), z: Math.round(z) });
    continue;
  }
  if (t.highway && e.type === 'way' && e.geometry) {
    if (t.tunnel && t.tunnel !== 'no') continue;
    const pts = wayPts(e);
    if (!near(pts)) continue;
    const cls = /^(motorway|trunk)/.test(t.highway) ? 1 : 2;
    region.roads.push({ name: t.ref || t.name || '', cls, link: /_link$/.test(t.highway), pts: rdp(pts, 3) });
  } else if (t.railway && e.type === 'way' && e.geometry) {
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.service) continue;
    const pts = wayPts(e);
    if (!near(pts)) continue;
    region.rails.push({ name: t.name || '', narrow: t.railway === 'narrow_gauge', pts: rdp(pts, 3) });
  } else if (t.landuse) {
    for (const p of elemPolygons(e)) {
      if (p.outer.length < 3 || !near(p.outer)) continue;
      const area = Math.abs(ringArea(p.outer));
      if (area < 20000) continue;
      region.settlements.push({ name: t.name || '', cls: t.landuse, area: Math.round(area), ring: cleanRing(p.outer, 6) });
    }
  }
}
log(`region: ${region.roads.length} major road pieces, ${region.rails.length} railway pieces, ${region.settlements.length} settlement polygons, ${region.towns.length} towns, ${region.peaks.length} peaks`);

// ---------------------------------------------------------------------------------------------------------------------
// Shops & businesses (osm_shops.json): the real street-level commerce, for the shop signs & awnings (buildings.js)
//   kind: 0 shop, 1 bar / restaurant / café, 2 bank, 3 pharmacy / health, 4 office, 5 hotel, 6 fuel, 7 other
// ---------------------------------------------------------------------------------------------------------------------
const shops = [];
try {
  const osmShops = load('osm_shops.json');
  const kindOf = (t) => {
    if (t.shop) return 0;
    if (/^(restaurant|cafe|bar|pub|fast_food|ice_cream|nightclub)$/.test(t.amenity || '')) return 1;
    if (t.amenity === 'bank') return 2;
    if (t.amenity === 'pharmacy' || t.healthcare || /^(dentist|clinic|doctors|veterinary|optician)$/.test(t.amenity || '')) return 3;
    if (t.office) return 4;
    if (t.tourism) return 5;
    if (t.amenity === 'fuel') return 6;
    return 7;
  };
  for (const e of osmShops.elements) {
    const t = e.tags || {};
    if (!t.name) continue;
    const lon = e.type === 'node' ? e.lon : e.center && e.center.lon;
    const lat = e.type === 'node' ? e.lat : e.center && e.center.lat;
    if (lon === undefined || !geo.inDetail(lon, lat)) continue;
    const [x, z] = toWorld(lon, lat);
    shops.push({ name: t.name.trim(), kind: kindOf(t), type: t.shop || t.amenity || t.office || t.craft || t.healthcare || t.tourism || t.leisure || '', x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, area: e.type !== 'node' ? 1 : 0 });
  }
  log(`${shops.length} named shops & businesses`);
} catch (err) {
  log(`no osm_shops.json (${err.message.split('\n')[0]}): shop signs stay generic`);
}

export { landuse, parks, trees, water, rail, landmarks, places, squares, region, shops, CLS_NAME };
