"""
Configuration centrale de l'Hydre : connexion MongoDB, chargement des modèles ML,
et TOUTES les constantes métier (bankroll, Scanner, Freebet Optimizer, Kelly).

⚠️ Aucune valeur n'a été modifiée lors de ce déplacement — uniquement extraites
telles quelles depuis l'ancien Serveur_Hydre.py (monofichier) pour centraliser
la configuration, comme demandé pour le refactoring MASTER/VIEWER.
"""
import os
import warnings
import joblib
from dotenv import load_dotenv
from pymongo import MongoClient

warnings.filterwarnings('ignore')

print("🚀 Réveil de l'Hydre (Mode V2 - Scanner de Marché + Bankroll Dynamique)...")

# --- Modèles ML (chemins relatifs INCHANGÉS : l'appli doit toujours être lancée
# depuis la racine du projet, comme avant ce refactoring) ---
try:
    lgbm_model = joblib.load("Modeles_Sauvegardes/Titan_LightGBM.pkl")
    xgb_model = joblib.load("Modeles_Sauvegardes/Titan_XGBoost.pkl")
    label_encoder = joblib.load("Modeles_Sauvegardes/LabelEncoder_FTR.pkl")
except Exception as e:
    print(f"❌ ERREUR CRITIQUE (Modèles) : {e}")
    exit()

# --- MongoDB ---
load_dotenv()
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
client = MongoClient(MONGO_URI)
db = client["Football_Quant"]

col_fixtures = db["Fixtures_A_Venir"]
col_historique = db["Matchs_Historique"]
col_paris = db["Paris_Engages"]
col_parametres = db["Parametres"]
col_profilage = db["Profils_Rentabilite"]
col_mouvements = db["Mouvements_Bankroll"]
# 🆕 Persistance des Matrices de Tir générées par le MASTER, pour permettre au VIEWER de
# consulter (lecture seule) la dernière matrice générée pour un match, y compris pour un
# pari déjà bloqué/validé. Aucune logique de calcul n'est modifiée : cette collection ne
# fait que stocker un snapshot du résultat déjà produit par /analyser.
col_matrices = db["Matrices_Tir"]

# ==========================================
# CONSTANTES — HYDRE / SCORING
# ==========================================
FEATURES_ELITE = [
    'Delta_xG', 'Delta_Shots_Pour', 'Delta_PPG_Saison', 'Delta_Shots_Contre',
    'Delta_Attaque_Saison', 'Delta_Defense_Saison', 'Delta_Defense_15J',
    'Delta_Corn_Pour', 'Delta_Corn_Contre', 'Dom_PPG', 'Ext_PPG',
    'xG_Attendu_Dom', 'xG_Attendu_Ext', 'Drop_Cote_Dom', 'Drop_Cote_Ext',
    'Ext_Moy15_Buts_Marques', 'Ext_Buts_Moyens', 'Delta_SOT_Pour',
    'H_EMA15_Shots_F', 'Delta_SOT_Contre', 'Dom_Moy15_Buts_Encaisses',
    'Ext_Moy15_Buts_Encaisses', 'Delta_Attaque_15J', 'Dom_Buts_Moyens'
]

# ==========================================
# 🆕 V2 — CONSTANTES GESTION DE BANKROLL & CRITÈRES
# ==========================================
PROFILS_EXPOSITION = {"PRUDENT": 10.0, "EQUILIBRE": 20.0, "AGRESSIF": 30.0}
MISE_MIN_PCT = 0.5
MISE_MAX_PCT = 3.0

SEUIL_PROBA = 45.0
COTE_MIN, COTE_MAX = 1.00, 3.00

PONDERATION_SCORE = {
    "edge": 0.45,
    "proba": 0.35,
    "roi_historique": 0.10,
    "volume_historique": 0.05,
    "gain_potentiel": 0.05
}

# ==========================================
# 🆕 FREEBET OPTIMIZER — CONSTANTES (facilement modifiables)
# ==========================================
ISSUE_LABELS_BACK = {"H": "Domicile (1)", "D": "Nul (X)", "A": "Extérieur (2)"}

