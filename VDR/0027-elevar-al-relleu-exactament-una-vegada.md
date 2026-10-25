# VDR-0027 — Tot el que s'escriu a cota de vorada s'eleva al relleu exactament una vegada

- **Data:** 2026-10-25
- **Estat:** Acceptada (regla per als props futurs; la doble elevació residual de les plaques, detectada en escriure
  aquest registre, ja és corregida)

## Context

La ciutat es genera plana i s'eleva després (VDR-0016): cada prop s'escriu amb `y` relativa a la calçada (0) o a la
vorera (`SW_TOP`) i algú hi suma `terrainY`. Quan dos punts del camí ho fan, el prop flota una vegada el relleu: el
propietari va veure **plaques de carrer i pals elevats dues vegades** (`groundY` ja portava el relleu i `pushMatrix` el
tornava a sumar) i **arbres de parc flotant** (`parkTreeSites` ja arribava elevat de `city-grid.js` i
`street-details.js` tornava a elevar `treePositions`) (`HOW_TO_IMPROVE.md` §3, sessió 3, punt 9).

## Decisió

**Un sol punt d'elevació per cada tipus de prop, i les dades d'entrada sempre a cota de vorada:**

- A `js/street-details.js`, **`groundY(x, z) = localGroundAt(x, z)`** (`city-grid.js`: el graó de vorera o la riba,
  **sense** relleu); el relleu el suma **només `pushMatrix`** (`y + lift(x, z)`), al moment d'escriure la matriu de
  cada instància. Els llums (`pointSites`, `spotSites`) s'eleven un cop al final del mòdul.
- Els **arbres**: `addTree` de `city-grid.js` eleva els arbres de parc i els marca **`lifted: relief`**;
  `street-details.js` només eleva els de `treePositions` que no porten `lifted`.
- Qualsevol funció que rebi `y` ha de dir al comentari si és a cota de vorada o del món; les que escriuen al
  `InstancedMesh` són les úniques que sumen el relleu.

Referències: `js/street-details.js` (`lift`, `pushMatrix`, `groundY`, bucle final sobre `treePositions` / `pointSites` /
`spotSites`); `js/city-grid.js` (`addTree`, `lifted`, `localGroundAt`).

## Alternatives considerades

- **Elevar a l'origen de cada dada** (que `city-grid.js` exporti tot ja elevat): llavors cada consumidor ha de saber
  què ja és al món; és el que va fallar amb els arbres.
- **Marcar totes les dades amb `lifted`** com els arbres: funciona, però és un flag més per oblidar; la regla "només
  qui escriu la matriu" és més simple i es pot comprovar llegint.
- **Fer `pushMatrix` idempotent** (detectar si `y` ja és al món): impossible sense saber-ho; `y = 2,65` pot ser
  qualsevol cosa.

## Conseqüències

- Regla per als props futurs: s'escriuen a cota de vorada i es deixen elevar pel punt d'escriptura.
- En escriure aquest registre es va detectar, llegint el codi, que `addPlaque` de `js/street-details.js` encara feia
  `y += lift(x, z)` abans de cridar `pushMatrix` (que torna a sumar `lift`): les plaques a paret (`wallY = SW_TOP +
  PLAQUE_Y`) i a pal (`baseY = groundY(...)`) quedaven elevades dues vegades, com havia vist el propietari a la segona
  ronda (`HOW_TO_IMPROVE.md` §3, sessió 3, punt 10). **Corregit el mateix dia**: `addPlaque` ja no suma el relleu
  ("y is the kerb-height mount; pushMatrix lifts it onto the relief (once)"); és exactament el cas que motiva la regla.
- No hi ha test que detecti una doble elevació: una prova de fum (VDR-0026) que compari la `y` d'una plaça amb
  `groundHeightAt` sota seu seria la manera de tancar-ho.

*Un polsim de Viandox:* la sal es posa una vegada, a l'olla; si cada cuiner en torna a posar al plat, no hi ha qui s'ho
mengi.
