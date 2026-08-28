"""
Routes "paris" : cycle de vie d'un pari individuel (analyse d'un match, validation,
clôture, modification, annulation) + Scanner de Marché / liste des prochains matchs.

⚠️ Logique métier INCHANGÉE — déplacée depuis Serveur_Hydre.py. Seules les
dépendances de sécurité ont été mises à jour (MASTER pour l'écriture, MASTER+VIEWER
pour la lecture) dans le cadre du refactoring MASTER/VIEWER.

🆕 Ajout (lecture seule, aucun impact sur la logique HYDRE/scores/edges) : chaque
Matrice de Tir générée par le MASTER via /analyser est désormais persistée
(col_matrices), et une route GET /matrice_tir/{id_match} permet au VIEWER de la
consulter — la dernière matrice générée pour un match, y compris pour un pari déjà
bloqué/validé — sans jamais pouvoir en déclencher une nouvelle.
"""
from typing import List, Optional
from datetime import datetime
import itertools

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth import require_master, require_any_role
from backend.config import col_fixtures, col_paris, col_matrices
from backend.utils import safe_float, _cote_est_verrouillee
from backend.hydre_engine import (
    calculer_predictions_completes, evaluer_profil, respecte_criteres_selection,
    _snapshot_score_hydre_pour_match, _scanner_marche_data,
)
from backend.bankroll import _calculer_finances_dict

from backend.utils import SEUIL_GEL_COTE_HEURES

router = APIRouter()


@router.get("/prochains_matchs", dependencies=[Depends(require_any_role)])
def get_prochains_matchs():
    try:
        cursor = col_fixtures.find().sort([("Date", 1), ("Time", 1)])
        matchs = []
        now = datetime.now()
        # 🔧 FIX §3 : score/edge d'un pari déjà bloqué (JOUE) doivent être le SNAPSHOT enregistré
        # avec ce pari au moment de sa validation (col_paris.score / col_paris.edge) — jamais
        # recalculés à la volée (ce recalcul relatif au pool du jour est ce qui les faisait changer
        # après le blocage d'autres matchs). On les indexe une fois par id_match pour éviter de
        # requêter col_paris à chaque itération.
        snapshots_par_id = {
            p["id_match"]: {"score": p.get("score"), "edge": p.get("edge")}
            for p in col_paris.find({}, {"id_match": 1, "score": 1, "edge": 1})
        }
        for doc in cursor:
            statut = doc.get("Statut", "A_REMPLIR")
            if statut == "ARCHIVE": continue
            dt_str = f"{doc['Date']} {doc['Time']}"
            try: match_dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M")
            except: continue

            heures_ecoulees = (now - match_dt).total_seconds() / 3600
            # 🆕 §9 : un match sans cote qui passe sous H-2 disparaît des listes de saisie/analyse
            # (il n'est plus "actionnable"), sans jamais être supprimé de la base.
            if statut == "A_REMPLIR" and heures_ecoulees > -SEUIL_GEL_COTE_HEURES: continue
            if statut == "ANALYSE" and heures_ecoulees > 4: continue

            match_id = f"{doc['HomeTeam']}_{doc['AwayTeam']}_{doc['Date']}"
            snap = snapshots_par_id.get(match_id, {})
            matchs.append({
                "id": match_id, "div": doc.get("Div", "Inconnu"),
                "date": dt_str,
                "home_team": doc['HomeTeam'], "away_team": doc['AwayTeam'],
                "cote_ouv_dom": round(safe_float(doc.get('Cote_Dom')), 2),
                "cote_ouv_nul": round(safe_float(doc.get('Cote_Nul')), 2),
                "cote_ouv_ext": round(safe_float(doc.get('Cote_Ext')), 2),
                "cote_act_dom": safe_float(doc.get('Cote_Actuelle_Dom', 0)) or "",
                "cote_act_nul": safe_float(doc.get('Cote_Actuelle_Nul', 0)) or "",
                "cote_act_ext": safe_float(doc.get('Cote_Actuelle_Ext', 0)) or "",
                "statut": statut, "derniere_analyse": doc.get("Derniere_Analyse", 0),
                "pari_choisi": doc.get("Pari_Choisi", ""), "cote_choisie": doc.get("Cote_Choisie", 0.0),
                "mise": doc.get("Mise", 0.0),
                # 🆕 §3/§5 : visibles sans ambiguïté sur un pari bloqué/en cours (JOUE).
                "type_fond": doc.get("Type_Fond", "CASH"),
                "bookmaker": doc.get("Bookmaker", ""),
                # 🔧 FIX §3 : snapshot figé (None si le pari n'a pas encore été bloqué, ou si aucun
                # score n'avait été calculé à ce moment-là — jamais inventé, jamais recalculé ici).
                "score": snap.get("score"),
                "edge": snap.get("edge")
            })
        return {"matchs": matchs}
    except Exception as e:
        return {"matchs": [], "erreur": str(e)}


