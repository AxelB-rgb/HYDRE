"""
Routes d'ADMINISTRATION : injection de nouvelles données (historique + fixtures),
tâche de fond de recalcul de la Matrice 3D, statut de cette tâche.

⚠️ Logique métier INCHANGÉE. Réservé au MASTER dans son intégralité (aucune
donnée ici n'est utile à un usage "consultation" côté VIEWER).
"""
import shutil
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, UploadFile, File

import Mongo_Injector
from backend.auth import require_master

router = APIRouter()

ETAT_USINE = {
    "statut": "repos",
    "message": "En attente de données."
}


def travail_de_l_ombre(data_dir: Path):
    global ETAT_USINE
    ETAT_USINE["statut"] = "en_cours"
    ETAT_USINE["message"] = "🧠 L'IA calcule la nouvelle Matrice 3D (environ 4 min)..."

    try:
        print("🛠️ [BACKGROUND] Lancement de l'analyse IA...")
        df_histo, df_fixtures = Mongo_Injector.preparer_donnees_pour_mongo(data_dir)

        if df_histo is not None or df_fixtures is not None:
            db_instance = Mongo_Injector.injecter_dans_mongodb(df_histo, df_fixtures)
            if db_instance is not None:
                Mongo_Injector.lancer_laboratoire_profilage(db_instance)

                ETAT_USINE["statut"] = "termine"
                ETAT_USINE["message"] = "✅ Matrice 3D en ligne et opérationnelle !"
                print("✅ [BACKGROUND] Matrice 3D terminée et injectée !")
    except Exception as e:
        ETAT_USINE["statut"] = "erreur"
        ETAT_USINE["message"] = f"❌ Erreur critique : {str(e)}"
        print(f"❌ [BACKGROUND] Erreur fatale : {e}")

@router.get("/statut_usine", dependencies=[Depends(require_master)])
async def verifier_statut():
    return ETAT_USINE

@router.post("/injecter_donnees", dependencies=[Depends(require_master)])
async def injecter_donnees(
        background_tasks: BackgroundTasks,
        fichiers_histo: List[UploadFile] = File(None),
        fichier_fixtures: UploadFile = File(None)
):
    try:
        data_dir = Path("Data")
        data_dir.mkdir(exist_ok=True)

        for f in data_dir.glob("*"):
            f.unlink()

        if fichiers_histo:
            for fichier in fichiers_histo:
                with open(data_dir / fichier.filename, "wb") as buffer:
                    shutil.copyfileobj(fichier.file, buffer)

        if fichier_fixtures:
            with open(data_dir / fichier_fixtures.filename, "wb") as buffer:
                shutil.copyfileobj(fichier_fixtures.file, buffer)

        background_tasks.add_task(travail_de_l_ombre, data_dir)

        return {
            "message": "📦 Fichiers réceptionnés. L'IA digère les données en arrière-plan (durée estimée : 4 minutes)."}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


