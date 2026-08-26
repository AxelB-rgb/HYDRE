"""
Freebet Optimizer — construction et gestion du portefeuille de combinés freebet
(candidats, calcul des combinés, score/profil, diversification, portefeuille
progressif, validation et clôture des combinés).

⚠️⚠️ BLOC DÉPLACÉ EN UN SEUL MORCEAU, SANS AUCUNE MODIFICATION DE LOGIQUE, exactement
comme demandé : c'est le module le plus sensible du projet (scores, profils SAFE/MID/
AMBITIEUX/LOTO, score portefeuille). Seules les dépendances de sécurité ont été mises
à jour (MASTER pour l'écriture, MASTER+VIEWER pour la lecture des candidats/combinés/
progression — aucune de ces routes de lecture ne persiste de donnée).
"""
import itertools
import math
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from backend.auth import require_master, require_any_role
from backend.config import (
    col_paris,
    ISSUE_LABELS_BACK, FREEBET_MAX_COMBINAISONS_CALCULEES, FREEBET_TOP_N_PAR_TAILLE,
    PONDERATION_SCORE_FREEBET, FREEBET_SEUIL_RISQUE_FAIBLE, FREEBET_SEUIL_RISQUE_MOYEN,
    FREEBET_POIDS_INDICE_PROFIL, FREEBET_SEUIL_PROFIL_SAFE, FREEBET_SEUIL_PROFIL_MID,
    FREEBET_SEUIL_PROFIL_AMBITIEUX, FREEBET_PROFILS_INFO, FREEBET_PROFILS_ORDRE_AFFICHAGE,
    FREEBET_SEUIL_CONCENTRATION_MODEREE, FREEBET_SEUIL_CONCENTRATION_FORTE,
    FREEBET_SEUIL_CONCENTRATION_TRES_FORTE, FREEBET_POIDS_SCORE_PORTEFEUILLE,
    FREEBET_SEUILS_GAIN_BASE, FREEBET_MAX_TICKETS_PORTEFEUILLE,
    FREEBET_EPSILON_AMELIORATION_PORTEFEUILLE, FREEBET_MAX_PASSES_RAFFINEMENT_PORTEFEUILLE,
    FREEBET_DEBUG_PORTEFEUILLE_LOGS, KELLY_DIVISEUR_BASE, KELLY_DAMPENING_PAR_TAILLE,
    KELLY_DAMPENING_DEFAUT, MISE_MIN_FREEBET_COMBI,
)
from backend.utils import _cote_est_verrouillee
from backend.hydre_engine import _scanner_marche_data
from backend.bankroll import _calculer_finances_dict

router = APIRouter()


def _matchs_deja_dans_combo_freebet():
    """🔧 FIX : un match reste éligible au Freebet Optimizer tant qu'il n'a pas commencé,
    même s'il est déjà présent dans un (ou plusieurs) combiné(s) Freebet sélectionné/bloqué.
    Cette fonction ne sert donc plus à exclure un match de la pool — elle retourne toujours
    un ensemble vide (conservée uniquement pour compatibilité de signature avec les
    fonctions qui l'appellent)."""
    return set()


def _freebet_candidats_depuis_paris_cash(today_str, now, deja_dans_combo):
    """🆕 Réintègre comme candidats Freebet les matchs pour lesquels un pari CASH est déjà
    pris (col_paris, non réglé) mais dont le coup d'envoi n'a pas encore eu lieu.
    Réutilise les données déjà enregistrées avec le pari (cote, edge, score) au lieu de
    relancer une analyse : la probabilité est dérivée algébriquement de l'edge et de la
    cote déjà stockés (edge = (proba*cote - 1), donc proba = (edge/100 + 1) / cote).
    🔧 FIX : un match déjà présent dans un combiné Freebet verrouillé reste éligible tant
    qu'il n'a pas commencé — `deja_dans_combo` n'est plus utilisé pour exclure un match."""
    candidats = []
    for p in col_paris.find({"type_fond": "CASH", "Resultat_Final": {"$exists": False}}):
        id_match = p.get("id_match")
        if not id_match:
            continue
        date_str = str(p.get("date", ""))
        if not date_str.startswith(today_str):
            continue
        try:
            match_dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M")
        except Exception:
            continue
        if match_dt <= now:
            continue

        cote = float(p.get("cote_choisie", 0) or 0)
        edge = p.get("edge")
        if cote <= 0 or edge is None:
            # Donnée insuffisante pour dériver la probabilité sans recalcul : on ignore
            # ce pari plutôt que d'inventer une probabilité ou de relancer le modèle.
            continue
        edge = float(edge)
        proba = ((edge / 100.0) + 1.0) / cote * 100.0
        issue = p.get("choix_pari", "")

        candidats.append({
            "id": id_match, "home_team": p.get("home_team", ""), "away_team": p.get("away_team", ""),
            "div": p.get("div", "Inconnu"), "date": date_str, "statut": "SELECTIONNE",
            "issue": issue, "issue_label": ISSUE_LABELS_BACK.get(issue, issue),
            "cote": round(cote, 2), "proba": round(proba, 1), "edge": round(edge, 2),
            "score": p.get("score") or 0
        })
    return candidats


def _freebet_candidats_liste():
    data = _scanner_marche_data()
    now = datetime.now()
    today_str = now.strftime("%Y-%m-%d")
    deja_dans_combo = _matchs_deja_dans_combo_freebet()
    candidats = []
    for m in data["matchs"]:
        if m.get("statut") not in ("SELECTIONNE", "POTABLE"):
            continue
        date_str = m.get("date", "")
        if not date_str.startswith(today_str):
            continue
        try:
            match_dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M")
        except Exception:
            continue
        if match_dt <= now:
            continue
        # 🔧 FIX : un match déjà utilisé dans un (ou plusieurs) combiné(s) Freebet
        # sélectionné/bloqué reste éligible tant qu'il n'a pas commencé — il n'est plus
        # retiré de la pool. Plusieurs combinés peuvent donc réutiliser le même match.
        candidats.append({
            "id": m["id"], "home_team": m["home_team"], "away_team": m["away_team"],
            "div": m.get("div", "Inconnu"), "date": date_str, "statut": m["statut"],
            "issue": m["issue"], "issue_label": ISSUE_LABELS_BACK.get(m["issue"], m["issue"]),
            "cote": m["cote"], "proba": m["proba"], "edge": m["edge"], "score": m.get("score", 0)
        })

    # 🆕 Ajout des matchs déjà pris en CASH mais pas encore commencés (données réutilisées,
    # pas recalculées), en évitant tout doublon si un match était déjà présent ci-dessus.
    ids_deja_presents = {c["id"] for c in candidats}
    for c in _freebet_candidats_depuis_paris_cash(today_str, now, deja_dans_combo):
        if c["id"] not in ids_deja_presents:
            candidats.append(c)
            ids_deja_presents.add(c["id"])

    return candidats, today_str


@router.get("/freebet_candidats", dependencies=[Depends(require_any_role)])
def freebet_candidats():
    candidats, today_str = _freebet_candidats_liste()
    return {"candidats": candidats, "date_du_jour": today_str}


class RequeteFreebetCombos(BaseModel):
    tailles: List[int]


def _classer_profil_combo(proba_pct, edge_pct, qualite_selections, cote_totale):
    """🆕 Classe un combiné dans un profil dynamique (SAFE / MID / AMBITIEUX / LOTO).
    Le classement n'est JAMAIS basé sur le nombre de matchs : il repose sur un indice
    composite (proba 35%, edge 25%, qualité Hydre moyenne des sélections 20%, rendement 20% —
    une cote énorme tire l'indice vers le bas, donc vers LOTO), moins dominé par la seule
    probabilité qu'auparavant. Les seuils sont FIXES (contrairement au score, relatif
    au pool du jour) : un profil peut donc rester vide si aucun combiné n'atteint son seuil."""
    edge_clamp = max(0.0, min(edge_pct, 150.0))
    rendement_inverse = max(0.0, 1.0 - (min(cote_totale, 50.0) / 50.0)) * 100.0

    indice = (
        FREEBET_POIDS_INDICE_PROFIL["proba"] * proba_pct +
        FREEBET_POIDS_INDICE_PROFIL["edge"] * edge_clamp +
        FREEBET_POIDS_INDICE_PROFIL["qualite_selections"] * qualite_selections +
        FREEBET_POIDS_INDICE_PROFIL["rendement_inverse"] * rendement_inverse
    ) / 100.0 * 100.0  # déjà sur 0-100, division/multiplication laissée pour lisibilité

    if indice >= FREEBET_SEUIL_PROFIL_SAFE:
        profil_id = "SAFE"
    elif indice >= FREEBET_SEUIL_PROFIL_MID:
        profil_id = "MID"
    elif indice >= FREEBET_SEUIL_PROFIL_AMBITIEUX:
        profil_id = "AMBITIEUX"
    else:
        profil_id = "LOTO"

    label, description = FREEBET_PROFILS_INFO[profil_id]
    return profil_id, label, description, round(indice, 1)