class RequeteMatch(BaseModel):
    home_team: str
    away_team: str
    cote_ouverture_dom: float
    cote_actuelle_dom: float
    cote_ouverture_nul: float
    cote_actuelle_nul: float
    cote_ouverture_ext: float
    cote_actuelle_ext: float

@router.post("/analyser", dependencies=[Depends(require_master)])
def analyser_match(requete: RequeteMatch):
    doc = col_fixtures.find_one({"HomeTeam": requete.home_team, "AwayTeam": requete.away_team})
    if not doc: raise HTTPException(status_code=404, detail="Match introuvable.")

    statut_actuel = doc.get("Statut", "A_REMPLIR")
    nouveau_statut = "JOUE" if statut_actuel == "JOUE" else "ANALYSE"
    col_fixtures.update_one({"_id": doc["_id"]}, {
        "$set": {"Cote_Actuelle_Dom": requete.cote_actuelle_dom, "Cote_Actuelle_Nul": requete.cote_actuelle_nul,
                 "Cote_Actuelle_Ext": requete.cote_actuelle_ext, "Statut": nouveau_statut,
                 "Derniere_Analyse": datetime.now().timestamp()}})
    # Le document en mémoire doit refléter la mise à jour ci-dessus : il est réutilisé plus bas
    # par _snapshot_score_hydre_pour_match (§1) pour calculer le Score Hydre avec les cotes à jour.
    doc["Cote_Actuelle_Dom"] = requete.cote_actuelle_dom
    doc["Cote_Actuelle_Nul"] = requete.cote_actuelle_nul
    doc["Cote_Actuelle_Ext"] = requete.cote_actuelle_ext
    doc["Statut"] = nouveau_statut

    pred = calculer_predictions_completes(
        doc, requete.cote_ouverture_dom, requete.cote_actuelle_dom,
        requete.cote_ouverture_nul, requete.cote_actuelle_nul,
        requete.cote_ouverture_ext, requete.cote_actuelle_ext
    )
    features_dict = pred["features"]
    l_H, l_D, l_A = pred["probas"]["LGBM"]["H"], pred["probas"]["LGBM"]["D"], pred["probas"]["LGBM"]["A"]
    x_H, x_D, x_A = pred["probas"]["XGB"]["H"], pred["probas"]["XGB"]["D"], pred["probas"]["XGB"]["A"]
    h_H, h_D, h_A = pred["probas"]["Hydre"]["H"], pred["probas"]["Hydre"]["D"], pred["probas"]["Hydre"]["A"]
    edges = pred["edges"]
    dxg = pred["dxg"]

    shots_H = features_dict['H_EMA15_Shots_F']
    shots_A = shots_H - features_dict['Delta_Shots_Pour']
    dom_ppg = features_dict['Dom_PPG']
    ext_ppg = features_dict['Ext_PPG']

    anomalies = []
    if dxg > 0.6: anomalies.append(f"🔥 xG Attendu : Avantage massif Domicile (+{dxg:.2f} xG)")
    elif dxg < -0.6: anomalies.append(f"🔥 xG Attendu : Avantage massif Extérieur ({dxg:.2f} xG)")
    datk = features_dict['Delta_Attaque_15J']
    if datk > 0.5: anomalies.append(f"⚔️ Attaque (15J) : Dynamique écrasante Dom (+{datk:.2f} buts/m)")
    elif datk < -0.5: anomalies.append(f"⚔️ Attaque (15J) : Dynamique écrasante Ext ({datk:.2f} buts/m)")
    if not anomalies: anomalies.append("⚖️ Match mathématiquement équilibré.")

    audit_comite = []
    issues = [("Domicile (H)", "H", requete.cote_actuelle_dom, edges["Hydre"]["H"]),
              ("Nul (D)", "D", requete.cote_actuelle_nul, edges["Hydre"]["D"]),
              ("Extérieur (A)", "A", requete.cote_actuelle_ext, edges["Hydre"]["A"])]
    tir_valide = False
    for nom_complet, code_issue, cote, edge in issues:
        profil = evaluer_profil(code_issue, cote, edge)
        if profil["statut"] == "VALIDE": tir_valide = True
        audit_comite.append({"issue": nom_complet, "cote": cote, "edge": round(edge, 2), "statut": profil["statut"],
                             "tag": profil["tag"], "detail": profil["detail"], "volume": profil["vol"],
                             "roi": round(profil["roi"], 2)})

    juge_msg = "🟢 TIRS RENTABLES DÉTECTÉS" if tir_valide else "🔴 NO BET : AUCUN PROFIL RENTABLE"

    # 🆕 CORRECTIF STOCKAGE (§1) : snapshot du VRAI Score Hydre pour ce match, calculé maintenant
    # (regroupé avec les autres matchs déjà ANALYSE de la même date réelle — cf. fonction ci-dessus).
    # None si le match n'est éligible à aucune issue simple : jamais inventé.
    score_hydre_snapshot = _snapshot_score_hydre_pour_match(doc)

    match_id = f"{requete.home_team}_{requete.away_team}_{doc['Date']}"

    resultat = {
        "Match": f"{requete.home_team} vs {requete.away_team}", "matchObj": {"div": doc.get("Div", "Inconnu")},
        "Score_Hydre": score_hydre_snapshot,
        "Radar_Marche": {"Ouv": {"H": float(requete.cote_ouverture_dom), "D": float(requete.cote_ouverture_nul),
                                 "A": float(requete.cote_ouverture_ext)},
                         "Act": {"H": float(requete.cote_actuelle_dom), "D": float(requete.cote_actuelle_nul),
                                 "A": float(requete.cote_actuelle_ext)},
                         "Drop": {"H": float(round(requete.cote_ouverture_dom - requete.cote_actuelle_dom, 2)),
                                  "D": float(round(requete.cote_ouverture_nul - requete.cote_actuelle_nul, 2)),
                                  "A": float(round(requete.cote_ouverture_ext - requete.cote_actuelle_ext, 2))}},
        "Matrice_Probas": {"LGBM": {"H": float(round(l_H, 1)), "D": float(round(l_D, 1)), "A": float(round(l_A, 1))},
                           "XGB": {"H": float(round(x_H, 1)), "D": float(round(x_D, 1)), "A": float(round(x_A, 1))},
                           "Hydre": {"H": float(round(h_H, 1)), "D": float(round(h_D, 1)), "A": float(round(h_A, 1))}},
        "Scanner_Value": {"LGBM": {k: float(round(v, 2)) for k, v in edges["LGBM"].items()},
                          "XGB": {k: float(round(v, 2)) for k, v in edges["XGB"].items()},
                          "Hydre": {k: float(round(v, 2)) for k, v in edges["Hydre"].items()}},
        "Boucliers": {"DC_1X": {"Proba": float(round(h_H + h_D, 1)),
                                "CoteMin": float(round(100 / (h_H + h_D), 2)) if (h_H + h_D) > 0 else 0.0},
                      "DC_X2": {"Proba": float(round(h_A + h_D, 1)),
                                "CoteMin": float(round(100 / (h_A + h_D), 2)) if (h_A + h_D) > 0 else 0.0},
                      "DC_12": {"Proba": float(round(h_H + h_A, 1)),
                                "CoteMin": float(round(100 / (h_H + h_A), 2)) if (h_H + h_A) > 0 else 0.0}},
        "Top_Stats": {"xG": {"H": float(round(features_dict['xG_Attendu_Dom'], 2)),
                             "A": float(round(features_dict['xG_Attendu_Ext'], 2)), "Delta": float(round(dxg, 2))},
                      "Tirs": {"H": float(round(shots_H, 1)), "A": float(round(shots_A, 1)),
                               "Delta": float(round(features_dict['Delta_Shots_Pour'], 1))},
                      "PPG": {"H": float(round(dom_ppg, 2)), "A": float(round(ext_ppg, 2)),
                              "Delta": float(round(features_dict['Delta_PPG_Saison'], 2))}},
        "Anomalies": anomalies[:3], "Audit_Comite": audit_comite,
        "Juge": {"Message": juge_msg, "Type": "VALIDE" if tir_valide else "NO_BET"}
    }

    # 🆕 Persiste un snapshot de cette Matrice de Tir (aucun impact sur la réponse ni sur la
    # logique de calcul ci-dessus) afin que le VIEWER puisse la consulter en lecture seule,
    # y compris après que ce match soit passé en statut JOUE (pari bloqué/validé).
    try:
        col_matrices.update_one(
            {"id_match": match_id},
            {"$set": {
                "id_match": match_id,
                "home_team": requete.home_team,
                "away_team": requete.away_team,
                "div": doc.get("Div", "Inconnu"),
                "matrice": resultat,
                "genere_le": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }},
            upsert=True
        )
    except Exception:
        # La persistance de la matrice est un confort de lecture pour le VIEWER : une erreur
        # ici ne doit jamais empêcher le MASTER d'obtenir sa Matrice de Tir.
        pass

    return resultat


