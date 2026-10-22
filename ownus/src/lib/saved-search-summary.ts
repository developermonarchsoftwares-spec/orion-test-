/**
 * Applies a saved search's filters on top of the page's default filter state. Only keys the page already has are taken, and only when the saved
 * value is the same kind of value (list for list, text for text, number for number, flag for flag), so an old or edited saved search can never
 * put the filter panel into a shape it cannot render.
 */
export function applySavedFilters<T extends Record<string, unknown>>(base: T, saved: unknown): T {
  const next: Record<string, unknown> = { ...base };
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return next as T;
  for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
    if (!(key in base)) continue;
    const current = base[key];
    const sameKind = Array.isArray(current) ? Array.isArray(value) : value !== null && typeof value === typeof current && !Array.isArray(value);
    if (sameKind) next[key] = value;
  }
  return next as T;
}

/** A short, real description of a saved search's filters ("3 filters: city, state, industry"), never a generic placeholder. */
export function describeSavedFilters(filters: unknown): string {
  if (!filters || typeof filters !== 'object') return 'No filters saved';
  const used = Object.entries(filters as Record<string, unknown>).filter(([, v]) => {
    if (v === null || v === undefined || v === '' || v === false) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v as object).length > 0;
    return true;
  });
  if (used.length === 0) return 'All businesses (no filters)';
  const names = used.slice(0, 4).map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase());
  return `${used.length} filter${used.length === 1 ? '' : 's'}: ${names.join(', ')}${used.length > 4 ? ', ...' : ''}`;
}
