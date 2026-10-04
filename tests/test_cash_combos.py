"""Financement distinct, un seul moteur et compatibilité des anciens tickets."""
import math
import ast
import itertools
import uuid
from datetime import datetime
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock
from backend.settlement import retour_net, montant_reglement, type_fond_effectif, dates_exposition_cash
from test_regressions import functions, ROOT


class HTTPError(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


class CashCombos(unittest.TestCase):
    def setUp(self):
        self.pnl = functions('backend/bankroll.py', {'_pnl_cash_pari'},
                             dict(retour_net=retour_net, type_fond_effectif=type_fond_effectif))['_pnl_cash_pari']

    def test_freebet_one_at_five_profits_four(self):
        p = dict(est_combine_freebet=True, type_ticket='FREEBET', mise=1, cote_choisie=5, Resultat_Final='GAGNE')
        p['Montant_Retour'] = montant_reglement(p, 'GAGNE', 999)
        self.assertEqual(p['Montant_Retour'], 4)
        self.assertEqual(self.pnl(p), 4)

    def test_cash_one_at_five_returns_five_profits_four(self):
        p = dict(est_combine_freebet=True, type_ticket='CASH', mise=1, cote_choisie=5, Resultat_Final='GAGNE')
        p['Montant_Retour'] = montant_reglement(p, 'GAGNE', 999)
        self.assertEqual(p['Montant_Retour'], 5)
        self.assertEqual(self.pnl(p), 4)
        p.update(Resultat_Final='PERDU', Montant_Retour=montant_reglement(p, 'PERDU', 999))
        self.assertEqual(self.pnl(p), -1)

    def test_legacy_combo_is_freebet_simple_remains_cash(self):
        p = dict(est_combine_freebet=True, mise=1, cote_choisie=5, Resultat_Final='GAGNE', Montant_Retour=5)
        self.assertEqual(type_fond_effectif(p), 'FREEBET')
        self.assertEqual(retour_net(p), 4)
        self.assertEqual(self.pnl(p), 4)
        self.assertEqual(type_fond_effectif({}), 'CASH')

    def test_balances_remain_separate_and_cancellation_restores_cash(self):
        params, paris = MagicMock(), MagicMock()
        params.find_one.return_value = dict(capital=100, freebets_total_acquis=10)
        settled = [dict(est_combine_freebet=True, type_ticket='FREEBET', mise=1, cote_choisie=5, Resultat_Final='GAGNE', Montant_Retour=4),
                   dict(est_combine_freebet=True, type_ticket='CASH', mise=1, cote_choisie=5, Resultat_Final='PERDU', Montant_Retour=0)]
        open_bets = [dict(est_combine_freebet=True, type_ticket='CASH', mise=2), dict(est_combine_freebet=True, mise=3)]
        paris.find.side_effect = [settled, open_bets]
        ns = functions('backend/bankroll.py', {'_calculer_finances_dict'}, dict(
            col_parametres=params, col_paris=paris, RESULTATS_REGLES=('GAGNE','PERDU','CASHOUT'),
            _pnl_cash_pari=self.pnl, type_fond_effectif=type_fond_effectif))
        f = ns['_calculer_finances_dict']()
        self.assertEqual((f['total'], f['engage'], f['disponible']), (103, 2, 101))
        self.assertEqual(f['freebets'], dict(total_acquis=9, engage=3, disponible=6))
        paris.find.side_effect = [settled, open_bets[1:]]
        self.assertEqual(ns['_calculer_finances_dict']()['disponible'], 103)

    def test_cash_risk_and_freebet_balance_use_distinct_limits(self):
        params = MagicMock()
        params.find_one.return_value = {'profil':'EQUILIBRE'}
        ns = functions('backend/freebet_optimizer.py', {'_verifier_financement_combo'}, dict(
            col_parametres=params, PROFILS_EXPOSITION={'EQUILIBRE':20}, MISE_MAX_PCT=3,
            _exposition_cash_deja_engagee_par_date=lambda _: {'2026-10-02':19}, HTTPException=HTTPError))
        funds = dict(total=100, disponible=100, freebets={'disponible':1})
        req = SimpleNamespace(mise_freebet=1, type_ticket='CASH', selections=[SimpleNamespace(date='2026-10-02 20:00')])
        ns['_verifier_financement_combo'](req, funds)
        req.mise_freebet=2
        with self.assertRaises(HTTPError): ns['_verifier_financement_combo'](req,funds)
        req.mise_freebet=4
        with self.assertRaises(HTTPError): ns['_verifier_financement_combo'](req,funds)
        req.type_ticket='FREEBET'; req.mise_freebet=1
        ns['_verifier_financement_combo'](req,funds)
        req.mise_freebet=2
        with self.assertRaises(HTTPError): ns['_verifier_financement_combo'](req,funds)

    def test_same_validation_preserves_selections_scores_and_profiles_for_both_types(self):
        paris = MagicMock()
        ns = functions('backend/freebet_optimizer.py', {'valider_combo_freebet'}, dict(
            col_paris=paris, math=math, uuid=uuid, datetime=datetime, HTTPException=HTTPError,
            _cote_est_verrouillee=lambda _:False, _calculer_finances_dict=lambda:{}, _verifier_financement_combo=MagicMock()))
        class Leg(SimpleNamespace):
            def dict(self): return vars(self).copy()
        selections = [Leg(id_match='A',home_team='A',away_team='B',issue='H',date='2026-10-02 20:00'),
                      Leg(id_match='C',home_team='C',away_team='D',issue='H',date='2026-10-02 21:00')]
        docs = []
        for type_ticket in ('FREEBET','CASH'):
            req=SimpleNamespace(taille=2,selections=selections,cote_totale_calculee=5,cote_totale_reelle=5,
                mise_freebet=1,score=71,niveau_risque='MOYEN',probabilite_pct=30,edge_pct=50,bookmaker='WINAMAX',type_ticket=type_ticket)
            ns['valider_combo_freebet'](req)
            docs.append(paris.insert_one.call_args.args[0])
        for key in ('selections_combine','score_combine','taille_combine','niveau_risque_combine','probabilite_pct_combine','edge_pct_combine','cote_totale_calculee'):
            self.assertEqual(docs[0][key],docs[1][key])
        self.assertEqual([p['type_ticket'] for p in docs],['FREEBET','CASH'])
        self.assertEqual([p['type_fond'] for p in docs],['FREEBET','CASH'])

    def test_cash_exposure_counts_each_match_date_once_not_booking_date(self):
        ticket=dict(est_combine_freebet=True,type_ticket='CASH',mise=2,date='2026-09-30',
                    selections_combine=[{'date':'2026-10-02 20:00'},{'date':'2026-10-02 21:00'},{'date':'2026-10-03 20:00'}])
        self.assertEqual(dates_exposition_cash(ticket),{'2026-10-02','2026-10-03'})
        paris=MagicMock(); paris.find.return_value=[ticket,dict(est_combine_freebet=True,mise=20,date='2026-10-02'),dict(type_fond='CASH',mise=1,date='2026-10-02')]
        ns=functions('backend/hydre_engine.py',{'_exposition_cash_deja_engagee_par_date'},dict(col_paris=paris,type_fond_effectif=type_fond_effectif,dates_exposition_cash=dates_exposition_cash))
        self.assertEqual(ns['_exposition_cash_deja_engagee_par_date'](100),{'2026-10-02':3,'2026-10-03':2})

    def test_dashboard_api_keeps_cash_and_legacy_freebet_statistics_separate(self):
        settled = [
            dict(_id='F',id_match='F',est_combine_freebet=True,mise=1,cote_choisie=5,Montant_Retour=5,Resultat_Final='GAGNE',taille_combine=2,Date_Cloture='2026-10-01 20:00'),
            dict(_id='C',id_match='C',est_combine_freebet=True,type_ticket='CASH',type_fond='CASH',mise=1,cote_choisie=5,Montant_Retour=5,Resultat_Final='GAGNE',taille_combine=2,Date_Cloture='2026-10-01 20:01'),
            dict(_id='L',id_match='L',est_combine_freebet=True,type_ticket='CASH',type_fond='CASH',mise=1,cote_choisie=3,Montant_Retour=0,Resultat_Final='PERDU',taille_combine=3,Date_Cloture='2026-10-02 20:00'),
        ]
        class Cursor(list):
            def sort(self, *args): return self
        paris, params, historique, fixtures = MagicMock(), MagicMock(), MagicMock(), MagicMock()
        paris.find.side_effect = lambda query,*args: Cursor([] if query.get('Resultat_Final') == {'$exists':False} else settled)
        params.find_one.return_value = {'capital':100}
        historique.find.return_value=[]; fixtures.find.return_value=[]
        ns=functions('backend/stats.py',namespace=dict(col_paris=paris,col_parametres=params,col_historique=historique,col_fixtures=fixtures,
            _debut_saison_actuelle=lambda:'2026-07-01',_pnl_cash_pari=self.pnl,retour_net=retour_net,type_fond_effectif=type_fond_effectif))
        result=ns['statistiques_dashboard']()
        self.assertEqual(result['statsTypePari']['COMBINE']['count'],1)
        self.assertEqual(result['statsTypePari']['COMBINE']['pnl'],4)
        self.assertEqual(result['statsTypePari']['COMBINE_CASH']['count'],2)
        self.assertEqual(result['statsTypePari']['COMBINE_CASH']['pnl'],3)
        self.assertEqual(result['statsTailleCombine']['2']['pnl'],4)
        self.assertEqual(result['statsTailleCombineCash']['3']['pnl'],-1)
        fb=next(p for p in result['historique'] if p['id']=='F')
        self.assertEqual((fb['type_ticket'],fb['type_fond'],fb['retour']),('FREEBET','FREEBET',4))

    def test_one_portfolio_engine_for_cash_and_freebet_even_without_freebet_balance(self):
        ns=dict(math=math,itertools=itertools,datetime=datetime,HTTPException=HTTPError)
        for n in ast.parse((ROOT/'backend/config.py').read_text(encoding='utf-8')).body:
            if isinstance(n,ast.Assign):
                try:
                    value=ast.literal_eval(n.value)
                    for t in n.targets:
                        if isinstance(t,ast.Name): ns[t.id]=value
                except (ValueError,TypeError): pass
        ns=functions('backend/hydre_engine.py',{'normaliser'},ns)
        ns=functions('backend/freebet_optimizer.py',namespace=ns)
        params=MagicMock(); params.find_one.return_value={'profil':'EQUILIBRE'}
        legs=[dict(id=str(i),home_team=str(i),away_team='Z',cote=2,proba=65,score=65,issue='H',issue_label='Domicile',div='F1') for i in range(3)]
        ns.update(col_parametres=params,FREEBET_DEBUG_PORTEFEUILLE_LOGS=False,
                  _freebet_candidats_liste=lambda:(legs,'2026-10-02'),
                  _calculer_finances_dict=lambda:dict(total=100,disponible=100,freebets={'disponible':0}),
                  _exposition_cash_deja_engagee_par_date=lambda _:{},
                  _freebet_progression_demarrer=lambda *args:None,_freebet_progression_maj=lambda **kwargs:None,
                  _freebet_progression_terminer=lambda *args:None)
        freebet=ns['freebet_portefeuille'](SimpleNamespace(tailles=[2,3],type_ticket='FREEBET'))
        cash=ns['freebet_portefeuille'](SimpleNamespace(tailles=[2,3],type_ticket='CASH'))
        self.assertEqual(freebet,cash)
        self.assertEqual(cash['budget_freebet_disponible'],0)
        self.assertEqual(cash['budget_cash_disponible'],20)
        self.assertTrue(cash['portefeuille_recommande'])


if __name__ == '__main__': unittest.main()
