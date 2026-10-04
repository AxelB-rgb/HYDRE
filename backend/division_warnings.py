"""Détection informative par saison (juillet–juin), sans ajustement des features."""
from backend.config import col_historique

DIVISIONS = {
    "E0": ("Angleterre", 1, "Premier League"), "E1": ("Angleterre", 2, "Championship"),
    "F1": ("France", 1, "Ligue 1"), "F2": ("France", 2, "Ligue 2"),
    "D1": ("Allemagne", 1, "Bundesliga"), "D2": ("Allemagne", 2, "2. Bundesliga"),
    "I1": ("Italie", 1, "Serie A"), "I2": ("Italie", 2, "Serie B"),
    "SP1": ("Espagne", 1, "La Liga"), "SP2": ("Espagne", 2, "Segunda División"),
}


def warnings_division(doc, cache=None):
    cache = cache if cache is not None else {}
    date = str(doc.get("Date", ""))
    if len(date) < 10 or doc.get("Div") not in DIVISIONS:
        return []
    saison = int(date[:4]) - (int(date[5:7]) < 7)
    debut, fin = f"{saison-1}-07-01", f"{saison}-07-01"
    nouvelle = DIVISIONS[doc["Div"]]
    warnings = []
    for team in (doc.get("HomeTeam"), doc.get("AwayTeam")):
        key = (team, saison)
        if key not in cache:
            previous = col_historique.find_one({
                "Date": {"$gte": debut, "$lt": fin},
                "$or": [{"HomeTeam": team}, {"AwayTeam": team}],
            }, {"Div": 1}, sort=[("Date", -1)])
            cache[key] = previous.get("Div") if previous else None
        ancienne = DIVISIONS.get(cache[key])
        if ancienne and ancienne[0] == nouvelle[0] and ancienne[1] != nouvelle[1]:
            warnings.append({"team": team, "sens": "PROMUE" if ancienne[1] > nouvelle[1] else "RELÉGUÉE",
                             "ancienne_division": ancienne[2], "nouvelle_division": nouvelle[2]})
    return warnings
