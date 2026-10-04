"""Tests métier hors réseau/Mongo, sur les fonctions de production."""
import ast
import json
from pathlib import Path
import unittest
from unittest.mock import MagicMock
from datetime import datetime
import math
import itertools
from backend.settlement import retour_net, montant_reglement, type_fond_effectif

ROOT = Path(__file__).resolve().parents[1]


def functions(path, names=None, namespace=None):
    tree = ast.parse((ROOT / path).read_text(encoding="utf-8-sig"))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and (names is None or n.name in names)]
    for node in nodes:
        node.decorator_list = []
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    module = ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[]))
    ns = namespace or {}
    exec(compile(module, str(path), "exec"), ns)
    return ns


class Regressions(unittest.TestCase):
    def setUp(self):
        self.weights = dict(edge=.45, proba=.35, roi_historique=.10, volume_historique=.05, gain_potentiel=.05)
        self.engine = functions("backend/hydre_engine.py", {"normaliser", "_calculer_scores_groupe", "_scanner_marche_data", "_snapshot_score_hydre_pour_match"}, {
            "PONDERATION_SCORE": self.weights,
            "SCORE_CALIBRATION": json.loads((ROOT / "backend/score_calibration.json").read_text()),
            "datetime": datetime,
        })

    def test_score_independent_of_pool_order_and_duplicates(self):
        row = dict(edge=20, proba=65, roi_historique=10, volume_historique=250, gain_potentiel=1)
        original = dict(row)
        self.engine['_calculer_scores_groupe']([original])
        for pool in ([dict(row), dict(row, edge=100)], [dict(row, edge=1), dict(row)], [dict(row)] * 5):
            self.engine['_calculer_scores_groupe'](pool)
            self.assertTrue(all(r['score'] == original['score'] for r in pool if r['edge'] == 20))
        for extreme in (-1000, 1000):
            data = {k: extreme for k in self.weights}
            self.engine['_calculer_scores_groupe']([data])
            self.assertGreaterEqual(data['score'], 0)
            self.assertLessEqual(data['score'], 100)

    def test_scanner_scores_even_without_available_budget(self):
        ns = self.engine
        fixture = dict(HomeTeam='H', AwayTeam='A', Date=datetime.now().strftime('%Y-%m-%d'), Time='20:00', Cote_Actuelle_Dom=2, Cote_Actuelle_Nul=3, Cote_Actuelle_Ext=3)
        fixtures, params = MagicMock(), MagicMock()
        fixtures.find.return_value = [fixture]
        params.find_one.return_value = None
        ns.update(col_fixtures=fixtures, col_parametres=params, PROFILS_EXPOSITION={'EQUILIBRE':20},
                  MISE_MIN_PCT=.5, MISE_MAX_PCT=3, safe_float=lambda v:float(v or 0),
                  warnings_division=lambda *args:[], _calculer_finances_dict=lambda:{'total':100},
                  respecte_criteres_selection=lambda p,c,e:p>45 and e>0 and c<=3,
                  evaluer_profil=lambda *args:{'roi':10,'vol':250},
                  calculer_predictions_completes=lambda *args:{'probas':{'Hydre':{'H':60,'D':20,'A':20}},'edges':{'Hydre':{'H':20,'D':-40,'A':-40}}})
        scores = []
        for budget in (0,20,30):
            ns['_exposition_cash_deja_engagee_par_date'] = lambda _, value=budget:{fixture['Date']:value}
            row = ns['_scanner_marche_data']()['matchs'][0]
            scores.append(row['score'])
        self.assertEqual(len(set(scores)), 1)
        self.assertEqual(ns['_snapshot_score_hydre_pour_match'](fixture), scores[0])

    def test_freebet_net_and_legacy_cash_unchanged(self):
        for mise,cote,net in [(1,5,4),(2,3,4),(10,1.5,5)]:
            p=dict(mise=mise,cote_choisie=cote,type_fond='FREEBET',Resultat_Final='GAGNE',Montant_Retour=mise*cote)
            self.assertEqual(retour_net(p),net)
            self.assertEqual(montant_reglement(p,'GAGNE',999),net)
            cash=dict(p,type_fond='CASH')
            self.assertEqual(retour_net(cash),mise*cote)
            self.assertEqual(montant_reglement(cash,'GAGNE',mise*cote),mise*cote)
            self.assertEqual(montant_reglement(cash,'GAGNE',999),999)
        self.assertEqual(retour_net(dict(type_fond='FREEBET',Resultat_Final='CASHOUT',Montant_Retour=2)),2)
        self.assertEqual(montant_reglement(dict(mise=5,type_fond='FREEBET'),'ANNULE',0),5)

    def test_promoted_relegated_and_same_division(self):
        history=MagicMock()
        ns=functions('backend/division_warnings.py', {'warnings_division'}, {'col_historique':history})
        tree=ast.parse((ROOT/'backend/division_warnings.py').read_text(encoding='utf-8'))
        ns['DIVISIONS']=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign))
        for current,old,direction in [('F1','F2','PROMUE'),('F2','F1','RELÉGUÉE')]:
            history.find_one.return_value={'Div':old}
            rows=ns['warnings_division'](dict(Date='2026-08-01',Div=current,HomeTeam='H',AwayTeam='A'))
            self.assertEqual([w['sens'] for w in rows],[direction,direction])
            query=history.find_one.call_args.args[0]
            self.assertEqual(query['Date'],{'$gte':'2025-07-01','$lt':'2026-07-01'})
        history.find_one.return_value={'Div':'F1'}
        self.assertEqual(ns['warnings_division'](dict(Date='2026-08-01',Div='F1',HomeTeam='H',AwayTeam='A')),[])
        history.find_one.return_value=None
        self.assertEqual(ns['warnings_division'](dict(Date='2026-08-01',Div='F1',HomeTeam='H',AwayTeam='A')),[])

    def test_ticket_progression_preserves_composition_0_to_5(self):
        paris,historique,fixtures=MagicMock(),MagicMock(),MagicMock()
        legs=[dict(id_match=str(i),home_team=str(i),away_team='A',date='2026-08-01',div='F1') for i in range(5)]
        ticket={'id_match':'TICKET','selections_combine':legs,'taille_combine':5}
        paris.find.return_value.sort.return_value=[ticket]
        historique.find_one.return_value=None
        fixtures.find_one.return_value=None
        ns=functions('backend/freebet_optimizer.py',{'combos_freebet_en_cours'},dict(col_paris=paris,col_historique=historique,col_fixtures=fixtures,warnings_division=lambda *args:[],type_fond_effectif=type_fond_effectif))
        for count in range(6):
            paris.find_one.side_effect=lambda query,n=count: {'id_match':query['id_match']} if int(query['id_match'])<n else None
            combo=ns['combos_freebet_en_cours']()['combos'][0]
            self.assertEqual(combo['nb_valides'],count)
            self.assertEqual(combo['nb_total'],5)
            self.assertEqual([s['id_match'] for s in combo['selections']],[str(i) for i in range(5)])
            self.assertEqual(combo['id_match'],'TICKET')
        paris.update_one.assert_not_called()

    def test_selection_counts_matches_not_tickets_or_only_closed_bets(self):
        paris=MagicMock()
        a=dict(id_match='A',date='2026-10-01',div='F1')
        b=dict(id_match='B',date='2026-10-02',div='F2')
        paris.find.return_value=[a,dict(est_combine_freebet=True,selections_combine=[a,b]),dict(id_match='OLD',date='2025-10-01',div='F1')]
        ns=functions('backend/stats.py',{'_matchs_selectionnes_liste'},{'col_paris':paris})
        rows=ns['_matchs_selectionnes_liste']('2026-07-01')
        self.assertEqual([r['id'] for r in rows],['A','B'])
        self.assertEqual([r['div'] for r in rows],['F1','F2'])
        self.assertEqual(paris.find.call_args.args[0],{'Resultat_Final':{'$ne':'ANNULE'}})

    def test_freebet_bankroll_profit_never_subtracts_stake_twice(self):
        ns=functions('backend/bankroll.py',{'_pnl_cash_pari'},{'retour_net':retour_net,'type_fond_effectif':type_fond_effectif})
        pnl=ns['_pnl_cash_pari']
        self.assertEqual(pnl(dict(type_fond='FREEBET',Resultat_Final='GAGNE',mise=1,cote_choisie=5,Montant_Retour=5)),4)
        self.assertEqual(pnl(dict(type_fond='FREEBET',Resultat_Final='PERDU',mise=1,Montant_Retour=0)),0)
        self.assertEqual(pnl(dict(type_fond='CASH',Resultat_Final='GAGNE',mise=1,Montant_Retour=5)),4)
        self.assertEqual(pnl(dict(type_fond='CASH',Resultat_Final='PERDU',mise=1,Montant_Retour=0)),-1)

    def test_combo_ev_and_portfolio_use_net_gain(self):
        ns=dict(math=math,itertools=itertools)
        config=ast.parse((ROOT/'backend/config.py').read_text(encoding='utf-8'))
        for n in config.body:
            if isinstance(n,ast.Assign):
                try:
                    value=ast.literal_eval(n.value)
                    for t in n.targets:
                        if isinstance(t,ast.Name): ns[t.id]=value
                except (ValueError,TypeError): pass
        ns.update(self.engine)
        ns=functions('backend/freebet_optimizer.py',namespace=ns)
        legs=[dict(id='A',home_team='A',away_team='Z',cote=2,proba=60,score=60),dict(id='B',home_team='B',away_team='Z',cote=2.5,proba=50,score=70)]
        combo=ns['_calculer_base_combo'](legs,2)
        self.assertEqual(combo['gain_potentiel_pour_1e'],4)
        self.assertEqual(combo['ev_pour_1e'],1.2)
        # Le portefeuille et le classement restent bornés après recalibration.
        combos,_,_,_=ns['_freebet_calculer_combos'](legs,[2],100)
        self.assertTrue(all(0<=c['score']<=100 for c in combos))
        for c in combos: c['mise_prevue_portefeuille']=1
        score=ns['_calculer_score_portefeuille'](combos,len(legs))
        self.assertTrue(0<=score['score_global']<=100)
        before=combos[0]['score']
        better=[dict(leg,score=leg['score']+10) for leg in legs]
        better_combos,_,_,_=ns['_freebet_calculer_combos'](better,[2],100)
        self.assertAlmostEqual(better_combos[0]['score']-before,1.9,places=1)

    def test_all_python_compiles(self):
        for path in [*ROOT.glob('backend/*.py'), *ROOT.glob('scripts/*.py')]:
            compile(path.read_text(encoding='utf-8-sig'),str(path),'exec')


if __name__ == '__main__':
    unittest.main()
