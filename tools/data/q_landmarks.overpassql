[out:json][timeout:240];
// Named buildings & sites of Terrassa: monuments, churches, museums, stations, markets, theatres, civic buildings,
// and the named squares & neighbourhoods (place nodes) for the districts
(
  way["building"]["name"](41.538,1.972,41.608,2.052);
  relation["building"]["name"](41.538,1.972,41.608,2.052);
  nwr["historic"]["name"](41.538,1.972,41.608,2.052);
  nwr["tourism"~"^(attraction|museum|artwork|viewpoint)$"]["name"](41.538,1.972,41.608,2.052);
  nwr["amenity"~"^(place_of_worship|townhall|theatre|marketplace|hospital|university|library|cinema|arts_centre|community_centre)$"]["name"](41.538,1.972,41.608,2.052);
  nwr["railway"="station"]["name"](41.538,1.972,41.608,2.052);
  nwr["man_made"~"^(tower|chimney|water_tower)$"](41.538,1.972,41.608,2.052);
  nwr["leisure"~"^(park|garden|stadium|sports_centre)$"]["name"](41.538,1.972,41.608,2.052);
  node["place"~"^(suburb|quarter|neighbourhood|square)$"](41.538,1.972,41.608,2.052);
  way["place"="square"]["name"](41.538,1.972,41.608,2.052);
);
out geom;
