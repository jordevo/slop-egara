[out:json][timeout:240];
// Major roads, railways and settlements around Terrassa, out to the fogged horizon (the low-detail surroundings)
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary)$"](41.47,1.88,41.68,2.14);
  way["railway"~"^(rail|light_rail|narrow_gauge)$"](41.47,1.88,41.68,2.14);
  way["landuse"~"^(residential|industrial|commercial|retail)$"](41.47,1.88,41.68,2.14);
  relation["landuse"~"^(residential|industrial|commercial|retail)$"](41.47,1.88,41.68,2.14);
  node["place"~"^(city|town|village|suburb|quarter|neighbourhood)$"](41.47,1.88,41.68,2.14);
  way["natural"="peak"](41.47,1.88,41.68,2.14);
  node["natural"="peak"](41.47,1.88,41.68,2.14);
);
out geom;
