const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
let TELEPORT_LOCATIONS, SPAWN, blockAt, nearestRoads, getIslandBoundsAtZ, onLand;
test.before(async () => {
  // the real city configuration, built from js/terrassa-geodata.js
  ({ TELEPORT_LOCATIONS, SPAWN, blockAt, nearestRoads, getIslandBoundsAtZ, onLand } = await import('../js/city-config.js'));
});

test('every teleport destination has a button and lands on a real street inside Terrassa', () => {
  const buttons = [...read('index.html').matchAll(/data-teleport="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(buttons).size, buttons.length, 'each destination is listed once');
  for (const key of Object.keys(TELEPORT_LOCATIONS)) {
    assert.ok(buttons.includes(key), `the teleport popover lists ${key}`);
  }
  for (const key of buttons) {
    assert.ok(TELEPORT_LOCATIONS[key], `the ${key} button has a destination in TELEPORT_LOCATIONS (a landmark that city-config.js could not find in the geodata?)`);
  }
  for (const [name, point] of Object.entries(TELEPORT_LOCATIONS)) {
    assert.ok(Number.isFinite(point.heading), `${name} has a heading`);
    assert.equal(blockAt(point.x, point.z), null, `${name} lands outside the blocks (on the roadway)`);
    const edge = getIslandBoundsAtZ(point.z);
    assert.ok(point.x > edge.westX + 8 && point.x < edge.eastX - 8, `${name} stays inside the detailed area`);
    assert.ok(onLand(point.x, point.z), `${name} is on land`);
    const nearby = nearestRoads(point.x, point.z, 20);
    assert.ok(nearby.length && nearby[0].dist <= 6, `${name} is within 6 m of a street (${nearby.length ? nearby[0].dist.toFixed(1) : 'none'} m)`);
    assert.ok(nearby.some(({ road, dist }) => dist <= Math.max(3, road.w / 2)), `${name} lands within a street's width`);
  }
});

test('the spawn is the Plaça Vella arrival, on a drivable street by the square', () => {
  assert.deepEqual(SPAWN, TELEPORT_LOCATIONS.placavella);
  assert.ok(Math.hypot(SPAWN.x, SPAWN.z) < 150, 'within 150 m of the Plaça Vella (the world origin)');
  const nearby = nearestRoads(SPAWN.x, SPAWN.z, 20);
  assert.ok(nearby.some(({ road, dist }) => dist < road.w / 2 && road.cls !== 3), 'on a street, not a pedestrian path');
});

test('preset and map teleports share arrival resets and mark the resolved landing point', () => {
  const main = read('js/main.js');
  const start = main.indexOf('  function teleportTo(');
  const end = main.indexOf('  const openMapBtn', start);
  assert.ok(start >= 0 && end > start, 'main.js keeps teleportTo() and the map system setup before the map button');
  const handlers = new Map();
  const calls = [];
  const landed = { x: 39.9, z: 71.3 };
  let map;
  // The map system under either name (NYCMapSystem until main.js is integrated, CityMapSystem after)
  class MapStub {
    constructor(options) { this.onTeleport = options.onTeleport; map = this; }
  }
  const environment = {
    TELEPORT_LOCATIONS,
    controllerManager: {
      teleportActiveTo: (...args) => { calls.push(['teleport', ...args]); return landed; }
    },
    touchControls: { reset: () => calls.push(['touch']) },
    gamepadControls: { reset: () => calls.push(['gamepad']) },
    cameraSystem: { resetForTeleport: () => calls.push(['camera']) },
    selectCamera: (...args) => calls.push(['selectCamera', ...args]),
    getLocationLabel: (x, z) => `${x}, ${z}`,
    cityBlocks: { allBlocks: [] },
    trafficSystem: {},
    CityMapSystem: MapStub,
    NYCMapSystem: MapStub,
    teleportButtons: Object.keys(TELEPORT_LOCATIONS).map((key) => ({
      getAttribute: () => key,
      addEventListener: (_event, handler) => handlers.set(key, handler)
    })),
    closePopovers: () => {}
  };
  vm.runInNewContext(main.slice(start, end), environment);
  for (const [name, point] of Object.entries(TELEPORT_LOCATIONS)) {
    calls.length = 0;
    handlers.get(name)();
    assert.deepEqual(calls, [
      ['teleport', point.x, point.z, point.heading], ['touch'], ['gamepad'], ['camera'], ['selectCamera', 'chase', true]
    ]);
    assert.equal(map.waypoint.x, landed.x);
    assert.equal(map.waypoint.z, landed.z);
  }
  map.waypoint = { x: 100, z: 200, name: 'inside a building' };
  map.onTeleport(100, 200);
  assert.equal(map.waypoint.x, landed.x, 'map marker follows the safe position returned by the controller');
  assert.equal(map.waypoint.z, landed.z);
  assert.equal(map.waypoint.name, `${landed.x}, ${landed.z}`);
});
