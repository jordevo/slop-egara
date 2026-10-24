# Grand Theft Ègara — Próximos pasos

Hoja de ruta razonada para seguir mejorando el simulador **sin romper lo que ya funciona**. Complementa a
`HOW_TO_IMPROVE.md` (que registra lo hecho y la fidelidad de cada capa); aquí se recoge lo que falta, por qué, cómo
hacerlo, qué puede romperse y cómo comprobar que no se ha roto. Fecha: 2026-10-24.

Principios de trabajo para no romper nada:

1. **Cada mejora es un commit aislado con un conmutador.** Lo nuevo entra detrás de una constante de configuración
   (`FEATURES` en `city-config.js`) o de un dato opcional en `GEO` (si falta, el código sigue como hoy). Así se puede
   desactivar en segundos si algo sale mal.
2. **Datos antes que código.** Casi todo lo que aún es "inventado" lo es por falta de datos (ver tablas de
   `HOW_TO_IMPROVE.md`). Primero se consigue el dato, se mete en `tools/`, se regenera `terrassa-geodata.js` y solo
   entonces se toca el runtime.
3. **Verificación en tres niveles**: (a) `node --test tests/` (107 pruebas); (b) el arnés headless de los módulos de
   construcción (en `/tools/harness/`, pendiente de mover desde el scratchpad: ejecuta city-grid → landmarks →
   buildings → street-details con un three.js simulado y da recuentos); (c) recarga en el navegador con la consola
   abierta y un recorrido fijo de prueba (Plaça Vella → Rambla → Vallparadís → Mútua) comparando FPS y errores.
4. **Comparar contra la realidad con capturas.** Para cada monumento o calle que se mejore, guardar una captura
   "antes/después" en `docs/` junto a la foto de referencia.

---

## Eje 1 · Realismo del mapa

### 1.1 Relieve real (la mejora de más impacto visual que queda)

**Qué.** Terrassa no es plana: sube de ~250 m (Can Jofresa) a ~400 m (Can Tusell), con el torrent de Vallparadís
8–15 m hundido, la Riera de les Arenes encajada 4–5 m, y la Serra de l'Obac al norte. Hoy la ciudad es un plano a y=0 y
el relieve exterior es procedural.

**Datos.** MDE de 5 m (o 2 m) del ICGC (CC BY 4.0, descarga por hojas o WCS); alternativa Copernicus DEM 30 m.

**Cómo, sin romper nada.**
1. `tools/geo-terrain.mjs`: lee el MDE, lo remuestrea a 4 m en el marco del mundo, resta la cota de referencia de la
   Plaça Vella y escribe `GEO.terrain = { x0, z0, cell, w, h, heights: Int16 (dm) }` (≈ 1,5 MB para la caja).
2. **Un único punto de verdad para la altura**: `groundHeightAt(x, z)` en `city-grid.js` ya lo es (jugador, placas,
   postes). Se amplía para sumar la altura del terreno. Todo lo que hoy apoya en y=0 (asfalto, aceras, edificios,
   árboles, farolas, coches del tráfico, peatones) debe pasar a llamar a esa función.
3. Orden de migración (cada paso con su conmutador `FEATURES.terrain`): suelo de asfalto como malla con alturas →
   aceras/bordillos (extrusión siguiendo el terreno) → edificios (cada caja apoya en la cota mínima de su huella;
   los edificios en pendiente ganan un zócalo) → red viaria (`road-network.js`: a los nodos y aristas se les añade
   `y`, los coches interpolan) → peatones → props.
4. Puentes y túneles por fin a su cota: los tramos `bridge=yes` se elevan sobre el terreno y los `tunnel=yes`
   (hoy excluidos) se pueden recuperar como pasos inferiores reales (C-58, Rambla soterrada bajo la Plaça de Catalunya?).

**Riesgos.** Es el cambio más transversal. Mitigación: hacerlo en una rama, activar por partes, y comparar el arnés
(recuentos iguales) y el recorrido de prueba. La física del coche necesitará pendiente (apartado 2.1).

**Esfuerzo.** 3–5 sesiones.

### 1.2 Alturas reales de los edificios (LiDAR)

**Qué.** Las plantas del Catastro son exactas, pero los metros por planta son una tabla. El LiDAR del ICGC (nube de
puntos 2 m, o el MDS ya rasterizado) da la altura real de cada volumen, incluida la forma de cubierta.

