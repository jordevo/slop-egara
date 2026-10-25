# VDR-0018 — Descarregar el model d'elevacions de l'ICGC (MET 5 m pel WCS) per al relleu real, i versionar el `.bin` generat

- **Data:** 2026-10-25
- **Estat:** Acceptada (descàrrega feta el 2026-10-25 amb permís explícit del propietari; el MET 2 m queda per a més endavant)

## Context

Tota la cadena del relleu (VDR-0012 a VDR-0017) estava preparada per a dades reals, però només es podia alimentar amb
el relleu sintètic (VDR-0015). La font prevista era el **Model d'Elevacions del Terreny de l'ICGC** (MET, 2 m o 5 m,
llicència CC BY 4.0, descàrrega per fulls o WCS), amb el **Copernicus GLO-30** com a reserva per al marge regional.
Qualsevol descàrrega requereix un "sí" explícit (VDR-0010).

## Decisió

Amb el permís del propietari, el 2026-10-25 es baixa el MET de l'ICGC pel **WCS** `geoserveis.icgc.cat/icc_mdt/wcs/service`,
cobertura **`icc:met`** (el servidor la serveix com a **`icc:met5`**, 5 m), **EPSG:25831** (ETRS89 / UTM 31N), format
**ARCGRID**, *bbox* **412010, 4596910 – 423260, 4608770** (la caixa de detall més ~450 m), **2250 × 2372 px**. La
comanda `curl` exacta és a `HOW_TO_IMPROVE.md` §2.8. El fitxer es guarda **fora del control de versions**:
`tools/data/dem/icgc_met5_terrassa_epsg25831.asc` (**96 MB**; `.gitignore`: `tools/data/dem/*.asc`, `*.tif`). El `.bin`
es genera amb `node tools/geo-terrain.mjs --epsg 25831 --smooth 5 tools/data/dem/icgc_met5_terrassa_epsg25831.asc`.

**El `js/terrassa-terrain.bin` generat (1,8 MB) sí que es versiona**: deixa de ser ignorat pel `.gitignore` i és la
dada que llegeix el runtime, com `terrassa-geodata.js` (VDR-0005). Qui cloni el repositori té el relleu sense baixar res.
El **MET 2 m** (LiDAR) només es serveix per WMS o per l'aplicació de descàrrega interactiva de l'ICGC: es deixa per a
més endavant.

Dades llegides del resultat: cota de la Plaça Vella **278,9 m**; relleu a la caixa **−100 … +510 m** (la Serra de l'Obac
entra pel nord). Llicència: **CC BY 4.0, ICGC**; l'atribució consta a `HOW_TO_IMPROVE.md` §2.8 i §5.7.

Referències: `HOW_TO_IMPROVE.md` §2.8 ("Fuente", comanda de regeneració), §3 sessió 3 (punt 7), §5.7; `.gitignore`;
`tools/geo-terrain.mjs` (`--epsg`, `--smooth`); `tools/lib/geotiff.mjs` (lector Arc/Info ASCII, VDR-0014).

## Alternatives considerades

- **Copernicus GLO-30 només**: cobertura global i senzilla, però 30 m no resol Vallparadís (30–60 m d'ample) ni les
  rieres.
- **SRTM 30 m**: igual o pitjor que Copernicus.
- **MET 2 m per fulls / LiDAR (núvol de punts)**: millor encara i serviria per a les alçades d'edificis
  (`NEXT_STEPS.md` §1.2), però avui no hi ha WCS i requeriria un lector LAS/LAZ i molta més dada; pas posterior.
- **GeoTIFF en lloc d'ARCGRID**: el lector propi accepta tots dos (VDR-0014); l'ASCII és el que el WCS va servir sense
  problemes.
- **Generar el `.bin` en clonar** en lloc de versionar-lo: obligaria cada clon a baixar 96 MB de l'ICGC (una petició de
  xarxa, VDR-0010) i a tenir Node; 1,8 MB al repositori és més barat.

## Conseqüències

- Primer contacte del lector `tools/lib/geotiff.mjs` amb fitxers reals: l'ASCII grid d'Arc/Info del WCS es llegeix
  amb `--epsg 25831` perquè el format no porta CRS.
- El `.bin` real substitueix el sintètic sense tocar cap altre fitxer (VDR-0013), però **ja no és el MDE nu**: porta el
  condicionament urbà de VDR-0022 i la taula de ponts de VDR-0023; cal regenerar-lo si canvia el geodata.
- Cada regeneració a partir de l'`.asc` és reproduïble sense xarxa mentre el fitxer sigui al disc; qui no el tingui,
  repeteix la comanda `curl` de §2.8 (amb permís).
- Pendent: l'atribució "ICGC, CC BY 4.0" encara no és al `README.md` (només a `HOW_TO_IMPROVE.md`).

*Un polsim de Viandox:* el bou ha arribat del proveïdor, amb factura i segell; l'extracte sintètic torna al rebost.
