export const comboType = ticket => ticket.type_ticket || 'FREEBET';

export const summarizeCombos = (history, type) => {
  const rows = history.filter(p => p.est_combine && comboType(p) === type && ['GAGNE', 'PERDU', 'CASHOUT'].includes(p.resultat));
  const sizes = {};
  let mise = 0, profit = 0, wins = 0, odds = 0;
  rows.forEach(p => {
    const stake = Number(p.mise) || 0;
    const pnl = Number(p.pnl) || 0;
    mise += stake; profit += pnl; odds += Number(p.cote) || 0;
    if (p.resultat === 'GAGNE') wins++;
    const size = p.taille_combine || 'Inconnue';
    if (!sizes[size]) sizes[size] = { count: 0, mise: 0, profit: 0, wins: 0 };
    sizes[size].count++; sizes[size].mise += stake; sizes[size].profit += pnl;
    if (p.resultat === 'GAGNE') sizes[size].wins++;
  });
  let cumulative = 0, peak = 0, drawdown = 0, maxDrawdown = 0;
  [...rows].sort((a, b) => (a.date_reglement || a.date || '').localeCompare(b.date_reglement || b.date || '') || String(a.id).localeCompare(String(b.id))).forEach(p => {
    cumulative += Number(p.pnl) || 0;
    peak = Math.max(peak, cumulative);
    drawdown = peak - cumulative;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  });
  return { count: rows.length, mise, profit, roi: mise ? profit / mise * 100 : 0,
    winrate: rows.length ? wins / rows.length * 100 : 0, coteMoyenne: rows.length ? odds / rows.length : 0,
    valeurParEuro: mise ? profit / mise : 0, drawdown, maxDrawdown, sizes };
};