**Cómo.** En `tools/geo-buildings.mjs`, para cada rectángulo del Catastro, muestrear el MDS−MDT dentro de la huella
(mediana) → `height` real; si la desviación típica dentro de la huella es alta, cubierta inclinada (estimar orientación
de la cumbrera por el gradiente). El runtime ya respeta `height` cuando es > 0 (prioridad sobre plantas).

**Riesgo.** Bajo: es un dato opcional por volumen.

### 1.3 Cubiertas y materiales desde la ortofoto

**Qué.** Teja vs terrat, color dominante de cada cubierta, y con menos fiabilidad el color de fachada.

**Cómo.** Ortofoto 25 cm del ICGC (WMS). Por huella: color medio de la cubierta → terracota = teja (inclinada),
gris = terrat/gravilla, blanco = terrat pintado, metálico = nave. Se escribe en el dato del edificio (`roof`,
`roofTint`) y `buildings.js` ya tiene los tres caminos de cubierta. Para fachadas, muestrear la ortofoto oblicua no es
viable; mejor una tabla por época y barrio revisada a mano con Street View (manual, pero el Centre y la Rambla son
pocas calles).

### 1.4 Barrios oficiales y nombres

Polígonos de barris i districtes del portal `opendata.terrassa.cat` → sustituye el Voronoi de nodos de OSM
(§2.6 del diario). Mejora etiquetas del mapa, tipologías procedurales residuales y la etiqueta "Estás en".

### 1.5 Más comercios y equipamientos

OSM tiene 868 comercios; Terrassa tiene varios miles. Fuentes: (a) censo de actividades del Ajuntament (datos
abiertos, con dirección), geocodificado contra las direcciones del Catastro (el GML `addresses` enlazado ya da
portal por referencia catastral); (b) completar OSM. Con direcciones catastrales los rótulos irían al **portal exacto**,
no al muro más próximo.

### 1.6 Árboles y alumbrado reales

Inventari d'arbrat viari e inventario de alumbrado del Ajuntament (datos abiertos): posición, especie y tipo de
farola de cada unidad. Sustituyen las alineaciones procedurales de `street-details.js` (hoy 🔴). Añadir especies
mediterráneas a `trees.js` (plátano ya; faltan tipuana, lledoner, morera, pi, alzina, xiprer).

### 1.7 Calzadas y aceras exactas

Base topogràfica 1:5.000 del ICGC: polígonos de calzada, acera, mediana, alcorques. Sustituye el modelo de anchos
(hoy 🟡 por clase de vía). Afecta al ráster de manzanas: regenerar y comparar recuentos (2.320 manzanas) para detectar
cambios inesperados.

### 1.8 Interior de parques y plazas

Caminos reales (`highway=footway/path` dentro de parques, no descargados aún), fuentes, pistas, juegos infantiles
(`leisure=playground`, ya descargado), mobiliario de OSM. Especialmente Vallparadís (con relieve real del 1.1), la
Plaça Vella (sin árboles en rejilla), el Parc de Sant Jordi.

### 1.9 Pasos de cebra y señales reales

Los 3.971 pasos de OSM (`roadGraph.crossings`) ya están en los datos: pintarlos (`road-paint.js`) y usarlos para
que los peatones crucen por ellos sin semáforo (hoy solo cruzan en cruces semaforizados). Señales de stop/ceda
(`n.stop`, 313 cruces) para la prioridad del tráfico. Riesgo bajo: todo aditivo.

### 1.10 Detalles que delatan "Manhattan"

Revisar y sustituir restos de la iconografía original: contenedores (los de Terrassa son los de carga lateral,
grises/verdes/azules/amarillos/marrones), papeleras, bancos, marquesinas de bus (TMESA), paradas con poste, bolardos,
cabinas, fuentes, alcantarillas. Todo instanciado y barato.

---

## Eje 2 · Motor: conducción, tráfico, semáforos, policía

### 2.1 Física de conducción

**Hoy.** Modelo cinemático: velocidad escalar con aceleración/frenado/arrastre (`CAR_DRIVE`), giro por ángulo de
dirección, sin masa, sin deslizamiento, sin pendiente, sin suspensión real.

