import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { USER_ID, audit } from '../engine/ledger.js';
import { ValidationError } from '../types.js';

export const MAX_ATTACHMENTS_PER_ENTRY = 20;
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

export interface AttachmentMeta {
  id: number;
  entry_id: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: string;
}

/** Detects the real file type from its bytes; the browser-supplied type and filename are never trusted. */
export function sniffType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head = buf.toString('latin1', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.slice(4, 8) === 'ftyp' && HEIF_BRANDS.has(head.slice(8, 12))) return 'image/heic';
  if (buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

export function safeFilename(raw: unknown): string {
  let s = typeof raw === 'string' ? raw : '';
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  s = s.split(/[\\/]/).pop() ?? '';
  s = s.replace(/[\u0000-\u001f\u007f"<>|*?:]+/g, '').replace(/\s+/g, ' ').trim();
  return (s || 'attachment').slice(0, 120);
}

export async function listAttachments(db: DB, entryId: number): Promise<AttachmentMeta[]> {
  return (await db
    .prepare('SELECT id, entry_id, filename, mime, size, sha256, created_at FROM entry_attachments WHERE entry_id = ? AND user_id = ? ORDER BY id')
    .all(entryId, USER_ID)) as AttachmentMeta[];
}

export async function addAttachment(db: DB, entryId: number, filename: string, data: Buffer, maxBytes: number): Promise<AttachmentMeta> {
  const entry = await db.prepare('SELECT id FROM journal_entries WHERE id = ? AND user_id = ?').get(entryId, USER_ID);
  if (!entry) throw new ValidationError('Entry not found.');
  if (!data.length) throw new ValidationError('The file is empty.');
  if (data.length > maxBytes) throw new ValidationError(`File is too large (max ${Math.round(maxBytes / 1048576)} MB).`);
  const mime = sniffType(data);
  if (!mime) throw new ValidationError('Only images (JPEG, PNG, HEIC, WebP, GIF) and PDF files can be attached.');
  return db.transaction(async () => {
    const { n } = (await db.prepare('SELECT COUNT(*) AS n FROM entry_attachments WHERE entry_id = ?').get(entryId)) as { n: number };
    if (n >= MAX_ATTACHMENTS_PER_ENTRY) throw new ValidationError(`An entry can have at most ${MAX_ATTACHMENTS_PER_ENTRY} attachments.`);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const row = (await db
      .prepare('INSERT INTO entry_attachments (user_id, entry_id, filename, mime, size, sha256, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, entry_id, filename, mime, size, sha256, created_at')
      .get(USER_ID, entryId, filename, mime, data.length, sha256, data)) as AttachmentMeta;
    await audit(db, 'attach', 'journal_entry', entryId, { attachmentId: row.id, filename, mime, size: data.length, sha256 });
    return row;
  })();
}

export async function getAttachment(db: DB, id: number): Promise<(AttachmentMeta & { data: Buffer }) | undefined> {
  return (await db.prepare('SELECT * FROM entry_attachments WHERE id = ? AND user_id = ?').get(id, USER_ID)) as (AttachmentMeta & { data: Buffer }) | undefined;
}

export async function deleteAttachment(db: DB, id: number): Promise<void> {
  const a = (await db.prepare('SELECT id, entry_id, filename, sha256 FROM entry_attachments WHERE id = ? AND user_id = ?').get(id, USER_ID)) as AttachmentMeta | undefined;
  if (!a) throw new ValidationError('Attachment not found.');
  await db.transaction(async () => {
    await db.prepare('DELETE FROM entry_attachments WHERE id = ?').run(id);
    await audit(db, 'detach', 'journal_entry', a.entry_id, { attachmentId: id, filename: a.filename, sha256: a.sha256 });
  })();
}

/** Keeps receipts with the corrected entry when an entry is edited (reversed and reposted). */
export async function copyAttachments(db: DB, fromEntryId: number, toEntryId: number): Promise<void> {
  await db
    .prepare('INSERT INTO entry_attachments (user_id, entry_id, filename, mime, size, sha256, data) SELECT user_id, ?, filename, mime, size, sha256, data FROM entry_attachments WHERE entry_id = ? AND user_id = ? ORDER BY id')
    .run(toEntryId, fromEntryId, USER_ID);
}
