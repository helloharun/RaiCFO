import type { Account } from './api';

export interface TreeRow {
  account: Account;
  depth: number;
  /** Own balance plus every descendant's balance (CAD cents). */
  total: number;
  hasChildren: boolean;
}

/** Orders accounts parent-first (siblings by sort order) and rolls sub-account balances up into their parents. */
export function accountTree(list: Account[]): TreeRow[] {
  const sorted = [...list].sort((x, y) => x.sort_order - y.sort_order || x.code.localeCompare(y.code));
  const ids = new Set(sorted.map((a) => a.id));
  const kids = new Map<number | null, Account[]>();
  for (const a of sorted) {
    const p = a.parent_id !== null && ids.has(a.parent_id) ? a.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), a]);
  }
  const out: TreeRow[] = [];
  const seen = new Set<number>();
  const walk = (a: Account, depth: number): number => {
    seen.add(a.id);
    const row: TreeRow = { account: a, depth, total: a.balance, hasChildren: false };
    out.push(row);
    for (const c of kids.get(a.id) ?? []) {
      if (seen.has(c.id)) continue;
      row.hasChildren = true;
      row.total += walk(c, depth + 1);
    }
    return row.total;
  };
  for (const a of kids.get(null) ?? []) walk(a, 0);
  for (const a of sorted) if (!seen.has(a.id)) walk(a, 0);
  return out;
}

/** Hides rows below any collapsed parent. */
export function visibleRows(rows: TreeRow[], collapsed: Set<number>): TreeRow[] {
  let hideBelow = Infinity;
  return rows.filter((r) => {
    if (r.depth > hideBelow) return false;
    hideBelow = r.hasChildren && collapsed.has(r.account.id) ? r.depth : Infinity;
    return true;
  });
}
