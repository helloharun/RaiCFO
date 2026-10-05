import { PageHeader, useApi } from '../components/ui';

export default function Audit() {
  const { data } = useApi<Array<{ id: number; ts: string; action: string; entity: string; entity_id: number | null; details: string | null }>>('/audit?limit=500');
  return (
    <div>
      <PageHeader title="Audit trail" subtitle="Every change to the books and configuration, in order. Append-only." />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Time (UTC)</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((a) => (
              <tr key={a.id}>
                <td className="text-slate-400">{a.id}</td>
                <td className="whitespace-nowrap">{a.ts}</td>
                <td><span className="badge bg-slate-100 text-slate-700">{a.action}</span></td>
                <td className="whitespace-nowrap">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ''}</td>
                <td className="max-w-xl truncate font-mono text-xs text-slate-500" title={a.details ?? ''}>{a.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