def _calculer_base_combo(selections, taille):
    """🆕 Calcul de base d'un combiné (cote totale, probabilité, edge, EV, qualité des
    sélections, niveau de risque) — FACTORISÉ pour être utilisé à l'identique par le
    Freebet Optimizer automatique (_freebet_calculer_combos) ET par le constructeur
    manuel de combiné (_calculer_metriques_combo_manuel). Ne calcule ni score ni Kelly
    (qui ont besoin respectivement d'un pool de comparaison et de la bankroll)."""
    cote_totale = 1.0
    proba_combo = 1.0
    score_moyen_legs = 0.0
    for c in selections:
        cote_totale *= c["cote"]
        proba_combo *= (c["proba"] / 100.0)
        score_moyen_legs += c.get("score", 0)
    score_moyen_legs /= taille

    proba_implicite_pct = (100.0 / cote_totale) if cote_totale > 0 else 0.0
    edge_pct = (proba_combo * cote_totale - 1) * 100
    ev_pour_1e = proba_combo * cote_totale - 1

    if proba_combo * 100 >= FREEBET_SEUIL_RISQUE_FAIBLE:
        niveau_risque = "FAIBLE"
    elif proba_combo * 100 >= FREEBET_SEUIL_RISQUE_MOYEN:
        niveau_risque = "MOYEN"
    else:
        niveau_risque = "ÉLEVÉ"

    return {
        "taille": taille,
        "selections": list(selections),
        "cote_totale": round(cote_totale, 2),
        "probabilite_pct": round(proba_combo * 100, 2),
        "probabilite_implicite_pct": round(proba_implicite_pct, 2),
        "edge_pct": round(edge_pct, 2),
        "ev_pour_1e": round(ev_pour_1e, 4),
        "qualite_selections": round(score_moyen_legs, 1),
        "niveau_risque": niveau_risque,
        "gain_potentiel_pour_1e": round(cote_totale - 1, 2),
        "_proba_combo_fraction": proba_combo,
    }


def _calculer_kelly_combo(cote_totale, proba_combo_fraction, taille, bankroll_cash):
    """🆕 Factorisé : Kelly TRÈS RESTRICTIF — capital de référence = BANKROLL CASH
    uniquement (jamais les freebets). Ne dépend d'aucun pool de comparaison : utilisable
    à l'identique pour un combiné isolé (constructeur manuel) ou pour tout un pool
    (Freebet Optimizer automatique)."""
    b = cote_totale - 1
    p = proba_combo_fraction
    f_full = ((p * b) - (1 - p)) / b if b > 0 else 0.0
    f_full = max(0.0, f_full)
    dampening = KELLY_DAMPENING_PAR_TAILLE.get(taille, KELLY_DAMPENING_DEFAUT)
    f_restrictive = (f_full / KELLY_DIVISEUR_BASE) * dampening
    mise_kelly = round(bankroll_cash * f_restrictive, 2)

    if mise_kelly < MISE_MIN_FREEBET_COMBI:
        return {
            "mise_recommandee": None, "sous_minimum": True,
            "message": f"Kelly calculé sous le minimum de {MISE_MIN_FREEBET_COMBI:.2f} € — pas de mise recommandée.",
            "fraction_utilisee_pct": round(f_restrictive * 100, 4)
        }
    return {
        "mise_recommandee": mise_kelly, "sous_minimum": False, "message": "",
        "fraction_utilisee_pct": round(f_restrictive * 100, 4)
    }


def _freebet_calculer_combos(candidats, tailles_demandees, bankroll_cash):
    """🆕 Cœur de calcul du Freebet Optimizer, factorisé pour être partagé entre
    /freebet_combos (classement brut par combiné) et /freebet_portefeuille (proposition
    de portefeuille diversifié). Ajoute le profil (SAFE/MID/AMBITIEUX/LOTO) à chaque
    combiné en plus des indicateurs existants (rien n'est supprimé).
    Retourne (tous_combos_tries_complets, tailles_ignorees, stats_par_taille, par_taille)."""
    tous_combos = []
    tailles_ignorees = []
    stats_par_taille = {}

    for taille in tailles_demandees:
        if taille > len(candidats):
            stats_par_taille[taille] = {"nb_combinaisons_possibles": 0, "nb_retournees": 0}
            continue

        nb_possibles = math.comb(len(candidats), taille)
        if nb_possibles > FREEBET_MAX_COMBINAISONS_CALCULEES:
            tailles_ignorees.append({
                "taille": taille,
                "raison": f"{nb_possibles} combinaisons possibles — trop de matchs éligibles aujourd'hui pour cette taille."
            })
            continue

        combos_taille = [_calculer_base_combo(combo_candidats, taille)
                          for combo_candidats in itertools.combinations(candidats, taille)]

        stats_par_taille[taille] = {"nb_combinaisons_possibles": nb_possibles, "nb_retournees": len(combos_taille)}
        tous_combos.extend(combos_taille)

    if not tous_combos:
        return [], tailles_ignorees, stats_par_taille, {}

    evs = [c["ev_pour_1e"] for c in tous_combos]
    edges = [c["edge_pct"] for c in tous_combos]
    probas = [c["probabilite_pct"] for c in tous_combos]
    tailles_vals = [c["taille"] for c in tous_combos]
    cotes_log = [math.log(max(c["cote_totale"], 1.0001)) for c in tous_combos]
    mn_ev, mx_ev = min(evs), max(evs)
    mn_edge, mx_edge = min(edges), max(edges)
    mn_p, mx_p = min(probas), max(probas)
    mn_t, mx_t = min(tailles_vals), max(tailles_vals)
    mn_cl, mx_cl = min(cotes_log), max(cotes_log)

    for c in tous_combos:
        # Score synthétique — formule claire, pondérations dans PONDERATION_SCORE_FREEBET.
        # Plus petite taille = léger bonus, relatif au pool du jour (jamais une pénalité
        # absolue) : ne double-pénalise donc pas excessivement les combinés longs.
        taille_score = normaliser(-c["taille"], -mx_t, -mn_t) if mx_t != mn_t else 0.5
        cote_log_score = normaliser(math.log(max(c["cote_totale"], 1.0001)), mn_cl, mx_cl) if mx_cl != mn_cl else 0.5
        score = (
            PONDERATION_SCORE_FREEBET["proba"] * normaliser(c["probabilite_pct"], mn_p, mx_p) +
            PONDERATION_SCORE_FREEBET["ev"] * normaliser(c["ev_pour_1e"], mn_ev, mx_ev) +
            PONDERATION_SCORE_FREEBET["edge"] * normaliser(c["edge_pct"], mn_edge, mx_edge) +
            PONDERATION_SCORE_FREEBET["qualite_selections"] * (c["qualite_selections"] / 100.0) +
            PONDERATION_SCORE_FREEBET["cote"] * cote_log_score +
            PONDERATION_SCORE_FREEBET["taille"] * taille_score
        ) * 100
        c["score"] = round(score, 1)

        c["kelly"] = _calculer_kelly_combo(c["cote_totale"], c["_proba_combo_fraction"], c["taille"], bankroll_cash)
        del c["_proba_combo_fraction"]

        # 🆕 PORTEFEUILLE FREEBET : profil dynamique (SAFE/MID/AMBITIEUX/LOTO).
        profil_id, profil_label, profil_description, indice_profil = _classer_profil_combo(
            c["probabilite_pct"], c["edge_pct"], c["qualite_selections"], c["cote_totale"]
        )
        c["profil"] = profil_id
        c["profil_label"] = profil_label
        c["profil_description"] = profil_description
        c["indice_profil"] = indice_profil

    tous_combos.sort(key=lambda c: c["score"], reverse=True)

    par_taille = {}
    for taille in tailles_demandees:
        groupe = [c for c in tous_combos if c["taille"] == taille]
        stats_t = stats_par_taille.get(taille, {"nb_combinaisons_possibles": 0, "nb_retournees": 0})
        par_taille[str(taille)] = {
            **stats_t,
            "score_moyen": round(sum(c["score"] for c in groupe) / len(groupe), 1) if groupe else 0,
            "meilleur_score": groupe[0]["score"] if groupe else 0,
            "meilleurs": groupe[:FREEBET_TOP_N_PAR_TAILLE]
        }

    return tous_combos, tailles_ignorees, stats_par_taille, par_taille