@router.get("/matrice_tir/{id_match}", dependencies=[Depends(require_any_role)])
def get_matrice_tir(id_match: str):
    """🆕 Lecture seule (MASTER et VIEWER) de la dernière Matrice de Tir générée pour ce
    match — aucune analyse n'est déclenchée ici, aucune donnée n'est modifiée. Permet au
    VIEWER de consulter la matrice associée à un match analysé ou à un pari déjà bloqué,
    exactement telle qu'elle a été produite par le MASTER via /analyser."""
    doc = col_matrices.find_one({"id_match": id_match})
    if not doc:
        raise HTTPException(status_code=404, detail="Aucune Matrice de Tir disponible pour ce match pour le moment.")
    matrice = dict(doc["matrice"])
    matrice["_genere_le"] = doc.get("genere_le")
    return matrice


@router.get("/scanner_marche", dependencies=[Depends(require_any_role)])
def scanner_marche():
    return _scanner_marche_data()


class RequeteBase(BaseModel):
    home_team: str
    away_team: str

@router.post("/reset_match", dependencies=[Depends(require_master)])
def reset_match(req: RequeteBase):
    col_fixtures.update_one({"HomeTeam": req.home_team, "AwayTeam": req.away_team}, {"$set": {"Statut": "A_REMPLIR"},
                                                                                     "$unset": {"Cote_Actuelle_Dom": "",
                                                                                                "Cote_Actuelle_Nul": "",
                                                                                                "Cote_Actuelle_Ext": "",
                                                                                                "Derniere_Analyse": "",
                                                                                                "Pari_Choisi": "",
                                                                                                "Cote_Choisie": "",
                                                                                                "Mise": ""}})
    return {"message": "Cotes purgées"}