**Propuesta (modelo "arcade con bicicleta dinámica")**, en `controllers.js` detrás de `FEATURES.carPhysics`:
- Modelo de bicicleta con masa, inercia de guiñada, neumáticos con curva de fuerza lateral saturable (Pacejka
  simplificada): da subviraje/sobreviraje, derrapes al frenar en curva y freno de mano.
- Reparto de frenada, ABS simple, aceleración limitada por adherencia (patinar al salir).
- Pendiente (cuando exista terreno): componente de gravedad en el eje longitudinal.
- Suspensión: 4 muelles-amortiguador visuales (ya hay cabeceo/balanceo; convertirlo en física real sobre el chasis).
- Colisiones: hoy el coche se para contra los colisionadores; pasar a respuesta con impulso (rebote, pérdida de
  velocidad proporcional al ángulo) y daño visual opcional.
- Sensación: cámara con retardo según aceleración lateral, FOV con velocidad, sonido de motor por marchas (ya hay
  síntesis de motor: añadir caja de 5 marchas).

**Verificación.** `tests/controllers.test.cjs` ya cubre teclado/teletransportes; añadir una prueba numérica de la
dinámica (un coche a 50 km/h frena en < 20 m; no supera 1,2 g lateral). Conmutador para volver al modelo actual.

### 2.2 Semáforos reales (y que no estén "siempre en rojo")

**Diagnóstico.** Hoy hay **un único reloj global**: todos los cruces de la ciudad cambian a la vez con el mismo ciclo
de 60 s (26 s verde principal / 26 s verde secundaria). Al circular, el siguiente cruce suele estar en la fase opuesta,
de ahí la sensación de rojo constante. Además las vías "secundarias" de un cruce de 3+ ramales comparten fase.

**Propuesta.**
1. **Desfase por cruce (onda verde).** Cada nodo semaforizado recibe un `offset` = distancia a lo largo de su vía
   principal desde el inicio del eje ÷ velocidad de diseño (40 km/h). Vías con semáforos coordinados en Terrassa:
   Rambla d'Ègara, Avinguda de Jacquard, Carretera de Montcada, Avinguda del Vallès, Carretera de Rubí, Avinguda de
   Béjar, Avinguda de les Glòries Catalanes. Implementación: `n.offset` en `road-network.js`; `phaseOf(e)` en
   `traffic.js` y las cabezas de `street-details.js` leen `signalPhase(elapsed - n.offset, …)`. El audio de
   semáforos peatonales (`audioSignals`) idem.
2. **Ciclos por tipo de cruce.** Cruce de dos vías principales: 90 s; principal con secundaria: 60 s con reparto
   60/40; cruce con solo paso peatonal: semáforo a demanda (verde fijo para coches salvo cuando un peatón espera).
3. **Fases por grupo real.** Cruces de 3+ ramales: una fase por grupo (`n.groupCount`) en lugar de "principal/resto".
   Giros a la izquierda protegidos en avenidas con mediana.
4. **Ámbar intermitente nocturno** (23:00–06:00 en el modo "Night") en cruces secundarios, como en la realidad.
5. **Planes reales**: si el Ajuntament publica el inventario de semáforos y sus planes de fases, sustituir las tablas.

**Riesgo.** Medio: el tráfico IA y los peatones dependen de las fases. Mitigación: `offset = 0` reproduce exactamente
el comportamiento actual; los tests de tráfico (`tests/traffic*.test.cjs`) siguen válidos; añadir una prueba de que
en ningún cruce dos grupos tienen verde a la vez.

### 2.3 Tráfico por IA

- **Rutas con destino.** Hoy los coches eligen movimiento en cada cruce; dar a cada coche un destino (otro nodo del
  grafo) y una ruta Dijkstra/A* → los flujos se parecen a los reales (entradas/salidas por las rondas, atracción al
  Centre, polígonos en hora punta). Reusar el grafo `roadGraph` (5.167 nodos).
- **Comportamientos.** Distancia de seguridad por velocidad, adelantamientos en avenidas de 2 carriles,
  aparcamiento en doble fila (muy terrassenc), autobuses que paran en paradas reales (OSM `highway=bus_stop`, no
  descargado aún) siguiendo las líneas reales de TMESA (OSM `route=bus`), rotondas con prioridad al que circula dentro
  (hoy las rotondas se colapsan en un nodo: tratarlas como anillo).