@router.post("/freebet_combos", dependencies=[Depends(require_any_role)])
def freebet_combos(req: RequeteFreebetCombos):
    candidats, _ = _freebet_candidats_liste()

    tailles_demandees = sorted(set(t for t in req.tailles if t >= 2))
    if not tailles_demandees:
        raise HTTPException(status_code=400,
                             detail="Le Freebet Optimizer ne propose jamais de pari simple : choisis au moins une taille de combiné (2+).")

    bankroll_cash = _calculer_finances_dict()["total"]
    tous_combos, tailles_ignorees, stats_par_taille, par_taille = _freebet_calculer_combos(
        candidats, tailles_demandees, bankroll_cash
    )

    return {
        "nb_candidats": len(candidats),
        "tailles_calculees": tailles_demandees,
        "tailles_ignorees": tailles_ignorees,
        "classement_global": tous_combos[:FREEBET_TOP_N_PAR_TAILLE],
        "par_taille": par_taille,
        "bankroll_cash_reference": bankroll_cash
    }


def _niveau_concentration_match(exposition_pct):
    """🆕 Niveau d'alerte de concentration d'un match dans un portefeuille — informatif,
    jamais bloquant : <40% FAIBLE, 40-60% MODEREE, 60-75% FORTE, >75% TRES_FORTE."""
    if exposition_pct > FREEBET_SEUIL_CONCENTRATION_TRES_FORTE:
        return "TRES_FORTE"
    if exposition_pct >= FREEBET_SEUIL_CONCENTRATION_FORTE:
        return "FORTE"
    if exposition_pct >= FREEBET_SEUIL_CONCENTRATION_MODEREE:
        return "MODEREE"
    return "FAIBLE"


def _analyser_diversification_portefeuille(portefeuille, nb_candidats_total=0):
    """🆕 Analyse le recouvrement entre les tickets d'un portefeuille de combinés :
    - recouvrement entre 2 tickets = nb de matchs communs / nb de matchs du PLUS PETIT ticket
    - concentration de chaque match (avec niveau d'alerte FAIBLE/MODEREE/FORTE/TRES_FORTE)
    - matchs critiques = concentration FORTE ou TRES_FORTE (>= 60%)
    - score de diversification global (100 = aucun recouvrement, 0 = recouvrement total)
    - indicateur de couverture = part des matchs éligibles du jour réellement utilisés."""
    nb_tickets = len(portefeuille)
    if nb_tickets == 0:
        return {
            "nb_tickets": 0, "score_diversification": 100.0, "recouvrement_moyen_pct": 0.0,
            "exposition_max_pct": 0.0, "penalite_concentration": 0.0,
            "recouvrements_par_paire": [], "concentration_matchs": [], "matchs_critiques": [],
            "couverture_pct": 0.0, "nb_matchs_uniques": 0
        }

    match_info = {}
    for t in portefeuille:
        for s in t["selections"]:
            if s["id"] not in match_info:
                match_info[s["id"]] = {
                    "id": s["id"], "home_team": s["home_team"], "away_team": s["away_team"],
                    "div": s.get("div", "Inconnu"), "nb_tickets": 0
                }
            match_info[s["id"]]["nb_tickets"] += 1

    concentration_matchs = []
    for info in match_info.values():
        exposition_pct = round(info["nb_tickets"] / nb_tickets * 100, 1)
        niveau = _niveau_concentration_match(exposition_pct)
        concentration_matchs.append({
            **info, "exposition_pct": exposition_pct, "niveau_concentration": niveau,
            "alerte": niveau in ("FORTE", "TRES_FORTE")
        })
    concentration_matchs.sort(key=lambda m: m["exposition_pct"], reverse=True)
    matchs_critiques = [m for m in concentration_matchs if m["alerte"]]

    recouvrements_par_paire = []
    for i in range(nb_tickets):
        for j in range(i + 1, nb_tickets):
            ids_i = {s["id"] for s in portefeuille[i]["selections"]}
            ids_j = {s["id"] for s in portefeuille[j]["selections"]}
            communs = ids_i & ids_j
            plus_petit = min(len(ids_i), len(ids_j))
            pct = round((len(communs) / plus_petit) * 100, 1) if plus_petit > 0 else 0.0
            recouvrements_par_paire.append({
                "ticket_a_profil": portefeuille[i]["profil"], "ticket_b_profil": portefeuille[j]["profil"],
                "nb_matchs_communs": len(communs), "pourcentage_recouvrement": pct
            })

    recouvrement_moyen_pct = round(
        sum(r["pourcentage_recouvrement"] for r in recouvrements_par_paire) / len(recouvrements_par_paire), 1
    ) if recouvrements_par_paire else 0.0

    # 🆕 Pénalité de CONCENTRATION/DÉPENDANCE : au-delà de la moyenne des recouvrements par
    # paire, un portefeuille où plusieurs tickets dépendent TOUS du même match doit voir son
    # intérêt marginal fortement réduit — même si le recouvrement moyen par paire reste modéré
    # (ex. un match présent dans 6 tickets sur 8 concentre le risque bien plus qu'un simple
    # recouvrement moyen ne le laisserait penser). Deux x2 qui partagent un match ne sont donc
    # pas automatiquement pénalisés lourdement (exposition faible si le reste diverge), mais
    # l'exposition MAXIMALE observée sur un seul match tire le score vers le bas au-delà du
    # seuil de concentration "modérée".
    exposition_max_pct = max((m["exposition_pct"] for m in concentration_matchs), default=0.0)
    penalite_concentration = round(max(0.0, exposition_max_pct - FREEBET_SEUIL_CONCENTRATION_MODEREE) * 0.6, 1)
    score_diversification = round(max(0.0, 100.0 - recouvrement_moyen_pct - penalite_concentration), 1)

    nb_matchs_uniques = len(match_info)
    couverture_pct = round((nb_matchs_uniques / nb_candidats_total) * 100, 1) if nb_candidats_total > 0 else 0.0

    return {
        "nb_tickets": nb_tickets,
        "score_diversification": score_diversification,
        "recouvrement_moyen_pct": recouvrement_moyen_pct,
        "exposition_max_pct": exposition_max_pct,
        "penalite_concentration": penalite_concentration,
        "recouvrements_par_paire": recouvrements_par_paire,
        "concentration_matchs": concentration_matchs,
        "matchs_critiques": matchs_critiques,
        "couverture_pct": couverture_pct,
        "nb_matchs_uniques": nb_matchs_uniques
    }


def _mise_prevue_combo(combo):
    """🆕 Mise envisagée pour un ticket dans le portefeuille : la recommandation Kelly si
    elle existe, sinon le minimum de 0,10 € (jamais 0 — un ticket retenu est toujours
    doté d'une mise, conformément au minimum existant)."""
    m = combo["kelly"]["mise_recommandee"]
    return m if m is not None else MISE_MIN_FREEBET_COMBI


