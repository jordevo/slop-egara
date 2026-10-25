# VDR-0013 — El relleu viatja en un binari a part (`js/terrassa-terrain.bin`, format `TRN1`), relatiu a la Plaça Vella

- **Data:** 2026-10-25
- **Estat:** Substituïda (per VDR-0021: la cel·la passa de 5 m a 10 m i es lliga a la retícula del tauler; el format
  `TRN1` i el fitxer a part que es descriuen aquí continuen vigents i VDR-0021 els recull)

## Context

`NEXT_STEPS.md` §1.1 proposava escriure el relleu dins de `GEO.terrain` (cel·les de 4 m, Int16 en decímetres, ≈ 1,5
MB) com una taula més de `js/terrassa-geodata.js` (VDR-0005). Però aquell fitxer ja pesa ≈ 7 MB, regenerar-lo triga i
necessita 8 GB de memòria, i el relleu canviarà diverses vegades (sintètic → ICGC 5 m → ICGC 2 m) sense que canviï
cap altra dada.

## Decisió

El relleu és un **fitxer binari independent, `js/terrassa-terrain.bin`**, escrit per `tools/geo-terrain.mjs` i
descarregat amb `fetch` a l'arrencada per `js/terrain.js` (`loadTerrain(url)`). No s'incrusta a
`terrassa-geodata.js`. Format (verificat a les dues bandes, `encodeTerrain` i `parseTerrain`):

- capçalera de **64 bytes**: `'TRN1'`, `u32 w`, `u32 h`, `f32 cell`, `f32 x0`, `f32 z0`, `f32 ref` (cota absoluta de
  l'origen, m s.n.m.), `f32 min`, `f32 max` (relatius), `u32 flags` (bit 1 = sintètic), `f32 smooth`, resta reservat;
- cos: **Int16 little-endian en centímetres per sobre de la Plaça Vella**, *row-major*, files al llarg de +z;
- després del cos, la **taula de ponts `BRDG`** (afegida per VDR-0023: `'BRDG'`, `u32 count`, i per tram `u32 link`,
  `f32 y0`, `f32 y1`); un lector antic s'atura al final del grid;
- **marge de 400 m** al voltant de la caixa de detall (perquè el terreny regional s'hi fusioni) i **suavitzat gaussià**
  (`--margin`, `--smooth`; σ per defecte 4 m, el fitxer actual porta 5). La mida de cel·la es va fixar primer en
  **5 m**; VDR-0021 la puja a **10 m** i la lliga a la retícula del tauler d'asfalt.

Les alçades són **relatives a la Plaça Vella** (`ref = gridSample(0, 0)` es resta a tot el grid) perquè `y = 0`
continuï essent la cota de referència de la ciutat (VDR-0002); l'absoluta es conserva a la capçalera.

Referències: `tools/geo-terrain.mjs` (capçalera, `encodeTerrain`, `build`); `js/terrain.js` (`parseTerrain`,
`loadTerrain`); `NEXT_STEPS.md` §1.1 (proposta original, superada en el detall del format).

## Alternatives considerades

- **`GEO.terrain` dins del geodata** (la proposta de `NEXT_STEPS.md`): un sol import, però acobla el relleu a la
  pipeline lenta.
- **JSON / base64**: 2–3× més gran i cal decodificar; el `.bin` es copia directament a un `Int16Array`.
- **Decímetres** (proposta original) vs **centímetres**: amb Int16 els centímetres cobreixen ±327 m, suficient per al
  desnivell de la caixa amb més precisió per a vorades i pendents suaus.
- **GeoTIFF directe al navegador**: obligaria a portar el lector al client i a projectar en temps real.

## Conseqüències

- El relleu es pot substituir sense tocar la pipeline de dades ni els tests de geodata.
- Un `fetch` més a l'arrencada. Fitxer actual (real, de l'ICGC: VDR-0018), llegit de la capçalera el 2026-10-25:
  914 × 995 cel·les de 10 m, origen (x0, z0) = (−4200, −6140), `ref` = 278,9 m s.n.m., relleu −100,0 … +510,4 m, σ = 5,
  `flags` = 0 → **1,8 MB**.
- Si el fitxer falta o està corromput, `loadTerrain` avisa per consola i la ciutat queda plana: cap pantalla en blanc.
- El `.bin` **real es versiona** al repositori (VDR-0018); un `.bin` sintètic (VDR-0015) no s'ha de cometre mai.

*Un polsim de Viandox:* la salsa va en un pot a part; així se'n pot canviar la marca sense refer l'estofat.
