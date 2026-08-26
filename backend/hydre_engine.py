"""
Moteur Hydre — logique métier CŒUR : prédictions ML (LightGBM/XGBoost), classement
de profil (SAFE/MID/AMBITIEUX/LOTO via evaluer_profil), critères de sélection,
score Hydre relatif au groupe (_calculer_scores_groupe) et son snapshot figé au
moment de la sélection (_snapshot_score_hydre_pour_match), Scanner de Marché.

⚠️ Aucune formule, aucun seuil, aucun poids n'a été modifié — code déplacé À
L'IDENTIQUE depuis Serveur_Hydre.py dans le cadre du refactoring MASTER/VIEWER.
"""
import pandas as pd
import numpy as np
from datetime import datetime

from backend.config import (
    col_fixtures, col_paris, col_profilage, col_parametres,
    lgbm_model, xgb_model, label_encoder,
    FEATURES_ELITE, PROFILS_EXPOSITION, MISE_MIN_PCT, MISE_MAX_PCT,
    SEUIL_PROBA, COTE_MIN, COTE_MAX, PONDERATION_SCORE,
)
from backend.utils import safe_float


def evaluer_profil(issue_code, cote, edge):
    """Lecture de la Matrice 3D historique (ROI / Volume). Purement informatif désormais :
    ne sert plus de filtre de sélection, mais alimente le score et le rapport 'Matrice de Tir'."""
    tranche_c = "[> 15.0]"
    if 1.0 <= cote < 1.5: tranche_c = "[1.0 - 1.5]"
    elif 1.5 <= cote < 2.0: tranche_c = "[1.5 - 2.0]"
    elif 2.0 <= cote < 2.5: tranche_c = "[2.0 - 2.5]"
    elif 2.5 <= cote < 3.0: tranche_c = "[2.5 - 3.0]"
    elif 3.0 <= cote < 3.5: tranche_c = "[3.0 - 3.5]"
    elif 3.5 <= cote < 4.0: tranche_c = "[3.5 - 4.0]"
    elif 4.0 <= cote < 5.0: tranche_c = "[4.0 - 5.0]"
    elif 5.0 <= cote < 7.0: tranche_c = "[5.0 - 7.0]"
    elif 7.0 <= cote < 10.0: tranche_c = "[7.0 - 10.0]"
    elif 10.0 <= cote < 15.0: tranche_c = "[10.0 - 15.0]"

    tranche_e = ""
    if edge < -10: tranche_e = "< -10%"
    elif -10 <= edge < -5: tranche_e = "[-10% à -5%]"
    elif -5 <= edge < -2: tranche_e = "[-5% à -2%]"
    elif -2 <= edge < 0: tranche_e = "[-2% à 0%]"
    elif 0 <= edge < 3: tranche_e = "[0% à 3%]"
    elif 3 <= edge < 6: tranche_e = "[3% à 6%]"
    elif 6 <= edge < 10: tranche_e = "[6% à 10%]"
    elif 10 <= edge < 15: tranche_e = "[10% à 15%]"
    elif 15 <= edge < 20: tranche_e = "[15% à 20%]"
    else: tranche_e = "> +20%"

    profil_historique = col_profilage.find_one({"Issue": issue_code, "Tranche_Cote": tranche_c, "Tranche_Edge": tranche_e})
    if not profil_historique: return {"statut": "REJETE", "tag": "INCONNU", "detail": f"{tranche_c} | {tranche_e}", "vol": 0, "roi": 0.0}

    vol = profil_historique.get("Volume", 0)
    roi = profil_historique.get("ROI", 0.0)
    detail_matrice = f"{tranche_c} | {tranche_e}"

    if vol < 50: return {"statut": "REJETE", "tag": "MANQUE D'HISTORIQUE", "detail": detail_matrice, "vol": vol, "roi": roi}
    if roi > 0:
        if roi > 15: tag = "KILL ZONE ABSOLUE"
        elif roi > 5: tag = "TRÈS RENTABLE"
        else: tag = "JOUABLE"
        return {"statut": "VALIDE", "tag": tag, "detail": detail_matrice, "vol": vol, "roi": roi}
    else:
        return {"statut": "REJETE", "tag": "TROU NOIR (ROI Négatif)", "detail": detail_matrice, "vol": vol, "roi": roi}


