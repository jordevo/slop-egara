# Slop Terrassa — Diario de desarrollo y guía de mejora

Este documento es el registro completo de cómo se ha adaptado *Slop New York* (simulación 1:1 de Manhattan de
mrdoob) a **Slop Terrassa**, qué partes de la ciudad son exactas, cuáles son aproximaciones, cuáles son invenciones
plausibles, y **cómo completar o mejorar cada una**. Se actualiza en cada sesión de trabajo. Fecha de inicio:
2026-10-24.

Convención del registro de fidelidad:

| Marca | Significado |
|---|---|
| ✅ **Exacto** | Geometría o dato real tomado tal cual de la fuente (OpenStreetMap) a escala 1:1 |
| 🟡 **Derivado** | Calculado a partir de datos reales con un modelo o heurística (p. ej. ancho de calzada a partir de la clase de vía) |
| 🟠 **Aproximado** | Dato real incompleto completado con valores típicos del barrio o la tipología |
| 🔴 **Inventado** | No hay dato: se genera de forma procedural plausible (igual que hacía el original con los edificios de Manhattan) |
| ⚪ **Pendiente** | Todavía no implementado en esta versión |

---

## 1. Decisiones de arquitectura

### 1.1 Por qué Terrassa no puede usar el motor "de retícula" del original

El original construye Manhattan con dos sistemas:

1. **Retícula** (calles numeradas por su `z`, avenidas por su `x`, Central Park, costa de la isla): ~60 % del código
   de `city-grid.js`, `street-details.js`, `buildings.js` y toda la configuración de `city-config.js`.
2. **Grafo de calles** (`GEO.roadGraph`, `js/road-network.js` paso 4b): el sistema que usaba para Lower Manhattan,
   Broadway y las calles curvas del norte, donde no hay retícula.

Terrassa es una ciudad interior, sin costa, sin isla, con un casco antiguo irregular, un Eixample en retícula girada
13,7° al oeste del norte y barrios periféricos con trazados propios. **Toda la ciudad corre por el sistema de grafo.**
Las tablas de calles/avenidas quedan vacías y los módulos que dependían de ellas se han generalizado (ver §4).

### 1.2 Marco de coordenadas (`tools/geo-base.mjs`)

| Elemento | Valor | Fidelidad |
|---|---|---|
| Origen (0, 0) | Centro de la **Plaça Vella** (way OSM 27491525): lat 41.561974, lon 2.011102 | ✅ |
| Orientación de los ejes | Histograma de orientación (mod 90°) ponderado por longitud de las calles a <1,5 km del origen: pico en **−13,70°** (el "norte" de la retícula del Eixample está 13,7° al oeste del norte real). `x` = este de retícula, `z` = sur de retícula | 🟡 medido sobre datos reales |
| Escala | 1 unidad = 1 m, proyección plano tangente local (misma fórmula que el original) | ✅ |
| Caja de detalle | lat 41.538–41.608, lon 1.972–2.052 (≈ 6,6 × 7,8 km): el área urbana completa, de Les Fonts/Can Parellada al sur a Can Tusell/Pla del Bon Aire al norte | — |

**Cómo mejorarlo:** si en el futuro se prefiere alinear los ejes con la Rambla d'Ègara y el casco antiguo (que van
casi norte-sur, pico secundario a 2°), basta cambiar el radio de 1500 m a 600 m en la calibración de `geo-base.mjs`.
La elección actual favorece al Eixample porque es donde hay más manzanas rectangulares, y las manzanas que no están
alineadas reciben su propio marco de fachada (frontage frames), igual que Lower Manhattan en el original.

### 1.3 Fuente de datos: solo OpenStreetMap

NYC tenía datos municipales abiertos (DCP, CSCL, NYC Parks). Para Terrassa se usa **exclusivamente OpenStreetMap**
(ODbL) descargado con `tools/overpass.sh` y las consultas `tools/data/q_*.overpassql` (descarga realizada el
2026-10-24 con permiso explícito del propietario del proyecto; los JSON están en `tools/data/terrassa/`).

| Fichero | Contenido | Tamaño | Notas de cobertura |
|---|---|---|---|
| `osm_boundary.json` | 31 términos municipales (admin_level 8) del entorno | 0,8 MB | Terrassa: 70,3 km², 897 vértices tras simplificar a 4 m |
| `osm_roads.json` | 12.914 vías `highway=*` del área urbana + 4.730 nodos (semáforos, pasos, stop) | 11,6 MB | 6.536 vías con nombre; `lanes` en 2.296; `width` solo en 120; `oneway` en 3.628 |
| `osm_buildings.json` | 13.504 huellas de edificio + 230 relaciones | 11 MB | **Solo 390 con `building:levels`, 16 con `height`.** La importación del Catastro no cubrió Terrassa: la cobertura es parcial e irregular por barrios |
| `osm_landuse.json` | 1.936 polígonos de uso del suelo, 834 árboles, 211 tramos de rieras/torrents, 44 tramos de vía férrea | 5,6 MB | 93 parques, 84 jardines, 15 plazas con nombre |
| `osm_landmarks.json` | 457 elementos con nombre; 51 nodos de barrio (`place=neighbourhood`), 17 plazas | 0,6 MB | 340 monumentos/edificios singulares tras filtrar estatuas y placas |
| `osm_region.json` | Autopistas, carreteras, ferrocarriles, polígonos de asentamiento, 20 poblaciones y 220 cimas a <16 km | 7,4 MB | Para el horizonte de bajo detalle |
| `osm_shops.json` | 868 comercios y servicios (766 con nombre): restaurantes, supermercados, farmacias, bancos, peluquerías… | 0,3 MB | Rótulos reales. La cobertura de OSM es parcial (Terrassa tiene miles de comercios) |
| `catastro.json` (de `tools/data/catastro/`, Catastro INSPIRE *Buildings* 08279) | **25.880 edificios y 101.848 partes** con plantas sobre rasante, uso (residencial 22.808, industrial 1.654, comercial 553, equipamientos 385, oficinas 173, agrario 209), año de construcción y nº de viviendas | 23 MB (GML original 380 MB) | Descargado el 2026-10-24 con permiso. Licencia: reutilización libre con atribución a la Dirección General del Catastro. Conversión UTM 31N → WGS84 en `tools/catastro-to-json.py` (error comprobado contra OSM: 0,1–5,7 m en los centroides de 5 monumentos) |

**Cómo mejorar los datos:**

