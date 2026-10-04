import React from 'react';

const money = value => `${value.toFixed(2)} €`;
const cell = { padding: 10, borderBottom: '1px solid #333' };
const profitColor = n => n < 0 ? '#ff4444' : '#00ffcc';

export default function ComboDashboard({ type, stats }) {
  const cash = type === 'CASH';
  const color = cash ? '#00ffcc' : '#ff8844';
  const kpis = [
    ['COMBINÉS JOUÉS', stats.count],
    [cash ? 'MONTANT MISÉ' : 'FREEBETS UTILISÉES', money(stats.mise)],
    ['PROFIT NET', money(stats.profit)],
    ...(cash ? [
      ['ROI', `${stats.roi.toFixed(2)} %`], ['WINRATE', `${stats.winrate.toFixed(1)} %`],
      ['COTE MOYENNE', stats.coteMoyenne.toFixed(2)],
      ['DRAWDOWN MAXIMAL', money(stats.maxDrawdown)], ['DRAWDOWN ACTUEL', money(stats.drawdown)],
    ] : [['VALEUR / € DE FREEBET', money(stats.valeurParEuro)]]),
  ];
  return <section aria-label={`Combinés ${type}`} style={{ marginBottom: 30, padding: 20, borderRadius: 10, border: `1px solid ${color}`, backgroundColor: '#171717' }}>
    <h3 style={{ color, marginTop: 0 }}>{cash ? '💶' : '🎁'} COMBINÉS {type}</h3>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      {kpis.map(([label, value]) => <div key={label} style={{ flex: '1 1 140px', padding: 16, backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 8, textAlign: 'center' }}>
        <div style={{ color: '#888', fontSize: '0.8rem', marginBottom: 8 }}>{label}</div>
        <div style={{ fontWeight: 'bold', fontSize: '1.5rem', color: label === 'PROFIT NET' ? profitColor(stats.profit) : '#fff' }}>{value}</div>
      </div>)}
    </div>
    <h4 style={{ color: '#aaa' }}>PERFORMANCE PAR TAILLE</h4>
    <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', color: '#ccc' }}>
      <thead><tr>{['Taille', 'Combinés', cash ? 'Montant misé' : 'Freebets utilisées', 'Profit net', cash ? 'ROI' : 'Valeur / €', ...(cash ? ['Winrate'] : [])].map(label => <th key={label} style={cell}>{label}</th>)}</tr></thead>
      <tbody>{Object.keys(stats.sizes).sort((a, b) => Number(a) - Number(b)).map(size => {
        const s = stats.sizes[size];
        const ratio = s.mise ? s.profit / s.mise : 0;
        return <tr key={size}><td style={cell}>{size === 'Inconnue' ? size : `x${size}`}</td><td style={cell}>{s.count}</td><td style={cell}>{money(s.mise)}</td><td style={{ ...cell, color: profitColor(s.profit) }}>{money(s.profit)}</td><td style={cell}>{cash ? `${(ratio * 100).toFixed(2)} %` : money(ratio)}</td>{cash && <td style={cell}>{(s.wins / s.count * 100).toFixed(1)} %</td>}</tr>;
      })}
      {!stats.count && <tr><td colSpan={cash ? 6 : 5} style={{ ...cell, color: '#777' }}>Aucun combiné réglé sur cette période.</td></tr>}</tbody>
    </table></div>
  </section>;
}