def _scenarios_gains_portefeuille(tickets):
    """🆕 Distribution EXACTE des gains cash d'un portefeuille de tickets FREEBET (mise non
    remboursée : un ticket perdant coûte 0 € de cash, un ticket gagnant rapporte
    mise × (cote_totale - 1)). Les tickets ne sont JAMAIS supposés indépendants lorsqu'ils
    partagent un match : chaque match distinct n'est qu'UNE SEULE variable aléatoire
    (le candidat freebet est une sélection fixe par match, jamais deux issues concurrentes
    sur le même match), et tout ticket qui la contient hérite de la MÊME réalisation.
    Implémentation : programmation dynamique par bitmask sur les TICKETS (pas les matchs) —
    le nombre d'états est donc borné par 2**len(tickets) (≤ 2**FREEBET_MAX_TICKETS_PORTEFEUILLE),
    quel que soit le nombre de matchs distincts impliqués. Retourne une liste [(gain, proba), …]."""
    n = len(tickets)
    if n == 0:
        return [(0.0, 1.0)]

    mises = [_mise_prevue_combo(t) for t in tickets]
    gains_si_victoire = [mises[i] * (tickets[i]["cote_totale"] - 1) for i in range(n)]

    matches_proba = {}
    matches_bits = {}
    for i, t in enumerate(tickets):
        for sel in t["selections"]:
            mid = sel["id"]
            matches_proba[mid] = sel["proba"] / 100.0
            matches_bits[mid] = matches_bits.get(mid, 0) | (1 << i)

    etats = {(1 << n) - 1: 1.0}
    for mid, p_win in matches_proba.items():
        bits_dependants = matches_bits[mid]
        nouveaux = {}
        for mask, prob in etats.items():
            if prob <= 0:
                continue
            nouveaux[mask] = nouveaux.get(mask, 0.0) + prob * p_win
            mask_perdu = mask & ~bits_dependants
            nouveaux[mask_perdu] = nouveaux.get(mask_perdu, 0.0) + prob * (1.0 - p_win)
        etats = nouveaux

    scenarios = []
    for mask, prob in etats.items():
        if prob <= 1e-12:
            continue
        gain = sum(gains_si_victoire[i] for i in range(n) if mask & (1 << i))
        scenarios.append((gain, prob))
    return scenarios


def _seuils_gain_adaptes(mise_totale_engagee):
    """🆕 Seuils (€) pour les probabilités P(gain >= seuil) affichées : les seuils fixes
    usuels (0,50 / 1 / 2 / 5 €) sont conservés tant qu'ils restent pertinents au regard du
    montant réellement engagé, et complétés par des fractions de la mise totale engagée pour
    rester informatifs sur un petit comme sur un gros portefeuille (jamais des seuils
    artificiellement fixes qui n'ont plus de sens une fois le montant engagé connu)."""
    if mise_totale_engagee <= 0:
        return list(FREEBET_SEUILS_GAIN_BASE[:2])
    seuils = {s for s in FREEBET_SEUILS_GAIN_BASE if s <= mise_totale_engagee * 4}
    for frac in (0.25, 0.5, 1.0, 1.5):
        seuils.add(round(mise_totale_engagee * frac, 2))
    return sorted(s for s in seuils if s > 0)[:6]


def _stats_scenarios_portefeuille(scenarios, mise_totale_engagee):
    """🆕 Statistiques de conversion dérivées de la distribution exacte des scénarios :
    EV, EV/€ engagé, P(gain>0), P(gain >= seuils adaptés), gain médian, gain maximal,
    P(perte totale des freebets engagés)."""
    if not scenarios:
        scenarios = [(0.0, 1.0)]

    ev = sum(g * p for g, p in scenarios)
    proba_gain_positif = sum(p for g, p in scenarios if g > 1e-9)
    proba_perte_totale = sum(p for g, p in scenarios if g <= 1e-9)

    seuils = _seuils_gain_adaptes(mise_totale_engagee)
    proba_par_seuil_gain = [
        {"seuil": seuil, "proba_pct": round(sum(p for g, p in scenarios if g >= seuil - 1e-9) * 100, 1)}
        for seuil in seuils
    ]

    ordonnes = sorted(scenarios, key=lambda x: x[0])
    cum = 0.0
    gain_median = ordonnes[-1][0] if ordonnes else 0.0
    for g, p in ordonnes:
        cum += p
        if cum >= 0.5 - 1e-9:
            gain_median = g
            break
    gain_maximal = max((g for g, _ in scenarios), default=0.0)

    return {
        "ev": round(ev, 3),
        "ev_par_euro_engage": round(ev / mise_totale_engagee, 3) if mise_totale_engagee > 0 else 0.0,
        "proba_gain_positif_pct": round(proba_gain_positif * 100, 1),
        "proba_perte_totale_pct": round(proba_perte_totale * 100, 1),
        "proba_par_seuil_gain": proba_par_seuil_gain,
        "gain_median": round(gain_median, 2),
        "gain_maximal": round(gain_maximal, 2),
        "mise_totale_engagee": round(mise_totale_engagee, 2),
        "nb_scenarios": len(scenarios),
    }


def _score_conversion_portefeuille(stats_distribution, mise_totale_engagee):
    """🆕 Sous-score (0-100) de qualité de CONVERSION des freebets en cash : combine la
    probabilité de récupérer quelque chose, la "profondeur" de la distribution (probabilité
    moyenne d'atteindre les différents seuils de gain) et le gain médian relatif à la mise
    engagée. Ne domine pas le score global à lui seul (35%) — voir FREEBET_POIDS_SCORE_PORTEFEUILLE."""
    if mise_totale_engagee <= 0:
        return 0.0
    p_positif = stats_distribution["proba_gain_positif_pct"]
    seuils_probas = [s["proba_pct"] for s in stats_distribution["proba_par_seuil_gain"]]
    profondeur = sum(seuils_probas) / len(seuils_probas) if seuils_probas else 0.0
    ratio_median = max(0.0, min(2.0, stats_distribution["gain_median"] / mise_totale_engagee)) / 2.0 * 100
    score = 0.5 * p_positif + 0.3 * profondeur + 0.2 * ratio_median
    return round(min(100.0, score), 1)


def _score_ev_portefeuille(stats_distribution):
    """🆕 Sous-score (0-100) d'EV/rendement : normalise ev_par_euro_engage sur une échelle
    relative (0 pour -1, càd tout perdu ; 25 pour un rendement nul ; 100 pour un rendement de
    +300% ou plus par € de freebet engagé), suffisamment ample pour ne pas saturer sur des
    rendements freebet élevés (les cotes/EV d'un freebet sont structurellement plus hauts
    qu'un pari cash puisque la mise elle-même n'est jamais récupérée)."""
    ratio = stats_distribution["ev_par_euro_engage"]
    return round(min(100.0, max(0.0, (ratio + 1.0) / 4.0 * 100)), 1)


def _score_equilibre_profils_portefeuille(tickets):
    """🆕 Sous-score (0-100) d'équilibre entre profils SAFE/MID/AMBITIEUX/LOTO : moyenne entre
    la diversité du nombre de profils réellement représentés (sur les 4) et l'équilibre de la
    répartition entre eux (pénalise un portefeuille à 100% dans un seul profil)."""
    if not tickets:
        return 0.0
    compte = {}
    for t in tickets:
        compte[t["profil"]] = compte.get(t["profil"], 0) + 1
    n = len(tickets)
    part_max = max(compte.values()) / n
    diversite = len(compte) / len(FREEBET_PROFILS_ORDRE_AFFICHAGE)
    equilibre_repartition = 1.0 - part_max
    return round(min(100.0, (0.5 * diversite + 0.5 * equilibre_repartition) * 100), 1)


