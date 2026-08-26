import React, { useState, useEffect } from 'react';
import { ComposedChart, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, ScatterChart, Scatter, ZAxis, Legend, ReferenceLine } from 'recharts';
import './App.css';
import { login as apiLogin, chargerSession, effacerSession } from './auth';

// UTILITAIRES TEMPORELS
const getWeekNumber = (d) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  return date.getUTCFullYear() + "-W" + Math.ceil((((date - yearStart) / 86400000) + 1)/7);
};

// ⏱️ CORRECTION FUSEAU HORAIRE
const DECALAGE_HEURE = 0;

const ajusterHeure = (dateString) => {
  if (!dateString) return "";
  try {
    const isFullDate = dateString.includes(' ');
    const timePart = isFullDate ? dateString.split(' ')[1] : dateString;
    const datePart = isFullDate ? dateString.split(' ')[0] : "";

    const [hour, minute] = timePart.split(':');
    let h = parseInt(hour, 10) + DECALAGE_HEURE;

    if (h < 0) h += 24;
    if (h >= 24) h -= 24;

    const newTime = `${String(h).padStart(2, '0')}:${minute}`;
    return isFullDate ? `${datePart} ${newTime}` : newTime;
  } catch (e) {
    return dateString;
  }
};

// 🎯 ARRONDI À 2 CHIFFRES SIGNIFICATIFS
// eslint-disable-next-line no-unused-vars
const arrondi2ChiffresSignificatifs = (nombre) => {
  if (!nombre || nombre === 0 || isNaN(nombre)) return 0;
  return parseFloat(Number(nombre).toPrecision(2));
};

// 🆕 GEL DES COTES À H-2 : >2h avant = modifiable ; ==2h = modifiable ; <2h = verrouillé.
const SEUIL_GEL_COTE_HEURES = 2;
const heuresAvantMatch = (dateStr) => {
  if (!dateStr) return null;
  const matchTime = new Date(dateStr.replace(' ', 'T')).getTime();
  if (isNaN(matchTime)) return null;
  return (matchTime - Date.now()) / 3600000;
};
const coteEstVerrouillee = (dateStr) => {
  const h = heuresAvantMatch(dateStr);
  if (h === null) return false;
  return h < SEUIL_GEL_COTE_HEURES;
};

const PROFILS_EXPO_FRONT = { PRUDENT: 10, EQUILIBRE: 20, AGRESSIF: 30 };
const ISSUE_LABELS = { H: 'Domicile (1)', D: 'Nul (X)', A: 'Extérieur (2)' };
// 🆕 DASHBOARD V2 (§6) : correspondance avec les libellés d'Audit_Comite renvoyés par /analyser,
// pour retrouver l'edge de l'issue jouée au moment de la validation (simples uniquement).
const AUDIT_ISSUE_LABELS = { H: 'Domicile (H)', D: 'Nul (D)', A: 'Extérieur (A)' };
const BADGE_INFO = {
  SELECTIONNE: { emoji: '🟢', label: 'SÉLECTIONNÉ', color: '#00ffcc' },
  POTABLE: { emoji: '🟡', label: 'POTABLE', color: '#ffcc00' },
  NON_CONFORME: { emoji: '🔴', label: 'NON CONFORME', color: '#ff4444' }
};

