import pandas as pd
import numpy as np
from pathlib import Path
from tqdm import tqdm
from pymongo import MongoClient
import warnings
import os
from dotenv import load_dotenv
import joblib

warnings.filterwarnings('ignore')

# ==========================================
# ⚙️ CONFIGURATION GLOBALE
# ==========================================
DATA_DIR = Path("Data")
DATE_ANTI_VAR = "2021-08-01"
SPAN_STATS = 15
SPAN_FORM = 5

# 🎯 TON PÉRIMÈTRE D'EXPERTISE (Les seules ligues autorisées)
LIGUES_AUTORISEES = ['B1', 'D1', 'D2', 'E0', 'E1', 'F1', 'F2', 'G1', 'I1', 'I2', 'N1', 'P1', 'SC0', 'SP1', 'SP2', 'T1']

FEATURES_ELITE = [
    'Delta_xG', 'Delta_Shots_Pour', 'Delta_PPG_Saison', 'Delta_Shots_Contre',
    'Delta_Attaque_Saison', 'Delta_Defense_Saison', 'Delta_Defense_15J',
    'Delta_Corn_Pour', 'Delta_Corn_Contre', 'Dom_PPG', 'Ext_PPG',
    'xG_Attendu_Dom', 'xG_Attendu_Ext', 'Drop_Cote_Dom', 'Drop_Cote_Ext',
    'Ext_Moy15_Buts_Marques', 'Ext_Buts_Moyens', 'Delta_SOT_Pour',
    'H_EMA15_Shots_F', 'Delta_SOT_Contre', 'Dom_Moy15_Buts_Encaisses',
    'Ext_Moy15_Buts_Encaisses', 'Delta_Attaque_15J', 'Dom_Buts_Moyens'
]

# --- CONFIGURATION MONGODB SÉCURISÉE ---
load_dotenv()
MONGO_URI = os.getenv("MONGO_URI")

if not MONGO_URI:
    print("❌ ERREUR FATALE : Impossible de trouver MONGO_URI dans le fichier .env !")
    exit()

DB_NAME = "Football_Quant"
COL_HISTORIQUE = "Matchs_Historique"
COL_FIXTURES = "Fixtures_A_Venir"
COL_PROFILAGE = "Profils_Rentabilite"


def nettoyer_cotes(df):
    cotes_cols = ["B365H", "B365D", "B365A", "B365CH", "B365CD", "B365CA", "PSH", "PSD", "PSA"]
    for col in cotes_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce')
    return df