def calculer_predictions_completes(doc, cote_ouv_dom, cote_act_dom, cote_ouv_nul, cote_act_nul, cote_ouv_ext, cote_act_ext):
    """🔒 LOGIQUE DE PRÉDICTION IA INCHANGÉE (V1). Extraite en fonction réutilisable
    pour être appelée à la fois par /analyser (rapport détaillé) et /scanner_marche (classement global)."""
    dom_j, ext_j = safe_float(doc.get('Dom_Matchs_Joues', 0)), safe_float(doc.get('Ext_Matchs_Joues', 0))
    dom_ppg = safe_float(doc.get('Dom_Points_Saison', 0)) / dom_j if dom_j > 0 else 0
    ext_ppg = safe_float(doc.get('Ext_Points_Saison', 0)) / ext_j if ext_j > 0 else 0
    dom_buts_moyens = safe_float(doc.get('Dom_Buts_Marques_Saison', 0)) / dom_j if dom_j > 0 else 0
    ext_buts_moyens = safe_float(doc.get('Ext_Buts_Marques_Saison', 0)) / ext_j if ext_j > 0 else 0
    dom_enc_moyens = safe_float(doc.get('Dom_Buts_Encaisses_Saison', 0)) / dom_j if dom_j > 0 else 0
    ext_enc_moyens = safe_float(doc.get('Ext_Buts_Encaisses_Saison', 0)) / ext_j if ext_j > 0 else 0
    shots_H = safe_float(doc.get('H_EMA15_Shots_F', 0))
    shots_A = safe_float(doc.get('A_EMA15_Shots_F', 0))

    features_dict = {
        'Delta_xG': safe_float(doc.get('xG_Attendu_Dom', 0)) - safe_float(doc.get('xG_Attendu_Ext', 0)),
        'Delta_Shots_Pour': shots_H - shots_A, 'Delta_PPG_Saison': dom_ppg - ext_ppg,
        'Delta_Shots_Contre': safe_float(doc.get('A_EMA15_Shots_A', 0)) - safe_float(doc.get('H_EMA15_Shots_A', 0)),
        'Delta_Attaque_Saison': dom_buts_moyens - ext_buts_moyens,
        'Delta_Defense_Saison': ext_enc_moyens - dom_enc_moyens,
        'Delta_Defense_15J': safe_float(doc.get('Ext_Moy15_Buts_Encaisses', 0)) - safe_float(doc.get('Dom_Moy15_Buts_Encaisses', 0)),
        'Delta_Corn_Pour': safe_float(doc.get('H_EMA15_Corn_F', 0)) - safe_float(doc.get('A_EMA15_Corn_F', 0)),
        'Delta_Corn_Contre': safe_float(doc.get('A_EMA15_Corn_A', 0)) - safe_float(doc.get('H_EMA15_Corn_A', 0)),
        'Dom_PPG': dom_ppg, 'Ext_PPG': ext_ppg, 'xG_Attendu_Dom': safe_float(doc.get('xG_Attendu_Dom', 0)),
        'xG_Attendu_Ext': safe_float(doc.get('xG_Attendu_Ext', 0)),
        'Drop_Cote_Dom': cote_ouv_dom - cote_act_dom,
        'Drop_Cote_Ext': cote_ouv_ext - cote_act_ext,
        'Ext_Moy15_Buts_Marques': safe_float(doc.get('Ext_Moy15_Buts_Marques', 0)), 'Ext_Buts_Moyens': ext_buts_moyens,
        'Delta_SOT_Pour': safe_float(doc.get('H_EMA15_SOT_F', 0)) - safe_float(doc.get('A_EMA15_SOT_F', 0)),
        'H_EMA15_Shots_F': shots_H,
        'Delta_SOT_Contre': safe_float(doc.get('A_EMA15_SOT_A', 0)) - safe_float(doc.get('H_EMA15_SOT_A', 0)),
        'Dom_Moy15_Buts_Encaisses': safe_float(doc.get('Dom_Moy15_Buts_Encaisses', 0)),
        'Ext_Moy15_Buts_Encaisses': safe_float(doc.get('Ext_Moy15_Buts_Encaisses', 0)),
        'Delta_Attaque_15J': safe_float(doc.get('Dom_Moy15_Buts_Marques', 0)) - safe_float(doc.get('Ext_Moy15_Buts_Marques', 0)),
        'Dom_Buts_Moyens': dom_buts_moyens
    }

    df_predict = pd.DataFrame([features_dict], columns=FEATURES_ELITE)
    probs_lgbm = lgbm_model.predict_proba(df_predict)[0]
    probs_xgb = xgb_model.predict_proba(df_predict)[0]
    classes = label_encoder.classes_
    idx_H, idx_D, idx_A = np.where(classes == 'H')[0][0], np.where(classes == 'D')[0][0], np.where(classes == 'A')[0][0]
    l_H, l_D, l_A = probs_lgbm[idx_H] * 100, probs_lgbm[idx_D] * 100, probs_lgbm[idx_A] * 100
    x_H, x_D, x_A = probs_xgb[idx_H] * 100, probs_xgb[idx_D] * 100, probs_xgb[idx_A] * 100
    h_H, h_D, h_A = (l_H + x_H) / 2, (l_D + x_D) / 2, (l_A + x_A) / 2

    def calc_edge(proba, cote):
        return ((proba / 100) * cote - 1) * 100 if cote > 0 else 0

    edges_hydre = {"H": calc_edge(h_H, cote_act_dom), "D": calc_edge(h_D, cote_act_nul), "A": calc_edge(h_A, cote_act_ext)}
    edges_lgbm = {"H": calc_edge(l_H, cote_act_dom), "D": calc_edge(l_D, cote_act_nul), "A": calc_edge(l_A, cote_act_ext)}
    edges_xgb = {"H": calc_edge(x_H, cote_act_dom), "D": calc_edge(x_D, cote_act_nul), "A": calc_edge(x_A, cote_act_ext)}

    return {
        "features": features_dict,
        "probas": {"LGBM": {"H": l_H, "D": l_D, "A": l_A}, "XGB": {"H": x_H, "D": x_D, "A": x_A}, "Hydre": {"H": h_H, "D": h_D, "A": h_A}},
        "edges": {"LGBM": edges_lgbm, "XGB": edges_xgb, "Hydre": edges_hydre},
        "dxg": features_dict['Delta_xG']
    }