def _calculer_score_portefeuille(tickets, nb_candidats_total):
    """🔧 REFONTE : le score du PORTEFEUILLE n'est plus "qualité + diversification +
    couverture" mais une évaluation de la CONVERSION des freebets en cash — le compromis
    rendement / probabilité de récupération / diversification du risque :
    - 35% conversion (distribution des gains : P(gain>0), profondeur, gain médian relatif)
    - 25% EV / rendement par € de freebet engagé
    - 20% diversification (recouvrement ET concentration/dépendance à un match, en pénalité)
    - 10% qualité moyenne des combinés retenus (score individuel — inchangé)
    - 10% équilibre des profils SAFE/MID/AMBITIEUX/LOTO
    La distribution des gains est calculée en tenant compte de la corrélation réelle entre
    tickets qui partagent un match (jamais une hypothèse d'indépendance) — voir
    _scenarios_gains_portefeuille."""
    diversification = _analyser_diversification_portefeuille(tickets, nb_candidats_total)
    nb_tickets = len(tickets)
    qualite_moyenne = round(sum(t["score"] for t in tickets) / nb_tickets, 1) if nb_tickets else 0.0

    mise_totale_engagee = sum(_mise_prevue_combo(t) for t in tickets)
    scenarios = _scenarios_gains_portefeuille(tickets)
    distribution = _stats_scenarios_portefeuille(scenarios, mise_totale_engagee)

    score_conversion = _score_conversion_portefeuille(distribution, mise_totale_engagee)
    score_ev = _score_ev_portefeuille(distribution) if nb_tickets else 0.0
    score_equilibre_profils = _score_equilibre_profils_portefeuille(tickets)

    score_global = round(
        FREEBET_POIDS_SCORE_PORTEFEUILLE["conversion"] * score_conversion +
        FREEBET_POIDS_SCORE_PORTEFEUILLE["ev"] * score_ev +
        FREEBET_POIDS_SCORE_PORTEFEUILLE["diversification"] * diversification["score_diversification"] +
        FREEBET_POIDS_SCORE_PORTEFEUILLE["qualite"] * qualite_moyenne +
        FREEBET_POIDS_SCORE_PORTEFEUILLE["equilibre_profils"] * score_equilibre_profils,
        1
    )

    return {
        "score_global": score_global,
        "qualite_moyenne": qualite_moyenne,
        "score_diversification": diversification["score_diversification"],
        "couverture_pct": diversification["couverture_pct"],
        "diversification_detail": diversification,
        "score_conversion": score_conversion,
        "score_ev": score_ev,
        "score_equilibre_profils": score_equilibre_profils,
        "mise_totale_engagee": round(mise_totale_engagee, 2),
        "distribution": distribution,
    }


# 🆕 PROGRESSION — construction du portefeuille Freebet. État partagé simple (un seul
# calcul à la fois, cohérent avec l'usage mono-utilisateur/mono-master de cette route) :
# le POST /freebet_portefeuille met à jour cet état pendant qu'il calcule, et le GET
# /freebet_portefeuille_progression permet au frontend de le lire par polling pendant
# ce temps-là (les deux routes tournent sur des threads séparés du même process).
_FREEBET_PROGRESSION_ETAT = {
    "en_cours": False,
    "termine": False,
    "etape": "",
    "candidats_evalues": 0,
    "candidats_total": 0,
    "pourcentage": 0.0,
    "temps_ecoule_sec": 0.0,
    "temps_restant_estime_sec": None,
    "nb_tickets_retenus": 0,
    "horodatage_debut": None,
}


def _freebet_progression_demarrer(candidats_total_estime):
    """🆕 (Ré)initialise l'état de progression au début de la construction du portefeuille."""
    _FREEBET_PROGRESSION_ETAT.update({
        "en_cours": True,
        "termine": False,
        "etape": "Initialisation de la construction du portefeuille…",
        "candidats_evalues": 0,
        "candidats_total": candidats_total_estime,
        "pourcentage": 0.0,
        "temps_ecoule_sec": 0.0,
        "temps_restant_estime_sec": None,
        "nb_tickets_retenus": 0,
        "horodatage_debut": time.time(),
    })


def _freebet_progression_maj(candidats_evalues=None, etape=None, nb_tickets_retenus=None):
    """🆕 Met à jour l'avancement réel (pas d'animation artificielle : ces valeurs reflètent
    l'état effectif de la boucle de construction au moment de l'appel)."""
    debut = _FREEBET_PROGRESSION_ETAT["horodatage_debut"]
    if debut is None:
        return
    if candidats_evalues is not None:
        _FREEBET_PROGRESSION_ETAT["candidats_evalues"] = candidats_evalues
    if etape is not None:
        _FREEBET_PROGRESSION_ETAT["etape"] = etape
    if nb_tickets_retenus is not None:
        _FREEBET_PROGRESSION_ETAT["nb_tickets_retenus"] = nb_tickets_retenus

    total = _FREEBET_PROGRESSION_ETAT["candidats_total"]
    fait = _FREEBET_PROGRESSION_ETAT["candidats_evalues"]
    _FREEBET_PROGRESSION_ETAT["pourcentage"] = round(min(99.0, (fait / total) * 100), 1) if total > 0 else 0.0

    ecoule = time.time() - debut
    _FREEBET_PROGRESSION_ETAT["temps_ecoule_sec"] = round(ecoule, 1)
    if fait > 0 and total > 0:
        rythme = ecoule / fait
        _FREEBET_PROGRESSION_ETAT["temps_restant_estime_sec"] = round(max(0.0, (total - fait) * rythme), 1)
    else:
        _FREEBET_PROGRESSION_ETAT["temps_restant_estime_sec"] = None


def _freebet_progression_terminer(nb_tickets_retenus):
    """🆕 Marque la recherche comme terminée (100%, message final, nombre de tickets retenus).
    candidats_evalues est aligné sur candidats_total pour garantir un état final cohérent
    (X/X) — en pratique le dernier passage sur le pool va déjà jusqu'au bout puisqu'il ne
    s'interrompt jamais en cours de route (seule la boucle EXTÉRIEURE peut s'arrêter, entre
    deux passages complets)."""
    debut = _FREEBET_PROGRESSION_ETAT["horodatage_debut"]
    ecoule = round(time.time() - debut, 1) if debut else 0.0
    _FREEBET_PROGRESSION_ETAT.update({
        "en_cours": False,
        "termine": True,
        "etape": "Recherche terminée.",
        "candidats_evalues": _FREEBET_PROGRESSION_ETAT["candidats_total"],
        "pourcentage": 100.0,
        "temps_ecoule_sec": ecoule,
        "temps_restant_estime_sec": 0.0,
        "nb_tickets_retenus": nb_tickets_retenus,
    })


