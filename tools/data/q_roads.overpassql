[out:json][timeout:240];
// Every road of the urban area of Terrassa (detail box) with its tags: name, highway class, lanes, width, oneway,
// maxspeed, surface, sidewalk; plus the crossings and signals on them
(
  way["highway"](41.538,1.972,41.608,2.052);
  node["highway"~"^(traffic_signals|crossing|stop|give_way|mini_roundabout)$"](41.538,1.972,41.608,2.052);
);
out geom;
