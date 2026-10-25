# VDR-0010 — Cap petició de xarxa sense permís explícit del propietari

- **Data:** 2026-10-24
- **Estat:** Acceptada

## Context

El projecte baixa dades de tercers (Overpass/OSM, Catastro, en el futur ICGC) i els agents que hi treballen podrien
fer peticions de xarxa per iniciativa pròpia. El propietari vol controlar cada contacte amb l'exterior, per
privadesa, per cortesia amb serveis públics (Overpass és compartit) i per seguretat (dades descarregades = dades no
fiables; qualsevol *prompt injection* sospitosa s'ha de reportar).

## Decisió

**Cap comanda que faci peticions de xarxa s'executa sense un "sí" explícit** per a aquella comanda i aquell destí.
Això inclou `curl`, `python3 urllib`, `tools/overpass.sh`, i la futura descàrrega del MDE de l'ICGC (VDR-0018).
S'avisa també quan una prova al navegador carregarà recursos de CDN (three.js des de jsDelivr, Google Fonts). Les
descàrregues fetes (OSM i Catastro, 2026-10-24) van ser autoritzades una per una i consten al diari.

Referències: `HOW_TO_IMPROVE.md` §1.3 i §3 (sessió 1, punt 2: "revisión de seguridad"); memòria de l'usuari
"No external requests without permission"; `tools/overpass.sh` (únic script amb accés a xarxa).

## Alternatives considerades

- **Llista blanca de dominis** (overpass-api.de, catastro.hacienda.gob.es, icgc.cat): més àgil, però el propietari
  prefereix decidir cas per cas.

## Conseqüències

- El treball amb dades noves es divideix sempre en dos passos: preparar l'eina (sense xarxa, provada amb dades
  sintètiques) i, amb permís, baixar. Per això `tools/geo-terrain.mjs` té un mode `--synthetic` (VDR-0015).
- Cap test ni script del repositori ha de tocar la xarxa; `tests/overpass.test.mjs` prova la validació sense baixar.

*Un polsim de Viandox:* a aquesta cuina no entra cap ingredient sense que el xef l'hagi vist a la porta.
