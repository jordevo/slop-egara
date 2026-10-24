#!/usr/bin/env python3
# tools/catastro-to-json.py — Catastro INSPIRE Buildings (GML, EPSG:25831) -> tools/data/terrassa/catastro.json
# usage: python3 -I tools/catastro-to-json.py tools/data/catastro tools/data/terrassa/catastro.json
#
# Reads A.ES.SDGC.BU.<ine>.building.gml (one feature per cadastral building: use, year, dwellings) and
# A.ES.SDGC.BU.<ine>.buildingpart.gml (its parts: footprint ring(s) + storeys above / below ground) and writes a
# compact JSON in WGS84 lon/lat, which tools/geo-buildings.mjs turns into the simulation's boxes.
# Dirección General del Catastro data: free reuse with attribution (https://www.catastro.hacienda.gob.es).
import json
import math
import re
import sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
building_gml = next(src.glob('*.building.gml'))
part_gml = next(src.glob('*.buildingpart.gml'))

# --- ETRS89 / UTM zone 31N (EPSG:25831) -> geographic (GRS80 ellipsoid), Snyder's inverse ------------------------------
A = 6378137.0
F = 1 / 298.257222101
E2 = 2 * F - F * F
EP2 = E2 / (1 - E2)
K0 = 0.9996
LON0 = math.radians(3.0)
E1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))


def utm_to_lonlat(x, y):
    xm = x - 500000.0
    m = y / K0
    mu = m / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256))
    phi1 = (mu + (3 * E1 / 2 - 27 * E1 ** 3 / 32) * math.sin(2 * mu) + (21 * E1 ** 2 / 16 - 55 * E1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * E1 ** 3 / 96) * math.sin(6 * mu) + (1097 * E1 ** 4 / 512) * math.sin(8 * mu))
    s1 = math.sin(phi1)
    c1 = math.cos(phi1)
    t1 = math.tan(phi1)
    n1 = A / math.sqrt(1 - E2 * s1 * s1)
    r1 = A * (1 - E2) / (1 - E2 * s1 * s1) ** 1.5
    c = EP2 * c1 * c1
    d = xm / (n1 * K0)
    t = t1 * t1
    lat = phi1 - (n1 * t1 / r1) * (d * d / 2 - (5 + 3 * t + 10 * c - 4 * c * c - 9 * EP2) * d ** 4 / 24
                                   + (61 + 90 * t + 298 * c + 45 * t * t - 252 * EP2 - 3 * c * c) * d ** 6 / 720)
    lon = LON0 + (d - (1 + 2 * t + c) * d ** 3 / 6 + (5 - 2 * c + 28 * t - 3 * c * c + 8 * EP2 + 24 * t * t) * d ** 5 / 120) / c1
    return round(math.degrees(lon), 7), round(math.degrees(lat), 7)


FEATURE = re.compile(r'<gml:featureMember>(.*?)</gml:featureMember>', re.S)
TAG = lambda name: re.compile(r'<%s[^>]*>([^<]*)</%s>' % (name, name))
LOCAL_ID = TAG('base:localId')
USE = TAG('bu-ext2d:currentUse')
YEAR = re.compile(r'<bu-core2d:beginning>(\d{4})')
DWELLINGS = TAG('bu-ext2d:numberOfDwellings')
UNITS = TAG('bu-ext2d:numberOfBuildingUnits')
FLOORS = TAG('bu-ext2d:numberOfFloorsAboveGround')
BELOW = TAG('bu-ext2d:numberOfFloorsBelowGround')
CONDITION = TAG('bu-core2d:conditionOfConstruction')
PATCH = re.compile(r'<gml:PolygonPatch>(.*?)</gml:PolygonPatch>', re.S)
EXTERIOR = re.compile(r'<gml:exterior>.*?<gml:posList[^>]*>([^<]*)</gml:posList>', re.S)
INTERIOR = re.compile(r'<gml:interior>.*?<gml:posList[^>]*>([^<]*)</gml:posList>', re.S)

USE_CODE = {'1_residential': 1, '2_agriculture': 2, '3_industrial': 3, '4_1_office': 4, '4_2_retail': 5, '4_3_publicServices': 6}


def ring(poslist):
    v = poslist.split()
    pts = [utm_to_lonlat(float(v[i]), float(v[i + 1])) for i in range(0, len(v) - 1, 2)]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return [c for p in pts for c in p]


def polygons(feature):
    polys = []
    for patch in PATCH.findall(feature):
        ext = EXTERIOR.search(patch)
        if not ext:
            continue
        outer = ring(ext.group(1))
        if len(outer) < 6:
            continue
        inners = [ring(m) for m in INTERIOR.findall(patch)]
        polys.append([outer] + [r for r in inners if len(r) >= 6])
    return polys


buildings = {}
text = building_gml.read_text(encoding='iso-8859-1')
for feature in FEATURE.findall(text):
    m = LOCAL_ID.search(feature)
    if not m:
        continue
    ref = m.group(1).strip()
    use = USE.search(feature)
    year = YEAR.search(feature)
    dw = DWELLINGS.search(feature)
    units = UNITS.search(feature)
    cond = CONDITION.search(feature)
    floors = FLOORS.search(feature)
    buildings[ref] = {
        'use': USE_CODE.get(use.group(1).strip() if use else '', 0),
        'year': int(year.group(1)) if year else 0,
        'dwellings': int(dw.group(1)) if dw and dw.group(1).strip().isdigit() else 0,
        'units': int(units.group(1)) if units and units.group(1).strip().isdigit() else 0,
        'condition': (cond.group(1).strip() if cond else '') or 'functional',
        'floors': int(floors.group(1)) if floors and floors.group(1).strip().isdigit() else 0,
        'parts': []
    }
del text
print('buildings', len(buildings), file=sys.stderr)

text = part_gml.read_text(encoding='iso-8859-1')
nparts = 0
orphans = 0
for feature in FEATURE.findall(text):
    m = LOCAL_ID.search(feature)
    if not m:
        continue
    local = m.group(1).strip()
    ref = local.split('_part')[0]
    b = buildings.get(ref)
    if b is None:
        orphans += 1
        continue
    floors = FLOORS.search(feature)
    below = BELOW.search(feature)
    fl = int(floors.group(1)) if floors and floors.group(1).strip().lstrip('-').isdigit() else 0
    bl = int(below.group(1)) if below and below.group(1).strip().lstrip('-').isdigit() else 0
    for poly in polygons(feature):
        b['parts'].append({'floors': fl, 'below': bl, 'rings': poly})
        nparts += 1
del text
print('parts', nparts, 'orphans', orphans, file=sys.stderr)

out.write_text(json.dumps({'source': 'Dirección General del Catastro, INSPIRE Buildings 08279 Terrassa', 'crs': 'EPSG:4326', 'buildings': buildings}, separators=(',', ':')))
print('wrote', out, out.stat().st_size // 1024, 'KB', file=sys.stderr)
