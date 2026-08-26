"""
Routes "portefeuille" (bankroll / finance) : mouvements de capital et de freebets,
configuration du profil de risque et de la mise, snapshot des finances.

⚠️ Logique métier INCHANGÉE — déplacée depuis Serveur_Hydre.py. Seules les
dépendances de sécurité ont été mises à jour (MASTER pour l'écriture, MASTER+VIEWER
pour la lecture) dans le cadre du refactoring MASTER/VIEWER.
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth import require_master, require_any_role
from backend.config import col_parametres, col_paris, col_mouvements, PROFILS_EXPOSITION
from backend.hydre_engine import RESULTATS_REGLES

router = APIRouter()


def _pnl_cash_pari(p):
    """🆕 P&L exprimé en CASH RÉEL uniquement. Pour un pari FREEBET, la mise n'a jamais été
    de l'argent réellement possédé : sa perte ne doit donc JAMAIS réduire la bankroll cash
    (perte cash = 0 €), et son gain ne doit pas être diminué par cette mise "virtuelle" (le
    profit cash = le montant de retour réellement perçu, en intégralité). Pour un pari CASH
    (mise réellement engagée, y compris les paris sans type_fond explicite — anciens paris,
    toujours CASH par défaut), le P&L reste retour - mise, comme avant."""
    retour = float(p.get("Montant_Retour", 0) or 0)
    mise = float(p.get("mise", 0) or 0)
    if p.get("Resultat_Final") == "ANNULE":
        return 0.0
    if p.get("type_fond", "CASH") == "FREEBET":
        return retour
    return retour - mise


def _calculer_finances_dict():
    config = col_parametres.find_one({"type": "bankroll"})
    if not config:
        return {
            "initialise": False, "total": 0, "engage": 0, "disponible": 0,
            "freebets": {"total_acquis": 0, "engage": 0, "disponible": 0}
        }

    capital_depart = float(config.get("capital", 0) or 0)
    freebets_credit_total = float(config.get("freebets_total_acquis", 0) or 0)

    # 🆕 Un ticket ANNULÉ ne doit générer ni profit ni perte, et ne doit jamais être compté
    # comme "réglé" : on l'exclut explicitement du P&L (requirement #6 / #3).
    paris_clotures = list(col_paris.find({"Resultat_Final": {"$in": list(RESULTATS_REGLES)}}))
    pnl_total = sum(_pnl_cash_pari(p) for p in paris_clotures)
    bankroll_totale = capital_depart + pnl_total

    # "En cours" = pas encore réglé du tout (ni gagné/perdu/cashout, ni annulé).
    paris_en_cours = list(col_paris.find({"Resultat_Final": {"$exists": False}}))
    capital_engage = sum(float(p.get("mise", 0) or 0) for p in paris_en_cours if p.get("type_fond", "CASH") == "CASH")
    freebets_engage = sum(float(p.get("mise", 0) or 0) for p in paris_en_cours if p.get("type_fond", "CASH") == "FREEBET")

    # 🆕 FB ACQUIS / FB ENGAGÉ / FB DISPO (voir §2 et §3 du cahier des charges) :
    # - FB ACQUIS ne bouge PAS quand un ticket est simplement bloqué/engagé ;
    # - FB ACQUIS ne diminue QUE quand un ticket est définitivement réglé (GAGNÉ/PERDU/CASHOUT) ;
    # - Un ticket ANNULÉ restitue intégralement la freebet (n'affecte jamais FB ACQUIS).
    tous_paris_freebet_regles = list(col_paris.find({"type_fond": "FREEBET", "Resultat_Final": {"$in": list(RESULTATS_REGLES)}}))
    freebets_consommees_definitivement = sum(float(p.get("mise", 0) or 0) for p in tous_paris_freebet_regles)
    freebets_acquis_restant = freebets_credit_total - freebets_consommees_definitivement
    freebets_disponible = freebets_acquis_restant - freebets_engage

    return {
        "initialise": True,
        "total": round(bankroll_totale, 2),
        "engage": round(capital_engage, 2),
        "disponible": round(bankroll_totale - capital_engage, 2),
        "freebets": {
            "total_acquis": round(freebets_acquis_restant, 2),
            "engage": round(freebets_engage, 2),
            "disponible": round(freebets_disponible, 2)
        }
    }


def _calculer_bankroll_a_date(date_limite_str):
    mouvements = list(col_mouvements.find({"date": {"$lt": date_limite_str}}))
    solde = 0.0
    for m in mouvements:
        montant = float(m.get("montant", 0) or 0)
        if m.get("type") in ("INIT", "DEPOT"):
            solde += montant
        elif m.get("type") == "RETRAIT":
            solde -= montant

    paris_clotures = list(col_paris.find({
        "Date_Cloture": {"$lt": date_limite_str},
        "Resultat_Final": {"$in": list(RESULTATS_REGLES)}
    }))
    pnl = sum(_pnl_cash_pari(p) for p in paris_clotures)
    return solde + pnl



class RequeteMouvement(BaseModel):
    type: str
    montant: float
    label: str = ""


@router.post("/mouvement_bankroll", dependencies=[Depends(require_master)])
def mouvement_bankroll(req: RequeteMouvement):
    type_mouvement = req.type.upper().strip()
    if type_mouvement not in ("DEPOT", "RETRAIT", "FREEBET"):
        raise HTTPException(status_code=400, detail="Type de mouvement invalide (DEPOT, RETRAIT ou FREEBET).")
    if req.montant is None or req.montant <= 0:
        raise HTTPException(status_code=400, detail="Montant invalide.")

    config = col_parametres.find_one({"type": "bankroll"})
    if not config:
        raise HTTPException(status_code=400, detail="Bankroll non initialisée. Initialise d'abord ton capital.")

    if type_mouvement == "DEPOT":
        col_parametres.update_one({"type": "bankroll"}, {"$inc": {"capital": req.montant}})
    elif type_mouvement == "RETRAIT":
        disponible_actuel = _calculer_finances_dict()["disponible"]
        if req.montant > disponible_actuel:
            raise HTTPException(status_code=400, detail="Fonds CASH disponibles insuffisants.")
        col_parametres.update_one({"type": "bankroll"}, {"$inc": {"capital": -req.montant}})
    elif type_mouvement == "FREEBET":
        col_parametres.update_one({"type": "bankroll"}, {"$inc": {"freebets_total_acquis": req.montant}}, upsert=True)

    doc_mouvement = {
        "type": type_mouvement,
        "montant": req.montant,
        "label": req.label or "Transaction Standard",
        "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": datetime.now().timestamp()
    }
    col_mouvements.insert_one(doc_mouvement)

    return {"message": "Mouvement enregistré.", "finances": _calculer_finances_dict()}


@router.get("/mouvements_bankroll", dependencies=[Depends(require_any_role)])
def get_mouvements_bankroll():
    cursor = col_mouvements.find().sort([("timestamp", 1)])
    mouvements = []
    solde_cumule = 0.0
    for doc in cursor:
        montant = float(doc.get("montant", 0) or 0)
        type_m = doc.get("type")
        if type_m in ("INIT", "DEPOT"):
            solde_cumule += montant
        elif type_m == "RETRAIT":
            solde_cumule -= montant
        mouvements.append({
            "id": str(doc["_id"]),
            "date": doc.get("date"),
            "type": type_m,
            "label": doc.get("label"),
            "montant": montant if type_m != "RETRAIT" else -montant,
            "balance": round(solde_cumule, 2) if type_m != "FREEBET" else round(solde_cumule, 2)
        })
    mouvements.reverse()
    return {"mouvements": mouvements}


# ==========================================
# ⚠️ ANCIEN SYSTÈME DE MISE FIXE (conservé pour compat, plus utilisé par le frontend V2)
# ==========================================
class RequeteConfigMise(BaseModel):
    pourcentage: float


@router.get("/config_mise", dependencies=[Depends(require_any_role)])
def get_config_mise():
    config = col_parametres.find_one({"type": "config_mise"})
    pourcentage = float(config.get("pourcentage", 0.035)) if config else 0.035
    return {"pourcentage": pourcentage}


@router.post("/config_mise", dependencies=[Depends(require_master)])
def set_config_mise(req: RequeteConfigMise):
    if req.pourcentage is None or req.pourcentage <= 0 or req.pourcentage > 1:
        raise HTTPException(status_code=400, detail="Pourcentage invalide (doit être compris entre 0 et 1).")
    col_parametres.update_one({"type": "config_mise"}, {"$set": {"pourcentage": req.pourcentage}}, upsert=True)
    return {"message": "Pourcentage mis à jour.", "pourcentage": req.pourcentage}


@router.get("/bankroll_semaine", dependencies=[Depends(require_any_role)])
def get_bankroll_semaine():
    now = datetime.now()
    lundi = now - timedelta(days=now.weekday())
    lundi = lundi.replace(hour=0, minute=0, second=0, microsecond=0)
    limite_str = lundi.strftime("%Y-%m-%d %H:%M:%S")

    bankroll_fin_semaine_precedente = _calculer_bankroll_a_date(limite_str)
    if bankroll_fin_semaine_precedente <= 0:
        bankroll_fin_semaine_precedente = _calculer_finances_dict()["total"]

    return {"bankroll_fin_semaine_precedente": round(bankroll_fin_semaine_precedente, 2)}


# ==========================================
# 🆕 V2 — PROFIL DE RISQUE (remplace le % fixe)
# ==========================================
@router.get("/config_profil", dependencies=[Depends(require_any_role)])
def get_config_profil():
    config = col_parametres.find_one({"type": "profil_risque"})
    profil = config.get("profil", "EQUILIBRE") if config else "EQUILIBRE"
    return {"profil": profil, "exposition_max": PROFILS_EXPOSITION[profil]}


class RequeteProfil(BaseModel):
    profil: str


@router.post("/config_profil", dependencies=[Depends(require_master)])
def set_config_profil(req: RequeteProfil):
    profil = req.profil.upper().strip()
    if profil not in PROFILS_EXPOSITION:
        raise HTTPException(status_code=400, detail="Profil invalide (PRUDENT, EQUILIBRE, AGRESSIF).")
    col_parametres.update_one({"type": "profil_risque"}, {"$set": {"profil": profil}}, upsert=True)
    return {"profil": profil, "exposition_max": PROFILS_EXPOSITION[profil]}


# --- ROUTES PROTÉGÉES ---


class RequeteInitBankroll(BaseModel):
    capital: float

@router.post("/init_bankroll", dependencies=[Depends(require_master)])
def init_bankroll(req: RequeteInitBankroll):
    col_parametres.update_one(
        {"type": "bankroll"},
        {"$set": {"capital": req.capital, "freebets_total_acquis": 0}},
        upsert=True
    )
    col_mouvements.insert_one({
        "type": "INIT",
        "montant": req.capital,
        "label": "Initialisation Bankroll",
        "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": datetime.now().timestamp()
    })
    return {"message": "Capital initialisé.", "finances": _calculer_finances_dict()}

@router.get("/finances", dependencies=[Depends(require_any_role)])
def get_finances():
    return _calculer_finances_dict()