- **Edificios (prioridad máxima):** la cobertura real está en el Catastro (Dirección General del Catastro, licencia
  compatible con atribución) y en el **ICGC** (Institut Cartogràfic i Geològic de Catalunya: *Base topogràfica 1:5.000*
  y *Edificacions 3D / LiDAR*, licencia CC BY 4.0). Ambos dan huella + plantas/altura de **todos** los edificios.
  Descargar el GML de Catastro del municipio 08279 (servicio INSPIRE *Buildings*) y convertirlo al mismo esquema
  que `osm_buildings.json` (ver §2.5) multiplicaría por ~4 el número de huellas y daría alturas reales en todas.
- **Alturas de edificios:** el modelo LiDAR del ICGC (MDS 2 m) permite calcular la altura de cada huella. Alternativa
  rápida: completar `building:levels` en OSM para las manzanas céntricas (y volver a descargar).
- **Anchos de calzada:** el ICGC *Base topogràfica 1:5.000* incluye las aceras y bordillos reales (polígonos de
  calzada), que sustituirían el modelo heurístico de anchos (§2.2).
- **Barrios:** el Ajuntament de Terrassa publica los límites oficiales de los 45 barris y 6 districtes en su portal
  de datos abiertos (`opendata.terrassa.cat`); sustituirían la asignación por nodo más cercano (§2.6).
- **Relieve:** Terrassa sube de ~250 m (sur) a ~400 m (norte) y tiene la Serra de l'Obac/Sant Llorenç del Munt al
  norte. El MDE del ICGC (5 m) o SRTM darían un terreno real. Por ahora la ciudad es plana (como Manhattan en el
  original). Ver §4.9.

Para volver a descargar (requiere red; peticiones a `overpass-api.de`):

```bash
for q in boundary roads landmarks landuse region buildings; do
  bash tools/overpass.sh tools/data/terrassa/osm_$q.json tools/data/q_$q.overpassql 6
done
GEO_DATA=tools/data/terrassa node --max-old-space-size=8192 tools/build-geodata.mjs
```

Catastro (los GML originales, 380 MB, **no están en el repositorio**; sí el `catastro.json` convertido). Para
regenerarlo: descargar `https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/08/08279-TERRASSA/A.ES.SDGC.BU.08279.zip`
(el servidor falla con `curl` por la cadena de certificados en macOS; `python3 -c "import urllib.request..."` funciona),
descomprimirlo en `tools/data/catastro/` y ejecutar:

```bash
python3 -I tools/catastro-to-json.py tools/data/catastro tools/data/terrassa/catastro.json
```

---

## 2. Pipeline de datos (`tools/`)

### 2.1 Límites y suelo (`geo-base.mjs`)

- ✅ Límite municipal de Terrassa y de los 30 municipios vecinos (para el mapa y el horizonte).
- 🟡 "Suelo" de la simulación = la caja de detalle (rectángulo girado en el marco del mundo). No hay agua: la calzada
  de asfalto que el original extendía por toda la isla se extiende aquí por toda la caja, y las manzanas se recortan
  encima. Las zonas no urbanas (bosque, campos) son manzanas con clase de uso del suelo (§2.4) y se pintan como tales.

### 2.2 Calles (`geo-roads.mjs`)

| Dato | Fidelidad | Detalle |
|---|---|---|
| Trazado de cada calle (eje) | ✅ | Geometría OSM, simplificada a 0,4–0,6 m |
| Nombre | ✅ | `name` de OSM en catalán completo, sin abreviar ("Carrer de Sant Pere", "Rambla d'Ègara"). Las vías sin nombre quedan con nombre vacío (1 de cada 4 tramos: pasajes, viales de polígono, enlaces) |
| Sentido único | ✅ | `oneway`, `junction=roundabout` |
| Número de carriles | 🟠 | `lanes` cuando existe (2.296 vías); si no, por clase: 1 en residencial de sentido único, 2 en el resto |
| **Ancho de calzada** (bordillo a bordillo) | 🟡 | `width` si existe (120 vías). Si no: `carriles × ancho de carril + aparcamiento típico`: residencial sentido único ≈ 5,9 m (mediana resultante), residencial doble sentido ≥ 7,5 m, terciaria ≈ 9,5 m, secundaria ≈ 9,2 m, peatonal 4 m. Tabla `LANE`/`EXTRA` en `geo-roads.mjs` |
| Ancho de acera | 🟠 | Constante `SIDEWALK = 2.4 m` (ver `geo-blocks.mjs`); en el Eixample real varía entre 1,5 y 3 m, en avenidas más |
| Túneles | — | Excluidos (no se dibujan ni se circula): p. ej. la C-58 soterrada, los pasos inferiores |
| Puentes y viaductos | 🟠 | **Se tratan a cota de calle** (ciudad plana). Donde un viaducto cruza otra calle sin nodo común, los coches no se cruzan (el grafo no los conecta) pero visualmente ambas calles están al mismo nivel. 386 tramos afectados, sobre todo la Ronda/C-58 |
| Semáforos | ✅ | 309 nodos `highway=traffic_signals` → 236 cruces del grafo señalizados |
| Pasos de peatones | ✅ | 3.971 pasos (cebra / semáforo / sin marcar) con su posición y la dirección de la calle |
| Stop / ceda el paso | ✅ | 313 cruces |
| Grafo circulable | ✅ | 5.167 nodos, 7.402 enlaces (todas las clases de `motorway` a `service`, excluidos caminos privados y aparcamientos) |

**Cómo mejorarlo:** (a) importar las calzadas del ICGC 1:5.000 para anchos exactos; (b) completar `lanes`, `width`
y `sidewalk` en OSM; (c) modelar niveles (puentes/túneles) en `road-network.js` y `city-grid.js` — el original tampoco
lo hacía dentro de Manhattan, salvo el viaducto del FDR.

### 2.3 Manzanas (`geo-blocks.mjs`)

Mismo algoritmo que el original: se rasteriza a 1 m todo el suelo, se "estampa" cada calzada con su ancho real, y lo
que queda entre calzadas son las **islas de bordillo** (manzanas). Se les calcula el contorno, la línea de propiedad
(bordillo − acera) y los solares rectangulares; las manzanas no alineadas con los ejes reciben *frontage frames*
(marcos girados a la dirección de cada calle que las bordea).

- ✅ Contorno de cada manzana (derivado del eje real + ancho modelado → 🟡 en la práctica).
- 🟡 Uso del suelo por manzana: porcentaje de parque, deportivo, bosque, matorral, cultivo, industrial, cementerio,
  ferrocarril, aparcamiento, agua, campus escolar/sanitario, plaza, césped (clases `CLS` en `geo-features.mjs`).
