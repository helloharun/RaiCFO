import { useRef, useState } from 'react';
import { Camera, FileText, Loader2, Paperclip, Trash2, X } from 'lucide-react';
import { api, type Attachment, uploadAttachment } from '../api';
import { ErrorBox, useApi } from './ui';

const ACCEPT = 'image/*,application/pdf,.heic,.heif';
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isImg = (mime: string) => mime.startsWith('image/');

/** Uploads files one by one; returns error messages for the ones that failed. */
export async function uploadAll(entryId: number, files: File[]): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) {
    try {
      await uploadAttachment(entryId, f);
    } catch (e) {
      failed.push((e as Error).message);
    }
  }
  return failed;
}

function PickButton({ onPick, label = 'Attach receipt / proof', busy = false }: { onPick: (files: File[]) => void; label?: string; busy?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (list.length) onPick(list);
        }}
      />
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />} {label}
      </button>
    </>
  );
}

/** Files chosen before the entry exists; uploaded right after it is posted. */
export function PendingFiles({ files, onChange, note }: { files: File[]; onChange: (f: File[]) => void; note?: string }) {
  return (
    <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <PickButton onPick={(f) => onChange([...files, ...f].slice(0, 20))} />
        <span className="text-xs text-slate-500">Photo, screenshot or PDF — optional.{note ? ` ${note}` : ''}</span>
      </div>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded bg-slate-50 px-2 py-1">
              <span className="truncate"><Paperclip size={13} className="mr-1 inline text-slate-400" />{f.name} <span className="text-xs text-slate-400">{fmtSize(f.size)}</span></span>
              <button type="button" className="btn-ghost p-1" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}><X size={15} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Attachments of a posted entry: view, add, remove. */
export function AttachmentPanel({ entryId, onChange }: { entryId: number; onChange?: () => void }) {
  const { data, reload } = useApi<Attachment[]>(`/journal/${entryId}/attachments`, [entryId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async (files: File[]) => {
    setBusy(true);
    setError(null);
    const failed = await uploadAll(entryId, files);
    if (failed.length) setError(failed.join('\n'));
    setBusy(false);
    reload();
    onChange?.();
  };
  const remove = async (a: Attachment) => {
    if (!confirm(`Remove attachment "${a.filename}"? This is recorded in the audit trail.`)) return;
    try {
      await api(`/attachments/${a.id}`, { method: 'DELETE' });
      reload();
      onChange?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="label mb-0">Attachments {data?.length ? `(${data.length})` : ''}</div>
        <PickButton onPick={add} busy={busy} label="Add" />
      </div>
      <ErrorBox error={error} onClose={() => setError(null)} />
      {data && !data.length && <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">No receipts or proof attached yet.</div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {data?.map((a) => (
          <div key={a.id} className="group relative overflow-hidden rounded-lg border border-slate-200 bg-white">
            <a href={`/api/attachments/${a.id}`} target="_blank" rel="noopener" className="block">
              {isImg(a.mime) && a.mime !== 'image/heic' ? (
                <img src={`/api/attachments/${a.id}`} alt={a.filename} loading="lazy" className="h-28 w-full bg-slate-50 object-cover" />
              ) : (
                <div className="flex h-28 items-center justify-center bg-slate-50 text-slate-400">
                  <FileText size={34} />
                </div>
              )}
              <div className="truncate px-2 py-1 text-xs" title={a.filename}>{a.filename}</div>
              <div className="px-2 pb-1 text-[11px] text-slate-400">{fmtSize(a.size)} · {a.created_at.slice(0, 10)}</div>
            </a>
            <button type="button" className="absolute right-1 top-1 rounded-full bg-white/90 p-1.5 text-rose-600 shadow" aria-label={`Remove ${a.filename}`} onClick={() => remove(a)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
