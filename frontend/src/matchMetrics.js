export const selectionFunnel = (analyses, selectionnes, { debut = '', fin = '', ligue = '' } = {}) => {
  const matchesFilter = m => (!debut || m.date >= debut) && (!fin || m.date <= fin) && (!ligue || m.div === ligue);
  const unique = rows => [...new Map(rows.map(m => [m.id, m])).values()];
  const selected = unique(selectionnes).filter(matchesFilter);
  const analysed = unique(analyses).filter(matchesFilter);
  return { matchsAnalyses: analysed.length, matchsSelectionnes: selected.length,
    tauxSelection: analysed.length ? selected.length / analysed.length * 100 : 0 };
};

export const comboProgress = selections => ({
  valides: selections.filter(s => s.valide).length,
  total: selections.length,
});