def _construire_portefeuille_freebet(tous_combos, nb_candidats_total, budget_freebet_disponible):
    """🔧 REFONTE : le portefeuille n'est plus construit en ajoutant simplement les meilleurs
    scores individuels — il est optimisé pour la CONVERSION des freebets en cash (compromis
    rendement / probabilité de récupération / diversification du risque), via le nouveau
    _calculer_score_portefeuille (conversion 35% + EV 25% + diversification 20% +
    qualité 10% + équilibre des profils 10%).

    Deux phases, sur TOUS les candidats de tous_combos (aucun plafonnement de pool) :

    PHASE 1 — construction progressive (AJOUT) : à chaque tour, on évalue tous les candidats
    encore éligibles (budget respecté, signature inédite) et on retient celui qui améliore le
    score portefeuille du plus grand nombre de points. On ne s'arrête PAS simplement parce que
    le premier candidat testé déçoit : tous les candidats restants sont comparés, et l'arrêt
    n'a lieu que lorsqu'aucun n'apporte plus que FREEBET_EPSILON_AMELIORATION_PORTEFEUILLE.
    Un ticket individuellement moins bon peut être préféré s'il améliore davantage la
    distribution globale des résultats ; le premier ticket lui-même n'est plus ajouté
    automatiquement : il doit améliorer le score par rapport à un portefeuille vide, sinon le
    portefeuille reste vide (le système ne cherche jamais à engager des freebets à tout prix).

    PHASE 2 — raffinement (RETRAIT / REMPLACEMENT) : un ticket ajouté tôt peut devenir
    sous-optimal une fois le portefeuille plus fourni (redondance, concentration). À chaque
    passe, on essaie de retirer le ticket dont l'absence améliorerait le score, puis de
    remplacer un ticket par un meilleur candidat du pool ; on s'arrête dès qu'une passe
    complète n'apporte plus d'amélioration, ou après FREEBET_MAX_PASSES_RAFFINEMENT_PORTEFEUILLE
    passes. Le recouvrement entre tickets reste autorisé (jamais une raison d'arrêt
    automatique) — seule une contribution marginale insuffisante l'est.

    Aucune règle artificielle du type "X matchs = Y tickets" : la taille finale du portefeuille
    (potentiellement 0) résulte uniquement des améliorations de score trouvées."""
    pool = tous_combos
    portefeuille = []
    signatures_utilisees = set()
    mise_cumulee = 0.0
    journal_construction = []
    score_actuel = _calculer_score_portefeuille([], nb_candidats_total)["score_global"]

    candidats_total_reel = max(1, len(pool))
    _freebet_progression_demarrer(candidats_total_reel)

    def _signature(c):
        return frozenset(s["id"] for s in c["selections"])

    if FREEBET_DEBUG_PORTEFEUILLE_LOGS:
        print(
            f"[FREEBET_DEBUG] === Démarrage construction portefeuille — pool={len(pool)} candidat(s) "
            f"(sur {len(tous_combos)} au total, aucun plafonnement), "
            f"budget_freebet_disponible={round(budget_freebet_disponible, 2)} ==="
        )

    # ---------- PHASE 1 : construction progressive (AJOUT) ----------
    while len(portefeuille) < FREEBET_MAX_TICKETS_PORTEFEUILLE:
        meilleur_candidat = None
        meilleure_metrique = None
        meilleur_gain = -1e18
        diag_nb_eligibles = 0
        candidats_evalues_ce_tour = 0

        etape_label = (
            "Évaluation du 1er ticket (par rapport à un portefeuille vide)…" if not portefeuille
            else f"Recherche du ticket {len(portefeuille) + 1}/{FREEBET_MAX_TICKETS_PORTEFEUILLE} — "
                 f"évaluation de tous les candidats restants…"
        )

        for c in pool:
            candidats_evalues_ce_tour += 1
            if candidats_evalues_ce_tour == 1 or candidats_evalues_ce_tour % 10 == 0 or candidats_evalues_ce_tour == len(pool):
                _freebet_progression_maj(
                    candidats_evalues=candidats_evalues_ce_tour, etape=etape_label,
                    nb_tickets_retenus=len(portefeuille)
                )

            sig = _signature(c)
            if sig in signatures_utilisees:
                continue
            mise_c = _mise_prevue_combo(c)
            if mise_cumulee + mise_c > budget_freebet_disponible + 1e-9:
                continue

            diag_nb_eligibles += 1
            metrique = _calculer_score_portefeuille(portefeuille + [c], nb_candidats_total)
            gain = metrique["score_global"] - score_actuel
            if gain > meilleur_gain:
                meilleur_gain = gain
                meilleur_candidat = c
                meilleure_metrique = metrique

        _freebet_progression_maj(
            candidats_evalues=candidats_evalues_ce_tour, etape=etape_label, nb_tickets_retenus=len(portefeuille)
        )

        if FREEBET_DEBUG_PORTEFEUILLE_LOGS:
            if meilleur_candidat is not None:
                print(
                    f"[FREEBET_DEBUG] --- Tour {len(portefeuille) + 1} : {diag_nb_eligibles} candidat(s) éligible(s) "
                    f"— meilleur = profil={meilleur_candidat['profil']} | gain={round(meilleur_gain, 3)} pt "
                    f"(seuil={FREEBET_EPSILON_AMELIORATION_PORTEFEUILLE}) ---"
                )
            else:
                print(f"[FREEBET_DEBUG] --- Tour {len(portefeuille) + 1} : aucun candidat éligible (budget/signature) ---")

        if meilleur_candidat is None or meilleur_gain < FREEBET_EPSILON_AMELIORATION_PORTEFEUILLE:
            if not portefeuille:
                if diag_nb_eligibles == 0:
                    journal_construction.append("Aucun combiné disponible ne respecte le budget freebet disponible.")
                else:
                    journal_construction.append(
                        "Aucun combiné n'améliore suffisamment le score portefeuille par rapport à un portefeuille "
                        "vide : les freebets ne sont pas engagés pour l'instant."
                    )
            elif diag_nb_eligibles == 0:
                journal_construction.append("Arrêt : aucun candidat supplémentaire ne respecte le budget freebet disponible.")
            else:
                journal_construction.append(
                    f"Arrêt : parmi les {diag_nb_eligibles} candidat(s) restant(s) (budget respecté), aucun "
                    f"n'améliore le score portefeuille d'au moins {FREEBET_EPSILON_AMELIORATION_PORTEFEUILLE} pt."
                )
            break

        sig = _signature(meilleur_candidat)
        signatures_utilisees.add(sig)
        mise_prevue = _mise_prevue_combo(meilleur_candidat)
        mise_cumulee += mise_prevue

        ticket = dict(meilleur_candidat)
        ticket["mise_prevue_portefeuille"] = round(mise_prevue, 2)
        portefeuille.append(ticket)
        score_actuel = meilleure_metrique["score_global"]

        journal_construction.append(
            f"Ticket {len(portefeuille)} : {ticket['profil_label']} ajouté — gain de "
            f"+{round(meilleur_gain, 1)} pt au score portefeuille (désormais {round(score_actuel, 1)})."
        )
        if FREEBET_DEBUG_PORTEFEUILLE_LOGS:
            print(f"[FREEBET_DEBUG] Ticket {len(portefeuille)} sélectionné : profil={ticket['profil']} | gain={round(meilleur_gain, 3)} | score_portefeuille_actuel={round(score_actuel, 2)}")

    # ---------- PHASE 2 : raffinement (RETRAIT / REMPLACEMENT) ----------
    # Permet de revenir sur un choix devenu sous-optimal, sans recherche combinatoire complète :
    # à chaque passe, on cherche d'abord un retrait qui améliore le score (redondance/
    # concentration devenues trop coûteuses), puis à défaut un remplacement. On s'arrête dès
    # qu'une passe complète ne trouve plus rien à améliorer.
    for num_passe in range(FREEBET_MAX_PASSES_RAFFINEMENT_PORTEFEUILLE):
        if not portefeuille:
            break

        etape_label = f"Raffinement du portefeuille (passe {num_passe + 1}/{FREEBET_MAX_PASSES_RAFFINEMENT_PORTEFEUILLE}) — retraits possibles…"
        _freebet_progression_maj(candidats_evalues=0, etape=etape_label, nb_tickets_retenus=len(portefeuille))

        # --- Essai de RETRAIT ---
        meilleur_retrait = None
        for i in range(len(portefeuille)):
            sans_ticket = portefeuille[:i] + portefeuille[i + 1:]
            metrique_sans = _calculer_score_portefeuille(sans_ticket, nb_candidats_total)
            gain_retrait = metrique_sans["score_global"] - score_actuel
            if gain_retrait > FREEBET_EPSILON_AMELIORATION_PORTEFEUILLE and (
                meilleur_retrait is None or gain_retrait > meilleur_retrait["gain"]
            ):
                meilleur_retrait = {"i": i, "metrique": metrique_sans, "gain": gain_retrait}

        if meilleur_retrait is not None:
            retire = portefeuille.pop(meilleur_retrait["i"])
            signatures_utilisees.discard(_signature(retire))
            mise_cumulee -= _mise_prevue_combo(retire)
            score_actuel = meilleur_retrait["metrique"]["score_global"]
            journal_construction.append(
                f"Retrait : {retire['profil_label']} retiré du portefeuille — améliore le score à "
                f"{round(score_actuel, 1)} (trop redondant/concentré au regard de sa contribution)."
            )
            if FREEBET_DEBUG_PORTEFEUILLE_LOGS:
                print(f"[FREEBET_DEBUG] Passe {num_passe + 1} : RETRAIT de profil={retire['profil']} | gain={round(meilleur_retrait['gain'], 3)}")
            continue  # on relance une passe complète avec le portefeuille modifié

        # --- Essai de REMPLACEMENT (seulement si aucun retrait n'a amélioré) ---
        etape_label = f"Raffinement du portefeuille (passe {num_passe + 1}/{FREEBET_MAX_PASSES_RAFFINEMENT_PORTEFEUILLE}) — remplacements possibles…"
        meilleur_remplacement = None
        candidats_evalues_ce_tour = 0
        for i in range(len(portefeuille)):
            ticket_actuel = portefeuille[i]
            sig_actuel = _signature(ticket_actuel)
            mise_actuelle = _mise_prevue_combo(ticket_actuel)
            reste = portefeuille[:i] + portefeuille[i + 1:]

            for c in pool:
                candidats_evalues_ce_tour += 1
                if candidats_evalues_ce_tour % 25 == 0:
                    _freebet_progression_maj(
                        candidats_evalues=min(candidats_evalues_ce_tour, candidats_total_reel),
                        etape=etape_label, nb_tickets_retenus=len(portefeuille)
                    )

                sig_c = _signature(c)
                if sig_c == sig_actuel or sig_c in signatures_utilisees:
                    continue
                mise_c = _mise_prevue_combo(c)
                if mise_cumulee - mise_actuelle + mise_c > budget_freebet_disponible + 1e-9:
                    continue

                metrique_swap = _calculer_score_portefeuille(reste + [c], nb_candidats_total)
                gain_swap = metrique_swap["score_global"] - score_actuel
                if gain_swap > FREEBET_EPSILON_AMELIORATION_PORTEFEUILLE and (
                    meilleur_remplacement is None or gain_swap > meilleur_remplacement["gain"]
                ):
                    meilleur_remplacement = {"i": i, "candidat": c, "metrique": metrique_swap, "gain": gain_swap}

        _freebet_progression_maj(
            candidats_evalues=candidats_total_reel, etape=etape_label, nb_tickets_retenus=len(portefeuille)
        )

        if meilleur_remplacement is None:
            if FREEBET_DEBUG_PORTEFEUILLE_LOGS:
                print(f"[FREEBET_DEBUG] Passe {num_passe + 1} : aucune amélioration (ni retrait, ni remplacement) -> fin du raffinement.")
            break

        i = meilleur_remplacement["i"]
        ancien = portefeuille[i]
        nouveau_combo = meilleur_remplacement["candidat"]
        signatures_utilisees.discard(_signature(ancien))
        mise_cumulee -= _mise_prevue_combo(ancien)
        mise_prevue = _mise_prevue_combo(nouveau_combo)
        mise_cumulee += mise_prevue

        ticket = dict(nouveau_combo)
        ticket["mise_prevue_portefeuille"] = round(mise_prevue, 2)
        portefeuille[i] = ticket
        signatures_utilisees.add(_signature(ticket))
        score_actuel = meilleur_remplacement["metrique"]["score_global"]

        journal_construction.append(
            f"Remplacement : {ancien['profil_label']} remplacé par {ticket['profil_label']} — améliore le "
            f"score à {round(score_actuel, 1)}."
        )
        if FREEBET_DEBUG_PORTEFEUILLE_LOGS:
            print(f"[FREEBET_DEBUG] Passe {num_passe + 1} : REMPLACEMENT {ancien['profil']} -> {ticket['profil']} | gain={round(meilleur_remplacement['gain'], 3)}")

    _freebet_progression_terminer(len(portefeuille))
    return portefeuille, journal_construction


