"""
Vérifie (et corrige si demandé) le champ Montant_Retour des paris FREEBET
dans Football_Quant.Paris_Engages.

Règle : une freebet ne récupère jamais sa mise.
  - GAGNE : retour net = mise * cote_choisie - mise
  - PERDU : retour net = 0
Autres résultats (CASHOUT, ANNULE, ticket non réglé) : ignorés, jamais modifiés
(un CASHOUT est une valeur saisie à la main, un ANNULE n'a pas de gain à recalculer).

Usage :
    python verifier_freebets.py            # DRY-RUN (aucune écriture)
    python verifier_freebets.py --apply    # applique les corrections

Seul le champ Montant_Retour des paris FREEBET est modifié. Jamais les paris CASH,
jamais un autre champ, jamais une autre collection.
"""
import os
import sys
from decimal import Decimal, ROUND_HALF_UP

from dotenv import load_dotenv
from pymongo import MongoClient

DB_NAME = "Football_Quant"
COLLECTION = "Paris_Engages"
TOLERANCE = 0.005  # écart < 0,5 centime = considéré identique


def to_float(v):
    """Convertit en float, None si absent/invalide."""
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def arrondi_2(x):
    """Arrondi commercial à 2 décimales (évite les artefacts flottants)."""
    return float(Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def est_freebet(p):
    if str(p.get("type_fond", "")).upper() == "CASH":
        return False  # sécurité : jamais un pari CASH
    return str(p.get("type_fond", "")).upper() == "FREEBET" or p.get("est_combine_freebet") is True


def retour_net_attendu(p):
    """Retourne (montant_attendu | None, raison_si_ignoré)."""
    resultat = str(p.get("Resultat_Final", "")).upper()
    if resultat == "PERDU":
        return 0.0, None
    if resultat == "GAGNE":
        mise = to_float(p.get("mise"))
        cote = to_float(p.get("cote_choisie"))
        if mise is None or cote is None or mise <= 0 or cote <= 0:
            return None, "mise ou cote_choisie manquante/invalide"
        return arrondi_2(mise * cote - mise), None
    return None, f"résultat '{resultat or 'non réglé'}' non vérifiable"


def main():
    appliquer = "--apply" in sys.argv

    load_dotenv()
    mongo_uri = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
    col = client[DB_NAME][COLLECTION]

    print(f"Mode : {'⚠️  MODIFICATION ACTIVÉE' if appliquer else 'DRY-RUN (aucune écriture)'}")
    print(f"Base : {DB_NAME}.{COLLECTION}\n")

    requete = {"$or": [{"type_fond": "FREEBET"}, {"est_combine_freebet": True}]}

    verifies = corrects = corriges = 0
    total_avant = total_apres = 0.0
    ignores = []
    tickets_corriges = []

    for p in col.find(requete):
        if not est_freebet(p):
            continue

        attendu, raison = retour_net_attendu(p)
        if attendu is None:
            ignores.append((p.get("id_match"), raison))
            continue

        verifies += 1
        actuel_brut = to_float(p.get("Montant_Retour"))
        actuel = actuel_brut if actuel_brut is not None else 0.0
        total_avant += actuel

        if actuel_brut is not None and abs(actuel - attendu) < TOLERANCE:
            corrects += 1
            total_apres += actuel
            continue

        corriges += 1
        total_apres += attendu
        tickets_corriges.append({
            "id_match": p.get("id_match"),
            "mise": to_float(p.get("mise")),
            "cote": to_float(p.get("cote_choisie")),
            "resultat": p.get("Resultat_Final"),
            "ancien": actuel_brut,
            "nouveau": attendu,
        })

        if appliquer:
            # UNIQUEMENT le champ Montant_Retour
            col.update_one({"_id": p["_id"]}, {"$set": {"Montant_Retour": attendu}})

    print("=" * 70)
    print("RÉSUMÉ")
    print("=" * 70)
    print(f"Freebets vérifiées      : {verifies}")
    print(f"Déjà correctes          : {corrects}")
    print(f"{'Corrigées' if appliquer else 'À corriger (simulé)'}".ljust(24) + f": {corriges}")
    print(f"Ignorées (non vérifiables): {len(ignores)}")
    print(f"Total avant correction  : {total_avant:.2f} €")
    print(f"Total après correction  : {total_apres:.2f} €" + ("" if appliquer else "  (simulé)"))

    if tickets_corriges:
        print("\nTICKETS " + ("CORRIGÉS" if appliquer else "À CORRIGER"))
        for t in tickets_corriges:
            ancien = "None" if t["ancien"] is None else f"{t['ancien']:.2f}"
            print(f"  - {t['id_match']} | {t['resultat']} | mise={t['mise']} | cote={t['cote']} "
                  f"| ancien={ancien} € -> nouveau={t['nouveau']:.2f} €")

    if ignores:
        print("\nTICKETS IGNORÉS")
        for id_match, raison in ignores:
            print(f"  - {id_match} : {raison}")

    if not appliquer and corriges:
        print("\nℹ️  DRY-RUN : rien n'a été modifié. Relance avec --apply pour corriger.")


if __name__ == "__main__":
    main()
