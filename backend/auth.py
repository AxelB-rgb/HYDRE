"""
Authentification & permissions.

🆕 Fait évoluer l'ancien système "une seule clé maître envoyée en clair à chaque
requête" (X-Hydre-Key) vers une vraie distinction MASTER / VIEWER :

- POST /login : le front envoie un mot de passe, le backend le compare aux deux
  secrets serveur (MASTER, VIEWER) et renvoie un TOKEN DE SESSION signé (HMAC),
  jamais le secret lui-même. Le token encode uniquement le rôle + une expiration.
- Le token est envoyé ensuite via l'en-tête X-Hydre-Token sur chaque requête.
- require_any_role  -> accès en LECTURE (MASTER ou VIEWER valides)
- require_master    -> accès en ÉCRITURE / ADMIN (MASTER uniquement)

Rétrocompatibilité : l'ancien en-tête X-Hydre-Key contenant la clé maître brute
continue de fonctionner et donne toujours un accès MASTER complet (aucune
coupure brutale de l'existant). Le secret VIEWER, lui, n'est JAMAIS envoyé au
frontend : seul le token de session (opaque, expirable) l'est.
"""
import base64
import hashlib
import hmac
import os
import time

from fastapi import Depends, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel

# --- Secrets serveur (jamais exposés au frontend) ---
MASTER_KEY = os.getenv("API_SECRET_KEY")            # 🔒 inchangé : c'était déjà le secret maître
VIEWER_KEY = os.getenv("API_VIEWER_KEY")             # 🆕 nouveau mot de passe à partager aux amis
# Secret de signature des tokens de session. À défaut d'une variable dédiée, on retombe
# sur MASTER_KEY pour ne rien casser sur un déploiement existant qui ne l'aurait pas encore défini.
TOKEN_SECRET = os.getenv("API_TOKEN_SECRET") or MASTER_KEY or "hydre-token-secret-a-changer"
TOKEN_TTL_SECONDS = 12 * 60 * 60  # 12h de session

ROLES_VALIDES = ("MASTER", "VIEWER")

api_key_header = APIKeyHeader(name="X-Hydre-Key", auto_error=False)   # 🔒 legacy (clé brute, MASTER)
token_header = APIKeyHeader(name="X-Hydre-Token", auto_error=False)    # 🆕 session (MASTER ou VIEWER)


def _signature(payload: str) -> str:
    return hmac.new(TOKEN_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()


def creer_token(role: str) -> str:
    """Émet un token de session opaque encodant le rôle + une expiration, signé HMAC."""
    expiration = int(time.time()) + TOKEN_TTL_SECONDS
    payload = f"{role}:{expiration}"
    brut = f"{payload}:{_signature(payload)}"
    return base64.urlsafe_b64encode(brut.encode()).decode()


def _decoder_token(token: str):
    try:
        brut = base64.urlsafe_b64decode(token.encode()).decode()
        role, expiration, signature = brut.split(":")
    except Exception:
        return None
    payload = f"{role}:{expiration}"
    if not hmac.compare_digest(signature, _signature(payload)):
        return None
    if int(expiration) < time.time():
        return None
    if role not in ROLES_VALIDES:
        return None
    return role


def _resoudre_role(api_key: str, token: str):
    # 1) Rétrocompatibilité : ancienne clé maître brute -> toujours MASTER.
    if api_key and MASTER_KEY and hmac.compare_digest(api_key, MASTER_KEY):
        return "MASTER"
    if api_key and VIEWER_KEY and hmac.compare_digest(api_key, VIEWER_KEY):
        return "VIEWER"
    # 2) Nouveau système : token de session signé.
    if token:
        role = _decoder_token(token)
        if role:
            return role
    return None


def get_role(api_key: str = Security(api_key_header), token: str = Security(token_header)) -> str:
    role = _resoudre_role(api_key, token)
    if not role:
        raise HTTPException(status_code=403, detail="Tir non autorisé. Authentification manquante ou invalide.")
    return role


def require_any_role(role: str = Depends(get_role)) -> str:
    """Toute route de LECTURE : accessible par MASTER et VIEWER."""
    return role


def require_master(role: str = Depends(get_role)) -> str:
    """Toute route d'ÉCRITURE ou d'ADMINISTRATION : MASTER uniquement."""
    if role != "MASTER":
        raise HTTPException(status_code=403, detail="Action réservée au compte MASTER (accès VIEWER en lecture seule).")
    return role


# 🔒 Alias de rétrocompatibilité : l'ancien nom `securite_maitre` reste utilisable
# tel quel si un appelant externe l'importait directement.
securite_maitre = require_master


class RequeteLogin(BaseModel):
    mot_de_passe: str


def login(req: RequeteLogin):
    """Authentifie un mot de passe MASTER ou VIEWER et renvoie un token de session."""
    if MASTER_KEY and hmac.compare_digest(req.mot_de_passe, MASTER_KEY):
        return {"role": "MASTER", "token": creer_token("MASTER")}
    if VIEWER_KEY and hmac.compare_digest(req.mot_de_passe, VIEWER_KEY):
        return {"role": "VIEWER", "token": creer_token("VIEWER")}
    raise HTTPException(status_code=403, detail="Mot de passe incorrect.")
