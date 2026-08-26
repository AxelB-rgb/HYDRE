"""
Route "statistiques" : agrégation complète du dashboard (bankroll, PnL, registre des
transactions/historique, ventilations par ligue/edge/score/bookmaker...).

⚠️ Logique et calculs INCHANGÉS — déplacés depuis Serveur_Hydre.py. Route de LECTURE
SEULE (aucune écriture) : accessible à MASTER et VIEWER.
"""
from fastapi import APIRouter, Depends

from backend.auth import require_any_role
from backend.config import col_fixtures, col_historique, col_paris, col_parametres
from backend.bankroll import _pnl_cash_pari

router = APIRouter()


@router.get("/statistiques_dashboard", dependencies=[Depends(require_any_role)])
def statistiques_dashboard():
    config = col_parametres.find_one({"type": "bankroll"})
    capital_depart = float(config.get("capital", 1000.0)) if config else 1000.0
    # 🆕 §6 : on récupère TOUS les tickets réglés (y compris ANNULÉ, pour l'historique/visibilité),
    # mais les KPI/statistiques de performance ne portent que sur les tickets réellement joués.
    paris_tous = list(col_paris.find({"Resultat_Final": {"$exists": True}}).sort("Date_Cloture", 1))
    paris = [p for p in paris_tous if p.get("Resultat_Final") != "ANNULE"]

    # 🆕 CORRECTIF STOCKAGE (§3) : "matchs analysés" recalculé à la volée depuis Fixtures_A_Venir —
    # PAS un journal d'analyses. Un match "traité" = Statut différent de A_REMPLIR (donc déjà passé par
    # /analyser au moins une fois), dédupliqué par identifiant unique, depuis le début de la saison
    # actuelle. Aucune configuration de "ligues suivies" n'existe dans ce fichier : Fixtures_A_Venir ne
    # contient par construction que les ligues déjà suivies par l'injecteur de données, donc aucun filtre
    # de ligue supplémentaire n'est appliqué ici (cf. limitations).
    # 🆕 CORRECTIF STOCKAGE (§3) : comptage via Matchs_Historique
    debut_saison = _debut_saison_actuelle()
    matchs_analyses_vus = set()
    matchs_analyses = []

    # On tape dans col_historique au lieu de col_fixtures et on retire le filtre Statut
    for d in col_historique.find(
            {"Date": {"$gte": debut_saison}},
            {"HomeTeam": 1, "AwayTeam": 1, "Date": 1, "Div": 1}
    ):
        mid = f"{d.get('HomeTeam')}_{d.get('AwayTeam')}_{d.get('Date')}"
        if mid in matchs_analyses_vus:
            continue
        matchs_analyses_vus.add(mid)
        matchs_analyses.append({"date": d.get("Date"), "div": d.get("Div", "Inconnu")})

    if not paris_tous:
        return {
            "kpis": {"profit_net": 0, "roi": 0, "winrate": 0, "cote_moyenne": 0, "total_paris": 0, "roc": 0, "clv": 0,
                     "count": 0},
            "chartData": [], "statsIssue": {}, "statsCotes": {}, "statsLigue": {},
            "evolution": [], "historique": [], "tableData": [], "stats_bookmakers": {},
            "statsTailleCombine": {}, "statsTypePari": {}, "matchs_analyses": matchs_analyses
        }


    total_paris = len(paris)
    paris_gagnes = sum(1 for p in paris if p.get("Resultat_Final") == "GAGNE")
    winrate = (paris_gagnes / total_paris) * 100 if total_paris > 0 else 0

    total_mise = sum(float(p.get("mise", 0) or 0) for p in paris)
    total_retour = sum(float(p.get("Montant_Retour", 0) or 0) for p in paris)
    # 🆕 P&L CASH réel (voir _pnl_cash_pari) : une mise FREEBET n'est jamais un investissement
    # cash, donc sa perte ne doit jamais réduire ce profit_net, ni son gain être amputé de la
    # mise "virtuelle". total_mise/total_retour restent des totaux bruts (cote moyenne, etc.).
    profit_net = sum(_pnl_cash_pari(p) for p in paris)
    roi = (profit_net / total_mise) * 100 if total_mise > 0 else 0
    roc = (profit_net / capital_depart) * 100 if capital_depart > 0 else 0

    cotes = [float(p.get("cote_choisie", 0) or 0) for p in paris if float(p.get("cote_choisie", 0) or 0) > 0]
    cote_moyenne = sum(cotes) / len(cotes) if cotes else 0

    clvs = []
    for p in paris:
        c_ouv = float(p.get("cote_choisie", 0) or 0)
        c_clo = float(p.get("Cote_Cloture", 0) or 0)
        if c_ouv > 0 and c_clo > 0:
            clvs.append(((c_ouv / c_clo) - 1) * 100)
    clv_moyenne = sum(clvs) / len(clvs) if clvs else 0

    evolution = [{"date": "Départ", "bankroll": round(capital_depart, 2), "pnl": 0}]
    current_bk = capital_depart
    historique = []

    stats_books, stats_issue, stats_cotes, stats_ligue, chart_data_dict = {}, {}, {}, {}, {}
    stats_taille_combine = {}
    stats_type_pari = {
        "SIMPLE": {"count": 0, "wins": 0, "mise": 0, "pnl": 0},
        "COMBINE": {"count": 0, "wins": 0, "mise": 0, "pnl": 0},
    }

    def init_stat(d, k):
        if k not in d: d[k] = {"count": 0, "wins": 0, "mise": 0, "pnl": 0}

    # --- Boucle KPI / stats de performance : UNIQUEMENT les tickets non-annulés ---
    for p in paris:
        mise = float(p.get("mise", 0) or 0)
        retour = float(p.get("Montant_Retour", 0) or 0)
        pnl_pari = _pnl_cash_pari(p)  # 🆕 P&L cash réel — jamais de perte cash sur une mise FREEBET
        current_bk += pnl_pari
        is_win = 1 if p.get("Resultat_Final") == "GAGNE" else 0
        est_combine = bool(p.get("est_combine_freebet"))
        taille_combine = p.get("taille_combine")

        book = p.get("Bookmaker", p.get("bookmaker", "WINAMAX")).upper()
        if book not in stats_books: stats_books[book] = {"Count": 0, "Wins": 0, "Mise": 0, "PnL": 0}
        stats_books[book]["Count"] += 1
        stats_books[book]["Mise"] += mise
        stats_books[book]["PnL"] += pnl_pari
        stats_books[book]["Wins"] += is_win

        issue = p.get("choix_pari", "UNK")
        init_stat(stats_issue, issue)
        stats_issue[issue]["count"] += 1
        stats_issue[issue]["mise"] += mise
        stats_issue[issue]["pnl"] += pnl_pari
        stats_issue[issue]["wins"] += is_win

        ligue = p.get("div", "UNK")
        init_stat(stats_ligue, ligue)
        stats_ligue[ligue]["count"] += 1
        stats_ligue[ligue]["mise"] += mise
        stats_ligue[ligue]["pnl"] += pnl_pari
        stats_ligue[ligue]["wins"] += is_win

        cote = float(p.get("cote_choisie", 0) or 0)
        if cote < 1.5:
            tranche = "[1.0 - 1.5]"
        elif cote < 2.0:
            tranche = "[1.5 - 2.0]"
        elif cote < 2.5:
            tranche = "[2.0 - 2.5]"
        elif cote < 3.0:
            tranche = "[2.5 - 3.0]"
        elif cote < 4.0:
            tranche = "[3.0 - 4.0]"
        else:
            tranche = "[> 4.0]"
        init_stat(stats_cotes, tranche)
        stats_cotes[tranche]["count"] += 1
        stats_cotes[tranche]["mise"] += mise
        stats_cotes[tranche]["pnl"] += pnl_pari
        stats_cotes[tranche]["wins"] += is_win

        # 🆕 §16/§17 : distinction compacte simples/combinés + performance par taille de combiné.
        # Le ticket combiné est TOUJOURS compté UNE SEULE FOIS (§14) — jamais par sélection.
        type_key = "COMBINE" if est_combine else "SIMPLE"
        stats_type_pari[type_key]["count"] += 1
        stats_type_pari[type_key]["mise"] += mise
        stats_type_pari[type_key]["pnl"] += pnl_pari
        stats_type_pari[type_key]["wins"] += is_win

        if est_combine and taille_combine:
            init_stat(stats_taille_combine, str(taille_combine))
            stats_taille_combine[str(taille_combine)]["count"] += 1
            stats_taille_combine[str(taille_combine)]["mise"] += mise
            stats_taille_combine[str(taille_combine)]["pnl"] += pnl_pari
            stats_taille_combine[str(taille_combine)]["wins"] += is_win

        date_str = p.get("Date_Cloture", p.get("date", ""))
        period = date_str[:7] if len(date_str) >= 7 else "UNK"
        if period not in chart_data_dict: chart_data_dict[period] = 0
        chart_data_dict[period] += pnl_pari

        evolution.append({"date": date_str.split(" ")[0][5:], "match": f"{p.get('home_team')} - {p.get('away_team')}",
                          "bankroll": round(current_bk, 2), "pnl": round(pnl_pari, 2)})

    # --- Historique affiché : TOUS les tickets réglés, y compris ANNULÉ (visible, non comptabilisé) ---
    for p in paris_tous:
        mise = float(p.get("mise", 0) or 0)
        retour = float(p.get("Montant_Retour", 0) or 0)
        resultat_final = p.get("Resultat_Final")
        pnl_pari = round(_pnl_cash_pari(p), 2)  # 🆕 P&L cash réel — jamais de perte cash sur une mise FREEBET
        date_str = p.get("Date_Cloture", p.get("date", ""))
        ligue = p.get("div", "UNK")
        issue = p.get("choix_pari", "UNK")
        cote = float(p.get("cote_choisie", 0) or 0)
        book = p.get("Bookmaker", p.get("bookmaker", "WINAMAX")).upper()

        historique.append({
            "id": str(p["_id"]), "div": ligue, "date": date_str.split(" ")[0],
            # 🆕 §1 SÉRIES : date de règlement à PLEINE PRÉCISION (jour + heure), pour trier les
            # tickets réellement dans leur ordre chronologique réel (le champ "date" ci-dessus,
            # tronqué au jour, ne suffit pas dès que plusieurs paris sont réglés le même jour).
            "date_reglement": date_str,
            "match": f"{p.get('home_team')} vs {p.get('away_team')}", "choix": issue,
            "cote": cote, "cote_cloture": float(p.get("Cote_Cloture", 0.0) or 0.0), "mise": mise,
            "resultat": resultat_final, "retour": retour, "pnl": pnl_pari,
            "bookmaker": book,
            # 🆕 §3 : CASH ou FREEBET, sans ambiguïté (défaut CASH pour les anciens paris, comme
            # partout ailleurs dans le calcul financier — voir _pnl_cash_pari).
            "type_fond": p.get("type_fond", "CASH"),
            "est_combine": bool(p.get("est_combine_freebet")), "taille_combine": p.get("taille_combine"),
            # 🆕 DASHBOARD V2 (§6) : null pour les anciens paris / combinés — jamais inventé.
            "edge": p.get("edge"),
            # 🆕 DASHBOARD V2.1 (§4) : score Hydre du Scanner de Marché au moment du pari (simples uniquement).
            "score": p.get("score"),
            # 🆕 DASHBOARD V2.1 (§8) : indicateurs déjà stockés pour les combinés Freebet (Freebet Optimizer),
            # simplement exposés ici — jamais recalculés.
            "score_combine": p.get("score_combine"),
            "risque_combine": p.get("niveau_risque_combine"),
            "proba_combine": p.get("probabilite_pct_combine"),
            "edge_combine": p.get("edge_pct_combine"),
            "cote_totale_calculee_combine": p.get("cote_totale_calculee")
        })

    historique.reverse()

    for b in stats_books:
        stats_books[b]["WinRate"] = round((stats_books[b]["Wins"] / stats_books[b]["Count"]) * 100, 1) if \
        stats_books[b]["Count"] > 0 else 0
        stats_books[b]["ROI"] = round((stats_books[b]["PnL"] / stats_books[b]["Mise"]) * 100, 2) if stats_books[b][
                                                                                                        "Mise"] > 0 else 0
        stats_books[b]["PnL"] = round(stats_books[b]["PnL"], 2)

    for t in stats_taille_combine:
        d = stats_taille_combine[t]
        d["winrate"] = round((d["wins"] / d["count"]) * 100, 1) if d["count"] > 0 else 0
        d["roi"] = round((d["pnl"] / d["mise"]) * 100, 2) if d["mise"] > 0 else 0
        d["pnl"] = round(d["pnl"], 2)

    for t in stats_type_pari:
        d = stats_type_pari[t]
        d["winrate"] = round((d["wins"] / d["count"]) * 100, 1) if d["count"] > 0 else 0
        d["roi"] = round((d["pnl"] / d["mise"]) * 100, 2) if d["mise"] > 0 else 0
        d["pnl"] = round(d["pnl"], 2)

    chart_data = []
    cumul = 0
    for k in sorted(chart_data_dict.keys()):
        cumul += chart_data_dict[k]
        chart_data.append({"period": k, "pnlPeriod": round(chart_data_dict[k], 2), "pnlCumul": round(cumul, 2)})

    return {
        "kpis": {"profit_net": round(profit_net, 2), "roi": round(roi, 2), "winrate": round(winrate, 1),
                 "cote_moyenne": round(cote_moyenne, 2), "total_paris": total_paris, "roc": round(roc, 2),
                 "clv": round(clv_moyenne, 2), "count": total_paris},
        "chartData": chart_data,
        "statsIssue": stats_issue,
        "statsCotes": stats_cotes,
        "statsLigue": stats_ligue,
        "statsTailleCombine": stats_taille_combine,
        "statsTypePari": stats_type_pari,
        "evolution": evolution,
        "historique": historique,
        "tableData": historique,
        "stats_bookmakers": stats_books,
        "matchs_analyses": matchs_analyses
    }