# Garde-fou anti-explosion combinatoire : au-delà, une taille est ignorée (voir "tailles_ignorees")
FREEBET_MAX_COMBINAISONS_CALCULEES = 200_000
# Nombre de combinés renvoyés au front par taille / dans le classement global
FREEBET_TOP_N_PAR_TAILLE = 25

# Pondération du score synthétique d'un combiné (somme = 1.0). La probabilité de réussite
# redevient le facteur PRINCIPAL (0.35), sans écraser l'EV (0.25) ni la qualité globale des
# sélections (0.17) ; la taille/complexité pèse volontairement peu (0.08) et est normalisée
# de façon relative (voir taille_score) pour ne jamais double-pénaliser les combinés longs.
PONDERATION_SCORE_FREEBET = {
    "proba": 0.30,
    "ev": 0.25,
    "edge": 0.15,
    "qualite_selections": 0.20,
    "cote": 0.05,
    "taille": 0.05,
}

# Niveau de risque d'un combiné, basé sur sa probabilité combinée (%) — purement informatif,
# n'entre plus dans le calcul du score (qui utilise directement la probabilité).
FREEBET_SEUIL_RISQUE_FAIBLE = 40.0   # proba_combo >= 40%  => FAIBLE
FREEBET_SEUIL_RISQUE_MOYEN = 20.0    # 20% <= proba_combo < 40% => MOYEN
                                       # proba_combo < 20% => ÉLEVÉ

# ==========================================
# 🆕 PORTEFEUILLE FREEBET — PROFILS DYNAMIQUES
# ==========================================
# Les profils ne sont JAMAIS définis par le nombre de matchs. Chaque combiné reçoit un
# "indice de profil" composite (probabilité 35%, edge 25%, qualité Hydre des sélections 20%,
# rendement/cote 20% — moins dominé par la seule probabilité) puis est classé selon des seuils fixes —
# donc stables d'un jour à l'autre, contrairement au score (relatif au pool du jour).
# Une catégorie peut rester vide si aucun combiné du jour n'atteint son seuil.
FREEBET_POIDS_INDICE_PROFIL = {
    "proba": 0.35,              # facteur principal, mais ne domine plus l'indice
    "edge": 0.25,
    "qualite_selections": 0.20,
    "rendement_inverse": 0.20,  # favorise les cotes contenues ; une cote énorme tire vers LOTO
}
FREEBET_SEUIL_PROFIL_SAFE = 45.0
FREEBET_SEUIL_PROFIL_MID = 25.0
FREEBET_SEUIL_PROFIL_AMBITIEUX = 10.0
# En-dessous de FREEBET_SEUIL_PROFIL_AMBITIEUX => LOTO

FREEBET_PROFILS_INFO = {
    "SAFE": ("🟢 SAFE", "Probabilité de réussite élevée, quasiment aucune spéculation."),
    "MID": ("🟡 MID / ÉQUILIBRÉ", "Compromis entre probabilité, EV et rendement."),
    "AMBITIEUX": ("🟠 AMBITIEUX", "Rendement plus élevé, risque assumé."),
    "LOTO": ("🟣 LOTO", "Cote très forte, probabilité faible, gain potentiel très important."),
}
FREEBET_PROFILS_ORDRE_AFFICHAGE = ["SAFE", "MID", "AMBITIEUX", "LOTO"]

# ==========================================
# 🆕 PORTEFEUILLE FREEBET — DIVERSIFICATION & CONCENTRATION
# ==========================================
# Recouvrement entre 2 tickets = nb de matchs communs / nb de matchs du PLUS PETIT ticket.
# Alertes de concentration par match (informatives, jamais bloquantes) :
FREEBET_SEUIL_CONCENTRATION_MODEREE = 40.0    # < 40%  => FAIBLE
FREEBET_SEUIL_CONCENTRATION_FORTE = 60.0      # 40-60% => MODEREE ; 60-75% => FORTE
FREEBET_SEUIL_CONCENTRATION_TRES_FORTE = 75.0  # > 75% => TRES_FORTE