- **Densidad por hora y zona.** Curva horaria (punta mañana/tarde) y densidad por clase de vía.
- **Motos y bicis** en el tráfico (Terrassa tiene carril bici en avenidas: `cycleway=*` en OSM).
- **Verificación.** `tests/traffic-performance.test.cjs` fija el presupuesto de CPU; mantener < 2 ms por frame.

### 2.4 Policía: Mossos y Policia Municipal, con criterio

**Hoy.** 1 de cada 60 coches es policía (librea Policia Municipal), **siempre con sirena** (el audio escribe una
fuente de sirena para todo coche con `isPolice` a menos de 200 m) y con luces fijas.

**Propuesta.**
1. Dos cuerpos: **Policia Municipal de Terrassa** (blanco con banda ajedrezada azul/amarilla, cerca del Centre y en
   el tráfico ordinario) y **Mossos d'Esquadra** (blanco con azul oscuro y rojo, luces azules, más en rondas y
   accesos). Un tercer vehículo: ambulancia SEM amarilla. Librea = una posición más de `carState.w`.
2. **Estados**: patrulla (sin sirena ni luces, respeta semáforos), emergencia (luces + sirena bitonal, salta
   semáforos, los demás se apartan) y parada (aparcado con luces). La emergencia salta aleatoriamente (p. ej. 1 cada
   4 minutos cerca del jugador) o cuando el jugador conduce temerariamente (opcional, modo juego).
3. **Reacción del tráfico**: los coches ceden al vehículo en emergencia (frenan y se arriman al bordillo).
4. **Sirena bitonal** ya existe en `audio-synthesis.js`; añadir la variante "yelp" en cruces.

**Riesgo.** Bajo: cambia librea, un flag de estado y la lógica que ya existe de `isPolice`.

### 2.5 Peatones

Cruzar por pasos de cebra (2.1.9), esperar en la acera cuando viene un coche, más variedad de ropa y edades, grupos
y terrazas de bar (sentados), colas en paradas de bus. Horarios: calles vacías de madrugada, mercadillo los miércoles
y sábados en el Mercat/Plaça de la Independència.

### 2.6 Modos y juego

- **Helicóptero**: ya; añadir **patinete/moto** y **autobús de TMESA conducible** con su línea.
- **Misiones ligeras**: taxi (recoger/llevar pasajeros a lugares reales), reparto, "visita turística" con puntos de
  interés narrados (Modernisme, Seu d'Ègara, chimeneas). Da sentido a los monumentos.
- **Hora y clima**: ciclo diario continuo (hoy 4 presets), lluvia de otoño, calima de verano, luz de poniente real.

### 2.7 Rendimiento

112k colisionadores y 110k cajas de fachada: fusionar volúmenes contiguos de igual altura (reduce ambos a la mitad),
LOD de fachada por distancia (ya existe), streaming de colisionadores por celda, y medir con el arnés + `hud-fps`.

---

## Eje 3 · Monumentos reconocibles

**Método para cada uno:** (1) reunir 3–6 fotos (fachada principal, lateral, aérea del ICGC) y el plano de OSM/
Catastro; (2) sacar proporciones medibles de la ortofoto (planta) y de las fotos (alturas relativas, número de vanos,
ritmo de arcos); (3) modelar en `landmarks.js` con las primitivas existentes (`archesAlong`, `ribbedDome`, `tower`,
`sawtoothRoof`…) o, si hace falta, un GLB low-poly hecho a medida y cargado con `GLTFLoader` (poner el fichero en
`assets/`, ≤ 1 MB); (4) captura antes/después. Las fotos para referencia se pueden buscar con permiso (Wikimedia
Commons tiene muchas de Terrassa con licencia libre, útil para no depender de la memoria).

Orden sugerido (impacto visual × facilidad):

1. **Catedral del Sant Esperit** (Plaça Vella): campanario neogótico de 1877, nave de 1601, fachada de piedra
   con rosetón. Comprobar la altura real del campanar (~50 m) y el ritmo de ventanas; añadir el cimborio real.
2. **Hospital Universitari Mútua Terrassa**: la torre (1970s, 17 plantas según OSM, 19 según Catastro) con sus
   bandas horizontales de hormigón y antepechos; hoy es una extrusión con fachada genérica. Es el edificio más
   visible desde todas partes: merece fachada propia (bandas) y el conjunto de pabellones bajos.
3. **Masia Freixa**: ya hay modelo; afinar con fotos el número y tamaño de cúpulas (hay una grande central y varias
   menores), la arcada parabólica continua de la planta baja, la torre con cúpula y la cerámica verde. Considerar GLB.
4. **mNACTEC**: comprobar las dents de serra (orientación y número) con la ortofoto; la fachada de ladrillo de la
   Rambla con sus ventanas en arco; la chimenea.
5. **Mercat de la Independència**: estructura de hierro modernista; la planta de OSM parece incluir anexos: usar
   la huella del Catastro.
6. **Seu d'Ègara**: tres iglesias con proporciones muy concretas (Sant Miquel es cuadrada con cúpula sobre ocho
   columnas, Santa Maria con cimborio, Sant Pere con ábside trilobulado). Hay planos publicados.