def respecte_criteres_selection(proba, cote, edge):
    """🆕 Nouveaux critères V2 — appliqués UNIQUEMENT aux issues simples (H/D/A)."""
    return proba > SEUIL_PROBA and COTE_MIN <= cote <= COTE_MAX and edge > 0


def normaliser(valeur, mini, maxi):
    if maxi == mini:
        return 0.5
    return max(0.0, min(1.0, (valeur - mini) / (maxi - mini)))


# ==========================================
# 🆕 GESTION FINANCIÈRE CENTRALISÉE (CASH + FREEBETS + MOUVEMENTS)
# ==========================================

RESULTATS_REGLES = ("GAGNE", "PERDU", "CASHOUT")  # règlements définitifs (hors ANNULÉ)


def _calculer_scores_groupe(groupe):
    """🔒 Formule INCHANGÉE du Scanner de Marché (PONDERATION_SCORE) — calcule un score relatif au
    sein du groupe fourni (matchs POTABLE partageant la même date réelle). Modifie 'score' en place."""
    if not groupe:
        return
    edges = [r["edge"] for r in groupe]
    probas = [r["proba"] for r in groupe]
    rois = [r["roi_historique"] for r in groupe]
    vols = [r["volume_historique"] for r in groupe]
    gains = [r["gain_potentiel"] for r in groupe]

    mn_e, mx_e = min(edges), max(edges)
    mn_p, mx_p = min(probas), max(probas)
    mn_r, mx_r = min(rois), max(rois)
    mn_v, mx_v = min(vols), max(vols)
    mn_g, mx_g = min(gains), max(gains)

    for r in groupe:
        score = (
            PONDERATION_SCORE["edge"] * normaliser(r["edge"], mn_e, mx_e) +
            PONDERATION_SCORE["proba"] * normaliser(r["proba"], mn_p, mx_p) +
            PONDERATION_SCORE["roi_historique"] * normaliser(r["roi_historique"], mn_r, mx_r) +
            PONDERATION_SCORE["volume_historique"] * normaliser(r["volume_historique"], mn_v, mx_v) +
            PONDERATION_SCORE["gain_potentiel"] * normaliser(r["gain_potentiel"], mn_g, mx_g)
        ) * 100
        r["score"] = round(score, 1)

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