# ==========================================
# 🆕 PORTEFEUILLE FREEBET — SCORE PORTEFEUILLE & CONSTRUCTION PROGRESSIVE
# ==========================================
# 🔧 REFONTE : le score portefeuille n'évalue plus seulement "qualité + diversification +
# couverture" mais la CONVERSION réelle des freebets en cash : qualité de la distribution
# des gains (probabilité de récupérer quelque chose, à quels niveaux), EV et rendement par
# euro de freebet engagé, diversification (recouvrement + concentration comme pénalités),
# qualité moyenne des combinés retenus, et équilibre entre profils SAFE/MID/AMBITIEUX/LOTO.
# Le compromis voulu : à EV proche, privilégier la meilleure probabilité de récupération ;
# à probabilité de récupération proche, privilégier le meilleur EV — d'où un poids fort mais
# pas totalement dominant sur la conversion (35%), et un EV significatif (25%) pour ne jamais
# favoriser systématiquement les tickets les plus sûrs au détriment du rendement.
FREEBET_POIDS_SCORE_PORTEFEUILLE = {
    "conversion": 0.35,        # qualité de conversion / distribution des gains
    "ev": 0.25,                 # EV et rendement du freebet engagé
    "diversification": 0.20,    # recouvrement + concentration traités comme pénalités
    "qualite": 0.10,            # qualité moyenne des combinés retenus (score individuel)
    "equilibre_profils": 0.10,  # diversité SAFE / MID / AMBITIEUX / LOTO du portefeuille
}
# Seuils de gain "de base" (€) pour les probabilités P(gain >= seuil) affichées — complétés
# par des seuils relatifs à la mise totale réellement engagée (voir _seuils_gain_adaptes),
# pour rester pertinents aussi bien sur un petit que sur un gros portefeuille de freebets.
FREEBET_SEUILS_GAIN_BASE = [0.5, 1.0, 2.0, 5.0]
# Nombre max de tickets dans le portefeuille (garde-fou de sécurité/performance, jamais un
# objectif à atteindre : aucune règle du type "X matchs = Y tickets").
FREEBET_MAX_TICKETS_PORTEFEUILLE = 10
# Gain minimum (points de score portefeuille, échelle 0-100) qu'un mouvement (ajout, retrait
# ou remplacement) doit apporter pour être retenu. Volontairement UNIQUE (plus de seuil
# différencié par profil) : l'équilibre des profils fait désormais partie intégrante du score
# composite lui-même, il n'a donc plus besoin d'un traitement à part dans le critère d'arrêt.
FREEBET_EPSILON_AMELIORATION_PORTEFEUILLE = 0.05
# Nombre de passes de raffinement (retrait / remplacement) après la construction progressive —
# permet au système de revenir sur ses choix (un ticket ajouté tôt peut devenir sous-optimal
# une fois le portefeuille plus fourni) sans effectuer une recherche combinatoire complète.
FREEBET_MAX_PASSES_RAFFINEMENT_PORTEFEUILLE = 3


# 🔧 TEMPORAIRE — diagnostic du goulot d'étranglement de _construire_portefeuille_freebet.
# Logs uniquement (aucun impact sur la sélection). À retirer une fois le diagnostic terminé.
FREEBET_DEBUG_PORTEFEUILLE_LOGS = True


# Kelly TRÈS RESTRICTIF — référence = BANKROLL CASH uniquement (jamais les freebets)
KELLY_DIVISEUR_BASE = 20.0  # on ne recommande que 1/20e du Kelly plein calculé
KELLY_DAMPENING_PAR_TAILLE = {   # multiplicateur additionnel selon la taille (plus gros combiné = plus restrictif)
    2: 1.00,
    3: 0.75,
    4: 0.55,
    5: 0.40,
    6: 0.30,
    7: 0.22,
    8: 0.16,
}
KELLY_DAMPENING_DEFAUT = 0.10  # pour toute taille au-delà de celles listées ci-dessus
MISE_MIN_FREEBET_COMBI = 0.10  # minimum théorique — sous ce seuil, aucune mise n'est forcée
