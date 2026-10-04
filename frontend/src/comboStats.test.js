import React from 'react';
import { createRoot } from 'react-dom/client';
import { act as domAct } from 'react-dom/test-utils';
import { comboType, summarizeCombos } from './comboStats';
import ComboDashboard from './ComboDashboard';
const act = React.act || domAct;

const history = [
  { id: 'F', est_combine: true, type_ticket: 'FREEBET', resultat: 'GAGNE', mise: 1, retour: 4, pnl: 4, cote: 5, taille_combine: 2, date_reglement: '2026-10-01 20:00' },
  { id: 'C', est_combine: true, type_ticket: 'CASH', resultat: 'GAGNE', mise: 1, retour: 5, pnl: 4, cote: 5, taille_combine: 2, date_reglement: '2026-10-01 20:01' },
  { id: 'L', est_combine: true, type_ticket: 'CASH', resultat: 'PERDU', mise: 1, retour: 0, pnl: -1, cote: 3, taille_combine: 3, date_reglement: '2026-10-02 20:00' },
  { id: 'X', est_combine: true, type_ticket: 'CASH', resultat: 'ANNULE', mise: 99, pnl: 0 },
  { id: 'S', est_combine: false, type_fond: 'CASH', resultat: 'GAGNE', mise: 10, pnl: 10 },
];

test('les statistiques CASH/FREEBET restent entièrement séparées', () => {
  const cash = summarizeCombos(history, 'CASH');
  const freebet = summarizeCombos(history, 'FREEBET');
  expect(cash).toMatchObject({ count: 2, mise: 2, profit: 3, roi: 150, winrate: 50, coteMoyenne: 4, drawdown: 1, maxDrawdown: 1 });
  expect(freebet).toMatchObject({ count: 1, mise: 1, profit: 4, valeurParEuro: 4 });
  expect(cash.sizes[2].profit).toBe(4);
  expect(cash.sizes[3].profit).toBe(-1);
  expect(freebet.sizes[3]).toBeUndefined();
});

test('anciens combinés FREEBET et aucun ticket ouvert dans les KPI de résultats', () => {
  expect(comboType({ est_combine: true })).toBe('FREEBET');
  expect(summarizeCombos([{ est_combine: true, resultat: 'GAGNE', mise: 1, pnl: 4, cote: 5 }], 'FREEBET').profit).toBe(4);
  expect(summarizeCombos([{ est_combine: true, type_ticket: 'CASH', mise: 1 }], 'CASH').count).toBe(0);
});

test('drawdown CASH chronologique indépendant des Freebets et de l’ordre reçu', () => {
  expect(summarizeCombos([...history].reverse(), 'CASH').maxDrawdown).toBe(1);
  expect(summarizeCombos(history.filter(p => p.type_ticket !== 'FREEBET'), 'CASH')).toEqual(summarizeCombos(history, 'CASH'));
});

test('encadrés distincts et Freebet sans gains/profit dupliqués', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<><ComboDashboard type="CASH" stats={summarizeCombos(history, 'CASH')} /><ComboDashboard type="FREEBET" stats={summarizeCombos(history, 'FREEBET')} /></>));
  expect(container.querySelectorAll('section').length).toBe(2);
  const fb = container.querySelector('[aria-label="Combinés FREEBET"]');
  expect(fb.textContent).toContain('PROFIT NET');
  expect(fb.textContent).not.toContain('GAINS GÉNÉRÉS');
  expect(fb.textContent).not.toContain('ROI');
  expect(container.querySelector('[aria-label="Combinés CASH"]').textContent).toContain('DRAWDOWN MAXIMAL');
  await act(async () => root.unmount());
});