7. **Castell Cartoixa de Vallparadís**, **Torre del Palau**, **Ajuntament**, **Teatre Principal**, **Casa Alegre de
   Sagrera**, **Estació del Nord**, **Estadi Olímpic**, chimeneas (la de la Bòvila Almirall es un hito de 63 m).
8. Nuevos: **Parc Audiovisual (antic Hospital del Tòrax)**, **Vapor Gran**, **Escola Industrial**, **Casa Baumann**,
   **Catalunya Caixa / edificio de la Caixa de Terrassa**, **Centre Cultural**, **Mercat de Sant Pere**, **Torre
   Mossèn Homs**, **Can Amat**, **Gran Casino**, el **Pont del Passeig** sobre Vallparadís (con relieve).

**Riesgo.** Nulo para el resto del motor: cada monumento es una función aislada en `landmarks.js`, y `buildings.js`
ya reserva su recinto.

---

## Eje 4 · Infraestructura del proyecto

- **Arnés headless en el repo** (`tools/harness/`): hoy vive en el scratchpad de la sesión. Meterlo con un comando
  `npm run harness` (o `node tools/harness/run.mjs`) que imprime recuentos y detecta NaN/geometría degenerada.
  Convertirlo en test de regresión (recuentos ± 5 %).
- **Prueba de humo en navegador** con Playwright (opcional, requiere dependencia): carga la página, espera el fin de
  `initApp`, captura la consola y una imagen del recorrido de prueba.
- **`FEATURES`** en `city-config.js` como único sitio de conmutadores.
- **Versionado de datos**: `GEO.version` y fecha de descarga de cada fuente en el diario.
- **Rama por mejora grande** (relieve, física) y `main` siempre arrancable.

---

## Priorización propuesta

| # | Mejora | Impacto | Esfuerzo | Riesgo | Depende de |
|---|---|---|---|---|---|
| 1 | Semáforos con desfase y ciclos por cruce (2.2) | Alto (se nota al minuto) | Bajo | Medio | — |
| 2 | Policía con estados, Mossos, sirena solo en emergencia (2.4) | Alto | Bajo | Bajo | — |
| 3 | Pasos de cebra pintados y peatones cruzando por ellos (1.9) | Medio | Bajo | Bajo | — |
| 4 | Monumentos con fotos: Catedral, Mútua, Masia Freixa, mNACTEC (3) | Alto | Medio | Nulo | fotos |
| 5 | Física de conducción (2.1) | Alto | Medio | Medio | — |
| 6 | Tráfico con rutas y autobuses en líneas reales (2.3) | Alto | Medio-alto | Medio | paradas OSM |
| 7 | Relieve real (1.1) | Muy alto | Alto | Alto | MDE ICGC |
| 8 | Alturas LiDAR y cubiertas (1.2, 1.3) | Medio-alto | Medio | Bajo | LiDAR/ortofoto ICGC |
| 9 | Comercios con direcciones (1.5), árboles y farolas reales (1.6) | Medio | Medio | Bajo | datos Ajuntament |
| 10 | Barrios oficiales (1.4), calzadas ICGC (1.7), parques (1.8) | Medio | Medio | Bajo-medio | datos |
| 11 | Mobiliario terrassenc (1.10), peatones (2.5), misiones (2.6) | Medio | Variable | Bajo | — |
| 12 | Rendimiento: fusión de volúmenes, streaming de colisionadores (2.7) | Medio | Medio | Medio | — |

Recomendación de arranque: **1 + 2 + 3** en una sesión (todo en `traffic.js`/`road-network.js`/`street-details.js`,
bajo riesgo, muy perceptible), después **4** con fotos, y en paralelo preparar los datos de **7** y **8**.
