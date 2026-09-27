import { createHash } from 'node:crypto';
import { originArchiveDigest } from './validation.js';
import type { OriginDigest } from './types.js';

export type OriginArchiveConfig = {
  sourceBaseUrl: string;
  snapshotDigests: OriginDigest[];
  pollMs: number;
};

function exactRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid origin archive config');
  const row = input as Record<string, unknown>;
  const fields = ['sourceBaseUrl', 'snapshotDigests', 'pollMs'];
  if (Object.keys(row).length !== fields.length || fields.some((field) => !Object.hasOwn(row, field)) ||
    Object.keys(row).some((field) => !fields.includes(field))) throw new Error('invalid origin archive config');
  return row;
}

export function originArchiveSourceBaseUrl(input: unknown): string {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 2048 ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\//.test(input) ||
    /[\s\u0000-\u001f\u007f\\?#]/.test(input) || !input.endsWith('/')) {
    throw new Error('invalid origin archive sourceBaseUrl');
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('invalid origin archive sourceBaseUrl'); }
  const port = Number(url.port);
  if (url.href !== input || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) || port < 1 || port > 65535 || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid origin archive sourceBaseUrl');
  }
  try {
    if (/[\s\u0000-\u001f\u007f\\]/.test(decodeURIComponent(url.pathname))) {
      throw new Error('invalid origin archive sourceBaseUrl');
    }
  } catch { throw new Error('invalid origin archive sourceBaseUrl'); }
  return input;
}

export function parseOriginArchiveConfig(raw: string | undefined): OriginArchiveConfig | null {
  if (!raw?.trim()) return null;
  try {
    const row = exactRecord(JSON.parse(raw));
    const sourceBaseUrl = originArchiveSourceBaseUrl(row.sourceBaseUrl);
    if (!Array.isArray(row.snapshotDigests) || row.snapshotDigests.length < 1 || row.snapshotDigests.length > 2) {
      throw new Error('invalid origin archive snapshotDigests');
    }
    const snapshotDigests = row.snapshotDigests.map((digest) => originArchiveDigest(digest, 'snapshot digest'));
    if (new Set(snapshotDigests).size !== snapshotDigests.length) throw new Error('invalid origin archive snapshotDigests');
    if (typeof row.pollMs !== 'number' || !Number.isInteger(row.pollMs) || row.pollMs < 100 || row.pollMs > 60000) {
      throw new Error('invalid origin archive pollMs');
    }
    return { sourceBaseUrl, snapshotDigests, pollMs: row.pollMs };
  } catch (error) {
    if (error instanceof Error && error.message.includes('origin archive')) throw error;
    throw new Error('invalid origin archive config');
  }
}

export function originArchiveConfigFingerprint(config: OriginArchiveConfig): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`;
}

export function originArchiveSourceId(config: OriginArchiveConfig): string {
  return originArchiveConfigFingerprint(config);
}
