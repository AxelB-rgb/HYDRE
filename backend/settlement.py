"""Comptabilité commune aux simples et combinés, avec compatibilité des tickets anciens."""

def type_fond_effectif(p):
    if p.get("est_combine_freebet") or p.get("est_combine"):
        return p.get("type_ticket") or "FREEBET"
    return p.get("type_fond", "CASH")


def dates_exposition_cash(p):
    if p.get("est_combine_freebet") or p.get("est_combine"):
        return {str(s.get("date", ""))[:10] for s in p.get("selections_combine", []) if s.get("date")}
    return {str(p.get("date", ""))[:10]} if p.get("date") else set()


def retour_net(p):
    retour = float(p.get("Montant_Retour", 0) or 0)
    if type_fond_effectif(p) == "FREEBET" and p.get("Resultat_Final") == "GAGNE":
        # La cote et la mise du ticket constituent la source de vérité, aussi pour
        # les anciens combinés enregistrés avec un retour brut.
        return round(float(p.get("mise", 0) or 0) * (float(p.get("cote_choisie", 1) or 1) - 1), 2)
    return retour


def montant_reglement(p, resultat, montant_saisi):
    if type_fond_effectif(p) != "FREEBET" and not (p.get("est_combine_freebet") or p.get("est_combine")):
        return montant_saisi
    if resultat == "GAGNE":
        mise = float(p.get("mise", 0) or 0)
        cote = float(p.get("cote_choisie", 1) or 1)
        return round(mise * (cote - (1 if type_fond_effectif(p) == "FREEBET" else 0)), 2)
    if resultat == "PERDU":
        return 0.0
    if resultat == "ANNULE":
        return float(p.get("mise", 0) or 0)
    return montant_saisi