function App() {
  const [vueActuelle, setVueActuelle] = useState('HOME');

  // --- VERROU DE SÉCURITÉ ---
  // 🆕 MASTER / VIEWER : la session (rôle + token) est chargée depuis le localStorage au
  // démarrage. Le vrai secret (mot de passe) n'est JAMAIS stocké côté client — seul un
  // token de session opaque et expirable, délivré par /login, l'est.
  const sessionInitiale = chargerSession();
  const [estConnecte, setEstConnecte] = useState(!!sessionInitiale);
  const [role, setRole] = useState(sessionInitiale ? sessionInitiale.role : null);
  const [token, setToken] = useState(sessionInitiale ? sessionInitiale.token : null);
  const [inputMotDePasse, setInputMotDePasse] = useState("");
  const [erreurConnexion, setErreurConnexion] = useState("");

  // 🆕 VIEWER : lecture seule. Utilisé pour désactiver/masquer les actions d'écriture côté
  // frontend — MAIS la vraie protection est appliquée par le backend sur chaque route
  // (voir dependencies=[Depends(require_master)]) : un appel direct à l'API par un VIEWER
  // est de toute façon refusé (403) même si ce garde-fou frontend était contourné.
  const estViewer = role === 'VIEWER';

  // --- CÂBLAGE DU CERVEAU (API RENDER) ---
  const API_URL = "https://moteur-hydre.onrender.com";

  const getHeaders = () => ({
    'Content-Type': 'application/json',
    'X-Hydre-Token': token
  });

  const verifierMotDePasse = async (e) => {
    e.preventDefault();
    setErreurConnexion("");
    try {
      const { role: roleObtenu, token: tokenObtenu } = await apiLogin(API_URL, inputMotDePasse);
      setToken(tokenObtenu);
      setRole(roleObtenu);
      setEstConnecte(true);
    } catch (err) {
      setErreurConnexion("❌ ACCÈS REFUSÉ.");
      setInputMotDePasse("");
    }
  };

  const seDeconnecter = () => {
    effacerSession();
    setEstConnecte(false);
    setRole(null);
    setToken(null);
  };

  const [sortConfig, setSortConfig] = useState({ issue: { key: 'count', dir: 'desc' }, cotes: { key: 'count', dir: 'desc' }, ligue: { key: 'count', dir: 'desc' }, edge: { key: 'count', dir: 'desc' } });

  const [matchs, setMatchs] = useState([]);
  const [cotesActuelles, setCotesActuelles] = useState({});
  const [resultat, setResultat] = useState(null);
  const [loadingId, setLoadingId] = useState(null);
  const [activeTab, setActiveTab] = useState('A_REMPLIR');
  const [expandedId, setExpandedId] = useState(null);
  const [choixPari, setChoixPari] = useState("");
  const [coteDC, setCoteDC] = useState("");
  const [typeFond, setTypeFond] = useState("CASH");
  const [montantsRetour, setMontantsRetour] = useState({});
  const [clotureEnCours, setClotureEnCours] = useState(null);
  const [misesManuelles, setMisesManuelles] = useState({});
  const [cotesCloture, setCotesCloture] = useState({});

  const [filtreDateDebut, setFiltreDateDebut] = useState("");
  const [filtreDateFin, setFiltreDateFin] = useState("");

  const [editModeId, setEditModeId] = useState(null);
  const [editCote, setEditCote] = useState("");
  const [editMise, setEditMise] = useState("");

  // 🆕 §7 : cote réellement obtenue chez le bookmaker (peut différer de la cote calculée)
  const [coteReelleOverride, setCoteReelleOverride] = useState("");
  // 🆕 §10 : filtre par date réelle du match dans MATCHS PRÊTS / MATCHS ANALYSÉS
  const [filtreDateScanner, setFiltreDateScanner] = useState('TOUTES');

  const [finances, setFinances] = useState({
    initialise: true, total: 0, engage: 0, disponible: 0,
    freebets: { total_acquis: 0, engage: 0, disponible: 0 }
  });

  const [ledgerBankroll, setLedgerBankroll] = useState([
    { id: 'init', date: 'Initial', type: 'INIT', label: 'Ouverture', montant: 0, balance: 0 }
  ]);

  const [inputCapital, setInputCapital] = useState("");
  const [dashboardData, setDashboardData] = useState(null);

  // GESTION DU PROFIL DE RISQUE + SCANNER DE MARCHÉ
  const [profilRisque, setProfilRisque] = useState('EQUILIBRE');
  const [scannerData, setScannerData] = useState(null);
  const [filtreStatutScanner, setFiltreStatutScanner] = useState('TOUS');
  const [triScanner, setTriScanner] = useState('score');

  const [dashGranularite, setDashGranularite] = useState('JOUR');
  const [dashDateDebut, setDashDateDebut] = useState("");
  const [dashDateFin, setDashDateFin] = useState("");
  const [dashFiltreLigue, setDashFiltreLigue] = useState("");
  const [dashMinParisLigue, setDashMinParisLigue] = useState(10); // 🆕 DASHBOARD V2 (§7)
  // 🆕 DASHBOARD CASH / FREEBET : bascule pour inclure ou non les combinés Freebet dans
  // les statistiques d'évaluation de la stratégie "paris simples". Par défaut désactivé
  // (paris simples uniquement) pour ne plus déformer ces statistiques.
  const [dashInclureFreebets, setDashInclureFreebets] = useState(false);

  const [statutUsine, setStatutUsine] = useState({ statut: 'repos', message: '' });

  const [montantDepot, setMontantDepot] = useState("");
  const [labelDepot, setLabelDepot] = useState("");
  const [montantRetrait, setMontantRetrait] = useState("");
  const [labelRetrait, setLabelRetrait] = useState("");
  const [montantFreebet, setMontantFreebet] = useState("");
  const [labelFreebet, setLabelFreebet] = useState("");

  const [bookmakerChoisi, setBookmakerChoisi] = useState('WINAMAX');

  // 🆕 FREEBET OPTIMIZER
  const [freebetTaillesChoisies, setFreebetTaillesChoisies] = useState([2, 3]);
  const [freebetCandidats, setFreebetCandidats] = useState([]);
  const [freebetResultats, setFreebetResultats] = useState(null);
  const [freebetChargement, setFreebetChargement] = useState(false);
  const [freebetFiltreTaille, setFreebetFiltreTaille] = useState('TOUS');
  const [freebetComboOuvert, setFreebetComboOuvert] = useState(null);
  const [freebetCoteReelle, setFreebetCoteReelle] = useState("");
  const [freebetMise, setFreebetMise] = useState("");
  const [combosFreebetEnCours, setCombosFreebetEnCours] = useState([]);
  // 🆕 PORTEFEUILLE FREEBET (diversification multi-profils)
  const [freebetSousVue, setFreebetSousVue] = useState('CLASSEMENT'); // 'CLASSEMENT' | 'PORTEFEUILLE' | 'CONSTRUCTEUR'
  const [freebetPortefeuille, setFreebetPortefeuille] = useState(null);
  const [freebetPortefeuilleChargement, setFreebetPortefeuilleChargement] = useState(false);
  // 🆕 PROGRESSION DE LA RECHERCHE — reflète l'avancement réel du calcul backend (polling de
  // GET /freebet_portefeuille_progression pendant l'appel à POST /freebet_portefeuille).
  const [freebetProgression, setFreebetProgression] = useState(null);
  // 🆕 CONSTRUCTEUR DE COMBINÉ MANUEL — indépendant de la sélection automatique.
  const [constructeurSelectionIds, setConstructeurSelectionIds] = useState([]);
  const [constructeurCombo, setConstructeurCombo] = useState(null);
  const [constructeurChargement, setConstructeurChargement] = useState(false);
  const [constructeurErreur, setConstructeurErreur] = useState('');
  const [clotureComboEnCours, setClotureComboEnCours] = useState(null);
  const [montantsRetourCombo, setMontantsRetourCombo] = useState({});
  const [cotesClotureCombo, setCotesClotureCombo] = useState({});
  const [comboExpandedId, setComboExpandedId] = useState(null);

  // eslint-disable-next-line no-unused-vars
  const [semaineReleve, setSemaineReleve] = useState(getWeekNumber(new Date()));

  const today = new Date();
  const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, '0') + "-" + String(today.getDate()).padStart(2, '0');
  const tomorrow = new Date(today.getTime() + 86400000);
  const tomorrowStr = tomorrow.getFullYear() + "-" + String(tomorrow.getMonth() + 1).padStart(2, '0') + "-" + String(tomorrow.getDate()).padStart(2, '0');
  const currentDayOfWeek = today.getDay();
  const isUpdateDay = currentDayOfWeek === 2 || currentDayOfWeek === 5;

  useEffect(() => {
    if(estConnecte) {
      chargerDonneesTrading();
      const interval = setInterval(() => { if (vueActuelle === 'TRADING' || vueActuelle === 'HOME') chargerDonneesTrading(); }, 60000);
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vueActuelle, estConnecte]);

  // 🆕 Vérifie qu'une session restaurée depuis le localStorage est toujours valide côté
  // backend (token non expiré) ; sinon, déconnexion propre plutôt que des erreurs 403 en boucle.
  useEffect(() => {
    if (estConnecte) {
      fetch(`${API_URL}/whoami`, { headers: getHeaders() })
        .then(res => { if (!res.ok) seDeconnecter(); })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (estConnecte && (vueActuelle === 'DASHBOARD' || vueActuelle === 'HOME' || vueActuelle === 'BANKROLL' || vueActuelle === 'DATA')) chargerDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vueActuelle, estConnecte]);

  useEffect(() => {
    if (estConnecte) {
      chargerConfigProfil();
      chargerLedger();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estConnecte]);

  useEffect(() => {
    if (estConnecte && (vueActuelle === 'TRADING' || vueActuelle === 'HOME')) {
      chargerScanner();
      const interval = setInterval(() => chargerScanner(), 60000);
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estConnecte, vueActuelle]);

  useEffect(() => {
    if (estConnecte && vueActuelle === 'TRADING' && activeTab === 'FREEBET') {
      chargerFreebetCandidats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estConnecte, vueActuelle, activeTab]);

  useEffect(() => {
    if (estConnecte && vueActuelle === 'TRADING' && activeTab === 'JOUE') {
      chargerCombosFreebetEnCours();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estConnecte, vueActuelle, activeTab]);

  useEffect(() => {
    let interval;
    if (statutUsine.statut === 'en_cours') {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`${API_URL}/statut_usine`, {
            headers: getHeaders()
          });
          if (res.ok) {
            const data = await res.json();
            setStatutUsine(data);

            if (data.statut === 'termine') {
              alert("🚨 RAPPORT : " + data.message);
              chargerDashboard();
              setStatutUsine({ statut: 'repos', message: '' });
            } else if (data.statut === 'erreur') {
              alert("❌ ÉCHEC DE L'USINE : " + data.message);
              setStatutUsine({ statut: 'repos', message: '' });
            }
          }
        } catch (e) {
          console.error("Erreur Sonar :", e);
        }
      }, 5000);
    }
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statutUsine.statut]);

  const chargerDonneesTrading = () => {
    fetch(`${API_URL}/finances`, { headers: getHeaders() })
      .then(res => {
          if(!res.ok) throw new Error("Accès Refusé API");
          return res.json();
      })
      .then(data => {
        setFinances(data);
      })
      .catch(err => console.error(err));

    fetch(`${API_URL}/prochains_matchs`, { headers: getHeaders() })
      .then(res => res.json())
      .then(data => {
      if (data.matchs) {
        setMatchs(data.matchs);
        const cotesInit = {};
        data.matchs.forEach(m => { if (m.cote_act_dom || m.cote_act_nul || m.cote_act_ext) cotesInit[m.id] = { dom: m.cote_act_dom, nul: m.cote_act_nul, ext: m.cote_act_ext }; });
        setCotesActuelles(cotesInit);
      }
    }).catch(err => console.error(err));
  };

  const chargerDashboard = () => {
      fetch(`${API_URL}/statistiques_dashboard`, { headers: getHeaders() })
      .then(res => res.json())
      .then(data => setDashboardData(data))
      .catch(err => console.error(err));
  };

  const chargerConfigProfil = () => {
    fetch(`${API_URL}/config_profil`, { headers: getHeaders() })
      .then(res => res.json())
      .then(data => setProfilRisque(data.profil || 'EQUILIBRE'))
      .catch(err => console.error(err));
  };

  const changerProfilRisque = async (nouveauProfil) => {
    try {
      const res = await fetch(`${API_URL}/config_profil`, {
        method: 'POST', headers: getHeaders(), body: JSON.stringify({ profil: nouveauProfil })
      });
      if (!res.ok) throw new Error("Erreur API");
      setProfilRisque(nouveauProfil);
      chargerScanner();
      alert(`✅ Profil de risque changé : ${nouveauProfil}`);
    } catch (e) {
      alert("❌ Erreur lors du changement de profil.");
    }
  };

  const chargerScanner = () => {
    fetch(`${API_URL}/scanner_marche`, { headers: getHeaders() })
      .then(res => res.json())
      .then(data => setScannerData(data))
      .catch(err => console.error(err));
  };

  const getMiseRecommandeeScanner = (matchId) => {
    const item = scannerData?.matchs?.find(m => m.id === matchId);
    return item && item.mise_euros ? item.mise_euros : 0;
  };

  const chargerLedger = () => {
    fetch(`${API_URL}/mouvements_bankroll`, { headers: getHeaders() })
      .then(res => res.json())
      .then(data => {
        if (data.mouvements) setLedgerBankroll(data.mouvements);
      })
      .catch(err => console.error(err));
  };

  // 🆕 FREEBET OPTIMIZER — fonctions
  const chargerFreebetCandidats = () => {
    fetch(`${API_URL}/freebet_candidats`, { headers: getHeaders() })
      .then(res => res.json())
      .then(data => setFreebetCandidats(data.candidats || []))
      .catch(err => console.error(err));
  };

  const chargerCombosFreebetEnCours = () => {
    fetch(`${API_URL}/combos_freebet_en_cours`, { headers: getHeaders() })
      .then(res => res.json())
      .then(data => setCombosFreebetEnCours(data.combos || []))
      .catch(err => console.error(err));
  };

  const toggleTailleFreebet = (taille) => {
    setFreebetTaillesChoisies(prev => prev.includes(taille) ? prev.filter(t => t !== taille) : [...prev, taille].sort((a, b) => a - b));
  };

  const lancerRechercheFreebet = async () => {
    if (freebetTaillesChoisies.length === 0) { alert("⚠️ Choisis au moins une taille de combiné (2 minimum)."); return; }
    setFreebetChargement(true);
    setFreebetResultats(null);
    setFreebetFiltreTaille('TOUS');
    setFreebetSousVue('CLASSEMENT');
    try {
      const res = await fetch(`${API_URL}/freebet_combos`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ tailles: freebetTaillesChoisies }) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
      const data = await res.json();
      setFreebetResultats(data);
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
    setFreebetChargement(false);
  };

  // 🆕 PORTEFEUILLE FREEBET — construit une proposition diversifiée (un ticket par profil).
  // Pendant l'appel (potentiellement long, la construction évalue désormais TOUS les
  // candidats à chaque tour), on interroge en parallèle GET /freebet_portefeuille_progression
  // pour afficher une progression réelle (pas une animation) tant que la requête POST n'est
  // pas revenue.
  const lancerRecherchePortefeuille = async () => {
    if (freebetTaillesChoisies.length === 0) { alert("⚠️ Choisis au moins une taille de combiné (2 minimum)."); return; }
    setFreebetPortefeuilleChargement(true);
    setFreebetPortefeuille(null);
    setFreebetProgression(null);
    setFreebetSousVue('PORTEFEUILLE');

    const intervalleProgression = setInterval(() => {
      fetch(`${API_URL}/freebet_portefeuille_progression`, { headers: getHeaders() })
        .then(res => res.ok ? res.json() : null)
        .then(data => { if (data) setFreebetProgression(data); })
        .catch(() => {});
    }, 600);

    try {
      const res = await fetch(`${API_URL}/freebet_portefeuille`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ tailles: freebetTaillesChoisies }) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
      const data = await res.json();
      setFreebetPortefeuille(data);
      setFreebetProgression(prev => ({
        ...(prev || {}), en_cours: false, termine: true, pourcentage: 100,
        etape: "Recherche terminée.", nb_tickets_retenus: (data.portefeuille_recommande || []).length
      }));
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
    clearInterval(intervalleProgression);
    setFreebetPortefeuilleChargement(false);
  };

  // 🆕 CONSTRUCTEUR DE COMBINÉ MANUEL — ajoute/retire librement un match, aucune limite
  // artificielle sur le nombre de matchs. Indépendant de la sélection automatique.
  const toggleConstructeurMatch = (id) => {
    setConstructeurSelectionIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const viderConstructeur = () => { setConstructeurSelectionIds([]); setConstructeurCombo(null); setConstructeurErreur(''); };

  useEffect(() => {
    if (constructeurSelectionIds.length < 2) { setConstructeurCombo(null); setConstructeurErreur(''); return; }
    let annule = false;
    setConstructeurChargement(true);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/freebet_combo_manuel`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ ids: constructeurSelectionIds }) });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
        const data = await res.json();
        if (!annule) { setConstructeurCombo(data.combo); setConstructeurErreur(''); }
      } catch (e) {
        if (!annule) { setConstructeurCombo(null); setConstructeurErreur(e.message); }
      }
      if (!annule) setConstructeurChargement(false);
    })();
    return () => { annule = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constructeurSelectionIds]);

  const ouvrirValidationCombo = (combo) => {
    setFreebetComboOuvert(combo);
    setFreebetCoteReelle(combo.cote_totale);
    setFreebetMise(combo.kelly && combo.kelly.mise_recommandee != null ? combo.kelly.mise_recommandee : "");
  };

  const validerComboFreebetHandler = async () => {
    const combo = freebetComboOuvert;
    if (!combo) return;
    const mise = parseFloat(freebetMise);
    if (!mise || mise <= 0) { alert("⚠️ Renseigne une mise Freebet valide."); return; }
    if (mise > finances.freebets.disponible) { alert("Solde FREEBET insuffisant !"); return; }
    // 🆕 §8 : si une sélection est à moins de 2h de son coup d'envoi, impossible de corriger la cote.
    const comboVerrouille = combo.selections.some(s => coteEstVerrouillee(s.date));
    const coteReelle = comboVerrouille ? combo.cote_totale : (parseFloat(freebetCoteReelle) || combo.cote_totale);

    const payload = {
      taille: combo.taille,
      selections: combo.selections.map(s => ({
        id_match: s.id, home_team: s.home_team, away_team: s.away_team, div: s.div, date: s.date,
        issue: s.issue, issue_label: s.issue_label, cote_calculee: s.cote, proba: s.proba, edge: s.edge, score: s.score
      })),
      cote_totale_calculee: combo.cote_totale,
      cote_totale_reelle: coteReelle,
      mise_freebet: mise,
      score: combo.score,
      niveau_risque: combo.niveau_risque,
      probabilite_pct: combo.probabilite_pct,
      edge_pct: combo.edge_pct,
      bookmaker: bookmakerChoisi
    };

    try {
      const res = await fetch(`${API_URL}/valider_combo_freebet`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(payload) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
      alert("✅ Combiné Freebet verrouillé, direction PARIS JOUÉS.");
      setFreebetComboOuvert(null);
      setFreebetResultats(null);
      chargerDonneesTrading();
      chargerCombosFreebetEnCours();
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  const cloturerComboFreebetHandler = async (combo, resultatTir, montant) => {
    if (resultatTir === "CASHOUT" && montant === undefined) {
      setClotureComboEnCours({ id: combo.id_match, type: resultatTir }); return;
    }
    if (resultatTir === "ANNULE") {
      if (!window.confirm("⚠️ Annuler ce combiné Freebet ? La freebet engagée sera restaurée. Aucun profit ni perte ne sera comptabilisé.")) return;
    }
    let retourFinal = 0;
    if (resultatTir === "GAGNE") { retourFinal = combo.mise * combo.cote_choisie; }
    else if (resultatTir === "PERDU") { retourFinal = 0; }
    else if (resultatTir === "ANNULE") { retourFinal = combo.mise; } // restitution intégrale, PnL = 0
    else { retourFinal = montant !== undefined ? parseFloat(montant) : 0; } // CASHOUT

    const coteClotureSaisie = cotesClotureCombo[combo.id_match] ? parseFloat(cotesClotureCombo[combo.id_match]) : 0;

    await fetch(`${API_URL}/cloturer_combo_freebet`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ id_match: combo.id_match, resultat: resultatTir, montant_retour: parseFloat(retourFinal.toFixed(2)), cote_cloture: coteClotureSaisie })
    });
    setClotureComboEnCours(null);
    chargerCombosFreebetEnCours();
    chargerDonneesTrading();
  };

  const initialiserBankroll = async () => {
    if (!inputCapital) return;
    await fetch(`${API_URL}/init_bankroll`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ capital: parseFloat(inputCapital) }) });
    chargerDonneesTrading();
    chargerLedger();
  };

  const handleDepot = async () => {
    const val = parseFloat(montantDepot);
    if (isNaN(val) || val <= 0) return;
    if (!window.confirm(`💰 Injecter ${val.toFixed(2)} € CASH ?`)) return;
    try {
      const res = await fetch(`${API_URL}/mouvement_bankroll`, {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({ type: 'DEPOT', montant: val, label: labelDepot })
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
      const data = await res.json();
      setFinances(data.finances);
      setMontantDepot(""); setLabelDepot("");
      chargerLedger();
      alert(`✅ Dépôt enregistré.`);
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  const handleRetrait = async () => {
    const val = parseFloat(montantRetrait);
    if (isNaN(val) || val <= 0) return;
    if (val > finances.disponible) { alert("❌ ERREUR : Fonds insuffisants."); return; }
    if (!window.confirm(`💸 Extraire ${val.toFixed(2)} € CASH vers ton compte bancaire ?`)) return;
    try {
      const res = await fetch(`${API_URL}/mouvement_bankroll`, {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({ type: 'RETRAIT', montant: val, label: labelRetrait })
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
      const data = await res.json();
      setFinances(data.finances);
      setMontantRetrait(""); setLabelRetrait("");
      chargerLedger();
      alert(`✅ Retrait enregistré.`);
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  const handleAjoutFreebet = async () => {
    const val = parseFloat(montantFreebet);
    if (isNaN(val) || val <= 0) return;
    if (!window.confirm(`🎁 Ajouter ${val.toFixed(2)} € en FREEBETS ?`)) return;
    try {
      const res = await fetch(`${API_URL}/mouvement_bankroll`, {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({ type: 'FREEBET', montant: val, label: labelFreebet })
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
      const data = await res.json();
      setFinances(data.finances);
      setMontantFreebet(""); setLabelFreebet("");
      chargerLedger();
      alert(`✅ Freebets crédités.`);
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  const handleCoteChange = (matchId, type, valeur) => { setCotesActuelles(prev => ({ ...prev, [matchId]: { ...prev[matchId], [type]: valeur } })); };

  const resetMatch = async (match) => {
    await fetch(`${API_URL}/reset_match`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ home_team: match.home_team, away_team: match.away_team }) });
    if(resultat?.matchObj?.id === match.id) setResultat(null);
    chargerDonneesTrading();
    chargerScanner();
  };

  const analyserMatch = async (match) => {
    const cotes = cotesActuelles[match.id];
    if (!cotes || !cotes.dom || !cotes.nul || !cotes.ext) { alert("Cotes manquantes !"); return; }
    setLoadingId(match.id);
    const payload = { home_team: match.home_team, away_team: match.away_team, cote_ouverture_dom: match.cote_ouv_dom, cote_actuelle_dom: parseFloat(cotes.dom), cote_ouverture_nul: match.cote_ouv_nul, cote_actuelle_nul: parseFloat(cotes.nul), cote_ouverture_ext: match.cote_ouv_ext, cote_actuelle_ext: parseFloat(cotes.ext) };
    try {
      const response = await fetch(`${API_URL}/analyser`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(payload) });
      const data = await response.json();
      setResultat({ ...data, matchObj: match });
      setChoixPari(""); setCoteDC(""); setTypeFond("CASH"); setCoteReelleOverride(""); chargerDonneesTrading(); chargerScanner();
    } catch (error) { alert("Erreur de connexion."); }
    setLoadingId(null);
  };

  const validerPari = async (match) => {
    if (!choixPari) return;
    const cotes = cotesActuelles[match.id];
    let coteCalculee = 0;
    if (choixPari === 'H') coteCalculee = parseFloat(cotes.dom); else if (choixPari === 'D') coteCalculee = parseFloat(cotes.nul); else if (choixPari === 'A') coteCalculee = parseFloat(cotes.ext);
    else if (['1X', 'X2', '12'].includes(choixPari)) { if (!coteDC) return; coteCalculee = parseFloat(coteDC); }

    // 🆕 §7/§8 : cote réellement obtenue — modifiable uniquement si le match est encore à 2h ou plus.
    const verrouille = coteEstVerrouillee(match.date);
    const coteFinale = (!verrouille && coteReelleOverride !== "" && !isNaN(parseFloat(coteReelleOverride)))
      ? parseFloat(coteReelleOverride)
      : coteCalculee;

    const miseRecommandee = getMiseRecommandeeScanner(match.id);
    let miseFinale = misesManuelles[match.id] !== undefined ? parseFloat(misesManuelles[match.id]) : miseRecommandee;

    if (!miseFinale || miseFinale <= 0) {
      alert("⚠️ Ce match n'a pas de mise recommandée par le scanner (non sélectionné). Saisis une mise manuelle dans le champ MISE avant d'engager.");
      return;
    }

    if (typeFond === "CASH" && miseFinale > finances.disponible) { alert("Fonds CASH insuffisants !"); return; }
    if (typeFond === "FREEBET" && miseFinale > finances.freebets.disponible) { alert("Solde FREEBET insuffisant !"); return; }

    // 🆕 DASHBOARD V2 (§6) : edge de l'issue jouée, uniquement disponible pour les issues simples (H/D/A).
    let edgeChoisi = null;
    if (['H', 'D', 'A'].includes(choixPari) && resultat?.Audit_Comite) {
      const auditChoisi = resultat.Audit_Comite.find(a => a.issue === AUDIT_ISSUE_LABELS[choixPari]);
      if (auditChoisi) edgeChoisi = auditChoisi.edge;
    }
    // 🆕 CORRECTIF STOCKAGE (§1) : score Hydre renvoyé directement par /analyser (snapshot fiable au
    // moment de l'analyse), remplace l'ancienne lecture dans scannerMatchs (souvent absente/périmée
    // si le Scanner de Marché n'avait pas été relancé juste avant).
    const scoreChoisi = (resultat && resultat.Score_Hydre !== undefined && resultat.Score_Hydre !== null) ? resultat.Score_Hydre : null;

    if(typeFond === "CASH") {
        setFinances(prev => ({ ...prev, engage: prev.engage + miseFinale, disponible: prev.disponible - miseFinale }));
    } else {
        setFinances(prev => ({
            ...prev,
            freebets: { ...prev.freebets, engage: prev.freebets.engage + miseFinale, disponible: prev.freebets.disponible - miseFinale }
        }));
    }

    try {
      const res = await fetch(`${API_URL}/valider_pari`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ id_match: match.id, home_team: match.home_team, away_team: match.away_team, date: match.date, div: match.div || "Inconnu", choix_pari: choixPari, cote_choisie: coteFinale, cote_calculee: coteCalculee, mise: miseFinale, type_fond: typeFond, bookmaker: bookmakerChoisi, edge: edgeChoisi, score: scoreChoisi }) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
      setResultat(null); setCoteReelleOverride(""); chargerDonneesTrading(); chargerScanner(); alert(`Transaction ${typeFond} verrouillée.`);
    } catch (e) {
      chargerDonneesTrading(); // resynchronise les finances après le rollback optimiste ci-dessus
      alert(`❌ ${e.message}`);
    }
  };

  const cloturerPari = async (match, resultatTir, montant) => {
    if (resultatTir === "CASHOUT" && montant === undefined) {
      setClotureEnCours({ id: match.id, type: resultatTir }); return;
    }
    if (resultatTir === "ANNULE") {
      const libelleFonds = match.type_fond === 'FREEBET' ? 'la freebet' : 'le cash';
      if (!window.confirm(`⚠️ Annuler ce pari ? ${libelleFonds} engagé(e) sera restauré(e). Aucun profit ni perte ne sera comptabilisé.`)) return;
    }
    let retourFinal = 0;
    if (resultatTir === "GAGNE") {
      // 🔧 FIX §2 : un FREEBET gagnant est payé en "Stake Not Returned" — la mise freebet
      // n'a jamais été de l'argent réel, donc elle n'est jamais restituée : le gain cash
      // réellement récupérable est (mise * cote) - mise, jamais le retour brut mise*cote
      // utilisé pour un pari CASH classique (voir aussi _pnl_cash_pari côté backend).
      retourFinal = match.type_fond === 'FREEBET' ? (match.mise * (match.cote_choisie - 1)) : (match.mise * match.cote_choisie);
    }
    else if (resultatTir === "PERDU") { retourFinal = 0; }
    else if (resultatTir === "ANNULE") { retourFinal = match.mise; } // restitution intégrale, PnL = 0
    else { retourFinal = montant !== undefined ? parseFloat(montant) : 0; } // CASHOUT

    const coteClotureSaisie = cotesCloture[match.id] ? parseFloat(cotesCloture[match.id]) : 0;

    await fetch(`${API_URL}/cloturer_pari`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ id_match: match.id, home_team: match.home_team, away_team: match.away_team, resultat: resultatTir, montant_retour: parseFloat(retourFinal.toFixed(2)), cote_cloture: coteClotureSaisie })
    });
    setClotureEnCours(null); chargerDonneesTrading(); chargerScanner();
    // 🆕 §2 : un pari simple PERDU peut avoir déclenché la perte automatique d'un ou plusieurs
    // combinés Freebet qui le contenaient — on rafraîchit la liste pour refléter la cascade.
    if (resultatTir === "PERDU") chargerCombosFreebetEnCours();
  };

  const annulerPariErreur = async (match) => {
    if(!window.confirm("⚠️ Annuler le trade et renvoyer au sas ?")) return;
    await fetch(`${API_URL}/annuler_pari_erreur`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ id_match: match.id, home_team: match.home_team, away_team: match.away_team }) });
    setExpandedId(null); chargerDonneesTrading(); chargerScanner();
  };

  const sauvegarderModification = async (match) => {
    // 🆕 §8 : la cote d'un pari déjà engagé est gelée à moins de 2h du coup d'envoi.
    const nouvelleCote = parseFloat(editCote);
    if (nouvelleCote !== match.cote_choisie && coteEstVerrouillee(match.date)) {
      alert("🔒 Cote verrouillée : moins de 2h avant le coup d'envoi, la cote ne peut plus être modifiée.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/modifier_pari`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ id_match: match.id, home_team: match.home_team, away_team: match.away_team, nouvelle_cote: nouvelleCote, nouvelle_mise: parseFloat(editMise) })
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Erreur API"); }
      setEditModeId(null);
      chargerDonneesTrading();
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  const purgerMatchsPerimes = async () => {
    if(!window.confirm("⚠️ Es-tu sûr de vouloir renvoyer tous les matchs périmés (Sas 2) vers le Sas 1 ?")) return;
    const matchsAPurger = matchs.filter(m => {
        const ageSec = (new Date().getTime() / 1000) - (m.derniere_analyse || 0);
        return m.statut === 'ANALYSE' && m.derniere_analyse > 0 && ageSec > 7200;
    });
    for (const match of matchsAPurger) {
        await fetch(`${API_URL}/reset_match`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ home_team: match.home_team, away_team: match.away_team }) });
    }
    if(resultat) setResultat(null);
    alert(`✅ ${matchsAPurger.length} matchs purgés.`); chargerDonneesTrading(); chargerScanner();
  };

  const copierRapportPourIA = () => {
    if (!resultat) return;
    let texte = `🤖 RAPPORT D'ANALYSE HYDRE\n===============================\n🎯 MATCH : ${resultat.Match}\n\n`;
    texte += `📊 1. MARCHÉ (Cotes Actuelles)\nDomicile (H) : ${resultat.Radar_Marche.Act.H} | Nul (D) : ${resultat.Radar_Marche.Act.D} | Extérieur (A) : ${resultat.Radar_Marche.Act.A}\n\n`;
    texte += `🧠 2. PROBABILITÉS (Hydre)\nH : ${resultat.Matrice_Probas.Hydre.H}% | D : ${resultat.Matrice_Probas.Hydre.D}% | A : ${resultat.Matrice_Probas.Hydre.A}%\n\n`;
    texte += `🔪 3. EDGES BRUTS\nH : ${resultat.Scanner_Value.Hydre.H}% | D : ${resultat.Scanner_Value.Hydre.D}% | A : ${resultat.Scanner_Value.Hydre.A}%\n\n`;
    texte += `⚖️ 4. COMITÉ DE SÉLECTION (Verdict Matrice 3D)\n`;
    resultat.Audit_Comite.forEach(a => { texte += `- ${a.issue} : Edge ${a.edge}% | Vol ${a.volume} matchs | ROI ${a.roi}% => ${a.statut} (${a.tag})\n`; });
    texte += `\n🔬 5. ANOMALIES DÉTECTÉES\n`;
    resultat.Anomalies.forEach(ano => { texte += `- ${ano}\n`; });
    navigator.clipboard.writeText(texte);
    alert("✅ Données copiées ! Tu n'as plus qu'à me les coller dans le chat.");
  };

  const Colorize = ({ val, inverse=false, isCurrency=false }) => {
    let color = '#fff';
    if (val > 0) color = inverse ? '#ff4444' : '#00ffcc';
    if (val < 0) color = inverse ? '#00ffcc' : '#ff4444';
    const prefix = val > 0 ? '+' : '';
    const suffix = isCurrency ? ' €' : '';
    return <span style={{ color, fontWeight: 'bold', whiteSpace: 'nowrap' }}>{prefix}{val}{suffix}</span>;
  };

  const currentWeekStr = getWeekNumber(today);

  const formaterPeriode = (dateStr, gran) => {
    if (!dateStr) return "Inconnu";
    const d = new Date(dateStr);
    if(gran === 'ANNEE') return d.getFullYear().toString();
    if(gran === 'MOIS') return dateStr.substring(0, 7);
    if(gran === 'SEMAINE') return getWeekNumber(d);
    return dateStr.substring(0, 10);
  };

  const genererDashboardFiltre = () => {
    if (!dashboardData) return null;
    let historyTotal = dashboardData.historique || [];
    const liguesDisponibles = [...new Set(historyTotal.map(p => p.div || "Inconnu"))].sort();

    let history = historyTotal;
    if (dashDateDebut) history = history.filter(p => p.date >= dashDateDebut);
    if (dashDateFin) history = history.filter(p => p.date <= dashDateFin);
    if (dashFiltreLigue) history = history.filter(p => (p.div || "Inconnu") === dashFiltreLigue);

    // 🆕 §6 : un ticket ANNULÉ reste visible dans le registre (tableData/historique ci-dessous),
    // mais ne doit JAMAIS entrer dans les statistiques de performance (KPI, winrate, ROI, ROC,
    // stats par cote/issue/ligue/taille de combiné...). On calcule donc tout ce qui suit
    // uniquement sur le sous-ensemble non-annulé.
    const historyStats = history.filter(p => p.resultat !== 'ANNULE');

    // 🆕 DASHBOARD CASH / FREEBET : sous-ensemble utilisé pour TOUTES les statistiques
    // d'évaluation de la stratégie "paris simples" (KPI globaux, courbe de profit, séries,
    // répartitions par issue/cote/ligue/bookmaker/edge/jour). Les combinés Freebet n'y
    // entrent que si l'utilisateur choisit explicitement de les inclure. Les statistiques
    // spécifiques aux freebets (plus bas) restent, elles, TOUJOURS calculées sur historyStats
    // en entier, quel que soit ce réglage.
    const historyStatsGenerales = dashInclureFreebets ? historyStats : historyStats.filter(p => !p.est_combine);

    let tMise = 0, tRetour = 0, tGagnes = 0, tCotes = 0, tClv = 0, countClv = 0;
    let tMiseJour = 0, tRetourJour = 0;
    let tMiseSemaine = 0, tRetourSemaine = 0;

    const statsIssue = {};
    // 🆕 §5 : nouvelles tranches de cote demandées (évite le gros groupe 2.00-3.00).
    const statsCotes = {
      '< 1.40': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '1.40 - 1.60': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '1.60 - 1.80': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '1.80 - 2.00': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '2.00 - 2.20': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '2.20 - 2.40': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '2.40 - 2.60': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '2.60 - 2.80': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '2.80 - 3.00': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '3.00+': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 }
    };
    const statsLigue = {};
    const statsBooks = {};
    // 🆕 §16/§17 : distinction compacte simples/combinés + performance par taille de combiné.
    // Un combiné reste UN SEUL ticket financier (§14) — jamais recompté par sélection.
    const statsTypePari = {
      SIMPLE: { mise: 0, pnl: 0, count: 0, wins: 0 },
      COMBINE: { mise: 0, pnl: 0, count: 0, wins: 0 }
    };
    const statsTailleCombine = {};

    // 🆕 V2.1 §3 : Performance par jour de la semaine (Lundi → Dimanche).
    const JOURS_SEMAINE = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    const statsJourSemaine = {};
    JOURS_SEMAINE.forEach(j => { statsJourSemaine[j] = { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 }; });

    // 🆕 V2.1 §4 : Performance par tranche de Score Hydre (simples uniquement — le score des combinés
    // Freebet suit une échelle différente et reste traité séparément, cf. detailCombinesFreebet).
    const statsScoreHydre = {
      '0 - 20': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '20 - 40': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '40 - 60': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '60 - 80': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '80 - 100': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 }
    };
    let nbSansScore = 0;

    // 🆕 V2.1 §7 : Performance des combinés Freebet par taille (2 / 3 / 4 / 5+), séparée des simples.
    const statsTailleFreebet = {
      '2 sélections': { mise: 0, retour: 0, pnl: 0, count: 0, wins: 0 },
      '3 sélections': { mise: 0, retour: 0, pnl: 0, count: 0, wins: 0 },
      '4 sélections': { mise: 0, retour: 0, pnl: 0, count: 0, wins: 0 },
      '5 sélections et +': { mise: 0, retour: 0, pnl: 0, count: 0, wins: 0 }
    };
    let nbSansTailleFreebet = 0;

    // 🆕 V2.1 §5/§8 : agrégats + détail des combinés Freebet (jamais les simples, jamais dupliqué).
    let nbCombinesFreebet = 0, freebetsUtilisees = 0, gainsFreebet = 0, profitFreebet = 0;
    const detailCombinesFreebet = [];

    // 🆕 §6 : Performance par Edge (uniquement pour les paris où l'edge a été enregistré).
    const statsEdge = {
      '< 5%': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '5% à < 10%': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '10% à < 15%': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '15% à < 20%': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '20% à < 25%': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 },
      '≥ 25%': { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 }
    };
    let nbSansEdge = 0;

    // 🆕 §2 : CLV détaillée (moyenne, médiane, % positive, min, max).
    const clvValues = [];
    // 🆕 §4 : Performance par CLV.
    const statsClv = {
      '< 0%': { mise: 0, pnl: 0, count: 0, wins: 0 },
      '0% à < 2%': { mise: 0, pnl: 0, count: 0, wins: 0 },
      '2% à < 5%': { mise: 0, pnl: 0, count: 0, wins: 0 },
      '5% à < 10%': { mise: 0, pnl: 0, count: 0, wins: 0 },
      '≥ 10%': { mise: 0, pnl: 0, count: 0, wins: 0 }
    };
    // 🆕 §3 : ROI vs CLV (un point par pari avec CLV connue).
    const scatterClvPnl = [];

    historyStatsGenerales.forEach(p => {
      // 🆕 §4 : équivalent CASH de la mise — une mise FREEBET n'a jamais été de l'argent
      // réellement risqué, donc elle ne doit jamais compter comme capital engagé dans les
      // statistiques évaluant la stratégie cash (ROI, PnL, répartitions). Le P&L (p.pnl,
      // déjà cash-correct côté backend) reste, lui, inchangé.
      const miseCash = p.type_fond === 'FREEBET' ? 0 : p.mise;

      tMise += miseCash; tRetour += p.retour;
      if (p.resultat === 'GAGNE') tGagnes++;
      if (p.cote) tCotes += p.cote;

      let clvPari = null;
      if (p.cote_cloture && p.cote_cloture > 0) {
        clvPari = ((p.cote / p.cote_cloture) - 1) * 100;
        tClv += (clvPari / 100); countClv++;
        clvValues.push(clvPari);
        scatterClvPnl.push({ clv: parseFloat(clvPari.toFixed(2)), pnl: p.pnl, win: p.resultat === 'GAGNE' });

        let trancheClv = '';
        if (clvPari < 0) trancheClv = '< 0%';
        else if (clvPari < 2) trancheClv = '0% à < 2%';
        else if (clvPari < 5) trancheClv = '2% à < 5%';
        else if (clvPari < 10) trancheClv = '5% à < 10%';
        else trancheClv = '≥ 10%';
        statsClv[trancheClv].mise += miseCash; statsClv[trancheClv].pnl += p.pnl; statsClv[trancheClv].count += 1;
        if (p.resultat === 'GAGNE') statsClv[trancheClv].wins += 1;
      }

      if (p.date === todayStr) { tMiseJour += miseCash; tRetourJour += p.retour; }
      if (getWeekNumber(new Date(p.date)) === currentWeekStr) { tMiseSemaine += miseCash; tRetourSemaine += p.retour; }

      const issue = p.choix || 'Inconnu';
      if (!statsIssue[issue]) statsIssue[issue] = { mise: 0, pnl: 0, count: 0, wins: 0 };
      statsIssue[issue].mise += miseCash; statsIssue[issue].pnl += p.pnl; statsIssue[issue].count += 1;
      if (p.resultat === 'GAGNE') statsIssue[issue].wins += 1;

      let tranche = '';
      if (p.cote < 1.40) tranche = '< 1.40';
      else if (p.cote < 1.60) tranche = '1.40 - 1.60';
      else if (p.cote < 1.80) tranche = '1.60 - 1.80';
      else if (p.cote < 2.00) tranche = '1.80 - 2.00';
      else if (p.cote < 2.20) tranche = '2.00 - 2.20';
      else if (p.cote < 2.40) tranche = '2.20 - 2.40';
      else if (p.cote < 2.60) tranche = '2.40 - 2.60';
      else if (p.cote < 2.80) tranche = '2.60 - 2.80';
      else if (p.cote < 3.00) tranche = '2.80 - 3.00';
      else tranche = '3.00+';

      statsCotes[tranche].mise += miseCash; statsCotes[tranche].pnl += p.pnl; statsCotes[tranche].count += 1;
      if (p.resultat === 'GAGNE') statsCotes[tranche].wins += 1;
      if (clvPari !== null) { statsCotes[tranche].clvSum += clvPari; statsCotes[tranche].clvCount += 1; }

      const div = p.div || 'Inconnu';
      if (!statsLigue[div]) statsLigue[div] = { mise: 0, pnl: 0, count: 0, wins: 0, clvSum: 0, clvCount: 0 };
      statsLigue[div].mise += miseCash; statsLigue[div].pnl += p.pnl; statsLigue[div].count += 1;
      if (p.resultat === 'GAGNE') statsLigue[div].wins += 1;
      if (clvPari !== null) { statsLigue[div].clvSum += clvPari; statsLigue[div].clvCount += 1; }

      const book = (p.bookmaker || 'WINAMAX').toUpperCase();
      if (!statsBooks[book]) statsBooks[book] = { Count: 0, Wins: 0, Mise: 0, PnL: 0 };
      statsBooks[book].Count += 1;
      statsBooks[book].Mise += miseCash;
      statsBooks[book].PnL += p.pnl;
      if (p.resultat === 'GAGNE') statsBooks[book].Wins += 1;

      // 🆕 §6 : Performance par Edge — seulement si l'edge a été enregistré pour ce pari
      // (issues simples validées après la mise à jour). Jamais estimé pour les anciens paris.
      if (p.edge === null || p.edge === undefined) {
        nbSansEdge += 1;
      } else {
        const e = p.edge;
        let trancheEdge = '';
        if (e < 5) trancheEdge = '< 5%';
        else if (e < 10) trancheEdge = '5% à < 10%';
        else if (e < 15) trancheEdge = '10% à < 15%';
        else if (e < 20) trancheEdge = '15% à < 20%';
        else if (e < 25) trancheEdge = '20% à < 25%';
        else trancheEdge = '≥ 25%';
        statsEdge[trancheEdge].mise += miseCash; statsEdge[trancheEdge].pnl += p.pnl; statsEdge[trancheEdge].count += 1;
        if (p.resultat === 'GAGNE') statsEdge[trancheEdge].wins += 1;
        if (clvPari !== null) { statsEdge[trancheEdge].clvSum += clvPari; statsEdge[trancheEdge].clvCount += 1; }
      }

      // 🆕 V2.1 §3 : Performance par jour de la semaine (basé sur la date du pari, comme le reste du Dashboard).
      const dObjJour = new Date(p.date);
      if (!isNaN(dObjJour.getTime())) {
        const dayIdx = dObjJour.getDay(); // 0=Dimanche ... 6=Samedi
        const jourLabel = JOURS_SEMAINE[(dayIdx + 6) % 7]; // remappe en Lundi..Dimanche
        const sj = statsJourSemaine[jourLabel];
        sj.mise += miseCash; sj.pnl += p.pnl; sj.count += 1;
        if (p.resultat === 'GAGNE') sj.wins += 1;
        if (clvPari !== null) { sj.clvSum += clvPari; sj.clvCount += 1; }
      }

      // 🆕 V2.1 §4 : Performance par Score Hydre — simples uniquement, jamais utilisé pour re-classer la sélection.
      if (!p.est_combine) {
        if (p.score === null || p.score === undefined) {
          nbSansScore += 1;
        } else {
          const sc = p.score;
          let trancheScore = '';
          if (sc < 20) trancheScore = '0 - 20';
          else if (sc < 40) trancheScore = '20 - 40';
          else if (sc < 60) trancheScore = '40 - 60';
          else if (sc < 80) trancheScore = '60 - 80';
          else trancheScore = '80 - 100';
          const ss = statsScoreHydre[trancheScore];
          ss.mise += miseCash; ss.pnl += p.pnl; ss.count += 1;
          if (p.resultat === 'GAGNE') ss.wins += 1;
          if (clvPari !== null) { ss.clvSum += clvPari; ss.clvCount += 1; }
        }
      }
    });

    // 🆕 DASHBOARD CASH / FREEBET : cette 2e boucle tourne TOUJOURS sur historyStats en
    // entier (jamais filtrée par dashInclureFreebets) car elle alimente exclusivement les
    // statistiques dédiées aux combinés Freebet, qui doivent rester disponibles quel que
    // soit le mode d'affichage choisi pour les statistiques générales ci-dessus.
    historyStats.forEach(p => {
      const typeKey = p.est_combine ? 'COMBINE' : 'SIMPLE';
      statsTypePari[typeKey].mise += p.mise; statsTypePari[typeKey].pnl += p.pnl; statsTypePari[typeKey].count += 1;
      if (p.resultat === 'GAGNE') statsTypePari[typeKey].wins += 1;

      if (p.est_combine && p.taille_combine) {
        const t = String(p.taille_combine);
        if (!statsTailleCombine[t]) statsTailleCombine[t] = { mise: 0, pnl: 0, count: 0, wins: 0 };
        statsTailleCombine[t].mise += p.mise; statsTailleCombine[t].pnl += p.pnl; statsTailleCombine[t].count += 1;
        if (p.resultat === 'GAGNE') statsTailleCombine[t].wins += 1;
      }

      // 🆕 V2.1 §5/§7/§8 : combinés Freebet uniquement (jamais les paris simples, jamais dupliqué —
      // un combiné reste un seul ticket, comme dans statsTailleCombine ci-dessus).
      if (p.est_combine) {
        nbCombinesFreebet += 1;
        freebetsUtilisees += p.mise;
        gainsFreebet += p.retour;
        profitFreebet += p.pnl;

        if (p.taille_combine) {
          let bucketTaille = '';
          if (p.taille_combine <= 2) bucketTaille = '2 sélections';
          else if (p.taille_combine === 3) bucketTaille = '3 sélections';
          else if (p.taille_combine === 4) bucketTaille = '4 sélections';
          else bucketTaille = '5 sélections et +';
          const tf = statsTailleFreebet[bucketTaille];
          tf.mise += p.mise; tf.retour += p.retour; tf.pnl += p.pnl; tf.count += 1;
          if (p.resultat === 'GAGNE') tf.wins += 1;
        } else {
          nbSansTailleFreebet += 1;
        }

        detailCombinesFreebet.push({
          id: p.id, date: p.date, taille: p.taille_combine, coteReelle: p.cote,
          coteCalculee: p.cote_totale_calculee_combine, resultat: p.resultat, pnl: p.pnl, mise: p.mise,
          score: p.score_combine, risque: p.risque_combine, proba: p.proba_combine, edge: p.edge_combine
        });
      }
    });

    const dPnl = tRetour - tMise;
    const dRoi = tMise > 0 ? (dPnl / tMise) * 100 : 0;
    const dRoc = finances.total > 0 ? (dPnl / finances.total) * 100 : 0;
    const dWinrate = historyStatsGenerales.length > 0 ? (tGagnes / historyStatsGenerales.length) * 100 : 0;
    const dCoteMoy = historyStatsGenerales.length > 0 ? (tCotes / historyStatsGenerales.length) : 0;
    const dClvMoy = countClv > 0 ? (tClv / countClv) * 100 : 0;

    const pnlJour = tRetourJour - tMiseJour;
    const roiJour = tMiseJour > 0 ? (pnlJour / tMiseJour) * 100 : 0;
    const pnlSemaine = tRetourSemaine - tMiseSemaine;
    const roiSemaine = tMiseSemaine > 0 ? (pnlSemaine / tMiseSemaine) * 100 : 0;

    Object.keys(statsBooks).forEach(b => {
      statsBooks[b].WinRate = statsBooks[b].Count > 0 ? (statsBooks[b].Wins / statsBooks[b].Count * 100).toFixed(1) : 0;
      statsBooks[b].ROI = statsBooks[b].Mise > 0 ? (statsBooks[b].PnL / statsBooks[b].Mise * 100).toFixed(2) : 0;
    });

    Object.keys(statsTypePari).forEach(t => {
      const d = statsTypePari[t];
      d.WinRate = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : 0;
      d.ROI = d.mise > 0 ? (d.pnl / d.mise * 100).toFixed(2) : 0;
    });
    Object.keys(statsTailleCombine).forEach(t => {
      const d = statsTailleCombine[t];
      d.WinRate = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : 0;
      d.ROI = d.mise > 0 ? (d.pnl / d.mise * 100).toFixed(2) : 0;
    });

    // 🆕 §5/§6/§7 : moyennes CLV par tranche (cote/edge/ligue) + winrate/ROI par tranche.
    Object.keys(statsCotes).forEach(t => {
      const d = statsCotes[t];
      d.WinRate = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : 0;
      d.ROI = d.mise > 0 ? (d.pnl / d.mise * 100).toFixed(2) : 0;
      d.ClvMoy = d.clvCount > 0 ? (d.clvSum / d.clvCount).toFixed(2) : null;
    });
    Object.keys(statsEdge).forEach(t => {
      const d = statsEdge[t];
      d.WinRate = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : 0;
      d.ROI = d.mise > 0 ? (d.pnl / d.mise * 100).toFixed(2) : 0;
      d.ClvMoy = d.clvCount > 0 ? (d.clvSum / d.clvCount).toFixed(2) : null;
    });
    Object.keys(statsClv).forEach(t => {
      const d = statsClv[t];
      d.WinRate = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : 0;
      d.ROI = d.mise > 0 ? (d.pnl / d.mise * 100).toFixed(2) : 0;
    });
    Object.keys(statsLigue).forEach(l => {
      const d = statsLigue[l];
      d.ClvMoy = d.clvCount > 0 ? (d.clvSum / d.clvCount).toFixed(2) : null;
    });

    // 🆕 V2.1 §3/§4/§7 : finalisation jour de la semaine / Score Hydre / taille de combiné Freebet.
    Object.keys(statsJourSemaine).forEach(j => {
      const d = statsJourSemaine[j];
      d.WinRate = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : null;
      d.ROI = d.count > 0 && d.mise > 0 ? (d.pnl / d.mise * 100).toFixed(2) : null;
      d.ClvMoy = d.clvCount > 0 ? (d.clvSum / d.clvCount).toFixed(2) : null;
    });
    Object.keys(statsScoreHydre).forEach(t => {
      const d = statsScoreHydre[t];
      d.WinRate = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : null;
      d.ROI = d.count > 0 && d.mise > 0 ? (d.pnl / d.mise * 100).toFixed(2) : null;
      d.ClvMoy = d.clvCount > 0 ? (d.clvSum / d.clvCount).toFixed(2) : null;
    });
    Object.keys(statsTailleFreebet).forEach(t => {
      const d = statsTailleFreebet[t];
      d.WinRate = d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : null;
      d.ROI = d.count > 0 && d.mise > 0 ? (d.pnl / d.mise * 100).toFixed(2) : null;
    });

    // 🆕 V2.1 §1 : séries de gains/pertes — uniquement sur les résultats définitifs GAGNE/PERDU,
    // ordonnés CHRONOLOGIQUEMENT (date/heure réelle de règlement, pas l'ordre de création/
    // modification des objets), dans le respect des filtres actuels du Dashboard.
    const streakSource = [...historyStatsGenerales]
      .filter(p => p.resultat === 'GAGNE' || p.resultat === 'PERDU')
      .sort((a, b) => (a.date_reglement || a.date).localeCompare(b.date_reglement || b.date));
    let longestWin = 0, longestLose = 0, runType = null, runLen = 0;
    streakSource.forEach(p => {
      const isWin = p.resultat === 'GAGNE';
      if (runType === (isWin ? 'W' : 'L')) { runLen += 1; }
      else { runType = isWin ? 'W' : 'L'; runLen = 1; }
      if (runType === 'W') longestWin = Math.max(longestWin, runLen);
      else longestLose = Math.max(longestLose, runLen);
    });
    const currentWin = runType === 'W' ? runLen : 0;
    const currentLose = runType === 'L' ? runLen : 0;

    // 🆕 V2.1 §2 : profit moyen par pari — indicateur secondaire.
    const profitMoyenParPari = historyStatsGenerales.length > 0 ? dPnl / historyStatsGenerales.length : null;

    // 🆕 V2.1 §5 : Freebet Efficiency — combinés uniquement, jamais les simples (déjà comptés ailleurs).
    const valeurGenereeParEuroFreebet = freebetsUtilisees > 0 ? gainsFreebet / freebetsUtilisees : null;

    // 🆕 §2 : CLV détaillée — médiane, % positive, min, max (sur les paris avec cote de clôture connue).
    const clvSorted = [...clvValues].sort((a, b) => a - b);
    let clvMediane = null;
    if (clvSorted.length > 0) {
      const mid = Math.floor(clvSorted.length / 2);
      clvMediane = clvSorted.length % 2 === 0 ? (clvSorted[mid - 1] + clvSorted[mid]) / 2 : clvSorted[mid];
    }
    const clvPositivePct = clvSorted.length > 0 ? (clvSorted.filter(v => v > 0).length / clvSorted.length) * 100 : null;
    const clvMin = clvSorted.length > 0 ? clvSorted[0] : null;
    const clvMax = clvSorted.length > 0 ? clvSorted[clvSorted.length - 1] : null;

    const chronoHistory = [...historyStatsGenerales].reverse();
    const grouped = {};
    let cumulativePnl = 0;

    chronoHistory.forEach(p => {
       const period = formaterPeriode(p.date, dashGranularite);
       if(!grouped[period]) grouped[period] = { period, pnlPeriod: 0, pnlCumul: 0 };
       grouped[period].pnlPeriod += p.pnl;
       cumulativePnl += p.pnl;
       grouped[period].pnlCumul = cumulativePnl;
    });
    const chartData = Object.values(grouped);

    // 🆕 §8 : Drawdown calculé à partir de la même courbe de profit cumulé que le graphique existant.
    let peak = 0, maxDrawdown = 0;
    const drawdownData = chartData.map(pt => {
      if (pt.pnlCumul > peak) peak = pt.pnlCumul;
      const dd = pt.pnlCumul - peak; // toujours ≤ 0
      if (dd < maxDrawdown) maxDrawdown = dd;
      return { period: pt.period, drawdown: parseFloat(dd.toFixed(2)) };
    });
    const drawdownActuel = drawdownData.length > 0 ? drawdownData[drawdownData.length - 1].drawdown : 0;

    // 🆕 CORRECTIF STOCKAGE (§3/§4/§6) : "matchs analysés" = matchs uniques déjà traités par le système
    // depuis le début de la saison actuelle (calculé côté backend à la volée depuis Fixtures_A_Venir,
    // plus de journal d'analyses). Toujours filtré par les mêmes filtres période/ligue du Dashboard
    // (sur la date réelle du match, pas la date du pari), avec repli sur le total saison si aucune
    // période n'est choisie — cohérent avec l'objectif "100 matchs analysés / 15 sélectionnés / 15%".
    let matchsAnalysesListe = dashboardData.matchs_analyses || [];
    if (dashDateDebut) matchsAnalysesListe = matchsAnalysesListe.filter(a => a.date >= dashDateDebut);
    if (dashDateFin) matchsAnalysesListe = matchsAnalysesListe.filter(a => a.date <= dashDateFin);
    if (dashFiltreLigue) matchsAnalysesListe = matchsAnalysesListe.filter(a => (a.div || "Inconnu") === dashFiltreLigue);
    const matchsAnalyses = matchsAnalysesListe.length;
    const matchsSelectionnes = historyStats.length;
    const tauxSelection = matchsAnalyses > 0 ? (matchsSelectionnes / matchsAnalyses) * 100 : null;

    return {
      // 🆕 DASHBOARD CASH / FREEBET
      modeStatsFreebet: dashInclureFreebets ? 'SIMPLES_PLUS_FREEBETS' : 'SIMPLES_UNIQUEMENT',
      kpis: { pnl: dPnl.toFixed(2), roi: dRoi.toFixed(2), roc: dRoc.toFixed(2), winrate: dWinrate.toFixed(1), cote: dCoteMoy.toFixed(2), count: historyStatsGenerales.length, clv: dClvMoy.toFixed(2) },
      kpisJour: { pnl: pnlJour.toFixed(2), roi: roiJour.toFixed(2) },
      kpisSemaine: { pnl: pnlSemaine.toFixed(2), roi: roiSemaine.toFixed(2) },
      chartData: chartData,
      tableData: history,
      historique: history,
      statsIssue: statsIssue,
      statsCotes: statsCotes,
      statsLigue: statsLigue,
      statsTypePari: statsTypePari,
      statsTailleCombine: statsTailleCombine,
      statsEdge: statsEdge,
      nbSansEdge: nbSansEdge,
      statsClv: statsClv,
      clvDetail: { moyenne: dClvMoy, mediane: clvMediane, positivePct: clvPositivePct, min: clvMin, max: clvMax, count: clvSorted.length },
      scatterClvPnl: scatterClvPnl,
      drawdownData: drawdownData,
      drawdownActuel: drawdownActuel,
      drawdownMax: maxDrawdown,
      funnel: { matchsAnalyses, matchsSelectionnes, tauxSelection },
      liguesDisponibles: liguesDisponibles,
      stats_bookmakers: statsBooks,
      // 🆕 V2.1
      streaks: { currentWin, currentLose, longestWin, longestLose },
      profitMoyenParPari: profitMoyenParPari,
      statsJourSemaine: statsJourSemaine,
      statsScoreHydre: statsScoreHydre,
      nbSansScore: nbSansScore,
      freebetEfficiency: { nbCombines: nbCombinesFreebet, freebetsUtilisees, gains: gainsFreebet, profit: profitFreebet, valeurParEuro: valeurGenereeParEuroFreebet },
      statsTailleFreebet: statsTailleFreebet,
      nbSansTailleFreebet: nbSansTailleFreebet,
      detailCombinesFreebet: detailCombinesFreebet
    };
  };

  const dashCalculs = genererDashboardFiltre();

  const copierRapportDashboardPourIA = () => {
    if (!dashCalculs) return;
    let texte = `🤖 RAPPORT DE BATAILLE HYDRE (DASHBOARD)\n=========================================\n`;
    texte += `📈 KPI GLOBAUX\n`;
    texte += `- PARIS JOUÉS : ${dashCalculs.kpis.count}\n`;
    texte += `- PROFIT NET : ${dashCalculs.kpis.pnl} €\n`;
    texte += `- R.O.I : ${dashCalculs.kpis.roi} %\n`;
    texte += `- CLV MOYENNE : ${dashCalculs.kpis.clv} %\n\n`;

    texte += `🎯 PAR ISSUE\n`;
    Object.keys(dashCalculs.statsIssue).sort().forEach(issue => {
       const d = dashCalculs.statsIssue[issue];
       if(d.count > 0) {
           const roi = ((d.pnl / d.mise) * 100).toFixed(2);
           const wr = ((d.wins / d.count) * 100).toFixed(1);
           texte += `- Issue ${issue} | Vol: ${d.count} | Win: ${wr}% | PnL: ${d.pnl.toFixed(2)}€ | ROI: ${roi}%\n`;
       }
    });

    texte += `\n📊 PAR COTES\n`;
    Object.keys(dashCalculs.statsCotes).forEach(tranche => {
       const d = dashCalculs.statsCotes[tranche];
       if(d.count > 0) {
           const roi = ((d.pnl / d.mise) * 100).toFixed(2);
           const wr = ((d.wins / d.count) * 100).toFixed(1);
           texte += `- Tranche ${tranche} | Vol: ${d.count} | Win: ${wr}% | PnL: ${d.pnl.toFixed(2)}€ | ROI: ${roi}%\n`;
       }
    });

    navigator.clipboard.writeText(texte);
    alert("✅ Rapport copié dans le presse-papier ! Tu n'as plus qu'à me le coller.");
  };

  const genererReleve = () => {
    if (!semaineReleve) return [];

    const fluxTreso = ledgerBankroll
        .filter(l => l.type && l.date && getWeekNumber(new Date(l.date.split(' ')[0])) === semaineReleve)
        .map(l => ({ id: l.id, date: l.date, type: l.type, label: l.label, montant: l.montant, balance: l.balance }));

    const fluxParis = (dashboardData?.historique || [])
        .filter(p => getWeekNumber(new Date(p.date)) === semaineReleve && (p.resultat === 'GAGNE' || p.resultat === 'PERDU'))
        .map(p => ({ id: p.id, date: p.date, type: `PARI ${p.resultat}`, label: `Pari: ${p.match} (${p.choix})`, montant: p.pnl, balance: 'Auto' }));

    return [...fluxTreso, ...fluxParis].sort((a, b) => a.date.localeCompare(b.date));
  };
  const donneesReleve = genererReleve();

  // LOGIQUE DU COMMAND CENTER (HOME)
  const nbARemplir = matchs.filter(m => m.statut === 'A_REMPLIR').length;
  const nbAnalyse = matchs.filter(m => m.statut === 'ANALYSE').length;
  const nbJoue = matchs.filter(m => m.statut === 'JOUE').length;
  const nbPerimes = matchs.filter(m => {
    const ageSec = (new Date().getTime() / 1000) - (m.derniere_analyse || 0);
    return m.statut === 'ANALYSE' && m.derniere_analyse > 0 && ageSec > 7200;
  });

  const matchsDuJourJoues = matchs.filter(m => m.date.startsWith(todayStr) && m.statut === 'JOUE');
  const matchsEnCoursJoues = matchs.filter(m => {
    const matchTime = new Date(ajusterHeure(m.date).replace(' ', 'T')).getTime();
    const nowTime = new Date().getTime();
    const diffMin = (nowTime - matchTime) / 60000;
    return diffMin >= 0 && diffMin <= 110 && m.statut === 'JOUE';
  });

  const matchsFiltres = matchs.filter(m => {
    if (m.statut !== activeTab) return false;
    const d = m.date.split(' ')[0];
    if (filtreDateDebut && d < filtreDateDebut) return false;
    if (filtreDateFin && d > filtreDateFin) return false;
    return true;
  });

  // 🆕 REFONTE COMMAND CENTER — dérivés du scanner pour le poste de pilotage
  const scannerMatchs = scannerData?.matchs || [];
  const paresSelectionnes = scannerMatchs.filter(m => m.statut === 'SELECTIONNE');
  const paresPotables = scannerMatchs.filter(m => m.statut === 'POTABLE');
  const paresNonConformes = scannerMatchs.filter(m => m.statut === 'NON_CONFORME');
  const nbPotablesTotal = paresSelectionnes.length + paresPotables.length;
  const scoreMoyenSelection = paresSelectionnes.length > 0
    ? (paresSelectionnes.reduce((acc, m) => acc + (m.score || 0), 0) / paresSelectionnes.length)
    : 0;
  const expositionMaxActuelle = scannerData?.exposition_max ?? PROFILS_EXPO_FRONT[profilRisque];
  const expositionUtilisee = scannerData?.exposition_utilisee_pct ?? 0;
  const expositionRatio = expositionMaxActuelle > 0 ? Math.min(100, (expositionUtilisee / expositionMaxActuelle) * 100) : 0;
  const montantEngageScanner = paresSelectionnes.reduce((acc, m) => acc + (m.mise_euros || 0), 0);

  const getCouleurExposition = (ratio) => {
    if (ratio >= 90) return '#ff4444';
    if (ratio >= 60) return '#ffcc00';
    return '#00ffcc';
  };

  const getLibelleQualite = (score) => {
    if (score === 0) return { label: 'AUCUNE DONNÉE', color: '#666' };
    if (score >= 75) return { label: 'JOURNÉE EXCELLENTE', color: '#00ffcc' };
    if (score >= 55) return { label: 'JOURNÉE CORRECTE', color: '#ffcc00' };
    return { label: 'JOURNÉE PAUVRE', color: '#ff4444' };
  };
  const qualiteJournee = getLibelleQualite(scoreMoyenSelection);

  const changerOngletTrading = (nouvelOnglet) => { setActiveTab(nouvelOnglet); setResultat(null); setExpandedId(null); setEditModeId(null); };
  const changerVueGlobale = (nouvelleVue) => { setVueActuelle(nouvelleVue); setResultat(null); setExpandedId(null); setEditModeId(null); };

  const pourcentageEngageCash = finances.total > 0 ? ((finances.engage / finances.total) * 100).toFixed(1) : 0.0;
  const pourcentageEngageFreebet = finances.freebets.total_acquis > 0 ? ((finances.freebets.engage / finances.freebets.total_acquis) * 100).toFixed(1) : 0.0;

  const getSortedKeys = (dataObj, tableKey) => {
    const config = sortConfig[tableKey];
    return Object.keys(dataObj).sort((a, b) => {
      const dA = dataObj[a];
      const dB = dataObj[b];

      const getVal = (obj, key) => {
        if (key === 'name') return 0;
        if (key === 'count') return obj.count;
        if (key === 'pnl') return obj.pnl;
        if (key === 'roi') return obj.mise > 0 ? (obj.pnl / obj.mise) : -999;
        if (key === 'winrate') return obj.count > 0 ? (obj.wins / obj.count) : 0;
        if (key === 'clv') return (obj.ClvMoy !== null && obj.ClvMoy !== undefined) ? parseFloat(obj.ClvMoy) : -999;
        return 0;
      };

      const valA = getVal(dA, config.key);
      const valB = getVal(dB, config.key);

      if (config.key === 'name') {
        return config.dir === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
      }

      return config.dir === 'asc' ? valA - valB : valB - valA;
    });
  };

  const handleSort = (table, key) => {
    setSortConfig(prev => ({
      ...prev,
      [table]: { key, dir: prev[table].key === key && prev[table].dir === 'desc' ? 'asc' : 'desc' }
    }));
  };

  const renderSortIcon = (table, key) => {
    if (sortConfig[table].key !== key) return <span style={{color: '#444', marginLeft: '5px'}}>↕</span>;
    return sortConfig[table].dir === 'asc' ? <span style={{color: '#00ffcc', marginLeft: '5px'}}>▲</span> : <span style={{color: '#00ffcc', marginLeft: '5px'}}>▼</span>;
  };

  if (!estConnecte) {
    return (
      <div style={{ backgroundColor: '#000', height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: '#00ffcc', fontFamily: 'monospace' }}>
        <h1 style={{ fontSize: '2.5rem', marginBottom: '10px', letterSpacing: '5px' }}>SYSTEME CHÈVRE BLEUE</h1>
        <p style={{ color: '#555', marginBottom: '30px' }}>PROTOCOLE DE SÉCURITÉ ACTIF</p>
        <form onSubmit={verifierMotDePasse} style={{ display: 'flex', flexDirection: 'column', gap: '15px', width: '300px' }}>
          <input type="password" value={inputMotDePasse} onChange={(e) => setInputMotDePasse(e.target.value)} placeholder="Clé Opérateur" style={{ padding: '15px', backgroundColor: '#111', color: '#fff', border: '1px solid #333', borderRadius: '4px', textAlign: 'center', fontSize: '1.2rem', letterSpacing: '3px' }} autoFocus />
          <button type="submit" style={{ padding: '15px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '1.1rem' }}>DÉVERROUILLER</button>
          {erreurConnexion && <p style={{ color: '#ff4444', textAlign: 'center', margin: 0 }}>{erreurConnexion}</p>}
        </form>
      </div>
    );
  }

  if (!finances.initialise) {
    return (
      <div style={{ backgroundColor: '#121212', color: '#fff', minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        <h1 style={{ color: '#00ffcc' }}>🏦 INITIALISATION BASE DE DONNEES</h1>
        <div style={{ display: 'flex', gap: '10px' }}><input type="number" value={inputCapital} onChange={e => setInputCapital(e.target.value)} style={{ padding: '15px' }} /><button onClick={initialiserBankroll} disabled={estViewer} style={{ padding: '15px', backgroundColor: estViewer ? '#333' : '#00ffcc', cursor: estViewer ? 'not-allowed' : 'pointer' }}>VERROUILLER</button></div>
      </div>
    )
  }

  return (
    <div style={{ backgroundColor: '#121212', color: '#ffffff', minHeight: '100vh', padding: '20px', fontFamily: 'monospace' }}>

      {/* HEADER SUPÉRIEUR */}
      <div style={{ display: 'flex', gap: '20px', marginBottom: '30px' }}>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'space-around', backgroundColor: '#1a1a1a', padding: '15px', borderRadius: '8px', border: '1px solid #333', borderBottom: '3px solid #00ffcc', boxShadow: '0 4px 15px rgba(0,255,204,0.05)' }}>
          <div style={{ textAlign: 'center' }}><div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '5px' }}>💶 CASH BRUT</div><div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#fff' }}>{finances.total.toFixed(2)} €</div></div>
          <div style={{ textAlign: 'center', borderLeft: '1px solid #333', borderRight: '1px solid #333', padding: '0 20px' }}><div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '5px' }}>CASH ENGAGÉ</div><div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#ffcc00' }}>{finances.engage.toFixed(2)} € <span style={{ fontSize: '0.8rem', color: '#888' }}>({pourcentageEngageCash}%)</span></div></div>
          <div style={{ textAlign: 'center' }}><div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '5px' }}>CASH DISPO.</div><div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: finances.disponible > 0 ? '#00ffcc' : '#ff4444' }}>{finances.disponible.toFixed(2)} €</div></div>
        </div>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'space-around', backgroundColor: '#1a1a1a', padding: '15px', borderRadius: '8px', border: '1px solid #333', borderBottom: '3px solid #ff4444', boxShadow: '0 4px 15px rgba(255,68,68,0.05)' }}>
          <div style={{ textAlign: 'center' }}><div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '5px' }}>🎁 FB ACQUIS</div><div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#fff' }}>{finances.freebets.total_acquis.toFixed(2)} €</div></div>
          <div style={{ textAlign: 'center', borderLeft: '1px solid #333', borderRight: '1px solid #333', padding: '0 20px' }}><div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '5px' }}>FB ENGAGÉ</div><div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#ffcc00' }}>{finances.freebets.engage.toFixed(2)} € <span style={{ fontSize: '0.8rem', color: '#888' }}>({pourcentageEngageFreebet}%)</span></div></div>
          <div style={{ textAlign: 'center' }}><div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '5px' }}>FB DISPO.</div><div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: finances.freebets.disponible > 0 ? '#ff4444' : '#888' }}>{finances.freebets.disponible.toFixed(2)} €</div></div>
        </div>
      </div>

      {/* MENU NAVIGATION */}
      <div className="flex flex-wrap justify-center gap-3 mb-8 border-b-2 border-[#333] pb-4" style={{ alignItems: 'center' }}>
        <button onClick={() => changerVueGlobale('HOME')} style={vueActuelle === 'HOME' ? menuActive : menuInactive}>🏠 COMMAND CENTER</button>
        <button onClick={() => changerVueGlobale('TRADING')} style={vueActuelle === 'TRADING' ? menuActive : menuInactive}>⚡ TERMINAL</button>
        <button onClick={() => changerVueGlobale('DASHBOARD')} style={vueActuelle === 'DASHBOARD' ? menuActive : menuInactive}>📊 DASHBOARD</button>
        <button onClick={() => changerVueGlobale('BANKROLL')} style={vueActuelle === 'BANKROLL' ? menuActive : menuInactive}>🏦 BANKROLL & FLUX</button>
        <button onClick={() => changerVueGlobale('DATA')} style={vueActuelle === 'DATA' ? menuActive : menuInactive}>🗄️ SYSTÈME & DATA</button>
        {/* 🆕 Badge de rôle : rappel visuel que le VIEWER est en lecture seule (la vraie
            protection est côté backend, ceci n'est qu'une indication à l'utilisateur). */}
        <span style={{
          marginLeft: '10px', padding: '6px 12px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 'bold',
          color: estViewer ? '#ffcc00' : '#00ffcc', border: `1px solid ${estViewer ? '#ffcc00' : '#00ffcc'}`
        }}>
          {estViewer ? '👁️ VIEWER — LECTURE SEULE' : '🔑 MASTER'}
        </span>
        <button onClick={seDeconnecter} style={{ padding: '6px 12px', backgroundColor: 'transparent', color: '#888', border: '1px solid #444', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem' }}>Déconnexion</button>
      </div>

      {/* VUE BANKROLL */}
      {vueActuelle === 'BANKROLL' && (
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          <h2 style={{ color: '#00ffcc', borderBottom: '1px solid #333', paddingBottom: '10px', marginBottom: '30px' }}>🏦 GESTION DES FLUX FINANCIERS</h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginBottom: '30px' }}>
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #00ffcc' }}>
              <div style={{ color: '#00ffcc', fontSize: '0.85rem', marginBottom: '10px', fontWeight: 'bold' }}>⚙️ PROFIL DE RISQUE</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[['PRUDENT', '🟢 Prudent', '10%'], ['EQUILIBRE', '🟡 Équilibré', '20%'], ['AGRESSIF', '🔴 Agressif', '30%']].map(([val, label, exp]) => (
                  <button key={val} onClick={() => changerProfilRisque(val)} disabled={estViewer} style={{ flex: 1, padding: '10px 6px', backgroundColor: profilRisque === val ? '#00ffcc' : '#121212', color: profilRisque === val ? '#000' : '#888', border: '1px solid #00ffcc', borderRadius: '4px', cursor: estViewer ? 'not-allowed' : 'pointer', fontSize: '0.78rem', fontWeight: 'bold', lineHeight: '1.4', opacity: estViewer ? 0.5 : 1 }}>{label}<br />exposition max {exp}</button>
                ))}
              </div>
            </div>
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333' }}>
              <div style={{ color: '#888', fontSize: '0.85rem', marginBottom: '8px', fontWeight: 'bold' }}>📊 EXPOSITION MAX AUTORISÉE</div>
              <div style={{ fontSize: '1.7rem', fontWeight: 'bold', color: '#fff' }}>{expositionMaxActuelle} %</div>
              <div style={{ color: '#666', fontSize: '0.75rem', marginTop: '6px' }}>Soit {(finances.total * (expositionMaxActuelle / 100)).toFixed(2)} € maximum engagés simultanément sur la bankroll actuelle.</div>
            </div>
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #ffcc00' }}>
              <div style={{ color: '#ffcc00', fontSize: '0.85rem', marginBottom: '8px', fontWeight: 'bold' }}>🎯 MISE UNITAIRE ACTUELLE</div>
              <div style={{ fontSize: '1.7rem', fontWeight: 'bold', color: '#ffcc00' }}>{scannerData?.mise_unitaire_pct || 0} %</div>
              <div style={{ color: '#666', fontSize: '0.75rem', marginTop: '6px' }}>{scannerData?.nb_selectionnes || 0} pari(s) sélectionné(s) actuellement (mise identique pour tous, min 0.5%, max 3%).</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px', marginBottom: '30px' }}>
            <div style={{ backgroundColor: '#1a1a1a', padding: '25px', borderRadius: '8px', border: '1px solid #333', height: '400px' }}>
                <h3 style={{ color: '#aaa', margin: '0 0 15px 0', fontSize: '1.1rem' }}>📈 CROISSANCE DU CAPITAL BRUT (CASH)</h3>
                <ResponsiveContainer width="100%" height="85%">
                    <AreaChart data={ledgerBankroll}>
                        <defs><linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#00ffcc" stopOpacity={0.3}/><stop offset="95%" stopColor="#00ffcc" stopOpacity={0}/></linearGradient></defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                        <XAxis dataKey="date" stroke="#888" fontSize={12} />
                        <YAxis stroke="#888" domain={['auto', 'auto']} />
                        <Tooltip contentStyle={{ backgroundColor: '#111', border: '1px solid #333', color: '#fff' }} itemStyle={{ color: '#00ffcc' }} labelStyle={{ color: '#fff' }} />
                        <Area type="stepAfter" dataKey="balance" stroke="#00ffcc" strokeWidth={3} fillOpacity={1} fill="url(#colorBalance)" />
                    </AreaChart>
                </ResponsiveContainer>
            </div>

            <div style={{ backgroundColor: '#1a1a1a', padding: '25px', borderRadius: '8px', border: '1px solid #333', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <h3 style={{ color: '#aaa', margin: '0', fontSize: '1.1rem' }}>🏛️ SAISIE DES FLUX</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  <div style={{ backgroundColor: '#121212', padding: '15px', borderRadius: '5px', border: '1px solid #00ffcc' }}><div style={{ color: '#00ffcc', fontWeight: 'bold', marginBottom: '10px' }}>📥 DÉPOSER DU CASH</div><div style={{ display: 'flex', gap: '10px' }}><input type="text" placeholder="Libellé" value={labelDepot} onChange={e => setLabelDepot(e.target.value)} style={{...inputStyle, flex: 2}} /><input type="number" step="10" placeholder="€" value={montantDepot} onChange={e => setMontantDepot(e.target.value)} style={{...inputStyle, flex: 1}} /><button onClick={handleDepot} disabled={estViewer} style={{ padding: '10px 20px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: estViewer ? 'not-allowed' : 'pointer', opacity: estViewer ? 0.5 : 1 }}>VALIDER</button></div></div>
                  <div style={{ backgroundColor: '#121212', padding: '15px', borderRadius: '5px', border: '1px solid #ffcc00' }}><div style={{ color: '#ffcc00', fontWeight: 'bold', marginBottom: '10px' }}>📤 RETIRER DU CASH</div><div style={{ display: 'flex', gap: '10px' }}><input type="text" placeholder="Libellé" value={labelRetrait} onChange={e => setLabelRetrait(e.target.value)} style={{...inputStyle, flex: 2}} /><input type="number" step="10" placeholder="€" value={montantRetrait} onChange={e => setMontantRetrait(e.target.value)} style={{...inputStyle, flex: 1}} /><button onClick={handleRetrait} disabled={estViewer} style={{ padding: '10px 20px', backgroundColor: '#ffcc00', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: estViewer ? 'not-allowed' : 'pointer', opacity: estViewer ? 0.5 : 1 }}>VALIDER</button></div></div>
                  <div style={{ backgroundColor: '#121212', padding: '15px', borderRadius: '5px', border: '1px solid #ff4444' }}><div style={{ color: '#ff4444', fontWeight: 'bold', marginBottom: '10px' }}>🎁 AJOUTER DES FREEBETS</div><div style={{ display: 'flex', gap: '10px' }}><input type="text" placeholder="Libellé" value={labelFreebet} onChange={e => setLabelFreebet(e.target.value)} style={{...inputStyle, flex: 2}} /><input type="number" step="5" placeholder="€" value={montantFreebet} onChange={e => setMontantFreebet(e.target.value)} style={{...inputStyle, flex: 1}} /><button onClick={handleAjoutFreebet} disabled={estViewer} style={{ padding: '10px 20px', backgroundColor: '#ff4444', color: '#fff', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: estViewer ? 'not-allowed' : 'pointer', opacity: estViewer ? 0.5 : 1 }}>CRÉDITER</button></div></div>
                </div>
            </div>
          </div>

          <div style={{ backgroundColor: '#1a1a1a', padding: '25px', borderRadius: '8px', border: '1px solid #444', marginBottom: '30px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', marginBottom: '30px', flexWrap: 'wrap', gap: '15px' }}>
             <h2 style={{ color: '#00ffcc', margin: 0 }}>📊 ANALYSE DES PERFORMANCES</h2>
             <div style={{ display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input type="date" value={dashDateDebut} onChange={e => setDashDateDebut(e.target.value)} style={dateInputStyle} />
                <input type="date" value={dashDateFin} onChange={e => setDashDateFin(e.target.value)} style={dateInputStyle} />
                <button onClick={copierRapportDashboardPourIA} style={{ padding: '10px 15px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: 'pointer', marginLeft: '10px' }}>📋 COPIER POUR L'IA</button>
                <button onClick={() => window.print()} style={{ padding: '10px 15px', backgroundColor: '#333', color: '#fff', border: '1px solid #666', borderRadius: '4px', cursor: 'pointer', marginLeft: '10px' }}>🖨️ PDF</button>
             </div>
          </div>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontFamily: 'monospace' }}>
              <thead><tr style={{ borderBottom: '1px solid #444', color: '#888' }}><th style={{ padding: '12px' }}>Date</th><th style={{ padding: '12px' }}>Type d'Opération</th><th style={{ padding: '12px' }}>Libellé / Justificatif</th><th style={{ padding: '12px', textAlign: 'right' }}>Montant Net</th></tr></thead>
              <tbody>
                {donneesReleve.map(flux => (
                    <tr key={flux.id} style={{ borderBottom: '1px solid #222' }}><td style={{ padding: '12px', color: '#888' }}>{flux.date}</td><td style={{ padding: '12px', fontWeight: 'bold', color: flux.type.includes('DEPOT') || flux.type.includes('GAGNE') ? '#00ffcc' : '#ff4444' }}>{flux.type}</td><td style={{ padding: '12px', color: '#fff' }}>{flux.label}</td><td style={{ padding: '12px', textAlign: 'right', fontWeight: 'bold' }}><Colorize val={flux.montant.toFixed(2)} isCurrency={true} /></td></tr>
                ))}
                {donneesReleve.length === 0 && <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px', color: '#666' }}>Aucun flux financier enregistré sur cette semaine.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{ backgroundColor: '#1a1a1a', padding: '25px', borderRadius: '8px', border: '1px solid #333' }}>
            <h3 style={{ color: '#00ffcc', marginTop: 0 }}>🗂️ HISTORIQUE COMPLET DES MOUVEMENTS (persisté en base — ne se perd plus au refresh)</h3>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc' }}>
              <thead><tr style={{ borderBottom: '1px solid #444', color: '#888' }}><th style={{ padding: '12px' }}>Date</th><th style={{ padding: '12px' }}>Type</th><th style={{ padding: '12px' }}>Libellé</th><th style={{ padding: '12px', textAlign: 'right' }}>Montant</th><th style={{ padding: '12px', textAlign: 'right' }}>Solde Cash</th></tr></thead>
              <tbody>
                {ledgerBankroll.map(flux => (
                  <tr key={flux.id} style={{ borderBottom: '1px solid #222' }}>
                    <td style={{ padding: '12px', color: '#888' }}>{flux.date}</td>
                    <td style={{ padding: '12px', fontWeight: 'bold', color: flux.type === 'DEPOT' || flux.type === 'INIT' ? '#00ffcc' : flux.type === 'RETRAIT' ? '#ff4444' : flux.type === 'FREEBET' ? '#ff8800' : '#fff' }}>{flux.type}</td>
                    <td style={{ padding: '12px', color: '#fff' }}>{flux.label}</td>
                    <td style={{ padding: '12px', textAlign: 'right', fontWeight: 'bold' }}><Colorize val={(flux.montant || 0).toFixed(2)} isCurrency={true} /></td>
                    <td style={{ padding: '12px', textAlign: 'right', color: '#888' }}>{typeof flux.balance === 'number' ? flux.balance.toFixed(2) + ' €' : flux.balance}</td>
                  </tr>
                ))}
                {ledgerBankroll.length === 0 && <tr><td colSpan="5" style={{ textAlign: 'center', padding: '20px', color: '#666' }}>Aucun mouvement enregistré pour l'instant.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VUE DATA */}
      {vueActuelle === 'DATA' && (
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          <h2 style={{ color: '#00ffcc', borderBottom: '1px solid #333', paddingBottom: '10px', marginBottom: '30px' }}>🗄️ CENTRE DE CONTRÔLE & BASE DE DONNÉES</h2>

          <div className="flex flex-col lg:flex-row gap-5 mb-8">
            <div className="w-full lg:w-2/5" style={{ backgroundColor: '#1a1a1a', padding: '25px', borderRadius: '8px', border: '1px solid #333' }}>
              <h3 style={{ color: '#aaa', margin: '0 0 20px 0', fontSize: '1.1rem' }}>📊 MÉTRIQUES SYSTÈME</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px', borderBottom: '1px dotted #333', paddingBottom: '5px' }}><span style={{ color: '#888' }}>Total Paris Archivés :</span><span style={{ fontWeight: 'bold', color: '#00ffcc' }}>{dashCalculs ? dashCalculs.kpis.count : 0}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px', borderBottom: '1px dotted #333', paddingBottom: '5px' }}><span style={{ color: '#888' }}>Matchs Sas 1 (Attente) :</span><span style={{ fontWeight: 'bold', color: '#fff' }}>{nbARemplir}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '15px', borderBottom: '1px dotted #333', paddingBottom: '5px' }}><span style={{ color: '#888' }}>Matchs Sas 2 (Analysés) :</span><span style={{ fontWeight: 'bold', color: '#fff' }}>{nbAnalyse}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '5px' }}><span style={{ color: '#888' }}>Cotes Périmées (supérieure 2h) :</span><span style={{ fontWeight: 'bold', color: nbPerimes.length > 0 ? '#ff4444' : '#00ffcc' }}>{nbPerimes.length}</span></div>
              <div style={{ marginTop: '20px', backgroundColor: '#2a1a1a', padding: '15px', borderRadius: '5px', border: '1px solid #ff4444' }}>
                <div style={{ color: '#ff4444', fontWeight: 'bold', marginBottom: '5px' }}>🚨 Purge d'Urgence</div>
                <button onClick={purgerMatchsPerimes} disabled={nbPerimes.length === 0 || estViewer} style={{ width: '100%', padding: '12px', backgroundColor: (nbPerimes.length > 0 && !estViewer) ? '#ff4444' : '#333', color: (nbPerimes.length > 0 && !estViewer) ? '#fff' : '#666', border: 'none', borderRadius: '4px', cursor: (nbPerimes.length > 0 && !estViewer) ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>{estViewer ? '🔒 Réservé au MASTER' : (nbPerimes.length > 0 ? `🔥 PURGER LES ${nbPerimes.length} MATCHS` : 'AUCUN MATCH À PURGER')}</button>
              </div>
            </div>

            <div className="w-full lg:w-3/5" style={{ backgroundColor: '#111', padding: '25px', borderRadius: '8px', border: '1px solid #00ffcc', display: 'flex', flexDirection: 'column' }}>
              <h3 style={{ color: '#00ffcc', margin: '0 0 15px 0', fontSize: '1.1rem', borderBottom: '1px solid #00ffcc44', paddingBottom: '10px' }}>🖥️ MONITEUR DE SYNCHRONISATION</h3>
              <div style={{ display: 'flex', gap: '15px', marginBottom: '20px' }}>
                <div style={{ flex: 1, backgroundColor: '#1a1a1a', padding: '15px', borderRadius: '8px', border: '1px solid #333', textAlign: 'center' }}><div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '5px' }}>CONNEXION ATLAS</div><div style={{ color: '#00ffcc', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}><div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div> EN LIGNE</div></div>
                <div style={{ flex: 1, backgroundColor: '#1a1a1a', padding: '15px', borderRadius: '8px', border: '1px solid #333', textAlign: 'center' }}><div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '5px' }}>MODE CLOUD (VERCEL)</div><div style={{ color: '#ffcc00', fontWeight: 'bold' }}>LECTURE SEULE</div></div>
              </div>
              <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px dashed #444', flex: 1 }}>
                <h4 style={{ color: '#fff', margin: '0 0 10px 0', fontSize: '1rem' }}>🛠️ Protocole d'Injection (La Forge)</h4>
                <p style={{ color: '#888', fontSize: '0.9rem', margin: '0 0 15px 0', lineHeight: '1.5' }}>Pour éviter la surcharge mémoire du serveur cloud, la mise à jour de la Matrice 3D est exclusivement verrouillée sur le PC Maître.</p>
                <ol style={{ color: '#aaa', fontSize: '0.9rem', margin: '0', paddingLeft: '20px', lineHeight: '1.6' }}><li>Glisse tes fichiers Excel dans le dossier <code style={{color: '#00ffcc', fontWeight: 'bold'}}>Data/</code> de ton ordinateur.</li><li>Ouvre le terminal de ton PC.</li><li>Lance la commande : <code style={{backgroundColor: '#000', padding: '3px 6px', borderRadius: '4px', color: '#ffcc00', border: '1px solid #333'}}>python Lancement_Local.py</code></li><li>Laisse le PC calculer et transférer les données vers Atlas.</li><li>Rafraîchis cette page pour voir les nouvelles métriques.</li></ol>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VUE HOME — POSTE DE PILOTAGE */}
      {vueActuelle === 'HOME' && (
        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>

          {/* 🎯 1. SCANNER DU MARCHÉ — WIDGET PRINCIPAL, PLEINE LARGEUR */}
          <div style={{ backgroundColor: '#111', padding: '25px 30px', borderRadius: '10px', border: '2px solid #00ffcc', marginBottom: '20px', boxShadow: '0 0 25px rgba(0,255,204,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
              <h2 style={{ color: '#00ffcc', margin: 0, fontSize: '1.3rem', letterSpacing: '1px' }}>🎯 SCANNER DU MARCHÉ — PLAN DE JEU DU JOUR</h2>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ color: '#888', fontSize: '0.85rem' }}>Profil :</span>
                <span style={{ color: '#00ffcc', fontWeight: 'bold', border: '1px solid #00ffcc', padding: '4px 12px', borderRadius: '4px', fontSize: '0.85rem' }}>
                  {profilRisque === 'PRUDENT' ? '🟢 PRUDENT' : profilRisque === 'AGRESSIF' ? '🔴 AGRESSIF' : '🟡 ÉQUILIBRÉ'} ({expositionMaxActuelle}% max)
                </span>
                <button onClick={chargerScanner} style={{ padding: '6px 12px', backgroundColor: '#1a1a1a', color: '#00ffcc', border: '1px solid #00ffcc', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' }}>🔄</button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div style={{ backgroundColor: '#1a1a1a', padding: '18px', borderRadius: '8px', border: '1px solid #00ffcc', textAlign: 'center' }}>
                <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px' }}>Paris Sélectionnés</div>
                <div style={{ fontSize: '2.2rem', fontWeight: 'bold', color: '#00ffcc' }}>{scannerData?.nb_selectionnes ?? 0}</div>
              </div>
              <div style={{ backgroundColor: '#1a1a1a', padding: '18px', borderRadius: '8px', border: '1px solid #333', textAlign: 'center' }}>
                <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px' }}>Mise / Pari</div>
                <div style={{ fontSize: '2.2rem', fontWeight: 'bold', color: '#fff' }}>{scannerData?.mise_unitaire_pct ?? 0}%</div>
              </div>
              <div style={{ backgroundColor: '#1a1a1a', padding: '18px', borderRadius: '8px', border: '1px solid #ffcc00', textAlign: 'center' }}>
                <div style={{ color: '#ffcc00', fontSize: '0.75rem', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px' }}>Exposition Prévue</div>
                <div style={{ fontSize: '2.2rem', fontWeight: 'bold', color: '#ffcc00' }}>{expositionUtilisee}%</div>
              </div>
              <div style={{ backgroundColor: '#1a1a1a', padding: '18px', borderRadius: '8px', border: '1px solid #333', textAlign: 'center' }}>
                <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px' }}>Bankroll Engagée</div>
                <div style={{ fontSize: '1.7rem', fontWeight: 'bold', color: '#fff' }}>{montantEngageScanner.toFixed(2)} €</div>
              </div>
              <div style={{ backgroundColor: '#1a1a1a', padding: '18px', borderRadius: '8px', border: '1px solid #333', textAlign: 'center' }}>
                <div style={{ color: '#888', fontSize: '0.75rem', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px' }}>Candidats Analysés</div>
                <div style={{ fontSize: '2.2rem', fontWeight: 'bold', color: '#fff' }}>{scannerMatchs.length}</div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '15px' }}>
              <button onClick={() => changerVueGlobale('TRADING')} style={{ padding: '10px 20px', backgroundColor: 'transparent', color: '#00ffcc', border: '1px solid #00ffcc', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold' }}>Ouvrir le Terminal →</button>
            </div>
          </div>

          {/* Ligne 2 : Statut des SAS | Résumé de la journée | Performance */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">

            {/* 2. STATUT DES SAS (enrichi) */}
            <div style={{ backgroundColor: '#1a1a1a', padding: '25px', borderRadius: '8px', border: '1px solid #333' }}>
              <h2 style={{ color: '#aaa', margin: '0 0 18px 0', fontSize: '1.1rem', borderBottom: '1px solid #333', paddingBottom: '10px' }}>⚙️ STATUT DES SAS</h2>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}><span style={{ fontSize: '0.95rem', color: '#888' }}>À renseigner</span><span style={{ fontSize: '1.3rem', fontWeight: 'bold', color: nbARemplir > 0 ? '#fff' : '#444' }}>{nbARemplir}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}><span style={{ fontSize: '0.95rem', color: '#888' }}>Analysés</span><span style={{ fontSize: '1.3rem', fontWeight: 'bold', color: nbAnalyse > 0 ? '#ffcc00' : '#444' }}>{nbAnalyse}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}><span style={{ fontSize: '0.95rem', color: '#888' }}>🟢 Sélectionnés</span><span style={{ fontSize: '1.3rem', fontWeight: 'bold', color: paresSelectionnes.length > 0 ? '#00ffcc' : '#444' }}>{paresSelectionnes.length}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ fontSize: '0.95rem', color: '#888' }}>En attente de résultat</span><span style={{ fontSize: '1.3rem', fontWeight: 'bold', color: nbJoue > 0 ? '#fff' : '#444' }}>{nbJoue}</span></div>
            </div>

            {/* 5. RÉSUMÉ DE LA JOURNÉE (nouveau) */}
            <div style={{ backgroundColor: '#1a1a1a', padding: '25px', borderRadius: '8px', border: '1px solid #333' }}>
              <h2 style={{ color: '#aaa', margin: '0 0 18px 0', fontSize: '1.1rem', borderBottom: '1px solid #333', paddingBottom: '10px' }}>📋 RÉSUMÉ DE LA JOURNÉE</h2>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}><span style={{ color: '#888', fontSize: '0.9rem' }}>Matchs analysés</span><span style={{ color: '#fff', fontWeight: 'bold' }}>{scannerMatchs.length}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}><span style={{ color: '#888', fontSize: '0.9rem' }}>Paris potables</span><span style={{ color: '#ffcc00', fontWeight: 'bold' }}>{nbPotablesTotal}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}><span style={{ color: '#888', fontSize: '0.9rem' }}>Paris sélectionnés</span><span style={{ color: '#00ffcc', fontWeight: 'bold' }}>{paresSelectionnes.length}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}><span style={{ color: '#888', fontSize: '0.9rem' }}>Non conformes</span><span style={{ color: '#ff4444', fontWeight: 'bold' }}>{paresNonConformes.length}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}><span style={{ color: '#888', fontSize: '0.9rem' }}>Profil actif</span><span style={{ color: '#fff', fontWeight: 'bold' }}>{profilRisque}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#888', fontSize: '0.9rem' }}>Mise recommandée</span><span style={{ color: '#fff', fontWeight: 'bold' }}>{scannerData?.mise_unitaire_pct || 0}%</span></div>
            </div>

            {/* 3. PERFORMANCE (consolidée en un seul widget compact) */}
            <div style={{ backgroundColor: '#1a1a1a', padding: '25px', borderRadius: '8px', border: '1px solid #00ffcc' }}>
              <h2 style={{ color: '#00ffcc', margin: '0 0 18px 0', fontSize: '1.1rem', borderBottom: '1px solid #00ffcc44', paddingBottom: '10px' }}>📊 PERFORMANCE</h2>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', paddingBottom: '10px', borderBottom: '1px dotted #333' }}>
                <span style={{ color: '#888', fontSize: '0.85rem' }}>Aujourd'hui</span>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontWeight: 'bold', marginRight: '10px' }}><Colorize val={dashCalculs?.kpisJour?.pnl || 0} isCurrency={true} /></span>
                  <span style={{ fontSize: '0.85rem' }}><Colorize val={dashCalculs?.kpisJour?.roi || 0} />%</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', paddingBottom: '10px', borderBottom: '1px dotted #333' }}>
                <span style={{ color: '#888', fontSize: '0.85rem' }}>Semaine</span>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontWeight: 'bold', marginRight: '10px' }}><Colorize val={dashCalculs?.kpisSemaine?.pnl || 0} isCurrency={true} /></span>
                  <span style={{ fontSize: '0.85rem' }}><Colorize val={dashCalculs?.kpisSemaine?.roi || 0} />%</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#888', fontSize: '0.85rem' }}>Historique global</span>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontWeight: 'bold', marginRight: '10px' }}><Colorize val={dashCalculs?.kpis?.pnl || 0} isCurrency={true} /></span>
                  <span style={{ fontSize: '0.85rem' }}>ROI <Colorize val={dashCalculs?.kpis?.roi || 0} />% · ROC <Colorize val={dashCalculs?.kpis?.roc || 0} />%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Ligne 3 : Exposition | Qualité globale | Alertes (discrètes) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-8">

            {/* 6. JAUGE D'EXPOSITION */}
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333' }}>
              <h3 style={{ color: '#aaa', margin: '0 0 15px 0', fontSize: '0.95rem' }}>🧭 EXPOSITION DE LA BANKROLL</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ color: '#888', fontSize: '0.8rem' }}>{expositionUtilisee}% utilisés</span>
                <span style={{ color: '#888', fontSize: '0.8rem' }}>{expositionMaxActuelle}% max</span>
              </div>
              <div style={{ width: '100%', height: '14px', backgroundColor: '#0a0a0a', borderRadius: '7px', overflow: 'hidden', border: '1px solid #333' }}>
                <div style={{ width: `${expositionRatio}%`, height: '100%', backgroundColor: getCouleurExposition(expositionRatio), transition: 'width 0.4s ease' }} />
              </div>
              <div style={{ textAlign: 'center', marginTop: '10px', fontSize: '0.8rem', color: getCouleurExposition(expositionRatio), fontWeight: 'bold' }}>
                {expositionRatio >= 90 ? '⚠️ Exposition proche du maximum' : expositionRatio >= 60 ? 'Exposition modérée' : 'Marge de manœuvre confortable'}
              </div>
            </div>

            {/* 7. QUALITÉ GLOBALE DE LA JOURNÉE */}
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: `1px solid ${qualiteJournee.color}` }}>
              <h3 style={{ color: '#aaa', margin: '0 0 15px 0', fontSize: '0.95rem' }}>🧠 QUALITÉ GLOBALE DE LA JOURNÉE</h3>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '8px' }}>
                <span style={{ fontSize: '2rem', fontWeight: 'bold', color: qualiteJournee.color }}>{scoreMoyenSelection.toFixed(0)}</span>
                <span style={{ color: '#888', fontSize: '0.8rem' }}>/ 100 (score moyen des sélectionnés)</span>
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: '#0a0a0a', borderRadius: '4px', overflow: 'hidden', border: '1px solid #333', marginBottom: '10px' }}>
                <div style={{ width: `${scoreMoyenSelection}%`, height: '100%', backgroundColor: qualiteJournee.color, transition: 'width 0.4s ease' }} />
              </div>
              <div style={{ textAlign: 'center', fontSize: '0.8rem', color: qualiteJournee.color, fontWeight: 'bold' }}>{qualiteJournee.label}</div>
            </div>

            {/* 4. ALERTES SYSTÈME (moins dominantes) */}
            <div style={{ backgroundColor: (isUpdateDay || nbPerimes.length > 0) ? '#221c0a' : '#1a1a1a', padding: '20px', borderRadius: '8px', border: (isUpdateDay || nbPerimes.length > 0) ? '1px solid #ffcc0066' : '1px solid #333', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <h3 style={{ color: (isUpdateDay || nbPerimes.length > 0) ? '#ffcc00' : '#555', margin: '0 0 10px 0', fontSize: '0.95rem' }}>🔔 ALERTES SYSTÈME</h3>
              {(isUpdateDay || nbPerimes.length > 0) ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {isUpdateDay && <div style={{ color: '#ccc', fontSize: '0.82rem' }}>📂 Extraction requise — mets à jour les fichiers dans le Data Center.</div>}
                  {nbPerimes.length > 0 && <div style={{ color: '#ccc', fontSize: '0.82rem' }}>⚠️ {nbPerimes.length} match(s) à cotes périmées nécessitent un recalcul.</div>}
                </div>
              ) : (
                <div style={{ color: '#444', fontSize: '0.85rem' }}>💤 Aucune alerte — tout est à jour.</div>
              )}
            </div>
          </div>

          {/* Raccourcis inchangés */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-4 h-16 md:h-20 mb-8">
            <a href="https://www.winamax.fr/paris-sportifs/sports/1" target="_blank" rel="noreferrer" style={{ flex: 1, backgroundColor: '#000', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', textDecoration: 'none', transition: '0.2s', border: '1px solid #333' }}><img src="/winamax.webp" alt="Winamax" style={{ height: '50px', objectFit: 'contain' }} /></a>
            <a href="https://www.betclic.fr/paris-sportifs" target="_blank" rel="noreferrer" style={{ flex: 1, backgroundColor: '#e10014', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', textDecoration: 'none', transition: '0.2s', border: '1px solid #ff4444' }}><img src="/betclic.png" alt="Betclic" style={{ height: '50px', objectFit: 'contain' }} /></a>
            <a href="https://www.unibet.fr/sport" target="_blank" rel="noreferrer" style={{ flex: 1, backgroundColor: '#000', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', textDecoration: 'none', transition: '0.2s', border: '1px solid #00a651' }}><img src="/unibet.png" alt="Unibet" style={{ height: '50px', objectFit: 'contain' }} /></a>
            <a href="https://www.flashscore.fr/" target="_blank" rel="noreferrer" style={{ flex: 1, backgroundColor: '#001e28', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', textDecoration: 'none', transition: '0.2s', border: '1px solid #333' }}><img src="/flashscore.jpeg" alt="Flashscore" style={{ height: '60px', borderRadius: '8px', objectFit: 'contain' }} /></a>
            <a href="https://www.football-data.co.uk/downloadm.php" target="_blank" rel="noreferrer" style={{ flex: 1, backgroundColor: '#ffffff', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', textDecoration: 'none', transition: '0.2s', border: '1px solid #333' }}><img src="/footballdata.jpg" alt="Football-Data" style={{ height: '40px', objectFit: 'contain' }} /></a>
            <a href="https://app.revolut.com" target="_blank" rel="noreferrer" style={{ flex: 1, backgroundColor: '#000', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', textDecoration: 'none', transition: '0.2s', border: '1px solid #888' }}><img src="/revolut.png" alt="Revolut" style={{ height: '50px', objectFit: 'contain' }} /></a>
          </div>

          {/* Matchs engagés aujourd'hui / en direct — conservé, en fin de page */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333' }}>
              <h3 style={{ color: '#aaa', fontSize: '1rem', margin: '0 0 15px 0' }}>🎯 TIRS ENGAGÉS AUJOURD'HUI ({matchsDuJourJoues.length})</h3>
              <div style={{ maxHeight: '220px', overflowY: 'auto', paddingRight: '5px' }}>
                {matchsDuJourJoues.length > 0 ? matchsDuJourJoues.map(m => (
                  <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', backgroundColor: '#121212', borderRadius: '6px', border: '1px solid #333', marginBottom: '8px' }}>
                    <span style={{ color: '#ccc', fontSize: '0.9rem' }}>{ajusterHeure(m.time || m.date.split(' ')[1])}</span>
                    <span style={{ fontWeight: 'bold', fontSize: '1rem' }}>{m.home_team} - {m.away_team}</span>
                    <span style={{ color: m.type_fond === 'FREEBET' ? '#ff4444' : '#ffcc00', fontWeight: 'bold', border: `1px solid ${m.type_fond === 'FREEBET' ? '#ff4444' : '#ffcc00'}`, padding: '3px 8px', borderRadius: '4px', fontSize: '0.9rem' }}>{m.type_fond === 'FREEBET' ? '🎁 ' : ''}{m.choix_pari || m.pari_choisi} @ {m.cote_choisie}</span>
                  </div>
                )) : <div style={{ color: '#555', textAlign: 'center', padding: '15px', backgroundColor: '#121212', borderRadius: '6px', border: '1px dashed #333' }}>Aucun tir engagé pour aujourd'hui.</div>}
              </div>
            </div>
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333' }}>
              <h3 style={{ color: '#ffcc00', fontSize: '1rem', margin: '0 0 15px 0' }}>🔥 MATCHS EN COURS ({matchsEnCoursJoues.length})</h3>
              <div style={{ maxHeight: '220px', overflowY: 'auto', paddingRight: '5px' }}>
                {matchsEnCoursJoues.length > 0 ? matchsEnCoursJoues.map(m => (
                  <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', backgroundColor: '#3a2a00', borderRadius: '6px', border: '1px solid #ffcc00', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 'bold', fontSize: '1rem', color: '#fff' }}>{m.home_team} - {m.away_team}</span>
                    <span className="blink" style={{ color: '#ffcc00', fontSize: '0.8rem', fontWeight: 'bold' }}>LIVE</span>
                  </div>
                )) : <div style={{ color: '#888', textAlign: 'center', padding: '15px', backgroundColor: '#3a2a0022', borderRadius: '6px', border: '1px dashed #ffcc0055' }}>Aucun match en direct pour le moment.</div>}
              </div>
            </div>
          </div>

          <div style={{ backgroundColor: '#111', padding: '40px', borderRadius: '8px', border: '2px dashed #333', textAlign: 'center', color: '#444' }}><h2 style={{ margin: 0, fontSize: '1.5rem', color: '#555' }}>📡 EMPLACEMENT RÉSERVÉ : API LIVE SCORE</h2><p style={{ fontSize: '1rem', marginTop: '10px' }}>En attente d'intégration du flux WebSocket...</p></div>
        </div>
      )}

      {/* VUE DASHBOARD */}
      {vueActuelle === 'DASHBOARD' && dashCalculs && (
        <div style={{ maxWidth: '1650px', margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', marginBottom: '30px', flexWrap: 'wrap', gap: '15px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}><span style={{ color: '#888' }}>Période :</span><input type="date" value={dashDateDebut} onChange={e => setDashDateDebut(e.target.value)} style={dateInputStyle} /><span style={{ color: '#888' }}>à</span><input type="date" value={dashDateFin} onChange={e => setDashDateFin(e.target.value)} style={dateInputStyle} /><button onClick={() => {setDashDateDebut(''); setDashDateFin('');}} style={{ padding: '10px', backgroundColor: '#333', color: '#ff4444', border: '1px solid #ff4444', borderRadius: '4px', cursor: 'pointer' }}>Reset</button></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}><span style={{ color: '#888' }}>Résolution :</span><select value={dashGranularite} onChange={e => setDashGranularite(e.target.value)} style={dateInputStyle}><option value="JOUR">Jour par Jour</option><option value="SEMAINE">Par Semaine</option><option value="MOIS">Par Mois</option><option value="ANNEE">Par Année</option></select></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px', borderLeft: '1px solid #444', paddingLeft: '15px' }}><span style={{ color: '#888' }}>Ligue :</span><select value={dashFiltreLigue} onChange={e => setDashFiltreLigue(e.target.value)} style={{...dateInputStyle, border: '1px solid #ffcc00', color: '#ffcc00'}}><option value="">🌍 Toutes les Ligues</option>{dashCalculs.liguesDisponibles && dashCalculs.liguesDisponibles.map(l => (<option key={l} value={l}>{l}</option>))}</select></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', borderLeft: '1px solid #444', paddingLeft: '15px' }}>
              <span style={{ color: '#888' }}>Stats :</span>
              <button onClick={() => setDashInclureFreebets(false)} style={!dashInclureFreebets ? { ...tabActive, padding: '8px 14px' } : { ...tabInactive, padding: '8px 14px' }}>🎯 Simples uniquement</button>
              <button onClick={() => setDashInclureFreebets(true)} style={dashInclureFreebets ? { ...tabActive, padding: '8px 14px', backgroundColor: '#cc66ff' } : { ...tabInactive, padding: '8px 14px' }}>🎯🎁 Simples + Freebets</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px', borderLeft: '1px solid #444', paddingLeft: '15px' }}>
              <button onClick={copierRapportDashboardPourIA} style={{ padding: '10px 15px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>📋 COPIER POUR L'IA</button>
              <button onClick={() => window.print()} style={{ padding: '10px 15px', backgroundColor: '#333', color: '#fff', border: '1px solid #666', borderRadius: '4px', cursor: 'pointer' }}>🖨️ PDF</button>
            </div>
          </div>

          <div style={{ fontSize: '0.8rem', color: dashInclureFreebets ? '#cc66ff' : '#888', marginBottom: '10px' }}>
            {dashInclureFreebets
              ? '🎁 Les KPI ci-dessous incluent les combinés Freebet.'
              : '🎯 Les KPI ci-dessous ne portent que sur les paris simples (combinés Freebet exclus).'}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-8">
            <div style={kpiCard}><div style={kpiLabel}>PARIS JOUÉS</div><div style={{...kpiValue, color: '#fff'}}>{dashCalculs.kpis.count}</div></div>
            <div style={kpiCard}><div style={kpiLabel}>PROFIT NET FILTRÉ</div><div style={kpiValue}><Colorize val={dashCalculs.kpis.pnl} isCurrency={true} /></div></div>
            <div style={kpiCard}><div style={kpiLabel}>R.O.I FILTRÉ</div><div style={kpiValue}><Colorize val={dashCalculs.kpis.roi} /> %</div></div>
            <div style={{...kpiCard, border: '1px solid #ffcc00'}}><div style={{...kpiLabel, color: '#ffcc00'}}>R.O.C (CAPITAL)</div><div style={kpiValue}><Colorize val={dashCalculs.kpis.roc} /> %</div></div>
            <div style={kpiCard}><div style={kpiLabel}>WINRATE</div><div style={{...kpiValue, color: '#ffcc00'}}>{dashCalculs.kpis.winrate} %</div></div>
            <div style={kpiCard}><div style={kpiLabel}>COTE MOYENNE</div><div style={{...kpiValue, color: '#fff'}}>{dashCalculs.kpis.cote}</div></div>
            <div style={{...kpiCard, border: '1px solid #00ffcc'}}><div style={kpiLabel}>CLV MOYENNE</div><div style={kpiValue}><Colorize val={dashCalculs.kpis.clv} /> %</div></div>
          </div>

          <div style={{ backgroundColor: '#1a1a1a', padding: '30px', borderRadius: '8px', border: '1px solid #333', marginBottom: '30px', height: '400px' }}>
            <h3 style={{ color: '#aaa', marginTop: 0 }}>📈 ÉLECTROCARDIOGRAMME DES GAINS</h3>
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={dashCalculs.chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis dataKey="period" stroke="#888" />
                    <YAxis stroke="#888" />
                    <Tooltip contentStyle={{ backgroundColor: '#111', border: '1px solid #333', color: '#fff' }} itemStyle={{ color: '#00ffcc' }} labelStyle={{ color: '#fff' }} />
                    <Bar dataKey="pnlPeriod" name="Profit Période (€)" radius={[4, 4, 0, 0]}>{dashCalculs.chartData.map((entry, index) => (<Cell key={`cell-${index}`} fill={entry.pnlPeriod >= 0 ? '#00ffcc' : '#ff4444'} />))}</Bar>
                    <Line type="monotone" dataKey="pnlCumul" name="Profit Cumulé (€)" stroke="#ffcc00" strokeWidth={3} dot={{ r: 3, fill: '#121212', stroke: '#ffcc00' }} activeDot={{ r: 6 }} />
                </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* 🆕 §1 : FUNNEL HYDRE — sélectionné = bloqué = joué, donc pas de stats sur les rejets.
              Matchs analysés = compteur recalculé à la volée (saison actuelle), cf. correctif stockage. */}
          <div style={{ marginBottom: '30px' }}>
            <h3 style={{ color: '#aaa', marginBottom: '15px' }}>🧭 FUNNEL HYDRE</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div style={kpiCard}>
                <div style={kpiLabel}>MATCHS ANALYSÉS</div>
                <div style={{...kpiValue, color:'#fff'}}>{dashCalculs.funnel.matchsAnalyses}</div>
              </div>
              <div style={kpiCard}>
                <div style={kpiLabel}>MATCHS SÉLECTIONNÉS</div>
                <div style={{...kpiValue, color:'#00ffcc'}}>{dashCalculs.funnel.matchsSelectionnes}</div>
              </div>
              <div style={{...kpiCard, border: '1px solid #ffcc00'}}>
                <div style={{...kpiLabel, color:'#ffcc00'}}>TAUX DE SÉLECTION</div>
                <div style={{...kpiValue, color:'#ffcc00'}}>{dashCalculs.funnel.tauxSelection !== null ? `${dashCalculs.funnel.tauxSelection.toFixed(1)} %` : '-'}</div>
              </div>
            </div>
          </div>


          {/* 🆕 §2/§4 : CLV DÉTAILLÉE + PERFORMANCE PAR CLV (analyse a posteriori uniquement,
              jamais utilisée pour modifier la sélection Hydre). */}
          <div style={{ marginBottom: '30px' }}>
            <h3 style={{ color: '#aaa', marginBottom: '15px' }}>🎯 CLV DÉTAILLÉE</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-5">
              <div style={{...kpiCard, border: '1px solid #00ffcc'}}>
                <div style={kpiLabel}>CLV MOYENNE</div>
                <div style={kpiValue}><Colorize val={dashCalculs.clvDetail.moyenne.toFixed(2)} />%</div>
              </div>
              <div style={kpiCard}>
                <div style={kpiLabel}>CLV MÉDIANE</div>
                <div style={kpiValue}>{dashCalculs.clvDetail.mediane !== null ? (<><Colorize val={dashCalculs.clvDetail.mediane.toFixed(2)} />%</>) : '-'}</div>
              </div>
              <div style={kpiCard}>
                <div style={{...kpiLabel, color:'#ffcc00'}}>% CLV POSITIVE</div>
                <div style={{...kpiValue, color:'#ffcc00'}}>{dashCalculs.clvDetail.positivePct !== null ? `${dashCalculs.clvDetail.positivePct.toFixed(1)} %` : '-'}</div>
              </div>
              <div style={kpiCard}>
                <div style={kpiLabel}>CLV MIN</div>
                <div style={kpiValue}>{dashCalculs.clvDetail.min !== null ? (<><Colorize val={dashCalculs.clvDetail.min.toFixed(2)} />%</>) : '-'}</div>
              </div>
              <div style={kpiCard}>
                <div style={kpiLabel}>CLV MAX</div>
                <div style={kpiValue}>{dashCalculs.clvDetail.max !== null ? (<><Colorize val={dashCalculs.clvDetail.max.toFixed(2)} />%</>) : '-'}</div>
              </div>
            </div>

            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333' }}>
              <h4 style={{ color: '#aaa', marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>📐 PERFORMANCE PAR CLV</h4>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                <thead><tr style={{ color: '#888', borderBottom: '1px solid #444' }}><th style={{padding:'10px'}}>Tranche CLV</th><th style={{padding:'10px'}}>Vol</th><th style={{padding:'10px'}}>Winrate</th><th style={{padding:'10px'}}>PnL</th><th style={{padding:'10px'}}>ROI</th></tr></thead>
                <tbody>
                  {Object.keys(dashCalculs.statsClv).map(tranche => {
                    const data = dashCalculs.statsClv[tranche];
                    return (<tr key={tranche} style={{ borderBottom: '1px solid #222' }}><td style={{padding:'10px', color:'#00ffcc'}}>{tranche}</td><td style={{padding:'10px'}}>{data.count}</td><td style={{padding:'10px', color:'#ffcc00'}}>{data.count > 0 ? `${data.WinRate}%` : '-'}</td><td style={{padding:'10px'}}>{data.count > 0 ? <Colorize val={data.pnl.toFixed(2)} isCurrency={true}/> : '-'}</td><td style={{padding:'10px'}}>{data.count > 0 ? (<><Colorize val={data.ROI}/>%</>) : '-'}</td></tr>);
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 🆕 §5/§6/§7 : Issue / Cotes (nouvelles tranches) / Edge / Ligue (filtre minimum) / Bookmaker. */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-10">
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
              <h3 style={{ color: '#aaa', marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>🎯 PAR ISSUE</h3>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ color: '#888', borderBottom: '1px solid #444', cursor: 'pointer' }}>
                    <th onClick={() => handleSort('issue', 'name')} style={{padding:'10px'}}>Issue {renderSortIcon('issue', 'name')}</th>
                    <th onClick={() => handleSort('issue', 'count')} style={{padding:'10px'}}>Vol {renderSortIcon('issue', 'count')}</th>
                    <th onClick={() => handleSort('issue', 'winrate')} style={{padding:'10px'}}>Winrate {renderSortIcon('issue', 'winrate')}</th>
                    <th onClick={() => handleSort('issue', 'pnl')} style={{padding:'10px'}}>PnL {renderSortIcon('issue', 'pnl')}</th>
                    <th onClick={() => handleSort('issue', 'roi')} style={{padding:'10px'}}>ROI {renderSortIcon('issue', 'roi')}</th>
                  </tr>
                </thead>
                <tbody>{getSortedKeys(dashCalculs.statsIssue, 'issue').map(issue => {
                  const data = dashCalculs.statsIssue[issue];
                  const roi = data.mise > 0 ? ((data.pnl / data.mise) * 100).toFixed(2) : 0;
                  const winrate = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(1) : 0;
                  return (<tr key={issue} style={{ borderBottom: '1px solid #222' }}><td style={{padding:'10px', fontWeight:'bold', color:'#fff'}}>{issue}</td><td style={{padding:'10px'}}>{data.count}</td><td style={{padding:'10px', color:'#ffcc00'}}>{winrate}%</td><td style={{padding:'10px'}}><Colorize val={data.pnl.toFixed(2)} isCurrency={true}/></td><td style={{padding:'10px'}}><Colorize val={roi}/>%</td></tr>);
                })}</tbody>
              </table>
            </div>

            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
              <h3 style={{ color: '#aaa', marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>📊 PAR COTES</h3>
              <div style={{ maxHeight: '350px', overflowY: 'auto', paddingRight: '5px' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                  <thead>
                    <tr style={{ color: '#888', borderBottom: '1px solid #444', cursor: 'pointer', position: 'sticky', top: 0, backgroundColor: '#1a1a1a', zIndex: 1 }}>
                      <th onClick={() => handleSort('cotes', 'name')} style={{padding:'10px'}}>Tranche {renderSortIcon('cotes', 'name')}</th>
                      <th onClick={() => handleSort('cotes', 'count')} style={{padding:'10px'}}>Vol {renderSortIcon('cotes', 'count')}</th>
                      <th onClick={() => handleSort('cotes', 'winrate')} style={{padding:'10px'}}>Winrate {renderSortIcon('cotes', 'winrate')}</th>
                      <th onClick={() => handleSort('cotes', 'pnl')} style={{padding:'10px'}}>PnL {renderSortIcon('cotes', 'pnl')}</th>
                      <th onClick={() => handleSort('cotes', 'roi')} style={{padding:'10px'}}>ROI {renderSortIcon('cotes', 'roi')}</th>
                      <th style={{padding:'10px'}}>CLV moy.</th>
                    </tr>
                  </thead>
                  <tbody>{getSortedKeys(dashCalculs.statsCotes, 'cotes').map(tranche => {
                    const data = dashCalculs.statsCotes[tranche];
                    const roi = data.mise > 0 ? ((data.pnl / data.mise) * 100).toFixed(2) : 0;
                    const winrate = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(1) : 0;
                    return (<tr key={tranche} style={{ borderBottom: '1px solid #222' }}><td style={{padding:'10px', color:'#ffcc00'}}>{tranche}</td><td style={{padding:'10px'}}>{data.count}</td><td style={{padding:'10px', color:'#ffcc00'}}>{data.count > 0 ? `${winrate}%` : '-'}</td><td style={{padding:'10px'}}>{data.count > 0 ? <Colorize val={data.pnl.toFixed(2)} isCurrency={true}/> : '-'}</td><td style={{padding:'10px'}}>{data.count > 0 ? (<><Colorize val={roi}/>%</>) : '-'}</td><td style={{padding:'10px'}}>{data.ClvMoy !== null ? (<><Colorize val={data.ClvMoy}/>%</>) : '-'}</td></tr>);
                  })}</tbody>
                </table>
              </div>
            </div>

            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
              <h3 style={{ color: '#aaa', marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>⚡ PAR EDGE</h3>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ color: '#888', borderBottom: '1px solid #444', cursor: 'pointer' }}>
                    <th onClick={() => handleSort('edge', 'name')} style={{padding:'10px'}}>Tranche {renderSortIcon('edge', 'name')}</th>
                    <th onClick={() => handleSort('edge', 'count')} style={{padding:'10px'}}>Vol {renderSortIcon('edge', 'count')}</th>
                    <th onClick={() => handleSort('edge', 'winrate')} style={{padding:'10px'}}>Winrate {renderSortIcon('edge', 'winrate')}</th>
                    <th onClick={() => handleSort('edge', 'pnl')} style={{padding:'10px'}}>PnL {renderSortIcon('edge', 'pnl')}</th>
                    <th onClick={() => handleSort('edge', 'roi')} style={{padding:'10px'}}>ROI {renderSortIcon('edge', 'roi')}</th>
                  </tr>
                </thead>
                <tbody>{getSortedKeys(dashCalculs.statsEdge, 'edge').map(tranche => {
                  const data = dashCalculs.statsEdge[tranche];
                  const roi = data.mise > 0 ? ((data.pnl / data.mise) * 100).toFixed(2) : 0;
                  const winrate = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(1) : 0;
                  return (<tr key={tranche} style={{ borderBottom: '1px solid #222' }}><td style={{padding:'10px', color:'#ffcc00'}}>{tranche}</td><td style={{padding:'10px'}}>{data.count}</td><td style={{padding:'10px', color:'#ffcc00'}}>{data.count > 0 ? `${winrate}%` : '-'}</td><td style={{padding:'10px'}}>{data.count > 0 ? <Colorize val={data.pnl.toFixed(2)} isCurrency={true}/> : '-'}</td><td style={{padding:'10px'}}>{data.count > 0 ? (<><Colorize val={roi}/>%</>) : '-'}</td></tr>);
                })}</tbody>
              </table>
              {dashCalculs.nbSansEdge > 0 && <div style={{color:'#555', fontSize:'0.7rem', marginTop:'10px'}}>{dashCalculs.nbSansEdge} pari(s) sans edge enregistré (anciennes données), exclu(s) de ce tableau.</div>}
            </div>

            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #333', paddingBottom: '10px' }}>
                <h3 style={{ color: '#aaa', margin: 0 }}>🌍 PAR LIGUE (DIV)</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: '#888', fontSize: '0.75rem' }}>Min. paris :</span>
                  <select value={dashMinParisLigue} onChange={e => setDashMinParisLigue(Number(e.target.value))} style={{ padding: '4px', backgroundColor: '#121212', color: '#ffcc00', border: '1px solid #444', borderRadius: '4px', fontSize: '0.8rem' }}>
                    <option value={5}>5</option><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option>
                  </select>
                </div>
              </div>
              <div style={{ maxHeight: '350px', overflowY: 'auto', paddingRight: '5px' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                  <thead>
                    <tr style={{ color: '#888', borderBottom: '1px solid #444', cursor: 'pointer', position: 'sticky', top: 0, backgroundColor: '#1a1a1a', zIndex: 1 }}>
                      <th onClick={() => handleSort('ligue', 'name')} style={{padding:'10px'}}>Ligue {renderSortIcon('ligue', 'name')}</th>
                      <th onClick={() => handleSort('ligue', 'count')} style={{padding:'10px'}}>Vol {renderSortIcon('ligue', 'count')}</th>
                      <th onClick={() => handleSort('ligue', 'winrate')} style={{padding:'10px'}}>Winrate {renderSortIcon('ligue', 'winrate')}</th>
                      <th onClick={() => handleSort('ligue', 'pnl')} style={{padding:'10px'}}>PnL {renderSortIcon('ligue', 'pnl')}</th>
                      <th onClick={() => handleSort('ligue', 'roi')} style={{padding:'10px'}}>ROI {renderSortIcon('ligue', 'roi')}</th>
                      <th onClick={() => handleSort('ligue', 'clv')} style={{padding:'10px'}}>CLV {renderSortIcon('ligue', 'clv')}</th>
                    </tr>
                  </thead>
                  <tbody>{getSortedKeys(dashCalculs.statsLigue, 'ligue').filter(div => dashCalculs.statsLigue[div].count >= dashMinParisLigue).map(div => {
                    const data = dashCalculs.statsLigue[div];
                    const roi = data.mise > 0 ? ((data.pnl / data.mise) * 100).toFixed(2) : 0;
                    const winrate = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(1) : 0;
                    return (<tr key={div} style={{ borderBottom: '1px solid #222' }}><td style={{padding:'10px', color:'#00ffcc', fontWeight:'bold'}}>{div}</td><td style={{padding:'10px'}}>{data.count}</td><td style={{padding:'10px', color:'#ffcc00'}}>{winrate}%</td><td style={{padding:'10px'}}><Colorize val={data.pnl.toFixed(2)} isCurrency={true}/></td><td style={{padding:'10px'}}><Colorize val={roi}/>%</td><td style={{padding:'10px'}}>{data.ClvMoy !== null ? (<><Colorize val={data.ClvMoy}/>%</>) : '-'}</td></tr>);
                  })}
                  {getSortedKeys(dashCalculs.statsLigue, 'ligue').filter(div => dashCalculs.statsLigue[div].count >= dashMinParisLigue).length === 0 && (
                    <tr><td colSpan="6" style={{textAlign:'center', padding:'20px', color:'#555'}}>Aucune ligue n'atteint ce seuil.</td></tr>
                  )}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #ffcc00', display: 'flex', flexDirection: 'column' }}>
              <h3 style={{ color: '#ffcc00', marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>📊 PAR BOOKMAKER</h3>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ color: '#888', borderBottom: '1px solid #444' }}>
                    <th style={{padding:'10px'}}>Book</th>
                    <th style={{padding:'10px'}}>Vol</th>
                    <th style={{padding:'10px'}}>Win%</th>
                    <th style={{padding:'10px'}}>ROI</th>
                  </tr>
                </thead>
                <tbody>
                  {dashCalculs.stats_bookmakers && Object.keys(dashCalculs.stats_bookmakers).map(book => {
                    const data = dashCalculs.stats_bookmakers[book];
                    return (
                      <tr key={book} style={{ borderBottom: '1px solid #222' }}>
                        <td style={{padding:'10px', fontWeight:'bold', color: book === 'WINAMAX' ? '#ff4444' : '#fff'}}>{book.substring(0, 4)}</td>
                        <td style={{padding:'10px'}}>{data.Count}</td>
                        <td style={{padding:'10px', color:'#ffcc00'}}>{data.WinRate}%</td>
                        <td style={{padding:'10px', fontWeight: 'bold'}}><Colorize val={data.ROI}/>%</td>
                      </tr>
                    );
                  })}
                  {(!dashCalculs.stats_bookmakers || Object.keys(dashCalculs.stats_bookmakers).length === 0) && (
                    <tr><td colSpan="4" style={{textAlign:'center', padding:'20px', color:'#555'}}>Aucune donnée.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 🆕 §3 : ROI VS CLV — observation uniquement, pas une preuve de causalité. */}
          <div style={{ backgroundColor: '#1a1a1a', padding: '30px', borderRadius: '8px', border: '1px solid #333', marginBottom: '30px', height: '420px' }}>
            <h3 style={{ color: '#aaa', marginTop: 0 }}>🔬 ROI VS CLV (observation, pas causalité)</h3>
            <p style={{ color: '#666', fontSize: '0.8rem', marginTop: '-5px', marginBottom: '15px' }}>Un pari peut avoir une CLV positive et être perdant, ou l'inverse — ce graphique observe seulement la relation entre les deux.</p>
            {dashCalculs.scatterClvPnl.length > 0 ? (
              <ResponsiveContainer width="100%" height="80%">
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis type="number" dataKey="clv" name="CLV" unit="%" stroke="#888" />
                  <YAxis type="number" dataKey="pnl" name="PnL" unit="€" stroke="#888" />
                  <ZAxis range={[60, 60]} />
                  <ReferenceLine x={0} stroke="#555" />
                  <ReferenceLine y={0} stroke="#555" />
                  <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ backgroundColor: '#111', border: '1px solid #333', color: '#fff' }} />
                  <Legend />
                  <Scatter name="Gagnants" data={dashCalculs.scatterClvPnl.filter(pt => pt.win)} fill="#00ffcc" />
                  <Scatter name="Perdants" data={dashCalculs.scatterClvPnl.filter(pt => !pt.win)} fill="#ff4444" />
                </ScatterChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ textAlign: 'center', color: '#555', padding: '40px' }}>Aucun pari avec CLV connue sur cette période.</div>
            )}
          </div>

          {/* 🆕 §8 : DRAWDOWN — calculé à partir de la courbe de profit cumulé déjà utilisée ci-dessus. */}
          <div style={{ marginBottom: '30px' }}>
            <h3 style={{ color: '#aaa', marginBottom: '15px' }}>📉 DRAWDOWN</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
              <div style={kpiCard}><div style={kpiLabel}>PROFIT CUMULÉ (PÉRIODE)</div><div style={kpiValue}><Colorize val={dashCalculs.kpis.pnl} isCurrency={true} /></div></div>
              <div style={{...kpiCard, border: '1px solid #ffcc00'}}><div style={{...kpiLabel, color:'#ffcc00'}}>DRAWDOWN ACTUEL</div><div style={{...kpiValue, color: dashCalculs.drawdownActuel < 0 ? '#ff4444' : '#fff'}}>{dashCalculs.drawdownActuel.toFixed(2)} €</div></div>
              <div style={{...kpiCard, border: '1px solid #ff4444'}}><div style={{...kpiLabel, color:'#ff4444'}}>DRAWDOWN MAXIMUM</div><div style={{...kpiValue, color:'#ff4444'}}>{dashCalculs.drawdownMax.toFixed(2)} €</div></div>
            </div>
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', height: '250px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dashCalculs.drawdownData}>
                  <defs><linearGradient id="colorDrawdown" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ff4444" stopOpacity={0.4}/><stop offset="95%" stopColor="#ff4444" stopOpacity={0}/></linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="period" stroke="#888" fontSize={12} />
                  <YAxis stroke="#888" />
                  <Tooltip contentStyle={{ backgroundColor: '#111', border: '1px solid #333', color: '#fff' }} itemStyle={{ color: '#ff4444' }} labelStyle={{ color: '#fff' }} />
                  <Area type="monotone" dataKey="drawdown" name="Drawdown (€)" stroke="#ff4444" strokeWidth={2} fillOpacity={1} fill="url(#colorDrawdown)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 🆕 V2.1 §1/§2/§3/§4 : zone SECONDAIRE — compacte, repliable pour les tableaux volumineux. */}
          <div style={{ marginBottom: '30px' }}>
            <h3 style={{ color: '#666', fontSize: '0.85rem', marginBottom: '15px', textTransform: 'uppercase', letterSpacing: '1px', borderBottom: '1px solid #333', paddingBottom: '8px' }}>📎 Analyses secondaires</h3>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-5">
              <div style={{...kpiCard, padding: '14px'}}>
                <div style={{...kpiLabel, fontSize: '0.7rem'}}>SÉRIE ACTUELLE (GAINS)</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', color: dashCalculs.streaks.currentWin > 0 ? '#00ffcc' : '#555' }}>{dashCalculs.streaks.currentWin > 0 ? dashCalculs.streaks.currentWin : '-'}</div>
              </div>
              <div style={{...kpiCard, padding: '14px'}}>
                <div style={{...kpiLabel, fontSize: '0.7rem'}}>SÉRIE ACTUELLE (PERTES)</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', color: dashCalculs.streaks.currentLose > 0 ? '#ff4444' : '#555' }}>{dashCalculs.streaks.currentLose > 0 ? dashCalculs.streaks.currentLose : '-'}</div>
              </div>
              <div style={{...kpiCard, padding: '14px'}}>
                <div style={{...kpiLabel, fontSize: '0.7rem'}}>PLUS LONGUE SÉRIE DE GAINS</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', color: '#00ffcc' }}>{dashCalculs.streaks.longestWin}</div>
              </div>
              <div style={{...kpiCard, padding: '14px'}}>
                <div style={{...kpiLabel, fontSize: '0.7rem'}}>PLUS LONGUE SÉRIE DE PERTES</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 'bold', color: '#ff4444' }}>{dashCalculs.streaks.longestLose}</div>
              </div>
              <div style={{...kpiCard, padding: '14px', border: '1px solid #444'}}>
                <div style={{...kpiLabel, fontSize: '0.7rem'}}>PROFIT MOYEN / PARI</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 'bold' }}>{dashCalculs.profitMoyenParPari !== null ? <Colorize val={dashCalculs.profitMoyenParPari.toFixed(2)} isCurrency={true}/> : '-'}</div>
              </div>
            </div>

            <details style={{ backgroundColor: '#1a1a1a', borderRadius: '8px', border: '1px solid #333', marginBottom: '15px' }}>
              <summary style={{ padding: '15px', cursor: 'pointer', color: '#aaa', fontWeight: 'bold' }}>📅 Performance par jour de la semaine</summary>
              <div style={{ padding: '0 20px 20px 20px', overflowX: 'auto' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                  <thead><tr style={{ color: '#888', borderBottom: '1px solid #444' }}><th style={{padding:'10px'}}>Jour</th><th style={{padding:'10px'}}>Vol</th><th style={{padding:'10px'}}>Winrate</th><th style={{padding:'10px'}}>PnL</th><th style={{padding:'10px'}}>ROI</th><th style={{padding:'10px'}}>CLV moy.</th></tr></thead>
                  <tbody>
                    {Object.keys(dashCalculs.statsJourSemaine).map(j => {
                      const d = dashCalculs.statsJourSemaine[j];
                      return (<tr key={j} style={{ borderBottom: '1px solid #222' }}>
                        <td style={{padding:'10px', fontWeight:'bold', color:'#fff'}}>{j}</td>
                        <td style={{padding:'10px'}}>{d.count}</td>
                        <td style={{padding:'10px', color:'#ffcc00'}}>{d.count > 0 ? `${d.WinRate}%` : '-'}</td>
                        <td style={{padding:'10px'}}>{d.count > 0 ? <Colorize val={d.pnl.toFixed(2)} isCurrency={true}/> : '-'}</td>
                        <td style={{padding:'10px'}}>{d.count > 0 ? (<><Colorize val={d.ROI}/>%</>) : '-'}</td>
                        <td style={{padding:'10px'}}>{d.ClvMoy !== null ? (<><Colorize val={d.ClvMoy}/>%</>) : '-'}</td>
                      </tr>);
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            <details style={{ backgroundColor: '#1a1a1a', borderRadius: '8px', border: '1px solid #333' }}>
              <summary style={{ padding: '15px', cursor: 'pointer', color: '#aaa', fontWeight: 'bold' }}>🧠 Performance par Score Hydre (paris simples)</summary>
              <div style={{ padding: '0 20px 20px 20px', overflowX: 'auto' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                  <thead><tr style={{ color: '#888', borderBottom: '1px solid #444' }}><th style={{padding:'10px'}}>Tranche</th><th style={{padding:'10px'}}>Vol</th><th style={{padding:'10px'}}>Winrate</th><th style={{padding:'10px'}}>PnL</th><th style={{padding:'10px'}}>ROI</th><th style={{padding:'10px'}}>CLV moy.</th></tr></thead>
                  <tbody>
                    {Object.keys(dashCalculs.statsScoreHydre).map(t => {
                      const d = dashCalculs.statsScoreHydre[t];
                      return (<tr key={t} style={{ borderBottom: '1px solid #222' }}>
                        <td style={{padding:'10px', color:'#ffcc00'}}>{t}</td>
                        <td style={{padding:'10px'}}>{d.count}</td>
                        <td style={{padding:'10px', color:'#ffcc00'}}>{d.count > 0 ? `${d.WinRate}%` : '-'}</td>
                        <td style={{padding:'10px'}}>{d.count > 0 ? <Colorize val={d.pnl.toFixed(2)} isCurrency={true}/> : '-'}</td>
                        <td style={{padding:'10px'}}>{d.count > 0 ? (<><Colorize val={d.ROI}/>%</>) : '-'}</td>
                        <td style={{padding:'10px'}}>{d.ClvMoy !== null ? (<><Colorize val={d.ClvMoy}/>%</>) : '-'}</td>
                      </tr>);
                    })}
                  </tbody>
                </table>
                {dashCalculs.nbSansScore > 0 && <div style={{color:'#555', fontSize:'0.7rem', marginTop:'10px'}}>{dashCalculs.nbSansScore} pari(s) simple(s) sans score Hydre enregistré (anciennes données), exclu(s) de ce tableau.</div>}
              </div>
            </details>
          </div>

          {/* 🆕 V2.1 §5/§6/§7/§8/§9 : zone FREEBET — séparée visuellement, combinés uniquement (jamais les simples,
              déjà comptés dans les KPI généraux). Statut des freebets = logique déjà existante (ANNULÉ exclu en amont
              comme pour tout le Dashboard ; GAGNÉ/PERDU/CASHOUT déjà les seuls résultats définitifs pris en compte). */}
          {dashCalculs.freebetEfficiency.nbCombines > 0 && (
          <div style={{ marginBottom: '30px', padding: '20px', borderRadius: '10px', border: '1px solid #ff4444', backgroundColor: 'rgba(255,68,68,0.03)' }}>
            <h3 style={{ color: '#ff4444', marginTop: 0, marginBottom: '20px' }}>🎁 COMBINÉS FREEBET</h3>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-3">
              <div style={kpiCard}><div style={kpiLabel}>COMBINÉS JOUÉS</div><div style={{...kpiValue, color:'#fff'}}>{dashCalculs.freebetEfficiency.nbCombines}</div></div>
              <div style={kpiCard}><div style={kpiLabel}>FREEBETS UTILISÉES</div><div style={{...kpiValue, color:'#fff'}}>{dashCalculs.freebetEfficiency.freebetsUtilisees.toFixed(2)} €</div></div>
              <div style={kpiCard}><div style={kpiLabel}>GAINS GÉNÉRÉS</div><div style={{...kpiValue, color:'#00ffcc'}}>{dashCalculs.freebetEfficiency.gains.toFixed(2)} €</div></div>
              <div style={kpiCard}><div style={kpiLabel}>PROFIT GÉNÉRÉ</div><div style={kpiValue}><Colorize val={dashCalculs.freebetEfficiency.profit.toFixed(2)} isCurrency={true}/></div></div>
              <div style={{...kpiCard, border: '1px solid #ff4444'}}><div style={{...kpiLabel, color:'#ff4444'}}>VALEUR / € DE FREEBET</div><div style={{...kpiValue, color:'#ff4444'}}>{dashCalculs.freebetEfficiency.valeurParEuro !== null ? `${dashCalculs.freebetEfficiency.valeurParEuro.toFixed(2)} €` : '-'}</div></div>
            </div>
            <div style={{ color: '#666', fontSize: '0.7rem', marginBottom: '20px' }}>Valeur générée par € de freebet = gains générés ÷ freebets utilisées.</div>

          {/* 🆕 §16/§17 : intégration compacte des combinés Freebet — pas de dashboard dupliqué,
              juste une distinction simples/combinés + une répartition par taille de combiné. */}
          {(dashCalculs.statsTypePari?.COMBINE?.count > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-10">
              <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333' }}>
                <h3 style={{ color: '#aaa', marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>🎫 SIMPLES vs COMBINÉS</h3>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                  <thead><tr style={{ color: '#888', borderBottom: '1px solid #444' }}><th style={{padding:'10px'}}>Type</th><th style={{padding:'10px'}}>Vol</th><th style={{padding:'10px'}}>Winrate</th><th style={{padding:'10px'}}>PnL</th><th style={{padding:'10px'}}>ROI</th></tr></thead>
                  <tbody>
                    {['SIMPLE', 'COMBINE'].map(t => {
                      const d = dashCalculs.statsTypePari[t];
                      return (
                        <tr key={t} style={{ borderBottom: '1px solid #222' }}>
                          <td style={{padding:'10px', fontWeight:'bold', color:'#fff'}}>{t === 'SIMPLE' ? '💶 Simples' : '🎫 Combinés'}</td>
                          <td style={{padding:'10px'}}>{d.count}</td>
                          <td style={{padding:'10px', color:'#ffcc00'}}>{d.WinRate}%</td>
                          <td style={{padding:'10px'}}><Colorize val={d.pnl.toFixed(2)} isCurrency={true}/></td>
                          <td style={{padding:'10px'}}><Colorize val={d.ROI}/>%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333' }}>
                <h3 style={{ color: '#aaa', marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>📐 PERFORMANCE PAR TAILLE DE COMBINÉ</h3>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                  <thead><tr style={{ color: '#888', borderBottom: '1px solid #444' }}><th style={{padding:'10px'}}>Taille</th><th style={{padding:'10px'}}>Vol</th><th style={{padding:'10px'}}>Gagnants</th><th style={{padding:'10px'}}>PnL</th><th style={{padding:'10px'}}>ROI</th></tr></thead>
                  <tbody>
                    {Object.keys(dashCalculs.statsTailleCombine).sort((a, b) => Number(a) - Number(b)).map(t => {
                      const d = dashCalculs.statsTailleCombine[t];
                      return (
                        <tr key={t} style={{ borderBottom: '1px solid #222' }}>
                          <td style={{padding:'10px', fontWeight:'bold', color:'#fff'}}>x{t}</td>
                          <td style={{padding:'10px'}}>{d.count}</td>
                          <td style={{padding:'10px', color:'#ffcc00'}}>{d.wins} ({d.WinRate}%)</td>
                          <td style={{padding:'10px'}}><Colorize val={d.pnl.toFixed(2)} isCurrency={true}/></td>
                          <td style={{padding:'10px'}}><Colorize val={d.ROI}/>%</td>
                        </tr>
                      );
                    })}
                    {Object.keys(dashCalculs.statsTailleCombine).length === 0 && (
                      <tr><td colSpan="5" style={{textAlign:'center', padding:'20px', color:'#555'}}>Aucun combiné réglé.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

            {/* 🆕 V2.1 §7 : Performance par taille de combiné Freebet, bucketée 2/3/4/5+ (comparaison des "poches"). */}
            <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', marginBottom: '20px' }}>
              <h4 style={{ color: '#aaa', marginTop: 0, borderBottom: '1px solid #333', paddingBottom: '10px' }}>📐 PERFORMANCE PAR TAILLE (2 / 3 / 4 / 5+)</h4>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.9rem' }}>
                  <thead><tr style={{ color: '#888', borderBottom: '1px solid #444' }}><th style={{padding:'10px'}}>Taille</th><th style={{padding:'10px'}}>Nb combinés</th><th style={{padding:'10px'}}>Freebets utilisées</th><th style={{padding:'10px'}}>Gains</th><th style={{padding:'10px'}}>Profit</th><th style={{padding:'10px'}}>ROI</th></tr></thead>
                  <tbody>
                    {Object.keys(dashCalculs.statsTailleFreebet).map(t => {
                      const d = dashCalculs.statsTailleFreebet[t];
                      return (<tr key={t} style={{ borderBottom: '1px solid #222' }}>
                        <td style={{padding:'10px', fontWeight:'bold', color:'#fff'}}>{t}</td>
                        <td style={{padding:'10px'}}>{d.count}</td>
                        <td style={{padding:'10px'}}>{d.count > 0 ? `${d.mise.toFixed(2)} €` : '-'}</td>
                        <td style={{padding:'10px'}}>{d.count > 0 ? `${d.retour.toFixed(2)} €` : '-'}</td>
                        <td style={{padding:'10px'}}>{d.count > 0 ? <Colorize val={d.pnl.toFixed(2)} isCurrency={true}/> : '-'}</td>
                        <td style={{padding:'10px'}}>{d.count > 0 ? (<><Colorize val={d.ROI}/>%</>) : '-'}</td>
                      </tr>);
                    })}
                  </tbody>
                </table>
              </div>
              {dashCalculs.nbSansTailleFreebet > 0 && <div style={{color:'#555', fontSize:'0.7rem', marginTop:'10px'}}>{dashCalculs.nbSansTailleFreebet} combiné(s) sans taille enregistrée, exclu(s) de ce tableau.</div>}
            </div>

            {/* 🆕 V2.1 §8 : indicateurs de sélection déjà stockés pour chaque combiné (Freebet Optimizer) — jamais recalculés. */}
            <details style={{ backgroundColor: '#1a1a1a', borderRadius: '8px', border: '1px solid #333' }}>
              <summary style={{ padding: '15px', cursor: 'pointer', color: '#aaa', fontWeight: 'bold' }}>📋 Détail des combinés Freebet ({dashCalculs.detailCombinesFreebet.length})</summary>
              <div style={{ padding: '0 20px 20px 20px', overflowX: 'auto' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc', fontSize: '0.85rem' }}>
                  <thead><tr style={{ color: '#888', borderBottom: '1px solid #444' }}><th style={{padding:'8px'}}>Date</th><th style={{padding:'8px'}}>Taille</th><th style={{padding:'8px'}}>Cote totale</th><th style={{padding:'8px'}}>Score</th><th style={{padding:'8px'}}>Risque</th><th style={{padding:'8px'}}>Proba</th><th style={{padding:'8px'}}>Edge</th><th style={{padding:'8px'}}>Résultat</th><th style={{padding:'8px'}}>PnL</th></tr></thead>
                  <tbody>
                    {dashCalculs.detailCombinesFreebet.map(c => (
                      <tr key={c.id} style={{ borderBottom: '1px solid #222' }}>
                        <td style={{padding:'8px'}}>{c.date}</td>
                        <td style={{padding:'8px'}}>{c.taille ? `x${c.taille}` : '-'}</td>
                        <td style={{padding:'8px'}}>{c.coteReelle || '-'}</td>
                        <td style={{padding:'8px'}}>{c.score !== null && c.score !== undefined ? c.score : '-'}</td>
                        <td style={{padding:'8px'}}>{c.risque || '-'}</td>
                        <td style={{padding:'8px'}}>{c.proba !== null && c.proba !== undefined ? `${c.proba}%` : '-'}</td>
                        <td style={{padding:'8px'}}>{c.edge !== null && c.edge !== undefined ? `${c.edge}%` : '-'}</td>
                        <td style={{padding:'8px', color: c.resultat === 'GAGNE' ? '#00ffcc' : (c.resultat === 'PERDU' ? '#ff4444' : '#ffcc00')}}>{c.resultat}</td>
                        <td style={{padding:'8px'}}><Colorize val={c.pnl.toFixed(2)} isCurrency={true}/></td>
                      </tr>
                    ))}
                    {dashCalculs.detailCombinesFreebet.length === 0 && (
                      <tr><td colSpan="9" style={{textAlign:'center', padding:'20px', color:'#555'}}>Aucun combiné sur cette période.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
          )}

          <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333' }}>
            <h3 style={{ color: '#aaa', marginTop: 0 }}>📝 REGISTRE DES TRANSACTIONS</h3>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#ccc' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #444', color: '#888' }}>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Ligue</th>
                  <th style={thStyle}>Match</th>
                  <th style={thStyle}>BOOK</th>
                  <th style={thStyle}>Fonds</th>
                  <th style={thStyle}>Choix</th>
                  <th style={thStyle}>Cote</th>
                  <th style={thStyle}>Résultat</th>
                  <th style={thStyle}>CLV</th>
                  <th style={thStyle}>Net</th>
                </tr>
              </thead>
              <tbody>
                  {dashCalculs.historique.map(pari => {
                    const clvPari = pari.cote_cloture > 0 ? ((pari.cote / pari.cote_cloture) - 1) * 100 : 0;

                    const estAnnule = pari.resultat === 'ANNULE';
                    return (
                      <tr key={pari.id} style={{ borderBottom: '1px solid #222', opacity: estAnnule ? 0.55 : 1 }}>
                        <td style={tdStyle}>{pari.date}</td>
                        <td style={{...tdStyle, color:'#00ffcc'}}>{pari.div}</td>
                        <td style={{...tdStyle, fontWeight: 'bold'}}>{pari.est_combine ? `🎫x${pari.taille_combine} ` : ''}{pari.match}</td>

                        <td style={tdStyle}>
                          <span style={getBookStyle(pari.bookmaker)}>{pari.bookmaker?.substring(0, 4)}</span>
                        </td>

                        <td style={tdStyle}>
                          <span style={{
                            color: pari.type_fond === 'FREEBET' ? '#cc66ff' : '#00ffcc',
                            border: `1px solid ${pari.type_fond === 'FREEBET' ? '#cc66ff' : '#00ffcc'}`,
                            padding: '2px 6px', borderRadius: '3px', fontSize: '0.7rem', fontWeight: 'bold',
                            whiteSpace: 'nowrap', display: 'inline-block'
                          }}>
                            {pari.type_fond === 'FREEBET' ? '🎁 FREEBET' : '💶 CASH'}
                          </span>
                        </td>

                        <td style={tdStyle}>{pari.choix}</td>
                        <td style={tdStyle}>{pari.cote}</td>
                        <td style={{...tdStyle, fontWeight: 'bold', color: estAnnule ? '#888' : (pari.resultat === 'GAGNE' ? '#00ffcc' : '#ff4444')}}>
                          {estAnnule ? '🚫 ANNULÉ' : pari.resultat}
                        </td>

                        <td style={tdStyle}>
                          {pari.cote_cloture > 0 ? <Colorize val={clvPari.toFixed(2)}/> : '-'}%
                        </td>

                        <td style={tdStyle}>{estAnnule ? <span style={{ color: '#888' }}>—</span> : <Colorize val={pari.pnl.toFixed(2)} isCurrency={true} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VUE TRADING */}
      {vueActuelle === 'TRADING' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', marginBottom: '20px' }}>
            <button style={activeTab === 'A_REMPLIR' ? tabActive : tabInactive} onClick={() => changerOngletTrading('A_REMPLIR')}>🎯 À RENSEIGNER ({nbARemplir})</button>
            <button style={activeTab === 'ANALYSE' ? tabActive : tabInactive} onClick={() => changerOngletTrading('ANALYSE')}>🔬 PRÊT / ANALYSÉ ({nbAnalyse})</button>
            <button style={activeTab === 'JOUE' ? tabActive : tabInactive} onClick={() => changerOngletTrading('JOUE')}>💰 PARIS JOUÉS ({nbJoue})</button>
            <button style={activeTab === 'FREEBET' ? tabActive : tabInactive} onClick={() => changerOngletTrading('FREEBET')}>🎁 FREEBET OPTIMIZER</button>
          </div>

          {activeTab !== 'ANALYSE' && activeTab !== 'FREEBET' && (
            <div style={{ maxWidth: '900px', margin: '0 auto 30px auto', display: 'flex', justifyContent: 'center', gap: '20px', backgroundColor: '#1a1a1a', padding: '15px', borderRadius: '8px', border: '1px solid #333' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}><span style={{ color: '#888' }}>Du :</span><input type="date" value={filtreDateDebut} onChange={e => setFiltreDateDebut(e.target.value)} style={dateInputStyle} /></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}><span style={{ color: '#888' }}>Au :</span><input type="date" value={filtreDateFin} onChange={e => setFiltreDateFin(e.target.value)} style={dateInputStyle} /></div>
              <button onClick={() => {setFiltreDateDebut(''); setFiltreDateFin('');}} style={{ padding: '10px', backgroundColor: '#333', color: '#ff4444', border: '1px solid #ff4444', borderRadius: '4px', cursor: 'pointer' }}>Reset Filtre</button>
            </div>
          )}

          {resultat && (
             <div style={{ maxWidth: '900px', margin: '0 auto 30px auto' }}>
                <div style={{...resultatStyle, margin: '0 0 20px 0'}}>
                  <h2 style={{ color: '#00ffcc', borderBottom: '1px solid #333', paddingBottom: '10px' }}>✅ MATRICE DE TIR : {resultat.Match} <span style={{fontSize: '0.8rem', color: '#888'}}>({resultat.matchObj.div})</span></h2>

                  <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
                    <div style={{ flex: 1, backgroundColor: '#1e1e1e', padding: '15px', borderRadius: '5px' }}>
                      <h3 style={{ color: '#aaa' }}>1. RADAR MARCHÉ (Drops)</h3>
                      <p><b>H :</b> Ouv {resultat.Radar_Marche.Ouv.H} ➔ Act {resultat.Radar_Marche.Act.H} (<Colorize val={resultat.Radar_Marche.Drop.H} inverse />)</p>
                      <p><b>D :</b> Ouv {resultat.Radar_Marche.Ouv.D} ➔ Act {resultat.Radar_Marche.Act.D} (<Colorize val={resultat.Radar_Marche.Drop.D} inverse />)</p>
                      <p><b>A :</b> Ouv {resultat.Radar_Marche.Ouv.A} ➔ Act {resultat.Radar_Marche.Act.A} (<Colorize val={resultat.Radar_Marche.Drop.A} inverse />)</p>

                      <h3 style={{ color: '#aaa', marginTop: '20px' }}>2. PROBABILITÉS PURES (%)</h3>
                      <table style={tableStyle}>
                        <thead><tr><th></th><th>H</th><th>D</th><th>A</th></tr></thead>
                        <tbody>
                          <tr><td><b>LGBM</b></td><td>{resultat.Matrice_Probas.LGBM.H}</td><td>{resultat.Matrice_Probas.LGBM.D}</td><td>{resultat.Matrice_Probas.LGBM.A}</td></tr>
                          <tr><td><b>XGB</b></td><td>{resultat.Matrice_Probas.XGB.H}</td><td>{resultat.Matrice_Probas.XGB.D}</td><td>{resultat.Matrice_Probas.XGB.A}</td></tr>
                          <tr><td style={{color:'#ffcc00'}}><b>HYDRE</b></td><td style={{color:'#ffcc00'}}>{resultat.Matrice_Probas.Hydre.H}</td><td style={{color:'#ffcc00'}}>{resultat.Matrice_Probas.Hydre.D}</td><td style={{color:'#ffcc00'}}>{resultat.Matrice_Probas.Hydre.A}</td></tr>
                        </tbody>
                      </table>
                    </div>

                    <div style={{ flex: 1, backgroundColor: '#1e1e1e', padding: '15px', borderRadius: '5px' }}>
                      <h3 style={{ color: '#aaa' }}>3. MATRICE DES EDGES (Value %)</h3>
                      <table style={tableStyle}>
                        <thead><tr><th></th><th>H</th><th>D</th><th>A</th></tr></thead>
                        <tbody>
                          <tr><td><b>LGBM</b></td><td><Colorize val={resultat.Scanner_Value.LGBM.H}/></td><td><Colorize val={resultat.Scanner_Value.LGBM.D}/></td><td><Colorize val={resultat.Scanner_Value.LGBM.A}/></td></tr>
                          <tr><td><b>XGB</b></td><td><Colorize val={resultat.Scanner_Value.XGB.H}/></td><td><Colorize val={resultat.Scanner_Value.XGB.D}/></td><td><Colorize val={resultat.Scanner_Value.XGB.A}/></td></tr>
                          <tr><td style={{color:'#ffcc00'}}><b>HYDRE</b></td><td><Colorize val={resultat.Scanner_Value.Hydre.H}/></td><td><Colorize val={resultat.Scanner_Value.Hydre.D}/></td><td><Colorize val={resultat.Scanner_Value.Hydre.A}/></td></tr>
                        </tbody>
                      </table>

                      <h3 style={{ color: '#aaa', marginTop: '20px' }}>4. BOUCLIERS (Double Chance)</h3>
                      <p><b>1X :</b> Proba {resultat.Boucliers.DC_1X.Proba}% | Min: {resultat.Boucliers.DC_1X.CoteMin}</p>
                      <p><b>X2 :</b> Proba {resultat.Boucliers.DC_X2.Proba}% | Min: {resultat.Boucliers.DC_X2.CoteMin}</p>
                      <p><b>12 :</b> Proba {resultat.Boucliers.DC_12.Proba}% | Min: {resultat.Boucliers.DC_12.CoteMin}</p>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
                    <div style={{ flex: 1, backgroundColor: '#1a1a1a', padding: '15px', borderRadius: '5px', borderLeft: '4px solid #00ffcc' }}>
                      <h3 style={{ color: '#aaa', margin: '0 0 10px 0' }}>5. VARIABLES D'ÉLITE (H vs A)</h3>
                      <table style={tableStyle}>
                        <thead><tr><th style={{textAlign:'left'}}>Moteur</th><th>Dom</th><th>Ext</th><th>Delta</th></tr></thead>
                        <tbody>
                          <tr><td style={{textAlign:'left'}}><b>xG Attendu</b></td><td>{resultat.Top_Stats.xG.H}</td><td>{resultat.Top_Stats.xG.A}</td><td><Colorize val={resultat.Top_Stats.xG.Delta} /></td></tr>
                          <tr><td style={{textAlign:'left'}}><b>Vol. Tirs (15J)</b></td><td>{resultat.Top_Stats.Tirs.H}</td><td>{resultat.Top_Stats.Tirs.A}</td><td><Colorize val={resultat.Top_Stats.Tirs.Delta} /></td></tr>
                          <tr><td style={{textAlign:'left'}}><b>PPG Saison</b></td><td>{resultat.Top_Stats.PPG.H}</td><td>{resultat.Top_Stats.PPG.A}</td><td><Colorize val={resultat.Top_Stats.PPG.Delta} /></td></tr>
                        </tbody>
                      </table>
                    </div>
                    <div style={{ flex: 1, backgroundColor: '#1a1a1a', padding: '15px', borderRadius: '5px', borderLeft: '4px solid #ffcc00' }}>
                      <h3 style={{ color: '#aaa', margin: '0 0 10px 0' }}>6. EXTRACTEUR D'ANOMALIES</h3>
                      {resultat.Anomalies.map((ano, idx) => <div key={idx} style={{ marginBottom: '8px', fontSize: '0.95rem' }}>{ano}</div>)}
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '5px', marginTop: '20px', border: `1px solid ${resultat.Juge.Type === 'VALIDE' ? '#00ffcc' : '#ff4444'}` }}>
                    <h3 style={{ color: resultat.Juge.Type === 'VALIDE' ? '#00ffcc' : '#ff4444', margin: '0 0 15px 0', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{resultat.Juge.Type === 'VALIDE' ? '🎯 LE COMITÉ DE SÉLECTION (Historique — informatif)' : '⛔ LE COMITÉ DE SÉLECTION (Historique — informatif)'}</span>
                      <span>{resultat.Juge.Message}</span>
                    </h3>
                    <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', color: '#fff', fontSize: '0.9rem' }}>
                      <thead><tr style={{ color: '#888', borderBottom: '1px solid #333' }}><th style={{paddingBottom:'10px'}}>Issue</th><th style={{paddingBottom:'10px'}}>Cote / Edge</th><th style={{paddingBottom:'10px'}}>Case Matrice</th><th style={{paddingBottom:'10px'}}>Histo. (Matchs)</th><th style={{paddingBottom:'10px'}}>ROI Histo.</th><th style={{paddingBottom:'10px'}}>Verdict</th></tr></thead>
                      <tbody>
                        {resultat.Audit_Comite.map((audit, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #222', backgroundColor: audit.statut === 'VALIDE' ? 'rgba(0, 255, 204, 0.05)' : 'transparent' }}>
                            <td style={{padding:'12px 5px', fontWeight:'bold'}}>{audit.issue}</td>
                            <td style={{padding:'12px 5px'}}>{audit.cote} / <Colorize val={audit.edge} />%</td>
                            <td style={{padding:'12px 5px', color: '#aaa'}}>{audit.detail}</td>
                            <td style={{padding:'12px 5px', color: audit.volume < 50 ? '#ffcc00' : '#fff'}}>{audit.volume}</td>
                            <td style={{padding:'12px 5px'}}><Colorize val={audit.roi} />%</td>
                            <td style={{padding:'12px 5px', fontWeight: 'bold', color: audit.statut === 'VALIDE' ? '#00ffcc' : '#ff4444'}}>{audit.tag}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p style={{ color: '#666', fontSize: '0.8rem', marginTop: '10px', marginBottom: 0 }}>ℹ️ Ce comité est l'ancienne Matrice 3D historique — purement informatif. La décision Sélectionné/Potable/Non Conforme est désormais prise par le Scanner de Marché (proba &gt; 45%, cote 1.00–3.00, edge &gt; 0).</p>
                  </div>

                  {resultat.matchObj.statut !== 'JOUE' ? (
                    <div style={{ backgroundColor: '#2a2a2a', padding: '20px', borderRadius: '5px', marginTop: '20px', border: '1px solid #444' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                        <h3 style={{ margin: 0, color: '#ffcc00' }}>7. SÉLECTION DU TRADE</h3>
                        <div style={{ display: 'flex', gap: '15px' }}>
                            <div style={{ backgroundColor: '#121212', padding: '10px', borderRadius: '5px', border: '1px solid #00ffcc', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ color: '#888' }}>MISE (€) : </span>
                            <input type="number" step="0.1" value={misesManuelles[resultat.matchObj.id] !== undefined ? misesManuelles[resultat.matchObj.id] : getMiseRecommandeeScanner(resultat.matchObj.id)} onChange={e => setMisesManuelles({...misesManuelles, [resultat.matchObj.id]: e.target.value})} style={{ width: '80px', padding: '5px', backgroundColor: '#121212', color: '#00ffcc', border: 'none', fontSize: '1.2rem', fontWeight: 'bold', outline: 'none', textAlign: 'center' }} />
                            </div>
                            <select value={typeFond} onChange={(e) => setTypeFond(e.target.value)} style={{ padding: '10px', backgroundColor: '#121212', color: typeFond === 'FREEBET' ? '#ff4444' : '#00ffcc', border: `1px solid ${typeFond === 'FREEBET' ? '#ff4444' : '#00ffcc'}`, fontWeight: 'bold', outline: 'none' }}>
                                <option value="CASH">💶 PAYER EN CASH</option>
                                <option value="FREEBET">🎁 PAYER EN FREEBET</option>
                            </select>
                        </div>
                      </div>

                      {choixPari && (() => {
                        const verrouille = coteEstVerrouillee(resultat.matchObj.date);
                        return (
                          <div style={{ backgroundColor: '#121212', padding: '10px', borderRadius: '5px', border: `1px solid ${verrouille ? '#555' : '#ffcc00'}`, display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
                            <span style={{ color: '#888', fontSize: '0.85rem' }}>{verrouille ? '🔒 Cote verrouillée (< H-2) — ' : 'Cote réellement obtenue chez le bookmaker : '}</span>
                            <input type="number" step="0.01" disabled={verrouille} placeholder="Cote calculée par défaut" value={coteReelleOverride} onChange={e => setCoteReelleOverride(e.target.value)}
                              style={{ width: '110px', padding: '5px', backgroundColor: verrouille ? '#1a1a1a' : '#121212', color: verrouille ? '#666' : '#ffcc00', border: 'none', outline: 'none' }} />
                            {verrouille && <span style={{ color: '#666', fontSize: '0.8rem' }}>Moins de 2h avant le coup d'envoi : la cote calculée fait foi.</span>}
                          </div>
                        );
                      })()}

                      {finances.freebets.disponible > 0 && choixPari && (
                         (() => {
                             let currentCote = 0;
                             if (choixPari === 'H') currentCote = parseFloat(cotesActuelles[resultat.matchObj.id]?.dom);
                             else if (choixPari === 'D') currentCote = parseFloat(cotesActuelles[resultat.matchObj.id]?.nul);
                             else if (choixPari === 'A') currentCote = parseFloat(cotesActuelles[resultat.matchObj.id]?.ext);
                             else if (['1X', 'X2', '12'].includes(choixPari) && coteDC) currentCote = parseFloat(coteDC);

                             if (currentCote >= 3.00) {
                                 return (
                                     <div className="blink" style={{ backgroundColor: '#4a1111', padding: '10px', borderRadius: '5px', border: '1px solid #ff4444', marginBottom: '15px', color: '#ff4444', fontWeight: 'bold', textAlign: 'center' }}>
                                         💡 OPTIMISATION QUANT : La cote ({currentCote}) est idéale pour convertir un Freebet !
                                     </div>
                                 );
                             }
                             return null;
                         })()
                      )}

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                        <div style={{ display: 'flex', gap: '15px' }}>
                          <select value={choixPari} onChange={(e) => {setChoixPari(e.target.value); setCoteDC("");}} style={{ flex: 1, padding: '10px', backgroundColor: '#121212', color: '#fff', border: '1px solid #00ffcc' }}>
                            <option value="">-- Sur quoi as-tu cliqué chez Winamax ? --</option>
                            <option value="H">Victoire Domicile ({cotesActuelles[resultat.matchObj.id]?.dom})</option>
                            <option value="D">Match Nul ({cotesActuelles[resultat.matchObj.id]?.nul})</option>
                            <option value="A">Victoire Extérieur ({cotesActuelles[resultat.matchObj.id]?.ext})</option>
                            <option value="1X">Double Chance 1X</option>
                            <option value="X2">Double Chance X2</option>
                            <option value="12">Double Chance 12</option>
                          </select>

                          <select value={bookmakerChoisi} onChange={(e) => setBookmakerChoisi(e.target.value)} style={{ padding: '10px', backgroundColor: '#121212', color: '#ffcc00', border: '1px solid #ffcc00', fontWeight: 'bold', outline: 'none' }}>
                            <option value="BETCLIC">⚪ Betclic</option>
                            <option value="WINAMAX">🔴 Winamax</option>
                            <option value="UNIBET">🟢 Unibet</option>
                          </select>

                          <button onClick={() => validerPari(resultat.matchObj)} disabled={estViewer} style={{...btnValider, opacity: estViewer ? 0.5 : 1, cursor: estViewer ? 'not-allowed' : 'pointer'}}>🔥 ENGAGER LE TIR</button>
                        </div>

                        {['1X', 'X2', '12'].includes(choixPari) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '15px', backgroundColor: '#1a1a1a', padding: '15px', borderRadius: '5px', border: '1px dotted #ffcc00' }}>
                            <label style={{ color: '#fff' }}>Saisis la cote Winamax pour {choixPari} :</label>
                            <input type="number" step="0.01" value={coteDC} onChange={e => setCoteDC(e.target.value)} style={{...inputStyle, width: '100px'}} />
                            {coteDC && <span style={{ fontSize: '1.2rem', fontWeight: 'bold', color: parseFloat(coteDC) >= resultat.Boucliers[`DC_${choixPari}`].CoteMin ? '#00ffcc' : '#ff4444' }}>{parseFloat(coteDC) >= resultat.Boucliers[`DC_${choixPari}`].CoteMin ? '✅ VALUE BET CONFIRMÉ' : '❌ COTE TROP FAIBLE (NO BET)'}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '5px', marginTop: '20px', border: '1px solid #00ffcc', textAlign: 'center' }}><h3 style={{ margin: '0', color: '#00ffcc' }}>🔒 TRADE DÉJÀ VERROUILLÉ DANS LE COFFRE-FORT</h3></div>
                  )}

                  <div style={{ display: 'flex', gap: '15px', marginTop: '20px' }}>
                    <button onClick={copierRapportPourIA} style={{ flex: 2, padding: '15px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '1.1rem' }}>📋 COPIER LE RAPPORT POUR L'IA</button>
                    <button onClick={() => setResultat(null)} style={{ flex: 1, padding: '15px', backgroundColor: '#333', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Fermer la Matrice</button>
                  </div>
                </div>
             </div>
          )}

          {activeTab === 'ANALYSE' ? (
            <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
              {scannerData && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1a1a1a', padding: '15px 20px', borderRadius: '8px', border: '1px solid #333', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
                  <div style={{ color: '#888' }}>
                    Profil : <span style={{ color: '#00ffcc', fontWeight: 'bold' }}>{scannerData.profil}</span>
                    {' '}({scannerData.exposition_max}% max)
                    {' '}— <span style={{ color: '#ffcc00' }}>{scannerData.nb_selectionnes}</span> sélectionné(s) aujourd'hui
                    {' '}— mise unitaire : <span style={{ color: '#00ffcc' }}>{scannerData.mise_unitaire_pct}%</span>
                    {' '}— exposition utilisée (aujourd'hui) : <span style={{ color: '#ffcc00' }}>{scannerData.exposition_utilisee_pct}%</span>
                  </div>
                  <button onClick={chargerScanner} style={{ padding: '8px 14px', backgroundColor: '#333', color: '#00ffcc', border: '1px solid #00ffcc', borderRadius: '4px', cursor: 'pointer' }}>🔄 Rafraîchir</button>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '15px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {[['TOUS', 'Tous'], ['SELECTIONNE', '🟢 Sélectionnés'], ['POTABLE', '🟡 Potables'], ['NON_CONFORME', '🔴 Non conformes']].map(([val, label]) => (
                    <button key={val} onClick={() => setFiltreStatutScanner(val)} style={filtreStatutScanner === val ? tabActive : tabInactive}>{label}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {/* 🆕 §10 : filtre par date RÉELLE du match — permet de préparer demain sans le mélanger à aujourd'hui */}
                  {[['TOUTES', '📅 Toutes dates'], ['AUJOURDHUI', "📅 Aujourd'hui"], ['DEMAIN', '📅 Demain']].map(([val, label]) => (
                    <button key={val} onClick={() => setFiltreDateScanner(val)} style={filtreDateScanner === val ? tabActive : tabInactive}>{label}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ color: '#888' }}>Trier par :</span>
                  <select value={triScanner} onChange={e => setTriScanner(e.target.value)} style={dateInputStyle}>
                    <option value="score">Score</option>
                    <option value="edge">Edge</option>
                    <option value="heure">Heure</option>
                    <option value="ligue">Championnat</option>
                  </select>
                </div>
              </div>

              {(() => {
                if (!scannerData) return <div style={{ textAlign: 'center', padding: '30px', color: '#666' }}>Scanner en cours de chargement...</div>;

                let liste = [...scannerData.matchs];
                if (filtreStatutScanner !== 'TOUS') liste = liste.filter(m => m.statut === filtreStatutScanner);
                if (filtreDateScanner === 'AUJOURDHUI') liste = liste.filter(m => m.date.startsWith(todayStr));
                else if (filtreDateScanner === 'DEMAIN') liste = liste.filter(m => m.date.startsWith(tomorrowStr));

                liste.sort((a, b) => {
                  if (triScanner === 'score') return (b.score || 0) - (a.score || 0);
                  if (triScanner === 'edge') return (b.edge || 0) - (a.edge || 0);
                  if (triScanner === 'heure') return a.date.localeCompare(b.date);
                  if (triScanner === 'ligue') return (a.div || '').localeCompare(b.div || '');
                  return 0;
                });

                if (liste.length === 0) return <div style={{ textAlign: 'center', padding: '30px', color: '#666' }}>Aucun match dans cette catégorie.</div>;

                return liste.map(m => {
                  const match = matchs.find(mm => mm.id === m.id);
                  if (!match) return null;
                  const badge = BADGE_INFO[m.statut];
                  const isMatchAnalysed = resultat && resultat.matchObj.id === match.id;
                  const ageSec = (new Date().getTime() / 1000) - (match.derniere_analyse || 0);
                  const estPerime = match.statut === 'ANALYSE' && match.derniere_analyse > 0 && ageSec > 7200;

                  return (
                    <div key={m.id} style={{ backgroundColor: '#1e1e1e', marginBottom: '10px', borderRadius: '5px', border: isMatchAnalysed ? '2px solid #00ffcc' : `1px solid ${badge.color}55` }}>
                      <div onClick={() => setExpandedId(expandedId === match.id ? null : match.id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px', cursor: 'pointer', backgroundColor: expandedId === match.id ? '#2a2a2a' : 'transparent', flexWrap: 'wrap', gap: '10px' }}>
                        <span style={{ color: badge.color, fontWeight: 'bold', fontSize: '0.8rem', border: `1px solid ${badge.color}`, padding: '3px 8px', borderRadius: '4px', minWidth: '150px', textAlign: 'center' }}>{badge.emoji} {badge.label}</span>
                        <span style={{ color: '#666', fontSize: '0.75rem', minWidth: '85px' }}>📅 {match.date.split(' ')[0]}{match.date.split(' ')[0] === todayStr ? ' (Auj.)' : match.date.split(' ')[0] === tomorrowStr ? ' (Dem.)' : ''}</span>
                        <span style={{ color: estPerime ? '#ffcc00' : '#888', minWidth: '55px' }}>🕒 {ajusterHeure(match.time || match.date.split(' ')[1])}</span>
                        <span style={{ color: '#ffcc00', minWidth: '45px' }}>{m.div}</span>
                        <span style={{ fontWeight: 'bold', fontSize: '1rem', flex: 1, minWidth: '200px' }}>{match.home_team} - {match.away_team}{estPerime && ' ⚠️'}</span>
                        {m.issue && <span style={{ color: '#fff', fontSize: '0.85rem', minWidth: '140px' }}>{ISSUE_LABELS[m.issue]} @ {m.cote}</span>}
                        {m.statut !== 'NON_CONFORME' && (
                          <>
                            <span style={{ color: '#00ffcc', fontWeight: 'bold', minWidth: '65px' }}>⭐ {m.score}</span>
                            <span style={{ minWidth: '55px' }}><Colorize val={m.edge} />%</span>
                            {m.statut === 'SELECTIONNE' && <span style={{ color: '#ffcc00', fontWeight: 'bold', minWidth: '110px' }}>💰 {m.mise_euros}€ ({m.mise_pct}%)</span>}
                          </>
                        )}
                        <span style={{ color: '#00ffcc' }}>{expandedId === match.id ? '▲' : '▼'}</span>
                      </div>

                      {expandedId === match.id && (
                        <div style={{ padding: '20px', borderTop: '1px solid #333' }}>
                          <div style={{ display: 'flex', gap: '15px', marginBottom: '15px' }}>
                            <div style={{ flex: 1 }}><label style={lblStyle}>Ouv H ({match.cote_ouv_dom}) ➔ Act H:</label><input type="number" step="0.01" style={inputStyle} value={cotesActuelles[match.id]?.dom || ''} onChange={e => handleCoteChange(match.id, 'dom', e.target.value)} /></div>
                            <div style={{ flex: 1 }}><label style={lblStyle}>Ouv D ({match.cote_ouv_nul}) ➔ Act D:</label><input type="number" step="0.01" style={inputStyle} value={cotesActuelles[match.id]?.nul || ''} onChange={e => handleCoteChange(match.id, 'nul', e.target.value)} /></div>
                            <div style={{ flex: 1 }}><label style={lblStyle}>Ouv A ({match.cote_ouv_ext}) ➔ Act A:</label><input type="number" step="0.01" style={inputStyle} value={cotesActuelles[match.id]?.ext || ''} onChange={e => handleCoteChange(match.id, 'ext', e.target.value)} /></div>
                          </div>
                          <div style={{ display: 'flex', gap: '10px' }}>
                            <button onClick={() => analyserMatch(match)} disabled={loadingId === match.id || estViewer} style={{...buttonStyle, flex: 3}}>{estPerime ? '🔄 RECALCULER' : (loadingId === match.id ? 'CALCUL...' : '📊 OUVRIR LA MATRICE DE TIR')}</button>
                            <button onClick={() => resetMatch(match)} disabled={estViewer} style={{ padding: '12px', backgroundColor: '#333', color: '#ff4444', border: '1px solid #ff4444', borderRadius: '4px', cursor: estViewer ? 'not-allowed' : 'pointer', flex: 1, opacity: estViewer ? 0.5 : 1 }}>🗑️ Purger</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          ) : activeTab === 'FREEBET' ? (
            <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1a1a1a', padding: '15px 20px', borderRadius: '8px', border: '1px solid #333', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
                <div style={{ color: '#888' }}>
                  🎯 <span style={{ color: '#ffcc00', fontWeight: 'bold' }}>{freebetCandidats.length}</span> match(s) éligible(s) aujourd'hui (Sélectionné/Potable, non commencé)
                  {' '}— Bankroll CASH (réf. Kelly) : <span style={{ color: '#00ffcc' }}>{finances.total.toFixed(2)} €</span>
                  {' '}— Freebets dispo : <span style={{ color: '#ff4444' }}>{finances.freebets.disponible.toFixed(2)} €</span>
                </div>
                <button onClick={chargerFreebetCandidats} style={{ padding: '8px 14px', backgroundColor: '#333', color: '#00ffcc', border: '1px solid #00ffcc', borderRadius: '4px', cursor: 'pointer' }}>🔄 Rafraîchir</button>
              </div>

              <div style={{ backgroundColor: '#1a1a1a', padding: '15px 20px', borderRadius: '8px', border: '1px solid #333', marginBottom: '20px' }}>
                <div style={{ color: '#888', marginBottom: '10px' }}>Tailles de combinés à rechercher (sélection multiple, jamais de pari simple) :</div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                  {[2, 3, 4, 5, 6, 7, 8].map(t => (
                    <button key={t} onClick={() => toggleTailleFreebet(t)} style={freebetTaillesChoisies.includes(t) ? tabActive : tabInactive}>x{t}</button>
                  ))}
                  <button onClick={lancerRechercheFreebet} disabled={freebetChargement} style={{ ...buttonStyle, width: 'auto', padding: '12px 25px', marginLeft: '10px' }}>
                    {freebetChargement ? '⏳ CALCUL EN COURS...' : '🔍 RECHERCHER LES MEILLEURS COMBINÉS'}
                  </button>
                  <button onClick={lancerRecherchePortefeuille} disabled={freebetPortefeuilleChargement} style={{ ...buttonStyle, width: 'auto', padding: '12px 25px', color: '#cc66ff', borderColor: '#cc66ff' }}>
                    {freebetPortefeuilleChargement ? '⏳ CONSTRUCTION EN COURS...' : '🧺 CONSTRUIRE UN PORTEFEUILLE DIVERSIFIÉ'}
                  </button>
                </div>
              </div>

              {/* 🆕 PROGRESSION DE LA RECHERCHE — avancement réel du calcul backend pendant la
                  construction du portefeuille (barre, %, candidats évalués/total, étape en
                  cours, temps écoulé, estimation du temps restant). Reste affiché après la fin
                  du calcul pour confirmer clairement "recherche terminée" + nb de tickets. */}
              {freebetProgression && (
                <div style={{ backgroundColor: '#1a1a1a', padding: '15px 20px', borderRadius: '8px', border: `1px solid ${freebetProgression.termine ? '#00ffcc55' : '#cc66ff55'}`, marginBottom: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ color: freebetProgression.termine ? '#00ffcc' : '#cc66ff', fontWeight: 'bold' }}>
                      {freebetProgression.termine ? '✅ RECHERCHE TERMINÉE' : '🧺 CONSTRUCTION DU PORTEFEUILLE EN COURS…'}
                    </div>
                    <div style={{ color: '#888', fontSize: '0.85rem' }}>
                      {freebetProgression.candidats_evalues != null && freebetProgression.candidats_total != null &&
                        `${freebetProgression.candidats_evalues} / ${freebetProgression.candidats_total} candidats évalués`}
                    </div>
                  </div>
                  <div style={{ width: '100%', height: '10px', backgroundColor: '#000', borderRadius: '5px', overflow: 'hidden', marginBottom: '8px' }}>
                    <div style={{
                      width: `${freebetProgression.pourcentage || 0}%`, height: '100%',
                      backgroundColor: freebetProgression.termine ? '#00ffcc' : '#cc66ff',
                      transition: 'width 0.4s ease'
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', fontSize: '0.85rem', color: '#aaa' }}>
                    <div>{freebetProgression.etape || ''}</div>
                    <div style={{ display: 'flex', gap: '15px' }}>
                      <span>{(freebetProgression.pourcentage || 0).toFixed(1)}%</span>
                      <span>⏱️ {(freebetProgression.temps_ecoule_sec || 0).toFixed(0)}s écoulées</span>
                      {!freebetProgression.termine && freebetProgression.temps_restant_estime_sec != null && (
                        <span>~{freebetProgression.temps_restant_estime_sec.toFixed(0)}s restantes</span>
                      )}
                    </div>
                  </div>
                  {freebetProgression.termine && (
                    <div style={{ marginTop: '8px', color: '#00ffcc', fontWeight: 'bold' }}>
                      🎟️ {freebetProgression.nb_tickets_retenus} ticket(s) retenu(s).
                    </div>
                  )}
                </div>
              )}

              {freebetCandidats.length === 0 && (
                <div style={{ textAlign: 'center', padding: '30px', color: '#666' }}>Aucun match Sélectionné/Potable et non commencé aujourd'hui pour l'instant.</div>
              )}

              {freebetCandidats.length > 0 && (
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '20px' }}>
                  {(freebetResultats || freebetPortefeuille) && (
                    <>
                      <button onClick={() => setFreebetSousVue('CLASSEMENT')} style={freebetSousVue === 'CLASSEMENT' ? tabActive : tabInactive}>📋 Meilleurs tickets individuels</button>
                      <button onClick={() => setFreebetSousVue('PORTEFEUILLE')} style={freebetSousVue === 'PORTEFEUILLE' ? tabActive : tabInactive}>🧺 Portefeuille recommandé</button>
                    </>
                  )}
                  <button onClick={() => setFreebetSousVue('CONSTRUCTEUR')} style={freebetSousVue === 'CONSTRUCTEUR' ? { ...tabActive, backgroundColor: '#ffcc00' } : tabInactive}>🛠️ Constructeur manuel</button>
                </div>
              )}

              {freebetSousVue === 'PORTEFEUILLE' && freebetPortefeuille && (() => {
                const pf = freebetPortefeuille;
                const sp = pf.score_portefeuille || {};
                const divDetail = sp.diversification_detail || {};
                const dist = sp.distribution || {};
                const seuils = dist.proba_par_seuil_gain || [];
                return (
                  <>
                    <div style={{ backgroundColor: '#1a1a1a', padding: '15px 20px', borderRadius: '8px', border: '1px solid #cc66ff55', marginBottom: '20px' }}>
                      <div style={{ color: '#cc66ff', fontWeight: 'bold', marginBottom: '10px' }}>🧺 COMPOSITION DU PORTEFEUILLE RECOMMANDÉ</div>
                      <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>TICKETS</div><div style={kpiValue}>{divDetail.nb_tickets || 0}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px', border: '1px solid #cc66ff' }}><div style={{...kpiLabel, color:'#cc66ff'}}>SCORE PORTEFEUILLE</div><div style={{ ...kpiValue, color: '#cc66ff' }}>{sp.score_global != null ? sp.score_global : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>MISE ENGAGÉE / DISPONIBLE</div><div style={{ ...kpiValue, color: '#00ffcc', fontSize: '1.1rem' }}>{pf.mise_totale_recommandee_portefeuille.toFixed(2)} € <span style={{fontSize:'0.7rem', color:'#888'}}>/ {pf.budget_freebet_disponible.toFixed(2)} €</span></div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>EV TOTAL</div><div style={{ ...kpiValue }}><Colorize val={dist.ev} /> €</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>EV / € ENGAGÉ</div><div style={{ ...kpiValue }}><Colorize val={dist.ev_par_euro_engage} /></div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>P(GAIN &gt; 0)</div><div style={{ ...kpiValue, color: '#00ffcc' }}>{dist.proba_gain_positif_pct != null ? `${dist.proba_gain_positif_pct}%` : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>P(TOUT PERDRE)</div><div style={{ ...kpiValue, color: '#ff4444' }}>{dist.proba_perte_totale_pct != null ? `${dist.proba_perte_totale_pct}%` : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>GAIN MÉDIAN</div><div style={kpiValue}>{dist.gain_median != null ? `${dist.gain_median.toFixed(2)} €` : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>GAIN MAXIMAL</div><div style={{ ...kpiValue, color: '#00ffcc' }}>{dist.gain_maximal != null ? `${dist.gain_maximal.toFixed(2)} €` : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>QUALITÉ MOYENNE</div><div style={kpiValue}>{sp.qualite_moyenne != null ? sp.qualite_moyenne : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>DIVERSIFICATION</div><div style={{ ...kpiValue, color: '#00ffcc' }}>{sp.score_diversification != null ? sp.score_diversification : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>COUVERTURE</div><div style={kpiValue}>{sp.couverture_pct != null ? `${sp.couverture_pct}%` : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>RECOUVREMENT MOYEN</div><div style={kpiValue}>{divDetail.recouvrement_moyen_pct != null ? `${divDetail.recouvrement_moyen_pct}%` : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>CONCENTRATION MAX (1 MATCH)</div><div style={{ ...kpiValue, color: (divDetail.exposition_max_pct || 0) >= 60 ? '#ff4444' : '#ccc' }}>{divDetail.exposition_max_pct != null ? `${divDetail.exposition_max_pct}%` : '-'}</div></div>
                        <div style={{ ...kpiCard, flex: '1 1 140px' }}><div style={kpiLabel}>ÉQUILIBRE PROFILS</div><div style={kpiValue}>{sp.score_equilibre_profils != null ? sp.score_equilibre_profils : '-'}</div></div>
                      </div>

                      {seuils.length > 0 && (
                        <div style={{ marginTop: '15px' }}>
                          <div style={{ color: '#888', fontSize: '0.8rem', marginBottom: '6px' }}>PROBABILITÉ D'ATTEINDRE UN NIVEAU DE GAIN (seuils adaptés à la mise engagée)</div>
                          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                            {seuils.map((s, i) => (
                              <div key={i} style={{ ...kpiCard, flex: '1 1 100px', padding: '8px 10px' }}>
                                <div style={{ ...kpiLabel, fontSize: '0.7rem' }}>≥ {s.seuil.toFixed(2)} €</div>
                                <div style={{ ...kpiValue, fontSize: '1rem', color: '#00ffcc' }}>{s.proba_pct}%</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {divDetail.matchs_critiques && divDetail.matchs_critiques.length > 0 && (
                      <div style={{ backgroundColor: '#2a1a00', border: '1px solid #ff4444', color: '#ff4444', padding: '12px 15px', borderRadius: '5px', marginBottom: '20px', fontSize: '0.85rem' }}>
                        {divDetail.matchs_critiques.map(m => (
                          <div key={m.id}>⚠️ Match critique ({m.niveau_concentration === 'TRES_FORTE' ? 'très forte' : 'forte'} concentration) : <b>{m.home_team} - {m.away_team}</b> présent dans {m.nb_tickets} ticket(s) sur {divDetail.nb_tickets} ({m.exposition_pct}% du portefeuille).</div>
                        ))}
                      </div>
                    )}

                    {divDetail.concentration_matchs && divDetail.concentration_matchs.length > 0 && (
                      <details style={{ backgroundColor: '#1a1a1a', borderRadius: '8px', border: '1px solid #333', marginBottom: '20px' }}>
                        <summary style={{ padding: '15px', cursor: 'pointer', color: '#aaa', fontWeight: 'bold' }}>📊 Concentration détaillée par match ({divDetail.concentration_matchs.length})</summary>
                        <div style={{ padding: '0 15px 15px' }}>
                          <table style={tableStyle}>
                            <thead><tr><th style={thStyle}>Match</th><th>Tickets</th><th>Exposition</th><th>Niveau</th></tr></thead>
                            <tbody>
                              {divDetail.concentration_matchs.map(m => {
                                const nColor = { FAIBLE: '#00ffcc', MODEREE: '#ffcc00', FORTE: '#ff8800', TRES_FORTE: '#ff4444' }[m.niveau_concentration] || '#ccc';
                                const nLabel = { FAIBLE: 'Faible', MODEREE: 'Modérée', FORTE: 'Forte', TRES_FORTE: 'Très forte' }[m.niveau_concentration] || m.niveau_concentration;
                                return (
                                  <tr key={m.id}><td style={{ textAlign: 'left', padding: '8px 5px' }}>{m.home_team} - {m.away_team} <span style={{ color: '#888' }}>({m.div})</span></td><td>{m.nb_tickets} / {divDetail.nb_tickets}</td><td>{m.exposition_pct}%</td><td style={{ color: nColor, fontWeight: 'bold' }}>{nLabel}</td></tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}

                    {divDetail.recouvrements_par_paire && divDetail.recouvrements_par_paire.length > 0 && (
                      <details style={{ backgroundColor: '#1a1a1a', borderRadius: '8px', border: '1px solid #333', marginBottom: '20px' }}>
                        <summary style={{ padding: '15px', cursor: 'pointer', color: '#aaa', fontWeight: 'bold' }}>🔗 Recouvrement entre tickets ({divDetail.recouvrements_par_paire.length} paire(s))</summary>
                        <div style={{ padding: '0 15px 15px' }}>
                          <table style={tableStyle}>
                            <thead><tr><th style={thStyle}>Ticket A</th><th>Ticket B</th><th>Matchs communs</th><th>Recouvrement</th></tr></thead>
                            <tbody>
                              {divDetail.recouvrements_par_paire.map((r, i) => (
                                <tr key={i}><td style={{ textAlign: 'left', padding: '8px 5px' }}>{FREEBET_PROFILS_INFO_FRONT[r.ticket_a_profil]}</td><td style={{ textAlign: 'left' }}>{FREEBET_PROFILS_INFO_FRONT[r.ticket_b_profil]}</td><td>{r.nb_matchs_communs}</td><td>{r.pourcentage_recouvrement}%</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}

                    {pf.journal_construction && pf.journal_construction.length > 0 && (
                      <details style={{ backgroundColor: '#1a1a1a', borderRadius: '8px', border: '1px solid #333', marginBottom: '20px' }}>
                        <summary style={{ padding: '15px', cursor: 'pointer', color: '#aaa', fontWeight: 'bold' }}>🧾 Détail de la construction du portefeuille</summary>
                        <div style={{ padding: '0 15px 15px', color: '#888', fontSize: '0.85rem' }}>
                          {pf.journal_construction.map((j, i) => <div key={i} style={{ marginBottom: '4px' }}>• {j}</div>)}
                        </div>
                      </details>
                    )}

                    {pf.portefeuille_recommande.length === 0 && (
                      <div style={{ textAlign: 'center', padding: '30px', color: '#666' }}>Aucun combiné disponible pour construire un portefeuille avec les tailles choisies (ou budget freebet insuffisant).</div>
                    )}

                    {pf.portefeuille_recommande.map((combo, idx) => {
                      const comboKey = `pf_${combo.taille}_${combo.selections.map(s => s.id).join('_')}`;
                      const risqueColor = combo.niveau_risque === 'FAIBLE' ? '#00ffcc' : combo.niveau_risque === 'MOYEN' ? '#ffcc00' : '#ff4444';
                      const pColor = profilFreebetColor(combo.profil);
                      return (
                        <div key={comboKey} style={{ backgroundColor: '#1e1e1e', marginBottom: '10px', borderRadius: '5px', border: `1px solid ${pColor}55` }}>
                          <div onClick={() => setComboExpandedId(comboExpandedId === comboKey ? null : comboKey)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px', cursor: 'pointer', backgroundColor: comboExpandedId === comboKey ? '#2a2a2a' : 'transparent', flexWrap: 'wrap', gap: '10px' }}>
                            <span style={{ color: '#666', fontSize: '0.75rem', minWidth: '20px' }}>#{idx + 1}</span>
                            <span style={{ color: pColor, fontWeight: 'bold', border: `1px solid ${pColor}`, padding: '3px 8px', borderRadius: '4px', minWidth: '150px', textAlign: 'center', fontSize: '0.8rem' }}>{combo.profil_label}</span>
                            <span style={{ color: '#ffcc00', fontWeight: 'bold', border: '1px solid #ffcc00', padding: '3px 8px', borderRadius: '4px', minWidth: '45px', textAlign: 'center' }}>x{combo.taille}</span>
                            <span style={{ flex: 1, minWidth: '250px', fontSize: '0.9rem' }}>{combo.selections.map(s => `${s.home_team} - ${s.away_team} (${s.issue_label})`).join('  +  ')}</span>
                            <span style={{ color: '#fff', minWidth: '70px' }}>Cote {combo.cote_totale}</span>
                            <span style={{ color: '#00ffcc', fontWeight: 'bold', minWidth: '65px' }}>⭐ {combo.score}</span>
                            <span style={{ color: risqueColor, fontWeight: 'bold', minWidth: '70px' }}>{combo.niveau_risque}</span>
                            <span style={{ color: '#00ffcc' }}>{comboExpandedId === comboKey ? '▲' : '▼'}</span>
                          </div>

                          {comboExpandedId === comboKey && (
                            <div style={{ padding: '20px', borderTop: '1px solid #333' }}>
                              <div style={{ color: '#aaa', fontSize: '0.8rem', marginBottom: '15px' }}>{combo.profil_description} (indice de profil : {combo.indice_profil})</div>
                              <table style={tableStyle}>
                                <thead><tr><th style={thStyle}>Match</th><th>Issue</th><th>Cote</th><th>Proba</th><th>Edge</th><th>Score</th></tr></thead>
                                <tbody>
                                  {combo.selections.map(s => (
                                    <tr key={s.id}><td style={{ textAlign: 'left', padding: '8px 5px' }}>{s.home_team} - {s.away_team} <span style={{ color: '#888' }}>({s.div})</span></td><td>{s.issue_label}</td><td>{s.cote}</td><td>{s.proba}%</td><td><Colorize val={s.edge} />%</td><td>{s.score}</td></tr>
                                  ))}
                                </tbody>
                              </table>

                              <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', marginTop: '15px' }}>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>COTE TOTALE</div><div style={kpiValue}>{combo.cote_totale}</div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>PROBABILITÉ</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}>{combo.probabilite_pct}%</div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>EDGE</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}><Colorize val={combo.edge_pct} />%</div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>EV (pour 1€)</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}><Colorize val={combo.ev_pour_1e} /></div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>MISE PRÉVUE</div><div style={{ ...kpiValue, fontSize: '1.3rem', color: '#00ffcc' }}>{combo.mise_prevue_portefeuille.toFixed(2)} €</div></div>
                              </div>

                              <div style={{ backgroundColor: '#121212', padding: '15px', borderRadius: '5px', border: '1px dotted #888', marginTop: '15px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                                <div style={{ color: '#ccc' }}>
                                  <b>Kelly TRÈS RESTRICTIF</b> (bankroll cash, fraction utilisée : {combo.kelly.fraction_utilisee_pct}%) :{' '}
                                  {combo.kelly.mise_recommandee != null
                                    ? <span style={{ color: '#00ffcc', fontWeight: 'bold' }}>{combo.kelly.mise_recommandee.toFixed(2)} €</span>
                                    : <span style={{ color: '#ffcc00' }}>{combo.kelly.message}</span>}
                                </div>
                                <button onClick={() => ouvrirValidationCombo(combo)} style={{ padding: '10px 20px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>✅ SÉLECTIONNER CE COMBINÉ</button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                );
              })()}

              {freebetSousVue === 'CONSTRUCTEUR' && (() => {
                const combo = constructeurCombo;
                const risqueColor = combo && (combo.niveau_risque === 'FAIBLE' ? '#00ffcc' : combo.niveau_risque === 'MOYEN' ? '#ffcc00' : '#ff4444');
                return (
                  <>
                    <div style={{ backgroundColor: '#1a1a1a', padding: '15px 20px', borderRadius: '8px', border: '1px solid #ffcc0055', marginBottom: '20px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <div style={{ color: '#ffcc00', fontWeight: 'bold' }}>🛠️ CONSTRUCTEUR DE COMBINÉ MANUEL</div>
                        <button onClick={viderConstructeur} style={{ padding: '6px 12px', backgroundColor: '#333', color: '#ff4444', border: '1px solid #ff4444', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' }}>🗑️ Vider la sélection</button>
                      </div>
                      <div style={{ color: '#888', fontSize: '0.85rem' }}>Clique sur les matchs éligibles ci-dessous pour les ajouter ou les retirer de ton combiné. Aucune limite de taille — tout se recalcule instantanément avec les mêmes fonctions que le Freebet Optimizer.</div>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '20px' }}>
                      {freebetCandidats.map(c => {
                        const selectionne = constructeurSelectionIds.includes(c.id);
                        return (
                          <button key={c.id} onClick={() => toggleConstructeurMatch(c.id)}
                            style={{
                              padding: '8px 12px', borderRadius: '5px', cursor: 'pointer', fontSize: '0.85rem', textAlign: 'left',
                              backgroundColor: selectionne ? '#ffcc00' : '#1e1e1e',
                              color: selectionne ? '#000' : '#ccc',
                              border: selectionne ? '1px solid #ffcc00' : '1px solid #333',
                              fontWeight: selectionne ? 'bold' : 'normal'
                            }}>
                            {selectionne ? '✅ ' : ''}{c.home_team} - {c.away_team} ({c.issue_label}) · {c.cote}
                          </button>
                        );
                      })}
                    </div>

                    {constructeurSelectionIds.length === 0 && (
                      <div style={{ textAlign: 'center', padding: '30px', color: '#666' }}>Sélectionne au moins 2 matchs ci-dessus pour construire ton combiné.</div>
                    )}
                    {constructeurSelectionIds.length === 1 && (
                      <div style={{ textAlign: 'center', padding: '20px', color: '#ffcc00' }}>Sélectionne au moins un second match pour former un combiné.</div>
                    )}
                    {constructeurChargement && (
                      <div style={{ textAlign: 'center', padding: '20px', color: '#888' }}>⏳ Recalcul en cours...</div>
                    )}
                    {constructeurErreur && (
                      <div style={{ backgroundColor: '#2a0000', border: '1px solid #ff4444', color: '#ff4444', padding: '12px 15px', borderRadius: '5px', marginBottom: '20px' }}>❌ {constructeurErreur}</div>
                    )}

                    {combo && !constructeurChargement && (
                      <div style={{ backgroundColor: '#1e1e1e', borderRadius: '5px', border: `1px solid ${risqueColor}55`, padding: '20px' }}>
                        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '15px' }}>
                          <span style={{ color: profilFreebetColor(combo.profil), fontWeight: 'bold', border: `1px solid ${profilFreebetColor(combo.profil)}`, padding: '3px 8px', borderRadius: '4px', fontSize: '0.8rem' }}>{combo.profil_label}</span>
                          <span style={{ color: '#ffcc00', fontWeight: 'bold', border: '1px solid #ffcc00', padding: '3px 8px', borderRadius: '4px' }}>x{combo.taille}</span>
                          <span style={{ color: risqueColor, fontWeight: 'bold' }}>{combo.niveau_risque}</span>
                        </div>
                        <div style={{ color: '#ccc', fontSize: '0.9rem', marginBottom: '15px' }}>{combo.selections.map(s => `${s.home_team} - ${s.away_team} (${s.issue_label})`).join('  +  ')}</div>

                        <table style={tableStyle}>
                          <thead><tr><th style={thStyle}>Match</th><th>Issue</th><th>Cote</th><th>Proba</th><th>Edge</th><th>Score</th></tr></thead>
                          <tbody>
                            {combo.selections.map(s => (
                              <tr key={s.id}><td style={{ textAlign: 'left', padding: '8px 5px' }}>{s.home_team} - {s.away_team} <span style={{ color: '#888' }}>({s.div})</span></td><td>{s.issue_label}</td><td>{s.cote}</td><td>{s.proba}%</td><td><Colorize val={s.edge} />%</td><td>{s.score}</td></tr>
                            ))}
                          </tbody>
                        </table>

                        <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', marginTop: '15px' }}>
                          <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>COTE TOTALE</div><div style={kpiValue}>{combo.cote_totale}</div></div>
                          <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>PROBABILITÉ</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}>{combo.probabilite_pct}%</div></div>
                          <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>PROBA IMPLICITE</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}>{combo.probabilite_implicite_pct}%</div></div>
                          <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>EDGE</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}><Colorize val={combo.edge_pct} />%</div></div>
                          <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>EV (pour 1€)</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}><Colorize val={combo.ev_pour_1e} /></div></div>
                          <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>GAIN POTENTIEL (/1€)</div><div style={{ ...kpiValue, fontSize: '1.3rem', color: '#00ffcc' }}>+{combo.gain_potentiel_pour_1e} €</div></div>
                          <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>SCORE</div><div style={{ ...kpiValue, fontSize: '1.3rem', color: '#ffcc00' }}>⭐ {combo.score}</div></div>
                        </div>
                        <div style={{ color: '#666', fontSize: '0.75rem', marginTop: '8px' }}>Score sur échelle absolue (non comparable au classement automatique, qui se normalise sur le pool de combinés du jour).</div>

                        <div style={{ backgroundColor: '#121212', padding: '15px', borderRadius: '5px', border: '1px dotted #888', marginTop: '15px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                          <div style={{ color: '#ccc' }}>
                            <b>Kelly TRÈS RESTRICTIF</b> (bankroll cash, fraction utilisée : {combo.kelly.fraction_utilisee_pct}%) :{' '}
                            {combo.kelly.mise_recommandee != null
                              ? <span style={{ color: '#00ffcc', fontWeight: 'bold' }}>{combo.kelly.mise_recommandee.toFixed(2)} €</span>
                              : <span style={{ color: '#ffcc00' }}>{combo.kelly.message}</span>}
                          </div>
                          <button onClick={() => ouvrirValidationCombo(combo)} style={{ padding: '10px 20px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>✅ SÉLECTIONNER CE COMBINÉ</button>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

              {freebetSousVue === 'CLASSEMENT' && freebetResultats && (
                <>
                  {freebetResultats.tailles_ignorees && freebetResultats.tailles_ignorees.length > 0 && (
                    <div style={{ backgroundColor: '#2a1a00', border: '1px solid #ffcc00', color: '#ffcc00', padding: '12px 15px', borderRadius: '5px', marginBottom: '15px', fontSize: '0.85rem' }}>
                      {freebetResultats.tailles_ignorees.map((t, i) => <div key={i}>⚠️ Taille x{t.taille} ignorée : {t.raison}</div>)}
                    </div>
                  )}

                  {Object.keys(freebetResultats.par_taille).length > 0 && (
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '20px' }}>
                      {Object.entries(freebetResultats.par_taille).map(([taille, info]) => (
                        <div key={taille} style={{ ...kpiCard, flex: '1 1 150px', textAlign: 'left' }}>
                          <div style={kpiLabel}>COMBINÉ x{taille}</div>
                          <div style={{ color: '#fff', fontSize: '0.85rem' }}>{info.nb_combinaisons_possibles} combinaison(s) possible(s)</div>
                          <div style={{ color: '#00ffcc', fontSize: '0.85rem' }}>Score moyen : {info.score_moyen}</div>
                          <div style={{ color: '#ffcc00', fontSize: '0.85rem' }}>Meilleur score : {info.meilleur_score}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '15px' }}>
                    <button onClick={() => setFreebetFiltreTaille('TOUS')} style={freebetFiltreTaille === 'TOUS' ? tabActive : tabInactive}>Classement global</button>
                    {freebetResultats.tailles_calculees.map(t => (
                      <button key={t} onClick={() => setFreebetFiltreTaille(t)} style={freebetFiltreTaille === t ? tabActive : tabInactive}>x{t} seul</button>
                    ))}
                  </div>

                  {(() => {
                    const liste = freebetFiltreTaille === 'TOUS'
                      ? freebetResultats.classement_global
                      : (freebetResultats.par_taille[freebetFiltreTaille]?.meilleurs || []);

                    if (liste.length === 0) return <div style={{ textAlign: 'center', padding: '30px', color: '#666' }}>Aucun combiné dans cette catégorie.</div>;

                    return liste.map((combo, idx) => {
                      const comboKey = `${combo.taille}_${combo.selections.map(s => s.id).join('_')}`;
                      const risqueColor = combo.niveau_risque === 'FAIBLE' ? '#00ffcc' : combo.niveau_risque === 'MOYEN' ? '#ffcc00' : '#ff4444';
                      return (
                        <div key={comboKey} style={{ backgroundColor: '#1e1e1e', marginBottom: '10px', borderRadius: '5px', border: `1px solid ${risqueColor}55` }}>
                          <div onClick={() => setComboExpandedId(comboExpandedId === comboKey ? null : comboKey)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px', cursor: 'pointer', backgroundColor: comboExpandedId === comboKey ? '#2a2a2a' : 'transparent', flexWrap: 'wrap', gap: '10px' }}>
                            <span style={{ color: profilFreebetColor(combo.profil), fontWeight: 'bold', border: `1px solid ${profilFreebetColor(combo.profil)}`, padding: '3px 8px', borderRadius: '4px', minWidth: '140px', textAlign: 'center', fontSize: '0.8rem' }}>{combo.profil_label}</span>
                            <span style={{ color: '#ffcc00', fontWeight: 'bold', border: '1px solid #ffcc00', padding: '3px 8px', borderRadius: '4px', minWidth: '45px', textAlign: 'center' }}>x{combo.taille}</span>
                            <span style={{ flex: 1, minWidth: '250px', fontSize: '0.9rem' }}>{combo.selections.map(s => `${s.home_team} - ${s.away_team} (${s.issue_label})`).join('  +  ')}</span>
                            <span style={{ color: '#fff', minWidth: '70px' }}>Cote {combo.cote_totale}</span>
                            <span style={{ color: '#00ffcc', fontWeight: 'bold', minWidth: '65px' }}>⭐ {combo.score}</span>
                            <span style={{ minWidth: '55px' }}><Colorize val={combo.edge_pct} />%</span>
                            <span style={{ color: risqueColor, fontWeight: 'bold', minWidth: '70px' }}>{combo.niveau_risque}</span>
                            <span style={{ color: '#00ffcc' }}>{comboExpandedId === comboKey ? '▲' : '▼'}</span>
                          </div>

                          {comboExpandedId === comboKey && (
                            <div style={{ padding: '20px', borderTop: '1px solid #333' }}>
                              <table style={tableStyle}>
                                <thead><tr><th style={thStyle}>Match</th><th>Issue</th><th>Cote</th><th>Proba</th><th>Edge</th><th>Score</th></tr></thead>
                                <tbody>
                                  {combo.selections.map(s => (
                                    <tr key={s.id}><td style={{ textAlign: 'left', padding: '8px 5px' }}>{s.home_team} - {s.away_team} <span style={{ color: '#888' }}>({s.div})</span></td><td>{s.issue_label}</td><td>{s.cote}</td><td>{s.proba}%</td><td><Colorize val={s.edge} />%</td><td>{s.score}</td></tr>
                                  ))}
                                </tbody>
                              </table>

                              <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', marginTop: '15px' }}>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>COTE TOTALE</div><div style={kpiValue}>{combo.cote_totale}</div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>PROBABILITÉ</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}>{combo.probabilite_pct}%</div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>PROBA IMPLICITE</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}>{combo.probabilite_implicite_pct}%</div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>EDGE</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}><Colorize val={combo.edge_pct} />%</div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>EV (pour 1€)</div><div style={{ ...kpiValue, fontSize: '1.3rem' }}><Colorize val={combo.ev_pour_1e} /></div></div>
                                <div style={{ ...kpiCard, flex: '1 1 130px' }}><div style={kpiLabel}>GAIN POTENTIEL (/1€)</div><div style={{ ...kpiValue, fontSize: '1.3rem', color: '#00ffcc' }}>+{combo.gain_potentiel_pour_1e} €</div></div>
                              </div>
                              <div style={{ color: '#aaa', fontSize: '0.8rem', marginTop: '10px' }}>{combo.profil_description} (indice de profil : {combo.indice_profil})</div>

                              <div style={{ backgroundColor: '#121212', padding: '15px', borderRadius: '5px', border: '1px dotted #888', marginTop: '15px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                                <div style={{ color: '#ccc' }}>
                                  <b>Kelly TRÈS RESTRICTIF</b> (bankroll cash, fraction utilisée : {combo.kelly.fraction_utilisee_pct}%) :{' '}
                                  {combo.kelly.mise_recommandee != null
                                    ? <span style={{ color: '#00ffcc', fontWeight: 'bold' }}>{combo.kelly.mise_recommandee.toFixed(2)} €</span>
                                    : <span style={{ color: '#ffcc00' }}>{combo.kelly.message}</span>}
                                </div>
                                <button onClick={() => ouvrirValidationCombo(combo)} style={{ padding: '10px 20px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>✅ SÉLECTIONNER CE COMBINÉ</button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </>
              )}

              {freebetComboOuvert && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
                  <div style={{ ...resultatStyle, maxWidth: '600px', width: '100%', maxHeight: '85vh', overflowY: 'auto' }}>
                    <h2 style={{ color: '#00ffcc', borderBottom: '1px solid #333', paddingBottom: '10px' }}>🎁 VALIDATION DU COMBINÉ FREEBET x{freebetComboOuvert.taille}</h2>
                    <p style={{ color: '#ccc', fontSize: '0.9rem' }}>{freebetComboOuvert.selections.map(s => `${s.home_team} - ${s.away_team} (${s.issue_label})`).join('  +  ')}</p>

                    <div style={{ display: 'flex', gap: '15px', marginBottom: '15px', flexWrap: 'wrap' }}>
                      <div style={{ flex: 1 }}>
                        <label style={lblStyle}>Cote totale calculée : {freebetComboOuvert.cote_totale}. Cote réellement obtenue chez le bookmaker :</label>
                        {(() => {
                          const comboVerrouille = freebetComboOuvert.selections.some(s => coteEstVerrouillee(s.date));
                          return (
                            <>
                              <input type="number" step="0.01" style={{ ...inputStyle, opacity: comboVerrouille ? 0.5 : 1 }} disabled={comboVerrouille} value={comboVerrouille ? freebetComboOuvert.cote_totale : freebetCoteReelle} onChange={e => setFreebetCoteReelle(e.target.value)} />
                              {comboVerrouille && <div style={{ color: '#666', fontSize: '0.8rem', marginTop: '5px' }}>🔒 Au moins une sélection est à moins de 2h de son coup d'envoi : la cote calculée fait foi.</div>}
                            </>
                          );
                        })()}
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={lblStyle}>Mise Freebet (€) {freebetComboOuvert.kelly.mise_recommandee != null ? `— Kelly conseille ${freebetComboOuvert.kelly.mise_recommandee.toFixed(2)} €` : '— sous le minimum Kelly, saisie libre'} :</label>
                        <input type="number" step="0.01" style={inputStyle} value={freebetMise} onChange={e => setFreebetMise(e.target.value)} />
                      </div>
                    </div>

                    <div style={{ marginBottom: '15px' }}>
                      <label style={lblStyle}>Bookmaker :</label>
                      <select value={bookmakerChoisi} onChange={(e) => setBookmakerChoisi(e.target.value)} style={{ padding: '10px', backgroundColor: '#121212', color: '#ffcc00', border: '1px solid #ffcc00', fontWeight: 'bold', outline: 'none' }}>
                        <option value="WINAMAX">🔴 Winamax</option>
                        <option value="BETCLIC">⚪ Betclic</option>
                        <option value="UNIBET">🟢 Unibet</option>
                      </select>
                    </div>

                    <div style={{ display: 'flex', gap: '15px' }}>
                      <button onClick={validerComboFreebetHandler} disabled={estViewer} style={{ flex: 2, padding: '15px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: estViewer ? 'not-allowed' : 'pointer', fontSize: '1.1rem', opacity: estViewer ? 0.5 : 1 }}>🔥 VALIDER LE COMBINÉ (→ PARIS JOUÉS)</button>
                      <button onClick={() => setFreebetComboOuvert(null)} style={{ flex: 1, padding: '15px', backgroundColor: '#333', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Annuler</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ maxWidth: '900px', margin: '0 auto' }}>
              {activeTab === 'JOUE' && combosFreebetEnCours.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ color: '#ffcc00', fontSize: '0.95rem', marginBottom: '10px' }}>🎁 COMBINÉS FREEBET EN COURS</h3>
                  {combosFreebetEnCours.map(combo => {
                    const risqueColor = combo.niveau_risque === 'FAIBLE' ? '#00ffcc' : combo.niveau_risque === 'MOYEN' ? '#ffcc00' : '#ff4444';
                    return (
                      <div key={combo.id_match} style={{ backgroundColor: '#1e1e1e', marginBottom: '10px', borderRadius: '5px', border: `1px solid ${risqueColor}` }}>
                        <div onClick={() => setComboExpandedId(comboExpandedId === combo.id_match ? null : combo.id_match)} style={{ display: 'flex', justifyContent: 'space-between', padding: '15px', cursor: 'pointer', backgroundColor: comboExpandedId === combo.id_match ? '#2a2a2a' : 'transparent' }}>
                          <span style={{ color: '#888' }}>🎫 {combo.home_team}</span>
                          <span style={getBookStyle(combo.bookmaker)}>{(combo.bookmaker || 'WINAMAX').substring(0, 4)}</span>
                          <span style={{ fontWeight: 'bold' }}>{combo.mise?.toFixed(2)} € @ {combo.cote_choisie?.toFixed(2)}</span>
                          <span style={{ color: '#00ffcc' }}>{comboExpandedId === combo.id_match ? '▲' : '▼'}</span>
                        </div>
                        {comboExpandedId === combo.id_match && (
                          <div style={{ padding: '20px', borderTop: '1px solid #333' }}>
                            <p style={{ color: '#ccc', fontSize: '0.85rem' }}>{combo.away_team}</p>
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '0.95rem', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
                              <div><b>Bookmaker :</b> <span style={getBookStyle(combo.bookmaker)}>{combo.bookmaker || 'WINAMAX'}</span></div>
                              <div><b>Mise :</b> {combo.mise?.toFixed(2)} € (FREEBET)</div>
                              <div><b>Cote :</b> {combo.cote_choisie?.toFixed(2)}</div>
                              <div><b>Retour potentiel :</b> <span style={{ color: '#00ffcc', fontWeight: 'bold' }}>{((combo.mise * combo.cote_choisie) - combo.mise).toFixed(2)} €</span></div>
                            </div>

                            {clotureComboEnCours?.id === combo.id_match ? (
                              <div style={{ display: 'flex', gap: '10px' }}>
                                <input type="number" step="0.01" placeholder={clotureComboEnCours.type === 'GAGNE' ? "Montant gagné (€)" : "Montant récupéré (€)"} onChange={(e) => setMontantsRetourCombo({ ...montantsRetourCombo, [combo.id_match]: e.target.value })} style={inputStyle} />
                                <button onClick={() => cloturerComboFreebetHandler(combo, clotureComboEnCours.type, montantsRetourCombo[combo.id_match])} disabled={estViewer} style={{ ...buttonStyle, flex: 0.5, opacity: estViewer ? 0.5 : 1 }}>CONFIRMER</button>
                                <button onClick={() => setClotureComboEnCours(null)} style={{ padding: '10px', backgroundColor: '#333', color: '#fff', border: 'none', cursor: 'pointer' }}>Annuler</button>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: '#1a1a1a', padding: '10px', borderRadius: '4px', border: '1px dotted #888' }}>
                                  <span style={{ color: '#aaa', fontSize: '0.9rem' }}>Cote de clôture (CLV, optionnel) :</span>
                                  <input type="number" step="0.01" value={cotesClotureCombo[combo.id_match] || ''} onChange={e => setCotesClotureCombo({ ...cotesClotureCombo, [combo.id_match]: e.target.value })} style={{ width: '80px', padding: '5px', backgroundColor: '#121212', color: '#00ffcc', border: '1px solid #444' }} />
                                </div>
                                <div style={{ display: 'flex', gap: '10px' }}>
                                  <button onClick={() => cloturerComboFreebetHandler(combo, "GAGNE")} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#0a3d20', color: '#00ffcc', border: '1px solid #00ffcc', cursor: estViewer ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: estViewer ? 0.5 : 1 }}>✅ GAGNÉ</button>
                                  <button onClick={() => cloturerComboFreebetHandler(combo, "PERDU")} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#4a1e0a', color: '#ff4444', border: '1px solid #ff4444', cursor: estViewer ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: estViewer ? 0.5 : 1 }}>❌ PERDU</button>
                                  <button onClick={() => cloturerComboFreebetHandler(combo, "CASHOUT")} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#333', color: '#ffcc00', border: '1px solid #ffcc00', cursor: estViewer ? 'not-allowed' : 'pointer', opacity: estViewer ? 0.5 : 1 }}>💰 CASHOUT</button>
                                  <button onClick={() => cloturerComboFreebetHandler(combo, "ANNULE")} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#2a2a1a', color: '#ff8800', border: '1px solid #ff8800', cursor: estViewer ? 'not-allowed' : 'pointer', opacity: estViewer ? 0.5 : 1 }}>🚫 ANNULER</button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {matchsFiltres.map(match => {
                const ageSec = (new Date().getTime() / 1000) - (match.derniere_analyse || 0);
                const estPerime = match.statut === 'ANALYSE' && match.derniere_analyse > 0 && ageSec > 7200;

                const isMatchAnalysed = resultat && resultat.matchObj.id === match.id;

                return (
                  <div key={match.id} style={{ backgroundColor: '#1e1e1e', marginBottom: '10px', borderRadius: '5px', border: estPerime ? '1px solid #ffcc00' : (isMatchAnalysed ? '2px solid #00ffcc' : '1px solid #333') }}>
                    <div onClick={() => setExpandedId(expandedId === match.id ? null : match.id)} style={{ display: 'flex', justifyContent: 'space-between', padding: '15px', cursor: 'pointer', backgroundColor: expandedId === match.id ? '#2a2a2a' : 'transparent' }}>
                        <span style={{ color: '#888' }}>🕒 {ajusterHeure(match.date)} <span style={{color: '#ffcc00', marginLeft:'10px'}}>{match.div}</span></span>
                        <span style={{ fontWeight: 'bold', fontSize: '1.1rem', color: estPerime ? '#ffcc00' : (isMatchAnalysed ? '#00ffcc' : '#fff') }}>{match.home_team} - {match.away_team} {estPerime && " ⚠️ MAJ REQUISE"}</span>
                        <span style={{ color: '#00ffcc' }}>{expandedId === match.id ? '▲' : '▼'}</span>
                    </div>

                    {expandedId === match.id && (
                      <div style={{ padding: '20px', borderTop: '1px solid #333' }}>
                          {activeTab === 'JOUE' ? (
                            <div style={{ backgroundColor: '#121212', padding: '20px', borderRadius: '5px', border: '1px solid #444' }}>
                              <div style={{ marginBottom: '20px', paddingBottom: '15px', borderBottom: '1px solid #333' }}>
                                <h3 style={{ color: '#ffcc00', margin: '0 0 15px 0' }}>Bilan du Trade : {match.pari_choisi} {match.type_fond === 'FREEBET' ? '🎁' : '💶'}</h3>
                                {editModeId === match.id ? (
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#222', padding: '10px', borderRadius: '5px', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
                                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                      <span style={{ color: '#aaa' }}>Mise:</span><input type="number" step="0.1" value={editMise} onChange={e => setEditMise(e.target.value)} style={{ width: '70px', padding: '5px', backgroundColor: '#121212', color: '#fff', border: '1px solid #00ffcc' }} />
                                      <span style={{ color: '#aaa', marginLeft: '15px' }}>Cote:</span>
                                      <input type="number" step="0.01" disabled={coteEstVerrouillee(match.date)} value={editCote} onChange={e => setEditCote(e.target.value)} style={{ width: '70px', padding: '5px', backgroundColor: coteEstVerrouillee(match.date) ? '#1a1a1a' : '#121212', color: coteEstVerrouillee(match.date) ? '#666' : '#fff', border: '1px solid #00ffcc' }} />
                                      {coteEstVerrouillee(match.date) && <span style={{ color: '#666', fontSize: '0.75rem' }}>🔒 &lt; H-2</span>}
                                    </div>
                                    <div><button onClick={() => sauvegarderModification(match)} disabled={estViewer} style={{ padding: '8px 15px', backgroundColor: '#00ffcc', color: '#000', border: 'none', borderRadius: '3px', cursor: estViewer ? 'not-allowed' : 'pointer', fontWeight: 'bold', marginRight: '10px', opacity: estViewer ? 0.5 : 1 }}>💾 OK</button><button onClick={() => setEditModeId(null)} style={{ padding: '8px 15px', backgroundColor: '#444', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>Annuler</button></div>
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '0.95rem', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                                    <div><b>Mise :</b> {match.mise?.toFixed(2) || "0.00"} € ({match.type_fond || 'CASH'})</div>
                                    <div><b>Cote :</b> {match.cote_choisie?.toFixed(2) || "0.00"}</div>
                                    <div><b>Bookmaker :</b> <span style={getBookStyle(match.bookmaker)}>{match.bookmaker || 'WINAMAX'}</span></div>
                                    {/* 🔧 FIX §3 : score/edge FIGÉS au moment de la sélection (snapshot enregistré avec
                                        le pari) — jamais recalculés, donc jamais modifiés par le blocage d'autres matchs. */}
                                    <div><b>Score Hydre (au pari) :</b> <span style={{ color: '#ffcc00', fontWeight: 'bold' }}>{match.score !== null && match.score !== undefined ? `⭐ ${match.score}` : '-'}</span></div>
                                    <div><b>Edge :</b> {match.edge !== null && match.edge !== undefined ? <Colorize val={match.edge} isPercent={true} /> : '-'}</div>
                                    <div>
                                      <b>Retour Potentiel :</b> <span style={{ color: '#00ffcc', fontWeight: 'bold' }}>
                                        {match.mise && match.cote_choisie ? (match.type_fond === 'FREEBET' ? ((match.mise * match.cote_choisie) - match.mise).toFixed(2) : (match.mise * match.cote_choisie).toFixed(2)) : "0.00"} €
                                      </span>
                                    </div>
                                    <button onClick={() => { setEditModeId(match.id); setEditCote(match.cote_choisie); setEditMise(match.mise); }} disabled={estViewer} style={{ padding: '5px 10px', backgroundColor: 'transparent', color: '#ffcc00', border: '1px solid #ffcc00', borderRadius: '3px', cursor: estViewer ? 'not-allowed' : 'pointer', fontSize: '0.8rem', opacity: estViewer ? 0.5 : 1 }}>✏️ ÉDITER</button>
                                  </div>
                                )}
                              </div>

                              <div style={{ marginBottom: '20px' }}><button onClick={() => analyserMatch(match)} disabled={loadingId === match.id || estViewer} style={{ width: '100%', padding: '10px', backgroundColor: '#1a1a1a', color: '#00ffcc', border: '1px dotted #00ffcc', borderRadius: '4px', cursor: estViewer ? 'not-allowed' : 'pointer' }}>{loadingId === match.id ? 'RECONSTRUCTION...' : (estViewer ? '🔒 Indisponible en lecture seule (score déjà affiché ci-dessus)' : '🔬 RAPPELER LA MATRICE DE TIR ORIGINALE')}</button></div>

                              {clotureEnCours?.id === match.id ? (
                                <div style={{ display: 'flex', gap: '10px' }}><input type="number" step="0.01" placeholder={clotureEnCours.type === 'GAGNE' ? "Montant gagné (€)" : "Montant récupéré (€)"} onChange={(e) => setMontantsRetour({...montantsRetour, [match.id]: e.target.value})} style={inputStyle} /><button onClick={() => cloturerPari(match, clotureEnCours.type, montantsRetour[match.id])} disabled={estViewer} style={{...buttonStyle, flex: 0.5, opacity: estViewer ? 0.5 : 1}}>CONFIRMER</button><button onClick={() => setClotureEnCours(null)} style={{padding: '10px', backgroundColor: '#333', color: '#fff', border: 'none', cursor: 'pointer'}}>Annuler</button></div>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: '#1a1a1a', padding: '10px', borderRadius: '4px', border: '1px dotted #888' }}>
                                    <span style={{ color: '#aaa', fontSize: '0.9rem' }}>Cote de clôture (CLV, optionnel) :</span>
                                    <input type="number" step="0.01" value={cotesCloture[match.id] || ''} onChange={e => setCotesCloture({...cotesCloture, [match.id]: e.target.value})} style={{ width: '80px', padding: '5px', backgroundColor: '#121212', color: '#00ffcc', border: '1px solid #444' }} />
                                  </div>
                                  <div style={{ display: 'flex', gap: '10px' }}>
                                    <button onClick={() => cloturerPari(match, "GAGNE")} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#0a3d20', color: '#00ffcc', border: '1px solid #00ffcc', cursor: estViewer ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: estViewer ? 0.5 : 1 }}>✅ GAGNÉ</button>
                                    <button onClick={() => cloturerPari(match, "PERDU")} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#4a1e0a', color: '#ff4444', border: '1px solid #ff4444', cursor: estViewer ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: estViewer ? 0.5 : 1 }}>❌ PERDU</button>
                                    <button onClick={() => cloturerPari(match, "CASHOUT")} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#333', color: '#ffcc00', border: '1px solid #ffcc00', cursor: estViewer ? 'not-allowed' : 'pointer', opacity: estViewer ? 0.5 : 1 }}>💰 CASHOUT</button>
                                    <button onClick={() => cloturerPari(match, "ANNULE")} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#2a2a1a', color: '#ff8800', border: '1px solid #ff8800', cursor: estViewer ? 'not-allowed' : 'pointer', opacity: estViewer ? 0.5 : 1 }}>🚫 ANNULER</button>
                                    <button onClick={() => annulerPariErreur(match)} disabled={estViewer} style={{ flex: 1, padding: '10px', backgroundColor: '#222', color: '#888', border: '1px dashed #555', cursor: estViewer ? 'not-allowed' : 'pointer', opacity: estViewer ? 0.5 : 1 }}>⏪ UNDO (ERREUR)</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div style={{ display: 'flex', gap: '15px', marginBottom: '15px' }}><div style={{ flex: 1 }}><label style={lblStyle}>Ouv H ({match.cote_ouv_dom}) ➔ Act H:</label><input type="number" step="0.01" style={inputStyle} value={cotesActuelles[match.id]?.dom || ''} onChange={e => handleCoteChange(match.id, 'dom', e.target.value)} /></div><div style={{ flex: 1 }}><label style={lblStyle}>Ouv D ({match.cote_ouv_nul}) ➔ Act D:</label><input type="number" step="0.01" style={inputStyle} value={cotesActuelles[match.id]?.nul || ''} onChange={e => handleCoteChange(match.id, 'nul', e.target.value)} /></div><div style={{ flex: 1 }}><label style={lblStyle}>Ouv A ({match.cote_ouv_ext}) ➔ Act A:</label><input type="number" step="0.01" style={inputStyle} value={cotesActuelles[match.id]?.ext || ''} onChange={e => handleCoteChange(match.id, 'ext', e.target.value)} /></div></div>
                              <div style={{ display: 'flex', gap: '10px' }}><button onClick={() => analyserMatch(match)} disabled={loadingId === match.id} style={{...buttonStyle, flex: 3}}>{estPerime ? '🔄 RECALCULER' : (loadingId === match.id ? 'CALCUL...' : 'ENGAGER LE TIR (OUVRIR LA MATRICE)')}</button>{match.statut === 'ANALYSE' && <button onClick={() => resetMatch(match)} disabled={estViewer} style={{ padding: '12px', backgroundColor: '#333', color: '#ff4444', border: '1px solid #ff4444', borderRadius: '4px', cursor: estViewer ? 'not-allowed' : 'pointer', flex: 1, opacity: estViewer ? 0.5 : 1 }}>🗑️ Purger</button>}</div>
                            </>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
              {matchsFiltres.length === 0 && <div style={{ textAlign: 'center', padding: '30px', color: '#666' }}>Aucun match dans ce sas.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// 🆕 PORTEFEUILLE FREEBET — couleur associée à chaque profil de combiné
const profilFreebetColor = (profil) => ({
  SAFE: '#00ffcc', MID: '#ffcc00', AMBITIEUX: '#ff8800', LOTO: '#cc66ff'
}[profil] || '#888');
const FREEBET_PROFILS_INFO_FRONT = { SAFE: '🟢 SAFE', MID: '🟡 MID', AMBITIEUX: '🟠 AMBITIEUX', LOTO: '🟣 LOTO' };
// 🆕 §5 : badge bookmaker réutilisable (registre des transactions ET paris/combinés bloqués).
const getBookStyle = (name) => {
  if (name === 'WINAMAX') return { color: '#ff4444', border: '1px solid #ff4444', padding: '2px 5px', borderRadius: '3px', fontSize: '0.7rem' };
  if (name === 'BETCLIC') return { color: '#fff', border: '1px solid #fff', padding: '2px 5px', borderRadius: '3px', fontSize: '0.7rem' };
  return { color: '#888', border: '1px solid #444', padding: '2px 5px', borderRadius: '3px', fontSize: '0.7rem' };
};

// STYLES
const menuActive = { padding: '15px 30px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', fontSize: '1.1rem', border: 'none', borderRadius: '5px', cursor: 'pointer' };
const menuInactive = { padding: '15px 30px', backgroundColor: 'transparent', color: '#888', fontWeight: 'bold', fontSize: '1.1rem', border: '1px solid #333', borderRadius: '5px', cursor: 'pointer' };
const tabActive = { padding: '12px 20px', backgroundColor: '#00ffcc', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '5px', cursor: 'pointer' };
const tabInactive = { padding: '12px 20px', backgroundColor: '#1e1e1e', color: '#888', border: '1px solid #333', borderRadius: '5px', cursor: 'pointer' };
const lblStyle = { display: 'block', color: '#888', marginBottom: '5px', fontSize: '0.8rem' };
const inputStyle = { width: '100%', padding: '10px', backgroundColor: '#121212', color: '#fff', border: '1px solid #444', borderRadius: '4px' };
const dateInputStyle = { padding: '10px', backgroundColor: '#121212', color: '#fff', border: '1px solid #444', borderRadius: '4px', outline: 'none', colorScheme: 'dark' };
const buttonStyle = { width: '100%', padding: '12px', backgroundColor: '#333', color: '#00ffcc', fontWeight: 'bold', border: '1px solid #00ffcc', borderRadius: '4px', cursor: 'pointer' };
const btnValider = { padding: '15px 20px', backgroundColor: '#ff4444', color: '#fff', fontWeight: 'bold', border: 'none', borderRadius: '4px', cursor: 'pointer', flex: 0.5, fontSize: '1.1rem' };
const resultatStyle = { backgroundColor: '#0f0f0f', padding: '30px', borderRadius: '8px', border: '1px solid #00ffcc' };
const tableStyle = { width: '100%', textAlign: 'center', borderCollapse: 'collapse', marginTop: '10px', color: '#ddd', fontSize: '0.85rem', tableLayout: 'fixed', wordWrap: 'break-word' };
const kpiCard = { backgroundColor: '#1a1a1a', padding: '20px', borderRadius: '8px', border: '1px solid #333', textAlign: 'center' };
const kpiLabel = { color: '#888', fontSize: '0.85rem', marginBottom: '10px', fontWeight: 'bold' };
const kpiValue = { fontSize: '1.8rem', fontWeight: 'bold' };
const thStyle = { padding: '10px', textAlign: 'left' };
const tdStyle = { padding: '15px 10px' };

export default App;