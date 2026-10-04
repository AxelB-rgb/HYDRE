# Vérification des modifications HYDRE

Les pondérations du score match restent 45 % edge, 35 % probabilité, 10 % ROI historique,
5 % volume et 5 % gain potentiel. Aucun ajustement de promotion/relégation n'est appliqué.

## Cause de l'écrasement et calibration

Les bornes fixes précédentes étaient edge 0–100 et probabilité 45–100. Sur les candidats
historiques éligibles, les percentiles P5/P95 sont respectivement 0,735–34,442 et
45,843–77,280. Ces deux composantes représentent 80 % du score : les anciennes bornes
compressaient donc mécaniquement la plupart des scores. Il n'y avait pas de double
normalisation dans le score match. Le scanner sautait aussi entièrement le scoring quand
l'exposition disponible était nulle ; ce calcul précède maintenant la décision de mise.

`calibrate_scores.py` reprend les features de `Mongo_Injector.py`, les modèles sauvegardés,
les mêmes critères d'éligibilité et le choix de l'issue par edge maximal. Les bornes P5/P95
sont estimées sur 5 863 candidats des saisons 2021–2025 puis figées dans
`backend/score_calibration.json`. ROI et volume gardent leurs anciennes bornes.
Le score ne consulte aucun pool de candidats pour sa calibration.

Le contrôle temporel sur 1 365 candidats de 2025–2026 donne :

| Distribution | Avant | Après |
| --- | ---: | ---: |
| Médiane | 14,7 | 27,4 |
| P90 | 24,5 | 50,6 |
| Maximum | 40,3 | 72,0 |
| Part au-dessus de 40 | 0,1 % | 21,6 % |

Ces chiffres isolent les trois composantes recalibrées : ROI/volume sont neutralisés
dans les deux comparaisons (ils peuvent ajouter jusqu'à 15 points en production).
Ce contrôle vérifie l'échelle, pas la rentabilité ni l'absence de données d'entraînement
dans les modèles préexistants. Les snapshots de tickets déjà engagés restent figés.

## Statistiques historiques et changements de division

Dans l'injecteur, les cumuls de saison utilisent `(Saison_ID, Team)` et repartent donc
de zéro chaque saison. Les EMA de tirs, tirs cadrés, corners et buts ainsi que la forme
utilisent seulement `Team`. Elles traversent les saisons et divisions et alimentent
directement les différences entre adversaires et le calcul xG des features existantes.

Les warnings comparent la division observée de chaque équipe en saison précédente à
celle du match courant, par paire de divisions d'un même pays. Les divisions supérieures
et inférieures disponibles sont couvertes pour Angleterre, France, Allemagne, Italie et
Espagne. Si la division précédente manque dans `Matchs_Historique`, le sens ne peut pas
être déterminé et aucun changement n'est inventé. Une correction statistique exigerait
une étude temporelle des transitions et un réentraînement/contrôle des modèles ; elle
n'est pas appliquée avec un coefficient arbitraire.

## Compteurs, tickets et freebets

Le funnel compte des matchs uniques validés, ouverts ou réglés, hors annulations,
dans la saison actuelle. Les jambes des combinés gardent leur date/ligue propre et les
matchs présents dans plusieurs tickets sont dédupliqués. Les fixtures analysées à venir
complètent le dénominateur historique. Les filtres s'appliquent aux deux ensembles.

Les tickets ouverts exposent chaque jambe et une progression ; cette lecture ne clôture
pas le ticket et conserve sa composition. Une jambe validée possède un pari individuel
ou une fixture JOUE ; un résultat historique H/D/A signale une jambe jouée. La cascade
de perte existante et la clôture manuelle sont conservées.

Les freebets gagnantes rapportent `mise × (cote − 1)`. Exemples : 1 € à 5 → 4 €,
2 € à 3 → 4 €, 10 € à 1,5 → 5 €. Ce retour est le profit cash, sans nouvelle soustraction
de la mise virtuelle. Les anciennes freebets gagnantes enregistrées brutes sont relues
nettes sans migration destructive. CASHOUT reste le montant cash saisi ; les règlements
cash restent inchangés. L'EV de conversion d'une freebet est `P(gain) × (cote − 1)`.

## Contrôles reproductibles

- `python -m unittest discover -s tests -v` : tests métier sans Mongo/réseau.
- Depuis frontend : `node node_modules/react-scripts/bin/react-scripts.js test --watchAll=false --runInBand --testMatch '**/*.test.js'`.
- Depuis frontend : `node node_modules/react-scripts/bin/react-scripts.js build`.
- `python scripts/calibrate_scores.py` : reproduction du diagnostic historique.

Le paramètre testMatch explicite contourne le motif CRA mal résolu sur ce chemin Windows.
Le loader est testé avec des requêtes simultanées dont la dernière échoue. Les appels
longs partagent le même compteur ; le polling de progression n'ajoute pas de loader.
Les tests backend utilisent les fonctions de production avec collections simulées.
La compilation et les imports sont contrôlés localement ; aucun déploiement ni test
sur une base Mongo de production n'est effectué.
