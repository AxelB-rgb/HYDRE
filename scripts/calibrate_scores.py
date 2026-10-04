"""Reproduit les features de l'injecteur hors Mongo et fige les bornes historiques.

Lancer depuis la racine avec les dépendances backend installées.
Calibration 2021–2025, contrôle temporel 2025–2026. Aucun accès réseau/base.
"""
import ast
import json
from pathlib import Path
import warnings
import pandas as pd
import numpy as np
import joblib
from tqdm import tqdm

warnings.filterwarnings("ignore")
source = ast.parse(Path("Mongo_Injector.py").read_text(encoding="utf-8-sig"))
nodes = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in
         ("nettoyer_cotes", "preparer_donnees_pour_mongo")]
namespace = dict(pd=pd, np=np, Path=Path, tqdm=tqdm, DATE_ANTI_VAR="2021-08-01", SPAN_STATS=15, SPAN_FORM=5,
                 LIGUES_AUTORISEES=['B1','D1','D2','E0','E1','F1','F2','G1','I1','I2','N1','P1','SC0','SP1','SP2','T1'])
exec(compile(ast.Module(body=nodes, type_ignores=[]), "injector", "exec"), namespace)
df, _ = namespace["preparer_donnees_pour_mongo"](Path("Data"))
df = df[df.Date < "2026-07-01"].copy()
# Réutilisation exacte du bloc de features vectorisé de l'injecteur.
laboratoire = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == "lancer_laboratoire_profilage")
start = next(i for i,n in enumerate(laboratoire.body) if isinstance(n, ast.FunctionDef) and n.name == "safe_float")
end = next(i for i,n in enumerate(laboratoire.body) if isinstance(n, ast.Assign) and
           any(isinstance(t,ast.Name) and t.id == "probs_lgbm" for t in n.targets))
namespace["df"] = df
exec(compile(ast.Module(body=laboratoire.body[start:end], type_ignores=[]), "features", "exec"), namespace)
config = ast.parse(Path("backend/config.py").read_text(encoding="utf-8"))
features = next(ast.literal_eval(n.value) for n in config.body if isinstance(n,ast.Assign) and
                any(isinstance(t,ast.Name) and t.id == "FEATURES_ELITE" for t in n.targets))
x = namespace["df_predict"][features]
lgb = joblib.load("Modeles_Sauvegardes/Titan_LightGBM.pkl")
xgb = joblib.load("Modeles_Sauvegardes/Titan_XGBoost.pkl")
lgb.set_params(n_jobs=1)
xgb.set_params(n_jobs=1)
classes = joblib.load("Modeles_Sauvegardes/LabelEncoder_FTR.pkl").classes_
probs = (lgb.predict_proba(x) + xgb.predict_proba(x)) / 2 * 100
odds = np.column_stack([pd.to_numeric(df[{'H':'Cote_Dom','D':'Cote_Nul','A':'Cote_Ext'}[c]], errors='coerce').fillna(0).to_numpy(dtype=float) for c in classes])
edges = (probs / 100 * odds - 1) * 100
eligible = (probs > 45) & (odds >= 1) & (odds <= 3) & (edges > 0)
chosen = np.argmax(np.where(eligible, edges, -np.inf), axis=1)
rows = np.arange(len(df))
valid = eligible.any(axis=1)
sample = pd.DataFrame({'date':df.Date.to_numpy(), 'edge':edges[rows,chosen],
                       'proba':probs[rows,chosen], 'gain_potentiel':odds[rows,chosen]-1})[valid]
train = sample[sample.date < "2025-07-01"]
holdout = sample[sample.date >= "2025-07-01"]
bounds = {key:[round(float(train[key].quantile(.05)),6),round(float(train[key].quantile(.95)),6)]
          for key in ('edge','proba','gain_potentiel')}
bounds.update(roi_historique=[0,30], volume_historique=[50,500])
artifact = {'version':'historical-2021-2025-v1', 'source':'Data/all-euro-data, features et modèles HYDRE existants',
            'calibration_start':'2021-08-01', 'calibration_end':'2025-06-30', 'samples':len(train),
            'method':'bornes fixes P5/P95 des candidats éligibles historiques; ROI/volume inchangés', 'bounds':bounds}
Path('backend/score_calibration.json').write_text(json.dumps(artifact,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
def distribution(data, limits):
    # Isolation de l'effet de calibration : ROI/volume à zéro dans les DEUX versions.
    score = sum(weight*np.clip((data[key]-limits[key][0])/(limits[key][1]-limits[key][0]),0,1)*100
                for key,weight in [('edge',.45),('proba',.35),('gain_potentiel',.05)])
    return {'n':len(data),'min':round(float(score.min()),1),'p10':round(float(score.quantile(.1)),1),
            'median':round(float(score.median()),1),'p90':round(float(score.quantile(.9)),1),
            'max':round(float(score.max()),1),'above40_pct':round(float((score>40).mean()*100),1)}
old = dict(edge=[0,100],proba=[45,100],gain_potentiel=[0,2])
report = {'bounds':bounds,'calibration':{'before':distribution(train,old),'after':distribution(train,bounds)},
          'holdout_2025_2026':{'before':distribution(holdout,old),'after':distribution(holdout,bounds)},
          'limitation':'Contrôle de distribution, pas validation de rentabilité ni garantie hors échantillon des modèles. ROI/volume neutralisés.'}
Path('scripts/score_distribution_report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(json.dumps(report,indent=2,ensure_ascii=False))
