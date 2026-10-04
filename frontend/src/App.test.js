import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import App from './App';
import { selectionFunnel, comboProgress } from './matchMetrics';

test('compteur et taux filtrent et dédupliquent les matchs', () => {
  const rows = [
    { id: 'A', date: '2026-10-01', div: 'F1' },
    { id: 'B', date: '2026-10-02', div: 'F1' },
    { id: 'C', date: '2026-10-02', div: 'F2' },
  ];
  expect(selectionFunnel(rows, [rows[0], rows[0]])).toMatchObject({ matchsAnalyses: 3, matchsSelectionnes: 1 });
  expect(selectionFunnel(rows, [rows[0], rows[0]]).tauxSelection).toBeCloseTo(100 / 3);
  expect(selectionFunnel(rows, [rows[0], rows[1]]).matchsSelectionnes).toBe(2);
  expect(selectionFunnel(rows, [rows[0]], { ligue: 'F1' }).tauxSelection).toBe(50);
  expect(selectionFunnel(rows, [rows[0]], { debut: '2026-10-02', fin: '2026-10-02' }).matchsSelectionnes).toBe(0);
  expect(selectionFunnel([], []).tauxSelection).toBe(0);
});

test('progression 0/5 à 5/5', () => {
  for (let n = 0; n <= 5; n++) {
    expect(comboProgress(Array.from({ length: 5 }, (_, i) => ({ valide: i < n })))).toEqual({ valides: n, total: 5 });
  }
});

test('un loader partagé reste présent jusqu’à la dernière réponse ou erreur', async () => {
  localStorage.setItem('hydre_session', JSON.stringify({ role: 'MASTER', token: 'test' }));
  const pending = [];
  global.fetch = jest.fn(url => new Promise((resolve, reject) => pending.push({ url, resolve, reject })));
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<App />));
  expect(container.querySelectorAll('[role="status"]').length).toBe(1);
  const response = data => ({ ok: true, clone: () => ({ arrayBuffer: () => Promise.resolve() }), json: () => Promise.resolve(data) });
  await act(async () => {
    pending.slice(0, -1).forEach(p => p.resolve(response(p.url.endsWith('/finances')
      ? { total: 100, engage: 0, disponible: 100, freebets: { total_acquis: 0, engage: 0, disponible: 0 } }
      : {})));
  });
  expect(container.querySelectorAll('[role="status"]').length).toBe(1);
  await act(async () => pending[pending.length - 1].reject(new Error('API unavailable')));
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => root.unmount());
  localStorage.clear();
  errorSpy.mockRestore();
});