def preparer_donnees_pour_mongo(data_dir):
    print("🚀 DÉMARRAGE DE L'USINE QUANTITATIVE (Fusion + Apprentissage)...\n")

    if not data_dir.exists():
        print(f"❌ ERREUR FATALE : Le dossier '{data_dir.name}' n'existe pas !")
        return None, None

    all_files = list(data_dir.glob("*.xlsx")) + list(data_dir.glob("*.xlsm")) + list(data_dir.glob("*.csv"))

    if not all_files:
        print(f"❌ ERREUR FATALE : Le dossier '{data_dir.name}' est VIDE.")
        return None, None

    df_list = []
    fixtures_df = None

    for f in tqdm(all_files, desc="Lecture des classeurs", unit="fichier"):
        try:
            if "fixtures" in f.name.lower():
                if f.suffix in ['.xlsx', '.xlsm']:
                    fixtures_df = pd.read_excel(f)
                else:
                    fixtures_df = pd.read_csv(f)
                fixtures_df['Is_Fixture'] = 1
                continue

            if f.suffix in ['.xlsx', '.xlsm']:
                xls_data = pd.read_excel(f, sheet_name=None)
                for sheet_name, df_sheet in xls_data.items():
                    if not df_sheet.empty and 'HomeTeam' in df_sheet.columns:
                        df_sheet['Is_Fixture'] = 0
                        df_list.append(df_sheet)
            elif f.suffix == '.csv':
                df_sheet = pd.read_csv(f)
                if not df_sheet.empty and 'HomeTeam' in df_sheet.columns:
                    df_sheet['Is_Fixture'] = 0
                    df_list.append(df_sheet)
        except Exception as e:
            print(f"\n⚠️ Fichier ignoré ({f.name}) : Erreur -> {e}")

    df_histo = pd.concat(df_list, ignore_index=True)

    if fixtures_df is not None and not fixtures_df.empty:
        print(f"\n📎 Fichier Fixtures détecté. Soudure avec l'historique en cours...")
        df_all = pd.concat([df_histo, fixtures_df], ignore_index=True)
    else:
        print("\n⚠️ Aucun fichier fixtures.xlsx n'a été détecté. L'usine tournera uniquement sur l'historique.")
        df_all = df_histo

    if 'Time' not in df_all.columns:
        df_all['Time'] = '00:00'
    else:
        df_all['Time'] = df_all['Time'].fillna('00:00').astype(str)

    df_all["Date"] = pd.to_datetime(df_all["Date"], format='mixed', dayfirst=True, errors='coerce')
    df_all['Datetime'] = pd.to_datetime(df_all['Date'].dt.strftime('%Y-%m-%d') + ' ' + df_all['Time'], format='mixed', errors='coerce')
    df_all['Datetime'] = df_all['Datetime'] + pd.Timedelta(hours=1)
    df_all['Date'] = df_all['Datetime'].dt.floor('D')
    df_all['Time'] = df_all['Datetime'].dt.strftime('%H:%M')

    print(f"✂️ PURGE ANTI-VAR : Suppression des matchs avant {DATE_ANTI_VAR}...")
    df_all = df_all[df_all['Date'] >= DATE_ANTI_VAR].copy()

    print(f"🎯 FILTRE DES LIGUES : Conservation exclusive des {len(LIGUES_AUTORISEES)} ligues autorisées...")
    df_all = df_all[df_all['Div'].isin(LIGUES_AUTORISEES)].copy()

    if df_all.empty:
        print("\n❌ ERREUR FATALE : Il ne reste plus aucun match après le filtrage des ligues !")
        return None, None

    df_all = nettoyer_cotes(df_all)

    required_cols = ["Div", "FTHG", "FTAG", "FTR", "HST", "AST", "HS", "AS", "HC", "AC", "B365CH", "B365CD", "B365CA",
                     "PSH", "PSD", "PSA"]
    for col in required_cols:
        if col not in df_all.columns:
            df_all[col] = np.nan if ('B365' in col or 'PS' in col) else 0

    for col in ["HST", "AST", "HS", "AS", "HC", "AC", "FTHG", "FTAG"]:
        df_all[col] = pd.to_numeric(df_all[col], errors='coerce').fillna(0)

    df_all['FTR'] = df_all['FTR'].fillna('X')

    df_all['HomePts'] = np.where(df_all['FTR'] == 'H', 3, np.where(df_all['FTR'] == 'D', 1, 0))
    df_all['AwayPts'] = np.where(df_all['FTR'] == 'A', 3, np.where(df_all['FTR'] == 'D', 1, 0))
    df_all['Saison_ID'] = np.where(df_all['Date'].dt.month >= 7, df_all['Date'].dt.year, df_all['Date'].dt.year - 1)

    home_df = df_all[['Date', 'Time', 'Saison_ID', 'HomeTeam', 'FTHG', 'FTAG', 'HST', 'AST', 'HS', 'AS', 'HC', 'AC',
                      'HomePts']].copy()
    home_df.columns = ['Date', 'Time', 'Saison_ID', 'Team', 'GF', 'GA', 'SOT_F', 'SOT_A', 'Shots_F', 'Shots_A',
                       'Corn_F', 'Corn_A', 'Pts']
    home_df['IsHome'] = 1

    away_df = df_all[['Date', 'Time', 'Saison_ID', 'AwayTeam', 'FTAG', 'FTHG', 'AST', 'HST', 'AS', 'HS', 'AC', 'HC',
                      'AwayPts']].copy()
    away_df.columns = ['Date', 'Time', 'Saison_ID', 'Team', 'GF', 'GA', 'SOT_F', 'SOT_A', 'Shots_F', 'Shots_A',
                   'Corn_F', 'Corn_A', 'Pts']
    away_df['IsHome'] = 0

    team_stats = pd.concat([home_df, away_df]).sort_values(['Team', 'Date', 'Time'])

    print("⚙️ Calcul de la dynamique de saison et des EMAs...")
    team_stats['Match_Count'] = 1
    team_stats['Szn_J'] = team_stats.groupby(['Saison_ID', 'Team'])['Match_Count'].transform(
        lambda x: x.shift(1).cumsum().fillna(0))
    team_stats['Szn_Pts'] = team_stats.groupby(['Saison_ID', 'Team'])['Pts'].transform(
        lambda x: x.shift(1).cumsum().fillna(0))
    team_stats['Szn_GF'] = team_stats.groupby(['Saison_ID', 'Team'])['GF'].transform(
        lambda x: x.shift(1).cumsum().fillna(0))
    team_stats['Szn_GA'] = team_stats.groupby(['Saison_ID', 'Team'])['GA'].transform(
        lambda x: x.shift(1).cumsum().fillna(0))
    team_stats['Form_Pts_5'] = team_stats.groupby('Team')['Pts'].transform(
        lambda x: x.rolling(window=SPAN_FORM, min_periods=1).sum().shift(1))

    features_stats = ['GF', 'GA', 'SOT_F', 'SOT_A', 'Shots_F', 'Shots_A', 'Corn_F', 'Corn_A']
    for feat in tqdm(features_stats, desc="Calcul stats profondes (EMA)", unit="stat"):
        col_name = f'EMA15_{feat}'
        team_stats[col_name] = team_stats.groupby('Team')[feat].transform(
            lambda x: x.ewm(span=SPAN_STATS, adjust=False).mean().shift(1))
        # Correctif 2 : Backfill + fallback pour le 1er match ou les équipes sans historique initial
        team_stats[col_name] = team_stats.groupby('Team')[col_name].bfill().fillna(team_stats[feat])

    cols_to_drop = features_stats + ['IsHome', 'Pts', 'Match_Count', 'Saison_ID']

    home_stats = team_stats[team_stats['IsHome'] == 1].drop(columns=cols_to_drop)
    home_stats.columns = ['Date', 'Time', 'HomeTeam'] + [f'H_{c}' for c in home_stats.columns if
                                                         c not in ['Date', 'Time', 'Team']]

    away_stats = team_stats[team_stats['IsHome'] == 0].drop(columns=cols_to_drop)
    away_stats.columns = ['Date', 'Time', 'AwayTeam'] + [f'A_{c}' for c in away_stats.columns if
                                                         c not in ['Date', 'Time', 'Team']]

    df_ml = pd.merge(df_all, home_stats, on=['Date', 'Time', 'HomeTeam'], how='left')
    df_ml = pd.merge(df_ml, away_stats, on=['Date', 'Time', 'AwayTeam'], how='left')

    W_SOT, W_SHOT, W_CORNER, W_GOAL = 0.50, 0.25, 0.15, 0.10
    SCALE = 4.0

    force_attaque_dom = (df_ml['H_EMA15_SOT_F'] * W_SOT + df_ml['H_EMA15_Shots_F'] * W_SHOT + df_ml[
        'H_EMA15_Corn_F'] * W_CORNER + df_ml['H_EMA15_GF'] * W_GOAL)
    fragilite_defense_ext = (df_ml['A_EMA15_SOT_A'] * W_SOT + df_ml['A_EMA15_Shots_A'] * W_SHOT + df_ml[
        'A_EMA15_Corn_A'] * W_CORNER + df_ml['A_EMA15_GA'] * W_GOAL)
    force_attaque_ext = (df_ml['A_EMA15_SOT_F'] * W_SOT + df_ml['A_EMA15_Shots_F'] * W_SHOT + df_ml[
        'A_EMA15_Corn_F'] * W_CORNER + df_ml['A_EMA15_GF'] * W_GOAL)
    fragilite_defense_dom = (df_ml['H_EMA15_SOT_A'] * W_SOT + df_ml['H_EMA15_Shots_A'] * W_SHOT + df_ml[
        'H_EMA15_Corn_A'] * W_CORNER + df_ml['H_EMA15_GA'] * W_GOAL)

    df_ml['xG_Attendu_Dom'] = ((force_attaque_dom + fragilite_defense_ext) / 2) / SCALE * 1.05
    df_ml['xG_Attendu_Ext'] = ((force_attaque_ext + fragilite_defense_dom) / 2) / SCALE

    if 'PSH' in df_ml.columns and 'B365H' in df_ml.columns:
        df_ml['Cote_Dom'] = df_ml['PSH'].fillna(df_ml['B365H'])
        df_ml['Cote_Nul'] = df_ml['PSD'].fillna(df_ml['B365D'])
        df_ml['Cote_Ext'] = df_ml['PSA'].fillna(df_ml['B365A'])
    else:
        df_ml['Cote_Dom'] = df_ml.get('PSH', df_ml.get('B365H', np.nan))
        df_ml['Cote_Nul'] = df_ml.get('PSD', df_ml.get('B365D', np.nan))
        df_ml['Cote_Ext'] = df_ml.get('PSA', df_ml.get('B365A', np.nan))

    inv_h, inv_d, inv_a = 1 / df_ml['Cote_Dom'], 1 / df_ml['Cote_Nul'], 1 / df_ml['Cote_Ext']
    margin = inv_h + inv_d + inv_a
    df_ml['Proba_Book_Dom'], df_ml['Proba_Book_Nul'], df_ml[
        'Proba_Book_Ext'] = inv_h / margin, inv_d / margin, inv_a / margin

    df_ml['Closing_Dom'] = df_ml.get('B365CH', df_ml['Cote_Dom']).fillna(df_ml['Cote_Dom'])
    df_ml['Closing_Nul'] = df_ml.get('B365CD', df_ml['Cote_Nul']).fillna(df_ml['Cote_Nul'])
    df_ml['Closing_Ext'] = df_ml.get('B365CA', df_ml['Cote_Ext']).fillna(df_ml['Cote_Ext'])

    df_ml['Drop_Cote_Dom'] = df_ml['Cote_Dom'] - df_ml['Closing_Dom']
    df_ml['Drop_Cote_Ext'] = df_ml['Cote_Ext'] - df_ml['Closing_Ext']

    df_ml = df_ml.rename(columns={
        'H_Szn_J': 'Dom_Matchs_Joues', 'H_Szn_Pts': 'Dom_Points_Saison',
        'H_Szn_GF': 'Dom_Buts_Marques_Saison', 'H_Szn_GA': 'Dom_Buts_Encaisses_Saison',
        'A_Szn_J': 'Ext_Matchs_Joues', 'A_Szn_Pts': 'Ext_Points_Saison',
        'A_Szn_GF': 'Ext_Buts_Marques_Saison', 'A_Szn_GA': 'Ext_Buts_Encaisses_Saison',
        'H_Form_Pts_5': 'Dom_Forme_Pts_5', 'A_Form_Pts_5': 'Ext_Forme_Pts_5',
        'H_EMA15_GF': 'Dom_Moy15_Buts_Marques', 'A_EMA15_GF': 'Ext_Moy15_Buts_Marques',
        'H_EMA15_GA': 'Dom_Moy15_Buts_Encaisses', 'A_EMA15_GA': 'Ext_Moy15_Buts_Encaisses'
    })

    final_cols = [
        'Is_Fixture', 'Div', 'Date', 'Time', 'HomeTeam', 'AwayTeam', 'FTR',
        'Dom_Matchs_Joues', 'Dom_Points_Saison', 'Dom_Buts_Marques_Saison', 'Dom_Buts_Encaisses_Saison',
        'Ext_Matchs_Joues', 'Ext_Points_Saison', 'Ext_Buts_Marques_Saison', 'Ext_Buts_Encaisses_Saison',
        'Proba_Book_Dom', 'Proba_Book_Nul', 'Proba_Book_Ext',
        'xG_Attendu_Dom', 'xG_Attendu_Ext',
        'Dom_Forme_Pts_5', 'Ext_Forme_Pts_5',
        'Dom_Moy15_Buts_Marques', 'Ext_Moy15_Buts_Marques',
        'Dom_Moy15_Buts_Encaisses', 'Ext_Moy15_Buts_Encaisses',
        'H_EMA15_SOT_F', 'A_EMA15_SOT_F', 'H_EMA15_SOT_A', 'A_EMA15_SOT_A',
        'H_EMA15_Shots_F', 'A_EMA15_Shots_F', 'H_EMA15_Shots_A', 'A_EMA15_Shots_A',
        'H_EMA15_Corn_F', 'A_EMA15_Corn_F', 'H_EMA15_Corn_A', 'A_EMA15_Corn_A',
        'Drop_Cote_Dom', 'Drop_Cote_Ext',
        'Cote_Dom', 'Cote_Nul', 'Cote_Ext'
    ]

    df_ml = df_ml.dropna(subset=['xG_Attendu_Dom', 'xG_Attendu_Ext'])
    final_dataset = df_ml[final_cols].copy()

    final_dataset['Date'] = final_dataset['Date'].dt.strftime('%Y-%m-%d')
    final_dataset['Time'] = final_dataset['Time'].apply(lambda x: str(x) if pd.notnull(x) else '00:00')
    final_dataset = final_dataset.replace({np.nan: None})

    df_historique = final_dataset[final_dataset['Is_Fixture'] == 0].drop(columns=['Is_Fixture'])
    df_fixtures = final_dataset[final_dataset['Is_Fixture'] == 1].drop(columns=['Is_Fixture'])

    print(f"\n✅ Pipeline mathématique terminé :")
    print(f"   -> {len(df_historique)} matchs historiques préparés.")
    print(f"   -> {len(df_fixtures)} fixtures à venir générées.")

    return df_historique, df_fixtures


