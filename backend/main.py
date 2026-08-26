"""
Point d'entrée de l'API L'Hydre.

Assemble l'app FastAPI, le CORS, la route de login (MASTER/VIEWER) et tous les
routers de domaine. Aucune logique métier ici — uniquement du câblage.

Lancement (inchangé) : `uvicorn backend.main:app --reload`, depuis la racine du
projet (celle qui contient Modeles_Sauvegardes/ et Mongo_Injector.py).
"""
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware

from backend.auth import login, require_any_role
from backend import paris, bankroll, freebet_optimizer, stats, admin

app = FastAPI(title="L'Hydre - Moteur Quantitatif")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://cockpit-farm.vercel.app"
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Hydre-Key", "X-Hydre-Token"],
    expose_headers=["*"]
)

# 🆕 Authentification : renvoie un token de session (MASTER ou VIEWER), jamais le secret.
app.post("/login")(login)

# 🆕 Permet au frontend de vérifier/rafraîchir le rôle courant sans re-saisir le mot de passe.
@app.get("/whoami")
def whoami(role: str = Depends(require_any_role)):
    return {"role": role}

app.include_router(paris.router)
app.include_router(bankroll.router)
app.include_router(freebet_optimizer.router)
app.include_router(stats.router)
app.include_router(admin.router)