class RequeteAnnulationErreur(BaseModel):
    id_match: str
    home_team: str
    away_team: str

@router.post("/annuler_pari_erreur", dependencies=[Depends(require_master)])
def annuler_pari_erreur(req: RequeteAnnulationErreur):
    col_paris.delete_one({"id_match": req.id_match})
    col_fixtures.update_one({"HomeTeam": req.home_team, "AwayTeam": req.away_team}, {"$set": {"Statut": "A_REMPLIR"},
                                                                                     "$unset": {"Pari_Choisi": "",
                                                                                                "Cote_Choisie": "",
                                                                                                "Mise": "",
                                                                                                "Cote_Actuelle_Dom": "",
                                                                                                "Cote_Actuelle_Nul": "",
                                                                                                "Cote_Actuelle_Ext": "",
                                                                                                "Derniere_Analyse": ""}})
    return {"message": "Trade annulé"}


class RequeteModification(BaseModel):
    id_match: str
    home_team: str
    away_team: str
    nouvelle_cote: float
    nouvelle_mise: float

@router.post("/modifier_pari", dependencies=[Depends(require_master)])
def modifier_pari(req: RequeteModification):
    doc_pari = col_paris.find_one({"id_match": req.id_match})
    cote_actuelle = float(doc_pari.get("cote_choisie", 0) or 0) if doc_pari else None
    # 🆕 §8 : la cote d'un pari déjà engagé ne peut plus être modifiée à moins de 2h du coup d'envoi.
    date_match_pari = doc_pari.get("date") if doc_pari else None
    if cote_actuelle is not None and req.nouvelle_cote != cote_actuelle and _cote_est_verrouillee(date_match_pari):
        raise HTTPException(status_code=400, detail="🔒 Cote verrouillée : moins de 2h avant le coup d'envoi, la cote ne peut plus être modifiée.")

    col_fixtures.update_one({"HomeTeam": req.home_team, "AwayTeam": req.away_team},
                            {"$set": {"Cote_Choisie": req.nouvelle_cote, "Mise": req.nouvelle_mise}})
    col_paris.update_one({"id_match": req.id_match},
                         {"$set": {"cote_choisie": req.nouvelle_cote, "mise": req.nouvelle_mise}})
    return {"message": "Trade mis à jour."}


