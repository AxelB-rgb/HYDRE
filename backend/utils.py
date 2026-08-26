"""
Fonctions utilitaires pures (aucune dépendance métier Hydre/Freebet/Bankroll) :
conversion de types, calcul de saison, gel des cotes avant coup d'envoi.
Logique et valeurs INCHANGÉES — simple déplacement depuis Serveur_Hydre.py.
"""
import pandas as pd
from datetime import datetime


def safe_float(val, default=0.0):
    try:
        if val is None or pd.isna(val): return float(default)
        return float(val)
    except:
        return float(default)


# 🆕 CORRECTIF STOCKAGE (§3/§6) : aucune configuration explicite de "saison actuelle" n'existe ailleurs
def _debut_saison_actuelle():
    now = datetime.now()
    annee_debut = now.year if now.month >= 7 else now.year - 1
    return f"{annee_debut}-07-01"


# ==========================================
# 🆕 GEL DES COTES À H-2 (utilisé pour la validation/modification de cote)
# ==========================================
SEUIL_GEL_COTE_HEURES = 2.0


def _heures_avant_coup_denvoi(date_str):
    """Retourne le nombre d'heures restantes avant le coup d'envoi (peut être négatif si déjà commencé).
    Retourne None si la date est illisible (dans ce cas, on considère que le gel ne s'applique pas)."""
    if not date_str:
        return None
    try:
        match_dt = datetime.strptime(date_str[:16], "%Y-%m-%d %H:%M")
    except Exception:
        return None
    return (match_dt - datetime.now()).total_seconds() / 3600.0


def _cote_est_verrouillee(date_str):
    """Règle exacte : >2h avant = modifiable ; ==2h = modifiable ; <2h = verrouillé."""
    heures = _heures_avant_coup_denvoi(date_str)
    if heures is None:
        return False
    return heures < SEUIL_GEL_COTE_HEURES


