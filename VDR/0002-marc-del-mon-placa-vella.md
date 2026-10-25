# VDR-0002 — Marc del món: 1 m per unitat, origen a la Plaça Vella, eixos girats −13,7°

- **Data:** 2026-10-24
- **Estat:** Acceptada

## Context

El simulador necessita un sistema de coordenades pla on 1 unitat = 1 m i on la major part de les illes siguin
rectangles alineats amb els eixos (el motor de façanes i de solars treballa amb rectangles). Terrassa no té un nord
"còmode": el nucli antic i la Rambla d'Ègara van quasi nord-sud, però l'Eixample (on hi ha més illes rectangulars)
està girat.

## Decisió

`tools/geo-base.mjs` defineix el marc i `tools/build-geodata.mjs` el publica com a `GEO.frame`:

- **Origen (0, 0)** = centre de la **Plaça Vella** (way OSM 27491525: lat 41.561974, lon 2.011102).
- **Orientació**: histograma d'orientacions (mòdul 90°) ponderat per longitud de les vies a < 1,5 km de l'origen; el
  pic cau a **−13,70°** (el "nord" de l'Eixample és 13,7° a l'oest del nord real). `x` = est de retícula, `z` = sud de
  retícula (nord = −z).
- **Escala**: 1 unitat = 1 m, projecció de pla tangent local (mateixa fórmula que l'original).
- **Caixa de detall**: lat 41.538–41.608, lon 1.972–2.052 (≈ 6,6 × 7,8 km).

El marc mesurat es guarda a `GEO.frame` (`bearingDeg`, `lat0`, `lon0`, `cutZ`…) perquè qualsevol eina posterior el
pugui reutilitzar sense tornar a mesurar (vegeu VDR-0014).

Referències: `HOW_TO_IMPROVE.md` §1.2; `tools/geo-base.mjs`; `tools/build-geodata.mjs` (línia `frame:`).

## Alternatives considerades

- **Alinear amb la Rambla i el nucli antic** (pic secundari a 2°): rebutjada perquè hi ha menys illes rectangulars;
  queda documentat que n'hi ha prou amb canviar el radi de calibració de 1500 m a 600 m si mai es vol.
- **Nord real amunt** (sense girar): rebutjada pel mateix motiu; el plànol (`city-map.js`) dibuixa el nord de retícula
  amunt i la brúixola ho indica.

## Conseqüències

- Les illes de l'Eixample surten alineades; les que no, reben *frontage frames* (VDR-0006).
- La cota `y = 0` queda lligada a la Plaça Vella: el relleu (VDR-0013) és relatiu a aquest punt.
- Qualsevol dada externa (Catastro, MDE) s'ha de portar a aquest marc: WGS84 → pla tangent → gir.

*Un polsim de Viandox:* tot bon plat té un punt de referència de sal; aquí és la Plaça Vella, i es tasta des d'allà.