def _snapshot_score_hydre_pour_match(doc):
    """🆕 CORRECTIF STOCKAGE (§1) : calcule le VRAI Score Hydre pour un match isolé, au moment présent —
    en le regroupant avec tous les autres matchs déjà passés en Statut ANALYSE partageant la même date
    réelle, exactement comme le ferait le Scanner de Marché s'il tournait à cet instant précis.
    Le score du Scanner est RELATIF à un groupe (normalisé par min/max du jour) : il n'existe donc pas
    de "score" pour un match totalement isolé sans ce regroupement — on reproduit ici fidèlement le même
    calcul, sans en modifier la formule ni la logique de sélection.
    Retourne None si ce match n'est éligible à aucune issue simple (pas de score défini dans ce cas)."""
    date_reelle = doc.get("Date")
    if not date_reelle:
        return None
    match_id_cible = f"{doc['HomeTeam']}_{doc['AwayTeam']}_{doc['Date']}"

    fixtures_meme_date = list(col_fixtures.find({"Statut": "ANALYSE", "Date": date_reelle}))
    # Le match en cours d'analyse peut ne pas encore être en Statut ANALYSE en base au moment de l'appel
    # (selon l'ordre des opérations) : on l'ajoute explicitement s'il manque, sans le dupliquer.
    if not any(f.get("_id") == doc.get("_id") for f in fixtures_meme_date):
        fixtures_meme_date.append(doc)

    groupe = []
    for d in fixtures_meme_date:
        cote_dom = safe_float(d.get('Cote_Actuelle_Dom', 0))
        cote_nul = safe_float(d.get('Cote_Actuelle_Nul', 0))
        cote_ext = safe_float(d.get('Cote_Actuelle_Ext', 0))
        if cote_dom <= 0 or cote_nul <= 0 or cote_ext <= 0:
            continue
        p = calculer_predictions_completes(
            d, safe_float(d.get('Cote_Dom', 0)), cote_dom,
            safe_float(d.get('Cote_Nul', 0)), cote_nul,
            safe_float(d.get('Cote_Ext', 0)), cote_ext
        )
        cotes_map = {"H": cote_dom, "D": cote_nul, "A": cote_ext}
        issues_qualifiees = []
        for ci in ["H", "D", "A"]:
            proba = p["probas"]["Hydre"][ci]
            cote = cotes_map[ci]
            edge = p["edges"]["Hydre"][ci]
            if respecte_criteres_selection(proba, cote, edge):
                issues_qualifiees.append((ci, proba, cote, edge))
        if not issues_qualifiees:
            continue
        issue_choisie, proba, cote, edge = max(issues_qualifiees, key=lambda t: t[3])
        profil_histo = evaluer_profil(issue_choisie, cote, edge)
        gain_potentiel = cote - 1
        mid = f"{d['HomeTeam']}_{d['AwayTeam']}_{d['Date']}"
        groupe.append({
            "id": mid, "proba": round(proba, 1), "cote": round(cote, 2), "edge": round(edge, 2),
            "roi_historique": round(profil_histo["roi"], 2), "volume_historique": profil_histo["vol"],
            "gain_potentiel": round(gain_potentiel, 2)
        })

    if not groupe:
        return None

    _calculer_scores_groupe(groupe)
    for r in groupe:
        if r["id"] == match_id_cible:
            return r["score"]
    return None


