[out:json][timeout:240];
// Shops, bars, restaurants, banks, pharmacies & other street-level businesses of the urban area of Terrassa, with
// their names (for the real shop signs & awnings) — nodes and building outlines alike
(
  nwr["shop"](41.538,1.972,41.608,2.052);
  nwr["amenity"~"^(restaurant|cafe|bar|pub|fast_food|bank|pharmacy|ice_cream|dentist|clinic|doctors|veterinary|post_office|fuel|car_wash|driving_school|language_school|music_school|dancing_school|gym|cinema|theatre|library|bus_station|childcare|kindergarten|optician|bicycle_rental|car_rental|marketplace|casino|nightclub|social_facility|community_centre|place_of_worship|townhall|police|fire_station|hospital)$"](41.538,1.972,41.608,2.052);
  nwr["office"](41.538,1.972,41.608,2.052);
  nwr["craft"](41.538,1.972,41.608,2.052);
  nwr["healthcare"](41.538,1.972,41.608,2.052);
  nwr["tourism"~"^(hotel|hostel|guest_house|apartment)$"](41.538,1.972,41.608,2.052);
  nwr["leisure"~"^(fitness_centre|sports_centre|dance|bowling_alley|escape_game)$"](41.538,1.972,41.608,2.052);
);
out center tags;
