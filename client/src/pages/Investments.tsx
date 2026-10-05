import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, cad, today } from '../api';
import { Empty, ErrorBox, Money, PageHeader, Stat, useApi } from '../components/ui';

interface Holding { accountId: number; accountName: string; securityId: number; symbol: string; name: string | null; currency: string; quantity: number; cost: number; avgCost: number; lastPrice: number | null; priceDate: string | null; marketValue: number | null; unrealizedGain: number | null }

export default function Investments() {
  const { data, reload } = useApi<{ holdings: Holding[]; totalCost: number; totalMarket: number; unrealizedGain: number; realizedGainYtd: number; investmentIncomeYtd: number }>('/investments');
  const [error, setError] = useState<string | null>(null);
  const setPrice = async (h: Holding, price: string) => {
    try {
      await api(`/securities/${h.securityId}`, { method: 'PUT', body: { price: price === '' ? null : Number(price), priceDate: today() } });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div>
      <PageHeader title="Investments" subtitle={<>Holdings are derived from investment purchase/sale journal lines (average-cost basis). Record trades on the <Link to="/record" className="text-indigo-600 underline">Record</Link> page, e.g. “Bought 10 shares of VFV at $120 in my TFSA”.</>} />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {data && (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Market value" value={cad(data.totalMarket)} sub={`Book cost ${cad(data.totalCost)}`} />
            <Stat label="Unrealized gain" value={cad(data.unrealizedGain)} tone={data.unrealizedGain >= 0 ? 'good' : 'bad'} sub={data.totalCost ? `${((data.unrealizedGain / data.totalCost) * 100).toFixed(2)}%` : undefined} />
            <Stat label="Realized gains (YTD)" value={cad(data.realizedGainYtd)} />
            <Stat label="Dividends & interest (YTD)" value={cad(data.investmentIncomeYtd)} />
          </div>
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Symbol</th>
                  <th className="num">Quantity</th>
                  <th className="num">Avg cost</th>
                  <th className="num">Book cost</th>
                  <th className="num">Price</th>
                  <th className="num">Market value</th>
                  <th className="num">Gain / loss</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.map((h) => (
                  <tr key={`${h.accountId}-${h.securityId}`}>
                    <td>{h.accountName}</td>
                    <td>
                      <div className="font-medium">{h.symbol}</div>
                      <div className="text-xs text-slate-500">{h.name}</div>
                    </td>
                    <td className="num">{h.quantity}</td>
                    <td className="num">{cad(h.avgCost)}</td>
                    <td className="num">{cad(h.cost)}</td>
                    <td className="num">
                      <input className="input w-24 text-right" type="number" step="0.01" defaultValue={h.lastPrice !== null ? h.lastPrice / 100 : ''} key={`${h.securityId}-${h.lastPrice}`} placeholder="set" onBlur={(e) => e.target.value !== (h.lastPrice !== null ? String(h.lastPrice / 100) : '') && setPrice(h, e.target.value)} />
                      {h.priceDate && <div className="text-[10px] text-slate-400">{h.currency} · {h.priceDate}</div>}
                    </td>
                    <td className="num">{cad(h.marketValue)}</td>
                    <td className="num"><Money cents={h.unrealizedGain} colored /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.holdings.length && <Empty>No holdings yet.</Empty>}
          </div>
        </>
      )}
    </div>
  );
}
