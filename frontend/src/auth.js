// src/auth.js
// 🆕 Authentification MASTER / VIEWER — remplace l'ancien système où le mot de
// passe maître était injecté en clair dans le bundle (process.env.REACT_APP_...)
// et renvoyé tel quel à chaque requête. Désormais, seul un TOKEN DE SESSION
// opaque et expirable (délivré par le backend via /login) est stocké côté
// client — le secret lui-même ne quitte jamais le serveur.

const STORAGE_KEY = 'hydre_session';

export async function login(apiUrl, motDePasse) {
  const res = await fetch(`${apiUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mot_de_passe: motDePasse })
  });
  if (!res.ok) {
    throw new Error('ACCÈS REFUSÉ');
  }
  const data = await res.json(); // { role, token }
  sauvegarderSession(data.role, data.token);
  return data;
}

export function sauvegarderSession(role, token) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ role, token }));
}

export function chargerSession() {
  try {
    const brut = localStorage.getItem(STORAGE_KEY);
    if (!brut) return null;
    const session = JSON.parse(brut);
    if (!session || !session.token || !session.role) return null;
    return session;
  } catch (e) {
    return null;
  }
}

export function effacerSession() {
  localStorage.removeItem(STORAGE_KEY);
}
