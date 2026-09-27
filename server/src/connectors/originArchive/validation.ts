import type { OriginArchiveSnapshotPayload, OriginArchiveSnapshotShape, OriginDigest } from './types.js';

const DIGEST = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const ADDRESS_LABEL = /^0x[0-9a-f]{40}$/;
const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SNAPSHOT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function exactRecord(input: unknown, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid origin archive object');
  const row = input as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(row, field)) ||
    keys.some((field) => !fields.includes(field))) throw new Error('invalid origin archive shape');
  return row;
}

export function originArchiveDigest(input: unknown, field = 'digest'): OriginDigest {
  if (typeof input !== 'string' || !DIGEST.test(input)) throw new Error(`invalid origin archive ${field}`);
  return input as OriginDigest;
}

export function originArchiveAddress(input: unknown, field = 'address'): `0x${string}` {
  if (typeof input !== 'string' || !ADDRESS.test(input)) throw new Error(`invalid origin archive ${field}`);
  return input as `0x${string}`;
}

/** Claimed reviewer grouping is syntax only. Zero remains an unauthenticated label. */
function originArchiveReviewerLabel(input: unknown): `0x${string}` {
  if (typeof input !== 'string' || !ADDRESS_LABEL.test(input)) throw new Error('invalid origin archive reviewer');
  return input as `0x${string}`;
}

export function originArchiveIdentityUrl(input: unknown): string {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 2048 ||
    /[\s\u0000-\u001f\u007f\\?#]/.test(input)) throw new Error('invalid origin archive identityUrl');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('invalid origin archive identityUrl'); }
  if (url.href !== input || url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
    url.search || url.hash) throw new Error('invalid origin archive identityUrl');
  return input;
}

function utcSecond(input: unknown): string {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') !== 20 || !UTC_SECOND.test(input)) {
    throw new Error('invalid origin archive createdAt');
  }
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== `${input.slice(0, 19)}.000Z`) {
    throw new Error('invalid origin archive createdAt');
  }
  return input;
}

function payload(input: unknown): OriginArchiveSnapshotPayload {
  const row = exactRecord(input, ['profile', 'kind', 'service', 'reviewer', 'snapshotId', 'createdAt', 'historyScope', 'entries']);
  if (row.profile !== 'city-origin@0.1' || row.kind !== 'archive-snapshot' ||
    row.historyScope !== 'reviewer-declared-from-inception') throw new Error('invalid origin archive payload discriminator');
  const service = exactRecord(row.service, ['method', 'identityUrl']);
  if (service.method !== 'https-origin') throw new Error('invalid origin archive service method');
  const identityUrl = originArchiveIdentityUrl(service.identityUrl);
  const reviewer = originArchiveReviewerLabel(row.reviewer);
  if (typeof row.snapshotId !== 'string' || !SNAPSHOT_ID.test(row.snapshotId)) throw new Error('invalid origin archive snapshotId');
  const createdAt = utcSecond(row.createdAt);
  if (!Array.isArray(row.entries) || row.entries.length > 256) throw new Error('invalid origin archive entries');
  const entries = row.entries.map((entry) => originArchiveDigest(entry, 'entry'));
  if (new Set(entries).size !== entries.length) throw new Error('invalid origin archive duplicate entry');
  return {
    profile: 'city-origin@0.1', kind: 'archive-snapshot',
    service: { method: 'https-origin', identityUrl }, reviewer,
    snapshotId: row.snapshotId, createdAt,
    historyScope: 'reviewer-declared-from-inception', entries,
  };
}

export function inspectOriginArchiveSnapshot(input: Uint8Array): OriginArchiveSnapshotShape {
  try {
    if (!(input instanceof Uint8Array) || input.byteLength > 32768) throw new Error('snapshot-too-large');
    if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) throw new Error('invalid-utf8-json');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    const outer = exactRecord(JSON.parse(text), ['profile', 'scheme', 'signer', 'payloadBase64', 'signature']);
    if (outer.profile !== 'city-origin@0.1' || outer.scheme !== 'eip712-secp256k1') {
      throw new Error('invalid-envelope-discriminator');
    }
    const signer = exactRecord(outer.signer, ['method', 'address']);
    if (signer.method !== 'secp256k1-key') throw new Error('invalid-signer-method');
    originArchiveAddress(signer.address, 'signer');
    if (typeof outer.signature !== 'string' || !SIGNATURE.test(outer.signature)) throw new Error('invalid-signature-shape');
    if (typeof outer.payloadBase64 !== 'string' || outer.payloadBase64.length === 0 ||
      outer.payloadBase64.length % 4 !== 0 || !BASE64.test(outer.payloadBase64)) throw new Error('invalid-payload-base64');
    const payloadBytes = Buffer.from(outer.payloadBase64, 'base64');
    if (payloadBytes.toString('base64') !== outer.payloadBase64) throw new Error('noncanonical-payload-base64');
    if (payloadBytes[0] === 0xef && payloadBytes[1] === 0xbb && payloadBytes[2] === 0xbf) throw new Error('invalid-utf8-json');
    const payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    return { status: 'valid', claimed: payload(JSON.parse(payloadText)) };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error && /^[a-z0-9-]+$/.test(error.message)
      ? error.message : 'invalid-shape' };
  }
}