@router.post("/freebet_portefeuille", dependencies=[Depends(require_any_role)])
def freebet_portefeuille(req: RequeteFreebetCombos):
    """🔧 Construit une proposition de PORTEFEUILLE de combinés Freebet optimisée pour la
    conversion en cash (rendement, probabilité de récupération, diversification du risque —
    voir _calculer_score_portefeuille), en plus du classement brut déjà fourni par
    /freebet_combos. N'affecte ni ne remplace cet endpoint."""
    # 🔧 FIX : on initialise un état de progression valide dès le tout début de la requête
    # (avant même le calcul des combinés candidats, potentiellement long) pour qu'un frontend
    # qui démarre son polling immédiatement après avoir lancé la recherche ne tombe jamais sur
    # l'état par défaut à zéro (candidats_total=0 / en_cours=False laissé par un appel
    # précédent, ou jamais initialisé). _construire_portefeuille_freebet réinitialisera cet
    # état avec le total RÉEL de candidats dès qu'il sera connu.
    _freebet_progression_demarrer(1)
    _freebet_progression_maj(etape="Calcul des combinés candidats…")

    candidats, _ = _freebet_candidats_liste()

    tailles_demandees = sorted(set(t for t in req.tailles if t >= 2))
    if not tailles_demandees:
        raise HTTPException(status_code=400,
                             detail="Le Freebet Optimizer ne propose jamais de pari simple : choisis au moins une taille de combiné (2+).")

    finances = _calculer_finances_dict()
    bankroll_cash = finances["total"]
    budget_freebet_disponible = finances["freebets"]["disponible"]

    tous_combos, tailles_ignorees, stats_par_taille, _ = _freebet_calculer_combos(
        candidats, tailles_demandees, bankroll_cash
    )

    if not tous_combos:
        # 🆕 Même sans candidat, on boucle l'état de progression (démarré puis aussitôt terminé)
        # pour qu'un frontend en train de faire du polling s'arrête proprement.
        _freebet_progression_demarrer(1)
        _freebet_progression_terminer(0)
        return {
            "nb_candidats": len(candidats), "tailles_calculees": tailles_demandees,
            "tailles_ignorees": tailles_ignorees, "bankroll_cash_reference": bankroll_cash,
            "budget_freebet_disponible": round(budget_freebet_disponible, 2),
            "top_par_profil": {}, "portefeuille_recommande": [], "journal_construction": [],
            "score_portefeuille": _calculer_score_portefeuille([], len(candidats)),
            "mise_totale_recommandee_portefeuille": 0.0
        }

    top_par_profil = {}
    for profil_id in FREEBET_PROFILS_ORDRE_AFFICHAGE:
        label, description = FREEBET_PROFILS_INFO[profil_id]
        groupe = [c for c in tous_combos if c["profil"] == profil_id]
        top_par_profil[profil_id] = {
            "profil_label": label, "profil_description": description,
            "nb_disponibles": len(groupe), "meilleurs": groupe[:FREEBET_TOP_N_PAR_TAILLE]
        }

    portefeuille, journal_construction = _construire_portefeuille_freebet(
        tous_combos, len(candidats), budget_freebet_disponible
    )
    score_portefeuille = _calculer_score_portefeuille(portefeuille, len(candidats))
    mise_totale = sum(t["mise_prevue_portefeuille"] for t in portefeuille)

    return {
        "nb_candidats": len(candidats),
        "tailles_calculees": tailles_demandees,
        "tailles_ignorees": tailles_ignorees,
        "bankroll_cash_reference": bankroll_cash,
        "budget_freebet_disponible": round(budget_freebet_disponible, 2),
        "top_par_profil": top_par_profil,
        "portefeuille_recommande": portefeuille,
        "journal_construction": journal_construction,
        "score_portefeuille": score_portefeuille,
        "mise_totale_recommandee_portefeuille": round(mise_totale, 2)
    }


@router.get("/freebet_portefeuille_progression", dependencies=[Depends(require_any_role)])
def freebet_portefeuille_progression():
    """🆕 Avancement en temps réel de la construction du portefeuille Freebet en cours (à
    interroger par polling pendant l'appel à POST /freebet_portefeuille — reflète l'état
    réel de la boucle de calcul, pas une animation artificielle)."""
    return dict(_FREEBET_PROGRESSION_ETAT)


class RequeteFreebetComboManuel(BaseModel):
    ids: List[str]


