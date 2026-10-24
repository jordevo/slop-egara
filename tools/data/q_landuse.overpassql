[out:json][timeout:240];
// Parks, squares, pitches, woods, streams (rieras), cemeteries, railways & other open land in the urban area
(
  way["leisure"~"^(park|garden|pitch|playground|sports_centre|stadium|track|dog_park|swimming_pool)$"](41.538,1.972,41.608,2.052);
  relation["leisure"~"^(park|garden|pitch|playground|sports_centre|stadium)$"](41.538,1.972,41.608,2.052);
  way["landuse"~"^(grass|forest|meadow|farmland|orchard|vineyard|cemetery|railway|industrial|allotments|recreation_ground|village_green|brownfield|greenfield)$"](41.538,1.972,41.608,2.052);
  relation["landuse"~"^(grass|forest|meadow|farmland|cemetery|railway|industrial)$"](41.538,1.972,41.608,2.052);
  way["natural"~"^(wood|scrub|grassland|heath|water|bare_rock|scree)$"](41.538,1.972,41.608,2.052);
  relation["natural"~"^(wood|scrub|water)$"](41.538,1.972,41.608,2.052);
  way["waterway"~"^(river|stream|canal|ditch|drain)$"](41.538,1.972,41.608,2.052);
  way["amenity"~"^(parking|school|university|college|hospital|marketplace|bus_station)$"](41.538,1.972,41.608,2.052);
  way["railway"~"^(rail|light_rail|platform)$"](41.538,1.972,41.608,2.052);
  way["place"="square"](41.538,1.972,41.608,2.052);
  way["highway"="pedestrian"]["area"="yes"](41.538,1.972,41.608,2.052);
  node["natural"="tree"](41.538,1.972,41.608,2.052);
);
out geom;