class RequetePari(BaseModel):
    id_match: str
    home_team: str
    away_team: str
    date: str
    div: str
    choix_pari: str
    cote_choisie: float
    cote_calculee: float = 0.0  # 🆕 §7 : cote initialement affichée/calculée (avant correction éventuelle)
    mise: float
    bookmaker: str = "WINAMAX"
    type_fond: str = "CASH"
    edge: Optional[float] = None  # 🆕 DASHBOARD V2 (§6 Performance par Edge) : edge de l'issue jouée si connu (simples uniquement)
    score: Optional[float] = None  # 🆕 DASHBOARD V2.1 (§4 Performance par Score Hydre) : score du Scanner de Marché si connu

@router.post("/valider_pari", dependencies=[Depends(require_master)])
def valider_pari(req: RequetePari):
    finances_actuelles = _calculer_finances_dict()
    if req.type_fond.upper() == "FREEBET":
        if req.mise > finances_actuelles["freebets"]["disponible"]:
            raise HTTPException(status_code=400, detail="Solde Freebet insuffisant.")
    else:
        if req.mise > finances_actuelles["disponible"]:
            raise HTTPException(status_code=400, detail="Fonds CASH insuffisants.")

    cote_calculee_origine = req.cote_calculee if req.cote_calculee and req.cote_calculee > 0 else req.cote_choisie
    # 🆕 §8 : à moins de 2h du coup d'envoi, la cote calculée fait foi — aucune correction manuelle.
    if cote_calculee_origine != req.cote_choisie and _cote_est_verrouillee(req.date):
        raise HTTPException(status_code=400, detail="🔒 Cote verrouillée : moins de 2h avant le coup d'envoi, la cote ne peut plus être modifiée.")

    col_fixtures.update_one({"HomeTeam": req.home_team, "AwayTeam": req.away_team}, {
        "$set": {"Statut": "JOUE", "Pari_Choisi": req.choix_pari, "Cote_Choisie": req.cote_choisie,
                 "Cote_Calculee_Origine": cote_calculee_origine, "Mise": req.mise, "Bookmaker": req.bookmaker,
                 "Type_Fond": req.type_fond.upper()}})  # 🆕 §3/§5 : exposé ensuite par /prochains_matchs
    doc_pari = req.dict()
    doc_pari["cote_calculee"] = cote_calculee_origine
    col_paris.insert_one({**doc_pari, "Date_Engagement": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
    return {"message": "✅ Pari verrouillé"}

class RequeteCloture(BaseModel):
    id_match: str
    home_team: str
    away_team: str
    resultat: str
    montant_retour: float
    cote_cloture: float = 0.0

def _cascade_perte_combo_freebet(id_match):
    """🆕 §2 : si le pari SIMPLE lié à ce match vient d'être déclaré PERDU, tout combiné
    Freebet encore en attente (Resultat_Final non réglé) qui contient ce même match parmi
    ses sélections est automatiquement déclaré PERDU à son tour — une seule jambe perdue
    suffit à faire perdre tout le combiné, sans attendre une action manuelle. Les conséquences
    financières s'appliquent normalement (Montant_Retour = 0, donc P&L cash = 0 pour ce
    combiné FREEBET — voir _pnl_cash_pari). Ne s'applique JAMAIS sur un GAGNÉ : le combiné
    doit alors attendre le résultat de ses autres sélections."""
    maintenant = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    combos_impactes = col_paris.find({
        "est_combine_freebet": True,
        "Resultat_Final": {"$exists": False},
        "selections_combine.id_match": id_match
    })
    for combo in combos_impactes:
        col_paris.update_one({"_id": combo["_id"]}, {"$set": {
            "Resultat_Final": "PERDU", "Montant_Retour": 0.0, "Cote_Cloture": 0.0,
            "Date_Cloture": maintenant,
            "cloture_automatique": True, "cloture_automatique_raison": f"Sélection perdante : {id_match}"
        }})

@router.post("/cloturer_pari", dependencies=[Depends(require_master)])
def cloturer_pari(req: RequeteCloture):
    col_fixtures.update_one({"HomeTeam": req.home_team, "AwayTeam": req.away_team}, {"$set": {"Statut": "ARCHIVE"}})
    col_paris.update_one({"id_match": req.id_match}, {
        "$set": {"Resultat_Final": req.resultat, "Montant_Retour": req.montant_retour, "Cote_Cloture": req.cote_cloture,
                 "Date_Cloture": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}})

    # 🆕 §2 : cascade automatique — un pari simple PERDU entraîne la perte des combinés Freebet
    # qui le contiennent comme sélection (jamais l'inverse pour un GAGNÉ).
    if req.resultat.upper() == "PERDU":
        _cascade_perte_combo_freebet(req.id_match)

    return {"message": "Pari clôturé et archivé."}


# ==========================================
# 🆕 FREEBET OPTIMIZER
# ==========================================
# Principe : on ne construit des combinés QUE parmi les matchs du jour, pas encore
# commencés, et qui sont soit SELECTIONNE (retenus par Hydre pour le cash) soit
# POTABLE (qualifiés par les critères V2 mais "bloqués" hors du cash faute de budget
# d'exposition). Comme chaque match ne fournit au maximum qu'une seule issue qualifiée
# (celle choisie par le Scanner de Marché), itertools.combinations garantit à la fois
# l'absence de doublons de combinés ET l'absence de deux sélections du même match dans
# un même combiné.