@router.post("/freebet_combo_manuel", dependencies=[Depends(require_any_role)])
def freebet_combo_manuel(req: RequeteFreebetComboManuel):
    """🆕 CONSTRUCTEUR DE COMBINÉ MANUEL — l'utilisateur choisit lui-même les matchs et
    issues (parmi les candidats éligibles du jour, exactement la même pool que le Freebet
    Optimizer). Recalcule tous les indicateurs avec EXACTEMENT les mêmes fonctions de
    calcul que l'Optimizer (_calculer_base_combo, _calculer_kelly_combo,
    _classer_profil_combo). Indépendant de la sélection automatique du portefeuille :
    n'affecte aucune autre fonctionnalité. Aucune limite artificielle sur le nombre de
    matchs (hormis un minimum de 2, un combiné n'existant pas à 1 seule jambe)."""
    ids_demandes = req.ids
    if len(ids_demandes) < 2:
        raise HTTPException(status_code=400, detail="Un combiné doit contenir au moins 2 matchs.")
    if len(set(ids_demandes)) != len(ids_demandes):
        raise HTTPException(status_code=400, detail="Un même match ne peut pas apparaître deux fois dans un combiné.")

    candidats, _ = _freebet_candidats_liste()
    par_id = {c["id"]: c for c in candidats}
    manquants = [i for i in ids_demandes if i not in par_id]
    if manquants:
        raise HTTPException(status_code=400,
                             detail=f"Match(s) non éligible(s) ou plus disponible(s) : {', '.join(manquants)}")

    selections = [par_id[i] for i in ids_demandes]
    taille = len(selections)
    bankroll_cash = _calculer_finances_dict()["total"]

    combo = _calculer_base_combo(selections, taille)
    combo["kelly"] = _calculer_kelly_combo(combo["cote_totale"], combo["_proba_combo_fraction"], taille, bankroll_cash)
    del combo["_proba_combo_fraction"]

    profil_id, profil_label, profil_description, indice_profil = _classer_profil_combo(
        combo["probabilite_pct"], combo["edge_pct"], combo["qualite_selections"], combo["cote_totale"]
    )
    combo["profil"] = profil_id
    combo["profil_label"] = profil_label
    combo["profil_description"] = profil_description
    combo["indice_profil"] = indice_profil

    # 🆕 Score sur échelle ABSOLUE (bornes fixes, mêmes pondérations que PONDERATION_SCORE_FREEBET) :
    # un combiné manuel isolé n'a pas de pool du jour contre lequel se normaliser relativement,
    # contrairement au classement automatique (voir _freebet_calculer_combos).
    proba_norm = combo["probabilite_pct"] / 100.0
    edge_norm = max(0.0, min((combo["edge_pct"] + 50.0) / 200.0, 1.0))
    ev_norm = max(0.0, min((combo["ev_pour_1e"] + 1.0) / 6.0, 1.0))
    qualite_norm = combo["qualite_selections"] / 100.0
    cote_norm = max(0.0, min(math.log(max(combo["cote_totale"], 1.0001)) / math.log(500.0), 1.0))
    taille_norm = max(0.0, 1.0 - (taille - 2) / 10.0)

    score_absolu = (
        PONDERATION_SCORE_FREEBET["proba"] * proba_norm +
        PONDERATION_SCORE_FREEBET["ev"] * ev_norm +
        PONDERATION_SCORE_FREEBET["edge"] * edge_norm +
        PONDERATION_SCORE_FREEBET["qualite_selections"] * qualite_norm +
        PONDERATION_SCORE_FREEBET["cote"] * cote_norm +
        PONDERATION_SCORE_FREEBET["taille"] * taille_norm
    ) * 100
    combo["score"] = round(score_absolu, 1)
    combo["score_est_absolu"] = True  # 🆕 signale au front que ce score n'est pas comparable
                                        # au score relatif (pool du jour) de l'Optimizer automatique

    return {"combo": combo, "bankroll_cash_reference": bankroll_cash}


class SelectionCombo(BaseModel):
    id_match: str
    home_team: str
    away_team: str
    div: str = "Inconnu"
    date: str
    issue: str
    issue_label: str = ""
    cote_calculee: float
    proba: float = 0.0
    edge: float = 0.0
    score: float = 0.0


class RequeteValidationCombo(BaseModel):
    taille: int
    selections: List[SelectionCombo]
    cote_totale_calculee: float
    cote_totale_reelle: float
    mise_freebet: float
    score: float = 0.0
    niveau_risque: str = ""
    probabilite_pct: float = 0.0
    edge_pct: float = 0.0
    bookmaker: str = "WINAMAX"


@router.post("/valider_combo_freebet", dependencies=[Depends(require_master)])
def valider_combo_freebet(req: RequeteValidationCombo):
    if req.taille < 2 or len(req.selections) != req.taille:
        raise HTTPException(status_code=400,
                             detail="Un combiné Freebet doit contenir au moins 2 sélections, cohérent avec la taille annoncée.")

    ids = [s.id_match for s in req.selections]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=400, detail="Un même match ne peut pas apparaître deux fois dans un combiné.")

    if req.mise_freebet <= 0:
        raise HTTPException(status_code=400, detail="Mise Freebet invalide.")

    # 🆕 §8 : si UNE des sélections est à moins de 2h de son coup d'envoi, la cote totale
    # calculée fait foi pour l'ensemble du combiné — plus de correction manuelle possible.
    if req.cote_totale_reelle != req.cote_totale_calculee and any(_cote_est_verrouillee(s.date) for s in req.selections):
        raise HTTPException(status_code=400, detail="🔒 Cote verrouillée : au moins une sélection est à moins de 2h de son coup d'envoi.")

    finances_actuelles = _calculer_finances_dict()
    if req.mise_freebet > finances_actuelles["freebets"]["disponible"]:
        raise HTTPException(status_code=400, detail="Solde Freebet insuffisant pour ce combiné.")

    combo_id = f"COMBO_{uuid.uuid4().hex[:10]}"
    resume_matchs = " | ".join(f"{s.home_team}-{s.away_team} ({s.issue})" for s in req.selections)

    doc_paris = {
        "id_match": combo_id,
        "home_team": f"🎫 Combiné Freebet x{req.taille}",
        "away_team": resume_matchs,
        "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "div": "FREEBET-COMBI",
        "choix_pari": f"COMBI-{req.taille}",
        "cote_choisie": req.cote_totale_reelle,
        "mise": req.mise_freebet,
        "type_fond": "FREEBET",
        "bookmaker": req.bookmaker,
        "Date_Engagement": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        # Champs propres au combiné, ignorés sans risque par le dashboard existant :
        "est_combine_freebet": True,
        "taille_combine": req.taille,
        "cote_totale_calculee": req.cote_totale_calculee,
        "score_combine": req.score,
        "niveau_risque_combine": req.niveau_risque,
        "probabilite_pct_combine": req.probabilite_pct,
        "edge_pct_combine": req.edge_pct,
        "selections_combine": [s.dict() for s in req.selections],
    }
    col_paris.insert_one(doc_paris)
    return {"message": "✅ Combiné Freebet verrouillé — direction PARIS JOUÉS.", "combo_id": combo_id}


@router.get("/combos_freebet_en_cours", dependencies=[Depends(require_any_role)])
def combos_freebet_en_cours():
    cursor = col_paris.find({"est_combine_freebet": True, "Resultat_Final": {"$exists": False}}).sort("Date_Engagement", -1)
    combos = []
    for doc in cursor:
        combos.append({
            "id_match": doc["id_match"], "home_team": doc.get("home_team"), "away_team": doc.get("away_team"),
            "date": doc.get("date"), "taille": doc.get("taille_combine"), "cote_choisie": doc.get("cote_choisie"),
            "mise": doc.get("mise"), "score": doc.get("score_combine"), "niveau_risque": doc.get("niveau_risque_combine"),
            "probabilite_pct": doc.get("probabilite_pct_combine"), "edge_pct": doc.get("edge_pct_combine"),
            "selections": doc.get("selections_combine", []),
            # 🆕 §5 : bookmaker réellement sélectionné lors de la validation du combiné.
            "bookmaker": doc.get("bookmaker", "WINAMAX")
        })
    return {"combos": combos}


class RequeteClotureCombo(BaseModel):
    id_match: str
    resultat: str
    montant_retour: float
    cote_cloture: float = 0.0


@router.post("/cloturer_combo_freebet", dependencies=[Depends(require_master)])
def cloturer_combo_freebet(req: RequeteClotureCombo):
    doc = col_paris.find_one({"id_match": req.id_match, "est_combine_freebet": True})
    if not doc:
        raise HTTPException(status_code=404, detail="Combiné Freebet introuvable.")
    col_paris.update_one({"id_match": req.id_match}, {
        "$set": {"Resultat_Final": req.resultat, "Montant_Retour": req.montant_retour, "Cote_Cloture": req.cote_cloture,
                 "Date_Cloture": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}})
    return {"message": "Combiné Freebet clôturé et archivé."}