- 🟡 Barrio de cada manzana: nodo `place=neighbourhood` más cercano (51 barrios). Ver §2.6.

### 2.4 Usos del suelo, parques, rieras, árboles (`geo-features.mjs`)

- ✅ 1.936 polígonos de uso del suelo (38 km² de bosque en la caja: la Serra de l'Obac/Sant Llorenç entra por el norte).
- ✅ 180 parques, jardines, plazas y cementerios con nombre (Parc de Vallparadís: 28,7 ha; Parc de Sant Jordi, Parc
  del Nord, Parc dels Catalans, Plaça Vella, Raval de Montserrat...).
- ✅ Rieras y torrents a cielo abierto (Riera de les Arenes, Riera del Palau, Torrent de Vallparadís...). Ancho: 🟠
  `width` si existe; si no 28 m para la Riera de les Arenes (canal), 10 m otras rieras, 3,5 m torrents.
- ✅ 834 árboles individuales (`natural=tree`). 🔴 El resto del arbolado de alineación se genera procedimentalmente.
- ✅ Vías férreas a cielo abierto (Renfe R4 y FGC donde no van soterradas).

### 2.5 Edificios (`geo-buildings.mjs`) — ✅ Catastro + OSM

Fuente principal desde la sesión 2: **Catastro INSPIRE Buildings**. Resultado: 23.752 edificios colocados en 1.543
manzanas (1.175 con cobertura ≥ 40 %), 110.265 cajas; 1.876 edificios quedan fuera de la caja de detalle o sobre
calzada (el término municipal es mucho mayor que el área urbana), 197 ruinas descartadas. OSM solo aporta 1.711
huellas en manzanas donde el Catastro no tiene nada.

| Dato | Fidelidad | Detalle |
|---|---|---|
| Huella de cada parte de edificio | ✅ | Catastro (precisión declarada 0,1 m), cajas alineadas a la orientación dominante del edificio, error ≤ 0,25 m |
| Plantas de cada parte | ✅ | `numberOfFloorsAboveGround` por parte: un mismo edificio tiene volúmenes de distinta altura (cuerpo de 5 plantas + ático + patio de 1) |
| Altura en metros | 🟡 | plantas × altura de planta según uso/época (3,2 m residencial, 3,5 ladrillo antiguo, 4 m vapors, 5,5 naves); el Catastro no da metros. Mejora: LiDAR ICGC |
| Uso | ✅ | residencial / industrial / oficinas / comercio / equipamiento / agrario → tipología de fachada y comercios |
| Año de construcción | ✅ | elige la época de la fachada (pre-1900 estuco y ladrillo, 1900-40 modernista/noucentista, 1950-80 bloques, >1990 moderno) |
| Viviendas | ✅ | distingue casa unifamiliar (cases de cos) de bloque de pisos |
| Cubiertas | 🟠 | el Catastro no da forma de cubierta: terrat por defecto, teja según época/tipología; `roof:shape` de OSM cuando existe |
| Materiales y colores | 🔴 | por época y uso |
| Edificios procedurales | 🔴 solo residual | únicamente en manzanas sin ningún edificio catastral ni huella OSM (campos, polígonos a medio construir) |
| Comercios | 🟡 | 764 rótulos con nombre real de OSM en su portal; el resto sin rótulo o genérico |

### 2.6 Barrios

OSM tiene 51 nodos de barrio, pero no sus polígonos. La asignación "manzana → barrio más cercano" (Voronoi) es
🟠 aproximada y falla en los bordes entre barrios. **Mejora:** descargar los polígonos oficiales de barris del
portal de datos abiertos del Ajuntament y hacer un *point-in-polygon* en `build-geodata.mjs`.

### 2.7 Monumentos y edificios singulares

✅ 340 elementos con nombre y huella real (Catedral del Sant Esperit, Masia Freixa, Castell Cartoixa de Vallparadís,
Torre del Palau con `height=26.7`, Mercat de la Independència, Ajuntament, mNACTEC/Vapor Aymerich, Amat i Jover,
Hospital Mútua (17 plantas, 70 m), Estadi Olímpic, estaciones, chimeneas industriales con altura...).
🟠 Altura: solo 13 tienen `height`; el resto usa la tabla de alturas por tipo del runtime (§4.6).

---

## 3. Diario de desarrollo

### 2026-10-24 — Sesión 2 (misma tarde)

1. Primer arranque en el navegador del propietario: demasiados edificios inventados, falta de detalle. Diagnóstico:
   el 75 % de los edificios no existe en OSM. Decisión: **Catastro INSPIRE** como fuente principal de edificios y
   **comercios de OSM** para los rótulos. Descargas autorizadas y realizadas (`tools/catastro-to-json.py`,
   `tools/data/q_shops.overpassql`).
2. `geo-buildings.mjs` reescrito: Catastro primero (partes con plantas propias, uso, año, viviendas, referencia
   catastral), OSM de relleno. 110.265 cajas (antes 35.858).
3. `buildings.js` consume el nuevo esquema (plantas por volumen, época de fachada, rótulos reales de 547 comercios,
   procedural solo en 207 manzanas vacías). 107 tests en verde. Masia Freixa: pendiente de fotos de referencia.
4. Validado en el navegador por el propietario ("me encanta como va mejorando"). Segundo push a `slop-egara`.

**Próximos pasos propuestos** (por impacto): (a) alturas reales por volumen con el LiDAR del ICGC; (b) relieve real
(MDE 5 m) para la ciudad y el entorno, con puentes y túneles a su cota; (c) Masia Freixa y resto de monumentos con
fotos de referencia; (d) polígonos oficiales de barris; (e) más comercios (completar OSM o datos del Ajuntament);
(f) pasos de cebra reales en cruces sin semáforo; (g) inventarios municipales de arbolado y alumbrado.

### 2026-10-24 — Sesión 1

1. Auditoría del proyecto original (3 exploraciones en paralelo del código). Resultado: la red viaria por grafo cubre
   cualquier trazado; semáforos, pasos y prioridades estaban ligados a la retícula; `boroughs.js` y `landmarks.js`
   son 100 % Manhattan y fallan con datos vacíos; `nyc-map.js` ya funciona con polilíneas genéricas.
2. Revisión de seguridad del repositorio: no se ha detectado ninguna instrucción embebida ni *prompt injection* en el
   código ni en los datos leídos. El único script con acceso a red es `tools/overpass.sh` (curl a tres servidores de
   Overpass, con validación del JSON y renombrado atómico). Las descargas se ejecutaron tras autorización expresa.
3. Redacción de las 6 consultas Overpass y descarga de los datos (77 MB en total).
4. Medición del marco (Plaça Vella, −13,7°) y escritura de `geo-base.mjs`, `geo-roads.mjs`, `geo-features.mjs`.
5. Hallazgo: cobertura parcial de edificios en OSM (13.504 huellas, 390 con plantas) → estrategia híbrida (§2.5).
6. Pipeline completa (`geo-blocks.mjs`, `geo-buildings.mjs`, `build-geodata.mjs`): 2.320 manzanas (1.467 con marcos de
   fachada girados), 13.032 huellas colocadas en 976 manzanas (620 con cobertura ≥ 40 %), 5.167 nodos y 7.402 tramos
   del grafo. `js/terrassa-geodata.js` = 4,0 MB (NYC: 1,1 MB). Tiempo de construcción: 15 s.
7. Verificación visual de los datos (render PNG con Pillow desde el JSON generado): Riera de les Arenes, Parc de
   Vallparadís, Eixample, polígonos industriales y rondas en su sitio; cobertura de huellas: Centre 79 %, Ca n'Aurell
   77 %, Ca n'Anglada 55 %, la Maurina 50 %, Sant Llorenç 26 %, Sant Pere Nord 2 %.
8. Reescritura de `city-config.js`, `road-network.js`, `pedestrian-routes.js`, `traffic.js` (fases/pasos),
   `controllers.js`, `main.js` (unidades). Seis agentes en paralelo sobre: suelo y detalles de calle; edificios;
   monumentos; entorno regional; mapa, cámaras e interfaz; vehículos.
9. Integración: `main.js` (mapa, cámaras, entorno, nombres de grupo para el culling), `tsl-materials.js` sin Central
   Park ni orillas (oclusión de cielo y reflejos nocturnos genéricos), borrado de `nyc-geodata.js`, `boroughs.js`,
   `fire-escapes.js` y los datos de Nueva York. 115 tests en verde; comprobación estática de que todos los `import`
   con nombre resuelven. Primera carga en navegador (del propietario, la extensión de Chrome no estaba disponible en
   la sesión): dos errores corregidos — un `assign` de TSL fuera de `Fn()` en el material de carreteras del entorno y
   la función `laneOffsets` borrada por error de `road-network.js`. Primer push a `github.com/oegea/slop-egara`.

---

## 4. Tiempo de ejecución (`js/`) — plan y estado

| Módulo | Estado | Qué cambia |
|---|---|---|
| 4.1 `city-config.js` | ✅ hecho | Reescrito del todo: marco, suelo (`LAND_RING`), calles (`ROADS`, `STREET_INDEX`, `nearestRoads`), manzanas (`BLOCKS`, `blockAt`), barrios (`DISTRICTS`, `blockProfile`: tipología constructiva por barri, 🟠 tabla manual), parques/usos/rieras/vías/árboles, monumentos (`LANDMARK_SITES`, `MODELLED_LANDMARKS`, `CITY_LANDMARKS`), teletransportes calculados sobre la calle más cercana a cada monumento (`streetSpotNear`), etiqueta de posición ("Carrer de Sant Pere & Carrer de la Rutlla", "Mercat de la Independència · Rambla d'Ègara & Carrer de Volta") |
| 4.2 `road-network.js` | ✅ hecho | Sin corredores de retícula: todas las calles son aristas "generales" del grafo. Los bordillos se comprueban contra el **polígono real** de cada manzana (`blockAt`), no contra rectángulos. Semáforos: los nodos OSM `highway=traffic_signals` (🟡 236 cruces; los semáforos de media manzana se tratan como pasos). Prioridad en cruces sin semáforo: la vía más ancha / de mayor clase (🟠 OSM `stop`/`give_way` se guardan en `n.stop` pero aún no se usan). Vías mayores: clase primaria/secundaria/autopista o nombre que empieza por Avinguda, Rambla, Passeig, Carretera, Ronda, Autopista, Autovia, Via |
| 4.3 `pedestrian-routes.js` / `traffic.js` | ✅ parcial | Pasos de peatones en cruces semaforizados en **cualquier ángulo** (a lo largo del eje lateral de cada vía que llega al cruce). Fase peatonal según el grupo de prioridad de la vía que se cruza (`n.sideGroup`). ⚪ Pendiente: usar los 3.971 pasos de cebra reales (`roadGraph.crossings`) para cruces sin semáforo; fases independientes en cruces de 3+ vías (hoy todas las secundarias comparten fase y el cruce se protege con la ocupación de la caja). Vehículos: ver 4.12 |
| 4.13 Vehículos (`actor-models.js`, `traffic.js`, audio) | ✅ hecho | Ver §5.1: taxis blancos con franja roja y azul, Policia Municipal (banda ajedrezada azul/amarilla, luces solo azules), autobuses de TMESA con letreros L1–L9, matrículas españolas, helicóptero de rescate, sirena bitonal |
| 4.12 `controllers.js` / `main.js` | ✅ hecho | Aparición en la calle más cercana a la Plaça Vella; taxi blanco con franja roja y azul (🟠 librea aproximada, número de licencia inventado), matrícula española "4821 KTR" (🔴 inventada); km/h y metros en el HUD; estado guardado en `terrassa-player-state` |
| 4.4 `city-grid.js` | ✅ hecho (ver §5.6) | Quitar agua, muelles, Central Park, plazas de Times Square, Battery; suelo = caja de detalle; aceras y bordillos genéricos; parques desde OSM; rieras; superficies por uso del suelo |
| 4.5 `buildings.js` | ✅ hecho (ver §5.4) | Huellas reales extruidas + generador procedural con tipologías de Terrassa; sin escaleras de incendios ni depósitos de agua; terrats con caixa d'escala |
| 4.6 `landmarks.js` | ✅ hecho (ver §5.5) | Constructor por datos (huella real + altura por tipo) con modelos específicos para los más icónicos |
| 4.7 `street-details.js` | ✅ hecho (ver §5.6) | Semáforos y señales en los cruces del grafo; placas de calle catalanas; farolas genéricas; sin bocas de metro ni carritos de perritos |
| 4.8 `nyc-map.js` → `city-map.js` | ✅ hecho (ver §5.3) | Suelo = término municipal; etiquetas de barrios; sin puentes/muelles |
| 4.9 `boroughs.js` → `surroundings.js` | ✅ hecho (ver §5.2) | Municipios vecinos como suelo de bajo detalle, polígonos de asentamiento con edificios genéricos, autopistas y ferrocarriles de la región, silueta de montañas (La Mola 1.104 m, Montcau 1.056 m, Serra de l'Obac) |
| 4.10 UI / HUD (`index.html`, `css/style.css`, `cameras.js`, README) | ✅ hecho (ver §5.3) | Nombre, unidades métricas (km/h, m), textos, iconos, fuentes |
| 4.11 Tests | ✅ hecho | `teleports`, `city-map`, `cameras`, `controllers`, `geodata`, `traffic*`, `vehicle-lights` en verde; `boot` pasa tras la integración | Actualizar `teleports.test.cjs`, `boot.test.cjs`, stubs |

---

## 5. Informes de fidelidad por módulo

### 5.1 Vehículos (`js/actor-models.js`, `js/traffic.js`, `js/audio-*.js`)

| Elemento | Marca | Detalle |
|---|---|---|
| Sentido de circulación | ✅ | Por la derecha |
| Matrículas | 🟡 | Formato español real "1234 BCD" (4 dígitos + 3 consonantes sin vocales, Ñ ni Q), fondo blanco, banda azul UE con 12 estrellas y "E". Números pseudoaleatorios deterministas (4 variantes compartidas por todos los coches). Mejora: una variante por coche vía atributo de instancia |
| Taxis | 🟠 | Blancos con franja diagonal roja y azul en las puertas delanteras y luminoso "TAXI" en el techo. Geometría de la franja, proporciones y colores aproximados (sin referencia fotográfica); número de licencia inventado. Mejora: comprobar la ordenanza municipal del taxi de Terrassa / fotos de la parada de la Rambla d'Ègara y ajustar ángulo, anchura y tonos |
| Policia Municipal | 🟠 | Coche blanco, banda ajedrezada azul/amarilla en las puertas, letras azules, puente de luces solo azul. Aproximación al diseño real (sin texto "POLICIA MUNICIPAL" ni escudo); no hay Mossos d'Esquadra. Mejora: segunda librea Mossos (blanco/azul oscuro, luces rojas+azules) con otra posición de `carState.w` |
| Proporción de flota | 🔴 | 1 taxi cada 9 coches y 1 policía cada 60 son decisiones de diseño. Paleta de turismos (blanco/plata/gris mayoritarios) aproximada a la matriculación española |
| Autobuses TMESA | 🟠 | Carrocería de 12 m de piso bajo (reutiliza la geometría del bus de 40 ft). Librea blanca con banda granate y cinta gris: aproximación de memoria, no la librea oficial. Mejora: fotos de la flota actual (tmesa.cat) para corregir tonos y forma de la banda |
| Letreros de línea | 🟠/🔴 | L1–L6, L8, L9 son líneas de TMESA; los destinos ("Can Roca · Centre", "Ca n'Anglada", "Sant Llorenç", "Can Palet", "Les Fonts", "Can Jofresa", "Ca n'Aurell", "Hospital") son inventados plausibles. Mejora: lista real de líneas y terminales de tmesa.cat en `BUS_ROUTES` de `traffic.js` |
| Helicóptero | 🔴 | Librea de rescate rojo/amarillo/blanco inspirada en los helicópteros de Bombers de la Generalitat; no reproduce ninguna aeronave real |
| Ambulancias SEM | ⚪ | No implementadas |
| Sirena | 🟡 | Bitonal "hi-lo" ≈660/880 Hz a ~1 Hz (vehículos de emergencia españoles); frecuencias y cadencia aproximadas. La antigua sirena americana sigue disponible como `'siren-wail'` |
| Luces de emergencia | 🟡 | Solo azules; el patrón de destello es el original con los colores cambiados |
| Sonido guardado | — | Clave `localStorage` `'terrassa-sound'` (antes `'nyc-sound'`) |
| Tráfico de autopista | ⚪ | `createHighwayTraffic` se mantiene sin carriles (main.js pasa `[]`); reutilizable para la C-58/B-40 cuando se modelen a su cota |

### 5.2 Entorno regional (`js/surroundings.js`, sustituye a `boroughs.js`)

| Elemento | Fidelidad | Detalle |
|---|---|---|
| Cimas (220 nodos `natural=peak` con nombre y cota a < 16 km: la Mola 1.103, el Montcau 1.056, Castellsapera 939, Turó de l'Ós 672...) | ✅ posición y cota exactas | Las 9 cimas dentro de la caja de detalle (Turonet del Palau, Montagut...) se ignoran: la ciudad queda plana |
| Polígonos de asentamiento (342: 172 residenciales 79,5 km², 148 industriales 28,4 km², 16 comerciales, 6 retail) | ✅ contorno exacto (simplificado a 6 m) | Pintados en el suelo con una textura de 1024² (39 m/px) y usados para situar los edificios |
| Poblaciones (20 nodos `place` con población) | ✅ | Escalan densidad y altura de los edificios genéricos |
| Autopistas y carreteras (3.936 tramos: C-58, B-40, C-16, AP-7, A-2, N-150, C-1413a, BP-1503...) | ✅ trazado · 🟡 ancho (24 m autopista, 9 m resto) · 🟠 cota (siguen el terreno procedural; túneles excluidos) | Los tramos dentro de la caja los dibuja `city-grid.js` |
| Ferrocarriles (461 tramos: R4 Barcelona–Manresa, FGC Barcelona–Vallès métrico, LAV, Castellbisbal–Mollet) | ✅ trazado · 🟡 ancho de balasto y galga | Ídem |
| **Relieve** (Sant Llorenç del Munt i l'Obac, Collserola, valle del Llobregat) | 🟠 **aproximado: no es un MDE** | Campo de alturas procedural: conos suaves alrededor de cada cima, radio ∝ altura relativa (3,4 m por m), + base del macizo al norte + ruido; plano en la caja de detalle y 1,5 km alrededor. Resultado: la Mola +892 m sobre la ciudad (real +823), Montcau +811 (real +776) |
| Color del terreno (pino blanco y encina, roca conglomerada ocre-gris en las cingleres, campos del Vallès) | 🔴 | Por altura, pendiente y ruido; no hay `landuse=forest` en la consulta regional |
| Edificios genéricos de los pueblos (43.444 cajas instanciadas: 2–8 plantas, torres de 9–15 en Sabadell, naves industriales, chalets en Matadepera/Ullastrell/Vacarisses) | 🔴 | Rejilla de solares por polígono con jitter; paleta catalana (revoco, ladrillo, teja, terrats); ventanas iluminadas de noche |
| Bosque lejano (50.000 pinos/encinas instanciados) | 🔴 | Posiciones y especies procedurales según altura/pendiente |

**Cómo mejorarlo:**
1. **Relieve real:** importar el MDE 5 m del ICGC (o SRTM 30 m / Copernicus DEM) en `tools/` y escribir `GEO.region.dem = { x0, z0, cell, w, h, heights }`; en `surroundings.js` basta sustituir `terrainModel()` por una lectura bilineal del MDE (colores, carreteras, árboles y edificios ya muestrean `terrainHeightAt`). Con un MDE la propia ciudad podría dejar de ser plana (§2.2).
2. **Edificios reales de Sabadell, Rubí, Sant Quirze, Matadepera...:** ampliar `q_region.overpassql` con `way["building"]` a < 10 km (o el Catastro INSPIRE de cada municipio) y extruirlos con la misma caja instanciada.
3. **Cobertura forestal real:** añadir `landuse=forest`, `natural=wood/scrub`, `landuse=farmland/orchard/vineyard` a la consulta regional y pintarlos en la textura de usos para colorear el terreno y sembrar los árboles sobre bosque real.
4. **Carreteras:** elevar puentes y viaductos (`bridge=yes`) sobre el terreno; añadir señalización y farolas de autopista.
5. **Luz nocturna de los pueblos:** usar la trama viaria real (`highway=residential` regional) en lugar de la rejilla de 30 m del shader.

### 5.3 Mapa, cámaras e interfaz (`js/city-map.js`, `js/cameras.js`, `index.html`, `css/style.css`)

**Mapa (`city-map.js`)**
- ✅ Exacto (datos OSM vía city-config): contorno del área de detalle, límite municipal de Terrassa (discontinuo) y los 30 municipios vecinos con su nombre al alejar; las 2.320 manzanas reales coloreadas por uso del suelo; contornos y nombres de los 180 parques/plazas; rieras y torrents con su ancho real; vías férreas a cielo abierto; 4.687 ejes de calle con jerarquía por clase (autopistas/rondes naranja, primarias/secundarias/avingudes amarillo pálido, calles finas, peatonales punteadas); huellas de los 30 monumentos modelados y marcas de los 17 lugares destacados; 51 nombres de barri a zoom medio y 17 plazas a zoom alto; rótulos de calle a lo largo de su trazado (1.183 nombres en catalán completo); búsqueda sobre calles, monumentos, parques y barris.
- 🟡 Derivado: posición de los rótulos de barri = nodo `place=neighbourhood` de OSM (no el centroide del polígono oficial); capa de usos naturales (bosque/campo/agua) como fondo bajo las manzanas.
- 🔴 Inventado: paleta (atlas oscuro, manzanas "papel cálido", ruta GPS en rojo); ruta GPS en línea recta (el original seguía la retícula); el plano se dibuja con el norte de la retícula arriba (13,7° al oeste del norte real; la brújula lo indica). Eliminado: costa, muelles, boroughs, puentes, Central Park, Times Square como destino inicial (ahora Plaça Vella).
- **Mejoras:** (a) polígonos oficiales de barris/districtes de `opendata.terrassa.cat`; (b) ruta GPS por el grafo (`GEO.roadGraph`, Dijkstra); (c) nombres de rieras a lo largo de su curso; (d) sombreado de relieve (MDE ICGC) como fondo del Vallès; (e) vista "norte real arriba" opcional rotando el lienzo −13,7°.

**Cámaras (`cameras.js`)**
- 🟡 Los 7 puntos de vista escénicos (`placaVella`, `masiaFreixa`, `rambla`, `vallparadis`, `mutua` a 70 m de altura, `estadi`, `skyline` hacia La Mola, más `drone`) se calculan en carga a partir de los centros y huellas reales de los monumentos; las distancias y alturas son 🔴 elección estética.
- **Mejora:** elevar cada cámara con la cota real cuando haya terreno; añadir cámaras de la Seu d'Ègara y la Torre del Palau.

**UI / HUD**
- 🔴 Inventado: insignia redonda roja `#c8102e` con "T" blanca (no es el escudo oficial de Terrassa, que es un escudo con torre y la senyera; usarlo requeriría comprobar su licencia/uso); acento rojo en vez del amarillo taxi; placas de calle estilo catalán (fondo crema `#f3eee2`, letra y borde azul `#1e3a70`) — aproximación genérica, las placas reales de Terrassa son de cerámica/esmalte con tipografía variada. UI en inglés (como el original) con topónimos en catalán sin abreviar; unidades métricas (km/h, m).
- 🟡 Subtítulos de los destinos de teletransporte (barri · calle) escritos a mano a partir de `CITY_LANDMARKS[].district` y de la calle preferida en city-config.
- **Mejora:** generar la lista de destinos y cámaras desde city-config en vez de HTML estático; versión en catalán de la UI (`lang="ca"`) como opción.

**Nombre público:** el README (en catalán, tono memístico) se titula *Grand Theft Ègara* (Ègara = nombre antiguo de Terrassa + guiño a GTA); "Frankfurt City" queda como chiste interno. El nombre interno de la app es *Slop Terrassa*.

**Tests (`tests/`)**
- `teleports.test.cjs` carga el city-config real: cada destino tiene botón, ninguno cae en manzana, todos en tierra, a ≤ 6 m de una calle. `city-map.test.cjs` y `cameras.test.cjs` con stubs de Terrassa. `geodata.test.mjs` construye los datos reales (15 s).

### 5.4 Edificios (`js/buildings.js`) — con Catastro (sesión 2)

Un único camino por manzana: **A, edificios reales** (1.543 manzanas con Catastro u OSM: 25.463 edificios, 110.265 volúmenes → 112.466 cajas) y **B, procedural** solo en las 207 manzanas edificables sin ningún edificio.

| Elemento | Marca | Detalle |
|---|---|---|
| Huella de cada volumen (Catastro, cajas en el marco del edificio, error ≤ 0,25 m) | ✅ Exacto | se omiten los edificios cuyo centroide cae en un recinto de `MODELLED_LANDMARKS` |
| Plantas de cada volumen (cuerpo, ático, cuerpo trasero, patio = plinto de 0,6 m) | ✅ Exacto | `numberOfFloorsAboveGround` por parte; solo las 1.711 huellas OSM sin `building:levels` usan las plantas típicas del barri |
| Uso (residencial / agrario / industrial / oficinas / comercio / equipamiento) y año de construcción | ✅ Exacto | eligen tipología, cubo de fachada, altura de planta, comercio en planta baja y ornamento |
| Metros por planta (3,1 residencial, 3,4 pre-1940, 3,6/4,0 planta baja comercial, 4,2 vapors y comercio, 6,5 naves, 3,5 oficinas, 3,8 equipamiento) | 🟡 Derivado | el Catastro no da metros. Mejora: LiDAR ICGC |
| Medianera / fachada a calle / patio por sondeo geométrico (volúmenes del mismo edificio y vecinos a ≤ 1,5 m; acera y calzada a ≤ 9 m) | 🟡 Derivado | depende del ancho de acera modelado (2,4 m) |
| Rótulos y toldos con el nombre real de 547 comercios de OSM en la pared a calle más próxima (≤ 14 m, 20 m en segunda pasada) | ✅ nombre exacto, 🟡 portal aproximado | los 217 restantes (gasolineras, grandes superficies, masies) quedan sin rótulo; ningún edificio sin comercio en OSM lleva rótulo |
| Materiales y colores por época y uso (8 cubos: estuco ocre y rosado pre-1940, ladrillo de vapor, estuco liso 1940-60, bloques 1960-85, moderno beige/blanco, paneles de nave, muro cortina) | 🟠 Aproximado | la época es real, el material concreto es inventado |
| Cubiertas: `roof:shape` de OSM cuando existe; si no, teja al 60 % en casas pre-1940 ≤ 2 plantas, dents de serra en naves pre-1960, terrat con caixa d'escala en el resto | 🔴 Inventado (salvo OSM) | el Catastro no da forma de cubierta |
| Cornisas, balcones (85 % pre-1940, 60 % bloques), caixes d'escala, climatizadores | 🔴 Inventado | porcentajes plausibles por época |
| Edificios procedurales en las 207 manzanas vacías | 🔴 Inventado | mismo generador que antes, nunca mezclado con huellas reales |

**Cómo mejorar:** alturas reales con LiDAR ICGC (MDS−MDT por volumen); cubiertas desde la ortofoto de 25 cm del ICGC o `roof:shape` en OSM; colocar los 217 comercios restantes buscando también paredes a patio/aparcamiento; completar los comercios de OSM (Terrassa tiene miles y OSM solo 868); fusionar volúmenes contiguos de igual altura para reducir los 112.466 colisionadores a la mitad; el atlas de rótulos es una textura de 4096×2304 (37 MB).

### 5.5 Monumentos (`js/landmarks.js`)

Constructor por datos: cada nombre de `MODELLED_LANDMARKS` se levanta sobre su **contorno real de OSM**; 31 sitios, 34.651 triángulos, 188 cajas de colisión. Convención: **Huella** = contorno OSM extruido tal cual (✅); **Altura** = OSM (✅) o supuesta (🟠); **Forma** = modelo específico (🟡 aproximación low-poly) o extrusión genérica (🟠).

| Monumento | Huella | Altura | Forma | Cómo mejorar |
|---|---|---|---|---|
| Catedral del Sant Esperit | ✅ (2.438 m²) | 🟠 nave 15 m + cubierta a dos aguas hasta 20,5; cimborio 27; campanario 44 + aguja a 56 | 🟡 contrafuertes y lancetas, rosetón y portal hacia la Plaça Vella, linterna octogonal, torre en la esquina NO con chapitel | Altura real del campanar y de la nave (ICGC LiDAR/3D) |
| Masia Freixa | ✅ (721 m²) | 🟠 galería 4,6 m, azotea 8,2, torre 24 m | 🟡 arcadas parabólicas caladas, ventanas parabólicas, 5 cúpulas nervadas blancas, torre-minarete, banda cerámica verde | Planos de Muncunill para número y posición exactos de cúpulas |
| Torre del Palau | ✅ (39 m²) | ✅ OSM 26,7 m | 🟡 torre cuadrada de piedra almenada | — |
| Castell Cartoixa de Vallparadís | ✅ (818 m²) | 🟠 muros 12 m, torres 18–21 | 🟡 almenas, 4 torres en las esquinas, tejado interior | Alturas reales; claustro no modelado |
| Mercat de la Independència | ✅ (3.046 m²) | 🟠 9,5 m + nave central 13,5 | 🟡 pilastras y grandes arcos de ladrillo, claristorio, frontispicio de piedra | La huella OSM parece incluir anexos: revisar en Catastro |
| Ajuntament / Antic Ajuntament | ✅ | 🟠 13,6 m | 🟡 civil + balcón, banderas, frontón con reloj hacia el Raval | Alturas reales |
| Vapor Aymerich, Amat i Jover (mNACTEC) | ✅ (15.973 m², bajo el nombre del museo) | 🟠 nave 8 m, dents de serra +2,6 cada 6 m, chimenea 42 m | 🟡 ladrillo con pilastras y arcos, cubierta en dientes de sierra recortada al contorno real, chimenea en la esquina NE | Paso real de los dientes y posición exacta de la chimenea (ICGC 3D) |
| Teatre Principal | ✅ | 🟠 14,4 m + caja escénica 26 m | 🟡 modernista + torre escénica | Altura real de la caja escénica |
| Santa Maria / Sant Pere / Sant Miquel (Seu d'Ègara) | ✅ | 🟠 9 / 8 / 7 m; campanar 17, linterna 14 | 🟡 arenisca; cimborio y campanario, espadaña, linterna octogonal | Alturas medidas; ábsides no modelados |
| Hospital Mútua de Terrassa | ✅ (1.773 m²) | ✅ OSM 70 m, 17 plantas | 🟡 extrusión con fachada propia, entrada acristalada, cuarto de máquinas | Fachada real (muro cortina parcial) |
| Estadi Municipal Olímpic | 🟡 envolvente convexa del contorno | 🟠 graderío 11,4 m, cubierta 17,5, torres de luz 32 | 🟡 gradas escalonadas, cubierta sobre una tribuna, 4 torres, césped | Lado real de la tribuna cubierta; superficie azul de hockey |
| Estació del Nord / Terrassa Est | ✅ | 🟠 9 m (OSM `height=3.2` ignorado) | 🟡 ladrillo + tejado + marquesina de andén | Lado real de los andenes |
| Casa Alegre de Sagrera, Museu Tèxtil, Institut Industrial, Casa Baumann | ✅ | 🟠 13–16,5 m | 🟠 genérico con doble cornisa, balcón, portales (Baumann: torreón) | Alturas y estilo de fachada |
| Hospital de Terrassa | ✅ (13.431 m²) | 🟠 22 m | 🟠 genérico hospitalario | Complejo de varios bloques: Catastro/ICGC |
| Chimeneas (9) | ✅ | ✅ OSM (Bòvila Almirall 63 m, 42, 45, 45, 25, 20, 20, 10); 🟠 Cal Guardiola 30 m | 🟡 fuste troncocónico, zócalo y corona | Altura de Cal Guardiola |
| Carrilló del mNACTEC | ✅ punto | 🟠 26 m | 🟡 fuste de ladrillo + campanario abierto con 5 campanas | Fotos de la estructura real |

Pendiente general: todas las alturas 🟠 pueden sustituirse por el modelo 3D de edificios / LiDAR del ICGC; las cubiertas siguen el contorno real pero con pendientes supuestas. `'Gran Casino'` no tiene huella en OSM (hay un constructor genérico listo si aparece).

### 5.6 Suelo, parques y detalles de calle (`js/city-grid.js`, `js/street-details.js`)

| Elemento | Fidelidad | Detalle / cómo mejorarlo |
|---|---|---|
| Suelo de asfalto | 🟡 | Un solo plano a cota 0 sobre la caja de detalle; sin relieve. Mejora: MDE 5 m del ICGC y pasar la ciudad a terreno real (`groundHeightAt` de city-grid es el punto de enganche) |
| Contorno de aceras y bordillos | 🟡 | Islas de bordillo derivadas del eje OSM + ancho de calzada modelado (§2.2); altura de bordillo 0,15 m y acera de 2,4 m constantes 🟠. Mejora: calzadas y aceras del ICGC 1:5.000 |
| Medianas (Rambla d'Ègara, avenidas) | 🟡 | Geometría derivada; seto 🔴 en medianas de 2,2–3,4 m, plátanos cada 8 m 🔴 en las de ≥ 3 m. Mejora: inventario de arbolado municipal |
| Parques (113 manzanas) | contorno ✅ / interior 🔴 | Césped, caminos de sauló en estrella hacia el centroide, bancos cada 9 m, farolas cada 24–34 m, árboles en rejilla de 11–13 m. Mejora: caminos reales (`highway=footway` dentro de parques, no descargados) y plano de cada parque |
| Parc de Vallparadís | contorno ✅ / cota 🔴 | Hundido 2,4–3,2 m con taludes de 4–12 m; en realidad el fondo del torrent queda 8–15 m bajo algunas calles y los puentes (Pont de Sant Pere, Passeig del Vint-i-dos de Juliol) lo cruzan. Mejora: MDE del ICGC + puentes como viaductos |
| Plazas (24 manzanas) | contorno ✅ / mobiliario 🔴 | Pavimento de granito, árboles en alcorque cada 9 m, bancos, farolas. La Plaça Vella real no tiene árboles en rejilla: afinar plaza a plaza |
| Bosques (36 manzanas, 1.590 ha) | polígono ✅ / arbolado 🔴 | Árboles cada 21 m (36.000) con esqueletos aproximados (pino carrasco ≈ acacia, encina ≈ olmo). Mejora: especies mediterráneas en trees.js, densidad del LiDAR / Mapa Forestal |
| Matorral y cultivos | polígono ✅ / superficie 🔴 | Textura de ruido ocre; surcos alineados con la retícula |
| Deportivo (10) | polígono ✅ / superficie 🔴 | Césped con rayas, valla de 3 m con dos puertas: sin pistas ni gradas |
| Aparcamientos (12) | ✅ / farolas 🔴 | Anillo de acera, asfalto, farolas cada 26 m; sin plazas pintadas |
| Cementiri de Terrassa | contorno ✅ / interior 🔴 | Muro de 2,4 m con una puerta 🟠, pavimento y cipreses en rejilla de 9 m; nichos ⚪ |
| Ferrocarril (19 km) | trazado ✅ / vía 🔴 | Balasto 7 m, carriles a 1,435 m: **Renfe R4 es ancho ibérico (1,668 m)**, FGC métrico (1,000 m) — corregir. Puentes ferroviarios a cota de calle |
| Riera de les Arenes y Riera del Palau | trazado ✅ / ancho 🟠 / canal 🔴 | Canal hundido 2,4 m (Arenes) / 1,6 m con parapeto de 1 m y paseo arbolado; el canal real de la Riera de les Arenes tiene ~30 m y 4–5 m de profundidad con taludes de hormigón. Mejora: MDE + sección real |
| Torrents (135 km) | trazado ✅ / cauce 🔴 | Franja plana de tierra y lodo; tramos bajo calle omitidos |
| Semáforos (236 cruces) | nodo ✅ / poste 🟡 / aspecto y fases 🔴 | Poste en la esquina derecha de cada acceso, 430 cabezas, báculo en calzadas ≥ 11 m; ciclo único de 60 s. Mejora: inventario de semáforos y planes de fases del Ajuntament |
| Semáforos peatonales | pasos ✅ / colocación 🟡 | 797 cabezas en los 571 pasos semaforizados de OSM; fase deducida de la vía principal del cruce |
| Placas de calle | nombres ✅ / posición 🟡 / diseño 🟠 | Esquina del edificio = esquina de bordillo + 2,4 m por la bisectriz; placa crema con texto azul sin escudo; 12.017 placas en 2.867 cruces |
| Farolas | posición 🔴 / tipología 🟠 | Columna de 8 m cada 28 m (calzada ≥ 8 m), báculo de 4,6 m cada 24 m, fanal de pared cada 20 m en casco antiguo y peatonales. Mejora: inventario de alumbrado público (opendata.terrassa.cat) |
| Árboles viarios | 834 ✅ (753 colocados) / alineaciones 🔴 | Plátanos cada 7–8 m en calles ≥ 9 m, ornamentales en el 30 % de calles residenciales. Mejora: inventari d'arbrat viari del Ajuntament |
| Papeleras, bolardos, bancos | 🔴 | Papelera junto a semáforos y 30 % de farolas; bolardos cada 2,5 m en peatonales; bancos tipo Neobarcino en parques y plazas |
| Mobiliario eliminado | — | Sin bocas de metro, carritos, hidrantes, buzones, chimeneas de vapor ni barreras de Nueva York |
