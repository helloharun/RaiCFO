import type { DB } from '../db.js';
import { todayISO } from '../money.js';
import { USER_ID, fxRate } from './ledger.js';

export interface Holding {
  accountId: number;
  accountName: string;
  securityId: number;
  symbol: string;
  name: string | null;
  currency: string;
  quantity: number;
  /** Book cost in CAD cents. */
  cost: number;
  avgCost: number;
  lastPrice: number | null;
  priceDate: string | null;
  /** Market value in CAD cents (null if no price). */
  marketValue: number | null;
  unrealizedGain: number | null;
}

export async function holdings(db: DB, opts: { accountId?: number; asOf?: string } = {}): Promise<Holding[]> {
  const asOf = opts.asOf ?? todayISO();
  const rows = (await db
    .prepare(
      `SELECT l.account_id, a.name AS account_name, s.id AS security_id, s.symbol, s.name, s.currency, s.last_price, s.price_date,
         SUM(COALESCE(l.quantity,0)) AS qty, SUM(l.debit - l.credit) AS cost
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       JOIN securities s ON s.id = l.security_id
       WHERE e.user_id = ? AND e.date <= ? ${opts.accountId ? 'AND l.account_id = ?' : ''}
       GROUP BY l.account_id, a.id, s.id ORDER BY a.code, s.symbol`,
    )
    .all(USER_ID, asOf, ...(opts.accountId ? [opts.accountId] : []))) as Array<{
    account_id: number;
    account_name: string;
    security_id: number;
    symbol: string;
    name: string | null;
    currency: string;
    last_price: number | null;
    price_date: string | null;
    qty: number;
    cost: number;
  }>;
  const rates = new Map<string, number>();
  for (const c of new Set(rows.map((r) => r.currency))) rates.set(c, await safeRate(db, c, asOf));
  return rows
    .filter((r) => Math.abs(r.qty) > 1e-9 || r.cost !== 0)
    .map((r) => {
      const qty = Math.round(r.qty * 1e8) / 1e8;
      const rate = rates.get(r.currency) ?? 1;
      const mv = r.last_price === null ? null : Math.round(qty * r.last_price * rate);
      return {
        accountId: r.account_id,
        accountName: r.account_name,
        securityId: r.security_id,
        symbol: r.symbol,
        name: r.name,
        currency: r.currency,
        quantity: qty,
        cost: r.cost,
        avgCost: qty ? Math.round(r.cost / qty) : 0,
        lastPrice: r.last_price,
        priceDate: r.price_date,
        marketValue: mv,
        unrealizedGain: mv === null ? null : mv - r.cost,
      };
    });
}

async function safeRate(db: DB, currency: string, date: string): Promise<number> {
  try {
    return await fxRate(db, currency, date);
  } catch {
    return 1;
  }
}

/** Average-cost basis (CAD cents) for selling `quantity` units of `symbol` from an account. */
export async function costBasisForSale(db: DB, accountId: number, symbol: string, quantity: number, asOf?: string): Promise<{ cost: number; held: number } | null> {
  const h = (await holdings(db, { accountId, asOf })).find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!h || h.quantity <= 0) return null;
  return { cost: Math.round((h.cost / h.quantity) * Math.min(quantity, h.quantity)), held: h.quantity };
}

/** Market-value adjustment per account: market value of priced securities minus their book cost. */
export async function marketAdjustments(db: DB, asOf?: string): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const h of (await holdings(db, { asOf }))) {
    if (h.marketValue === null) continue;
    map.set(h.accountId, (map.get(h.accountId) ?? 0) + h.marketValue - h.cost);
  }
  return map;
}