def injecter_dans_mongodb(df_histo, df_fixtures):
    print(f"\n🔌 Connexion à MongoDB ({MONGO_URI})...")
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.server_info()
    except Exception as e:
        print(f"❌ ERREUR MONGODB : {e}")
        return None

    db = client[DB_NAME]

    col_histo = db[COL_HISTORIQUE]
    print(f"🗑️  Purge de l'ancienne collection {COL_HISTORIQUE}...")
    col_histo.drop()
    if not df_histo.empty:
        col_histo.insert_many(df_histo.to_dict('records'))
        print(f"✅ {len(df_histo)} matchs scellés dans {COL_HISTORIQUE}.")

    col_fixt = db[COL_FIXTURES]
    print(f"🗑️  Purge de l'ancienne collection {COL_FIXTURES}...")
    col_fixt.drop()
    if not df_fixtures.empty:
        col_fixt.insert_many(df_fixtures.to_dict('records'))
        print(f"✅ {len(df_fixtures)} matchs scellés dans {COL_FIXTURES}.")

    return db


# ==========================================
# 🧠 RE-ENTRAINEMENT CONTINU (LABORATOIRE PROFILAGE INTÉGRÉ)
# ==========================================
def lancer_laboratoire_profilage(db):
    print("\n=======================================================================")
    print("☢️ ALLUMAGE DU LABORATOIRE DE PROFILAGE MASSIF (MATRICE 3D)")
    print("=======================================================================")

    try:
        lgbm_model = joblib.load("Modeles_Sauvegardes/Titan_LightGBM.pkl")
        xgb_model = joblib.load("Modeles_Sauvegardes/Titan_XGBoost.pkl")
        label_encoder = joblib.load("Modeles_Sauvegardes/LabelEncoder_FTR.pkl")
    except Exception as e:
        print(f"❌ Erreur critique au chargement des modèles : {e}")
        return

    col_histo = db[COL_HISTORIQUE]
    col_profilage = db[COL_PROFILAGE]

    print("📥 Extraction de l'archive temporelle fraîchement mise à jour...")
    cursor = col_histo.find({"Cote_Dom": {"$gt": 0}, "Cote_Nul": {"$gt": 0}, "Cote_Ext": {"$gt": 0}})
    df = pd.DataFrame(list(cursor))

    if df.empty:
        print("❌ Aucune donnée trouvée dans l'historique pour le calcul de la matrice.")
        return

    def safe_float(col):
        return pd.to_numeric(df[col], errors='coerce').fillna(0.0)

    print("🧬 Calcul des variables d'élite pour la modélisation...")
    df_predict = pd.DataFrame()
    df_predict['Delta_xG'] = safe_float('xG_Attendu_Dom') - safe_float('xG_Attendu_Ext')
    df_predict['Delta_Shots_Pour'] = safe_float('H_EMA15_Shots_F') - safe_float('A_EMA15_Shots_F')

    dom_j, ext_j = safe_float('Dom_Matchs_Joues'), safe_float('Ext_Matchs_Joues')
    df_predict['Delta_PPG_Saison'] = np.where(dom_j > 0, safe_float('Dom_Points_Saison') / dom_j, 0) - np.where(
        ext_j > 0, safe_float('Ext_Points_Saison') / ext_j, 0)
    df_predict['Delta_Shots_Contre'] = safe_float('A_EMA15_Shots_A') - safe_float('H_EMA15_Shots_A')

    dom_bm = np.where(dom_j > 0, safe_float('Dom_Buts_Marques_Saison') / dom_j, 0)
    ext_bm = np.where(ext_j > 0, safe_float('Ext_Buts_Marques_Saison') / ext_j, 0)
    dom_be = np.where(dom_j > 0, safe_float('Dom_Buts_Encaisses_Saison') / dom_j, 0)
    ext_be = np.where(ext_j > 0, safe_float('Ext_Buts_Encaisses_Saison') / ext_j, 0)

    df_predict['Delta_Attaque_Saison'] = dom_bm - ext_bm
    df_predict['Delta_Defense_Saison'] = ext_be - dom_be
    df_predict['Delta_Defense_15J'] = safe_float('Ext_Moy15_Buts_Encaisses') - safe_float('Dom_Moy15_Buts_Encaisses')
    df_predict['Delta_Corn_Pour'] = safe_float('H_EMA15_Corn_F') - safe_float('A_EMA15_Corn_F')
    df_predict['Delta_Corn_Contre'] = safe_float('A_EMA15_Corn_A') - safe_float('H_EMA15_Corn_A')
    df_predict['Dom_PPG'] = np.where(dom_j > 0, safe_float('Dom_Points_Saison') / dom_j, 0)
    df_predict['Ext_PPG'] = np.where(ext_j > 0, safe_float('Ext_Points_Saison') / ext_j, 0)
    df_predict['xG_Attendu_Dom'] = safe_float('xG_Attendu_Dom')
    df_predict['xG_Attendu_Ext'] = safe_float('xG_Attendu_Ext')
    df_predict['Drop_Cote_Dom'] = safe_float('Drop_Cote_Dom')
    df_predict['Drop_Cote_Ext'] = safe_float('Drop_Cote_Ext')
    df_predict['Ext_Moy15_Buts_Marques'] = safe_float('Ext_Moy15_Buts_Marques')
    df_predict['Ext_Buts_Moyens'] = ext_bm
    df_predict['Delta_SOT_Pour'] = safe_float('H_EMA15_SOT_F') - safe_float('A_EMA15_SOT_F')
    df_predict['H_EMA15_Shots_F'] = safe_float('H_EMA15_Shots_F')
    df_predict['Delta_SOT_Contre'] = safe_float('A_EMA15_SOT_A') - safe_float('H_EMA15_SOT_A')
    df_predict['Dom_Moy15_Buts_Encaisses'] = safe_float('Dom_Moy15_Buts_Encaisses')
    df_predict['Ext_Moy15_Buts_Encaisses'] = safe_float('Ext_Moy15_Buts_Encaisses')
    df_predict['Delta_Attaque_15J'] = safe_float('Dom_Moy15_Buts_Marques') - safe_float('Ext_Moy15_Buts_Marques')
    df_predict['Dom_Buts_Moyens'] = dom_bm

    print("🔮 Génération de la Matrice des Probabilités...")
    probs_lgbm = lgbm_model.predict_proba(df_predict[FEATURES_ELITE])
    probs_xgb = xgb_model.predict_proba(df_predict[FEATURES_ELITE])

    classes = label_encoder.classes_
    idx_H, idx_D, idx_A = np.where(classes == 'H')[0][0], np.where(classes == 'D')[0][0], np.where(classes == 'A')[0][0]

    probs_hydre_H = (probs_lgbm[:, idx_H] + probs_xgb[:, idx_H]) / 2
    probs_hydre_D = (probs_lgbm[:, idx_D] + probs_xgb[:, idx_D]) / 2
    probs_hydre_A = (probs_lgbm[:, idx_A] + probs_xgb[:, idx_A]) / 2

    cotes_H = df['Cote_Dom'].values
    cotes_D = df['Cote_Nul'].values
    cotes_A = df['Cote_Ext'].values

    edge_H = ((probs_hydre_H * cotes_H) - 1) * 100
    edge_D = ((probs_hydre_D * cotes_D) - 1) * 100
    edge_A = ((probs_hydre_A * cotes_A) - 1) * 100

    resultats_reels = df['FTR'].values

    print("⚔️ Simulation de TOUTES les issues pour TOUS les matchs (Calcul vectorisé)...")
    df_H = pd.DataFrame({"Issue": "H", "Cote": cotes_H, "Edge": edge_H, "Gagne": np.where(resultats_reels == 'H', 1, 0),
                         "PnL": np.where(resultats_reels == 'H', cotes_H - 1, -1)})
    df_D = pd.DataFrame({"Issue": "D", "Cote": cotes_D, "Edge": edge_D, "Gagne": np.where(resultats_reels == 'D', 1, 0),
                         "PnL": np.where(resultats_reels == 'D', cotes_D - 1, -1)})
    df_A = pd.DataFrame({"Issue": "A", "Cote": cotes_A, "Edge": edge_A, "Gagne": np.where(resultats_reels == 'A', 1, 0),
                         "PnL": np.where(resultats_reels == 'A', cotes_A - 1, -1)})

    df_matrice = pd.concat([df_H, df_D, df_A], ignore_index=True)

    # BINNING ZONES TACTIQUES
    cotes_bins = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 7.0, 10.0, 15.0, 100.0]
    cotes_labels = ['[1.0 - 1.5]', '[1.5 - 2.0]', '[2.0 - 2.5]', '[2.5 - 3.0]', '[3.0 - 3.5]', '[3.5 - 4.0]',
                    '[4.0 - 5.0]', '[5.0 - 7.0]', '[7.0 - 10.0]', '[10.0 - 15.0]', '[> 15.0]']
    df_matrice['Tranche_Cote'] = pd.cut(df_matrice['Cote'], bins=cotes_bins, labels=cotes_labels)

    def categoriser_edge(e):
        if e < -10:
            return "< -10%"
        elif -10 <= e < -5:
            return "[-10% à -5%]"
        elif -5 <= e < -2:
            return "[-5% à -2%]"
        elif -2 <= e < 0:
            return "[-2% à 0%]"
        elif 0 <= e < 3:
            return "[0% à 3%]"
        elif 3 <= e < 6:
            return "[3% à 6%]"
        elif 6 <= e < 10:
            return "[6% à 10%]"
        elif 10 <= e < 15:
            return "[10% à 15%]"
        elif 15 <= e < 20:
            return "[15% à 20%]"
        else:
            return "> +20%"

    df_matrice['Tranche_Edge'] = df_matrice['Edge'].apply(categoriser_edge)

    print("🧮 Calcul des ROIs croisés...")
    profils = df_matrice.groupby(['Issue', 'Tranche_Cote', 'Tranche_Edge']).agg(
        Volume_Matchs=('PnL', 'count'),
        Victoires=('Gagne', 'sum'),
        Profit_Net_Unites=('PnL', 'sum')
    ).reset_index()

    profils = profils[profils['Volume_Matchs'] > 0]
    profils['ROI_Pourcent'] = (profils['Profit_Net_Unites'] / profils['Volume_Matchs']) * 100
    profils['WinRate_Pourcent'] = (profils['Victoires'] / profils['Volume_Matchs']) * 100

    print("📡 Injection de la nouvelle Matrice 3D d'apprentissage dans MongoDB...")
    col_profilage.delete_many({})

    documents_a_inserer = []
    for _, row in profils.iterrows():
        documents_a_inserer.append({
            "Issue": str(row['Issue']),
            "Tranche_Cote": str(row['Tranche_Cote']),
            "Tranche_Edge": str(row['Tranche_Edge']),
            "Volume": int(row['Volume_Matchs']),
            "ROI": float(row['ROI_Pourcent']),
            "WinRate": float(row['WinRate_Pourcent'])
        })

    col_profilage.insert_many(documents_a_inserer)

    print("\n" + "=" * 70)
    print("✅ CERVEAU MIS À JOUR : La machine a intégré les derniers matchs de la semaine.")
    print("=" * 70)


if __name__ == "__main__":
    # 1. Extraction et Transformation
    df_histo, df_fixtures = preparer_donnees_pour_mongo(DATA_DIR)

    if df_histo is not None:
        # 2. Chargement dans Mongo (Historique + Fixtures)
        db_instance = injecter_dans_mongodb(df_histo, df_fixtures)

        # 3. Lancement de l'apprentissage continu si l'injection a réussi
        if db_instance is not None:
            lancer_laboratoire_profilage(db_instance)