# ==========================================
# 🆕 V2 — SCANNER DE MARCHÉ (score + sélection globale)
# ==========================================
def _exposition_cash_deja_engagee_par_date(bankroll_totale):
    """🔧 FIX exposition journalière : calcule, pour chaque date RÉELLE de match, le %
    de bankroll déjà engagé en paris CASH. Seule la date du MATCH compte (champ 'date'
    de col_paris), jamais la date à laquelle le pari a été enregistré. Retourne
    {date_str: pct_engage}."""
    deja_engage_euros = {}
    if bankroll_totale <= 0:
        return {}
    for p in col_paris.find({"type_fond": "CASH"}):
        date_match = str(p.get("date", ""))[:10]
        if not date_match:
            continue
        mise = float(p.get("mise", 0) or 0)
        deja_engage_euros[date_match] = deja_engage_euros.get(date_match, 0.0) + mise
    return {d: (m / bankroll_totale) * 100 for d, m in deja_engage_euros.items()}


def _scanner_marche_data():
    """🔒 LOGIQUE INCHANGÉE du Scanner de Marché V2, extraite en fonction réutilisable
    pour être appelée à la fois par /scanner_marche et par le Freebet Optimizer."""
    config = col_parametres.find_one({"type": "profil_risque"})
    profil = config.get("profil", "EQUILIBRE") if config else "EQUILIBRE"
    exposition_max = PROFILS_EXPOSITION[profil]

    fixtures = list(col_fixtures.find({"Statut": "ANALYSE"}))
    resultats = []

    for doc in fixtures:
        cote_dom = safe_float(doc.get('Cote_Actuelle_Dom', 0))
        cote_nul = safe_float(doc.get('Cote_Actuelle_Nul', 0))
        cote_ext = safe_float(doc.get('Cote_Actuelle_Ext', 0))
        if cote_dom <= 0 or cote_nul <= 0 or cote_ext <= 0:
            continue

        pred = calculer_predictions_completes(
            doc, safe_float(doc.get('Cote_Dom', 0)), cote_dom,
            safe_float(doc.get('Cote_Nul', 0)), cote_nul,
            safe_float(doc.get('Cote_Ext', 0)), cote_ext
        )

        cotes_map = {"H": cote_dom, "D": cote_nul, "A": cote_ext}
        issues_qualifiees = []
        for code_issue in ["H", "D", "A"]:
            proba = pred["probas"]["Hydre"][code_issue]
            cote = cotes_map[code_issue]
            edge = pred["edges"]["Hydre"][code_issue]
            if respecte_criteres_selection(proba, cote, edge):
                issues_qualifiees.append((code_issue, proba, cote, edge))

        match_id = f"{doc['HomeTeam']}_{doc['AwayTeam']}_{doc['Date']}"
        base_info = {
            "id": match_id, "div": doc.get("Div", "Inconnu"), "date": f"{doc['Date']} {doc['Time']}",
            "home_team": doc['HomeTeam'], "away_team": doc['AwayTeam'],
        }

        if not issues_qualifiees:
            resultats.append({
                **base_info, "statut": "NON_CONFORME", "issue": None, "score": 0,
                "proba": 0, "cote": 0, "edge": 0, "mise_pct": 0, "mise_euros": 0,
                "roi_historique": 0, "volume_historique": 0
            })
            continue

        issue_choisie, proba, cote, edge = max(issues_qualifiees, key=lambda t: t[3])
        profil_histo = evaluer_profil(issue_choisie, cote, edge)
        gain_potentiel = cote - 1

        resultats.append({
            **base_info, "statut": "POTABLE",
            "issue": issue_choisie, "proba": round(proba, 1), "cote": round(cote, 2), "edge": round(edge, 2),
            "roi_historique": round(profil_histo["roi"], 2), "volume_historique": profil_histo["vol"],
            "gain_potentiel": round(gain_potentiel, 2)
        })

    # 🆕 EXPOSITION JOURNALIÈRE (§11/§12) — la sélection et le budget d'exposition sont calculés
    # INDÉPENDAMMENT pour chaque date réelle de match (doc['Date']), jamais mélangés entre eux.
    # Un match préparé pour demain consomme le budget de "demain", pas celui d'aujourd'hui.
    def _scorer_et_selectionner(groupe, exposition_disponible):
        """Score + sélectionne un groupe de matchs POTABLE partageant la même date réelle,
        en respectant le budget ENCORE DISPONIBLE pour cette date (plafond de 20% moins
        ce qui est déjà engagé en CASH sur cette même date). Modifie 'statut'/'score'/
        'mise_pct' en place. Retourne (mise_unitaire_pct, nb_selectionnes)."""
        if not groupe or exposition_disponible <= 0:
            for r in groupe:
                r["statut"] = "POTABLE"
                r["mise_pct"] = 0.0
            return 0.0, 0

        _calculer_scores_groupe(groupe)

        groupe.sort(key=lambda r: r["score"], reverse=True)

        n_max_selectable = int(exposition_disponible // MISE_MIN_PCT)
        k = min(len(groupe), n_max_selectable)

        mise_unitaire_pct_groupe = 0.0
        if k > 0:
            mise_unitaire_pct_groupe = exposition_disponible / k
            mise_unitaire_pct_groupe = max(MISE_MIN_PCT, min(MISE_MAX_PCT, mise_unitaire_pct_groupe))
            # 🔒 Le plafond de 20% reste strict même après division : si l'arrondi/plancher
            # MISE_MIN_PCT fait dépasser le budget disponible, on retire les derniers matchs.
            while k > 0 and mise_unitaire_pct_groupe * k > exposition_disponible + 1e-9:
                k -= 1
                if k == 0:
                    mise_unitaire_pct_groupe = 0.0
                    break
                mise_unitaire_pct_groupe = exposition_disponible / k
                mise_unitaire_pct_groupe = max(MISE_MIN_PCT, min(MISE_MAX_PCT, mise_unitaire_pct_groupe))

        for i, r in enumerate(groupe):
            if i < k:
                r["statut"] = "SELECTIONNE"
                r["mise_pct"] = round(mise_unitaire_pct_groupe, 2)
            else:
                r["statut"] = "POTABLE"
                r["mise_pct"] = 0.0

        return mise_unitaire_pct_groupe, k

    potables = [r for r in resultats if r["statut"] == "POTABLE"]
    dates_presentes = sorted(set(r["date"][:10] for r in potables))

    finances = _calculer_finances_dict()
    bankroll_totale = finances["total"]
    deja_engage_pct_par_date = _exposition_cash_deja_engagee_par_date(bankroll_totale)

    today_str = datetime.now().strftime("%Y-%m-%d")
    mise_unitaire_pct_today = 0.0
    nb_selectionnes_today = 0

    for date_reelle in dates_presentes:
        groupe = [r for r in potables if r["date"][:10] == date_reelle]
        deja_engage_pct = deja_engage_pct_par_date.get(date_reelle, 0.0)
        exposition_disponible = max(0.0, exposition_max - deja_engage_pct)
        mise_unitaire_pct_groupe, k = _scorer_et_selectionner(groupe, exposition_disponible)
        if date_reelle == today_str:
            mise_unitaire_pct_today = mise_unitaire_pct_groupe
            nb_selectionnes_today = k

    for r in resultats:
        if r.get("statut") == "SELECTIONNE":
            r["mise_euros"] = round(bankroll_totale * (r["mise_pct"] / 100), 2)
        else:
            r["mise_euros"] = 0.0

    resultats_tries = sorted(
        resultats,
        key=lambda r: (r["statut"] != "SELECTIONNE", r["statut"] != "POTABLE", -r.get("score", 0))
    )

    exposition_utilisee_today = round(
        deja_engage_pct_par_date.get(today_str, 0.0) +
        sum(r["mise_pct"] for r in resultats if r["statut"] == "SELECTIONNE" and r["date"][:10] == today_str), 2
    )

    return {
        "profil": profil,
        "exposition_max": exposition_max,
        "date_du_jour": today_str,
        # 🆕 Ces 3 champs (utilisés par le "PLAN DE JEU DU JOUR") ne reflètent QUE la date du jour,
        # jamais les matchs préparés à l'avance pour une date future.
        "nb_selectionnes": nb_selectionnes_today,
        "mise_unitaire_pct": round(mise_unitaire_pct_today, 2),
        "exposition_utilisee_pct": exposition_utilisee_today,
        "matchs": resultats_tries
    }


