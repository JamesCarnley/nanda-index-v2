import { randomBytes } from 'node:crypto';
import { keccak256 } from 'viem';
import type { OriginArchiveConfig } from '../../src/connectors/originArchive/config.js';
import type { OriginArchiveSnapshotPayload } from '../../src/connectors/originArchive/types.js';
import { getSql } from '../../src/db/client.js';

export const originDigest = (value: number): `0x${string}` =>
  `0x${value.toString(16).padStart(64, '0')}`;
export const originAddress = (value: number): `0x${string}` =>
  `0x${value.toString(16).padStart(40, '0')}`;
const fixturePair = randomBytes(8).toString('hex');
const fixtureReviewer = `0x${randomBytes(20).toString('hex')}` as `0x${string}`;

export function originConfig(overrides: Partial<OriginArchiveConfig> = {}): OriginArchiveConfig {
  const token = randomBytes(4).toString('hex');
  return {
    sourceBaseUrl: `http://127.0.0.1:9400/public-origin/${token}/`,
    snapshotDigests: [originDigest(1)],
    pollMs: 100,
    ...overrides,
  };
}

export function originPayload(overrides: Partial<OriginArchiveSnapshotPayload> = {}): OriginArchiveSnapshotPayload {
  return {
    profile: 'city-origin@0.1',
    kind: 'archive-snapshot',
    service: { method: 'https-origin', identityUrl: `https://origin-${fixturePair}.example/identity.json` },
    reviewer: fixtureReviewer,
    snapshotId: `snapshot-${randomBytes(4).toString('hex')}`,
    createdAt: '2026-09-26T12:34:56Z',
    historyScope: 'reviewer-declared-from-inception',
    entries: [originDigest(11), originDigest(12)],
    ...overrides,
  };
}

export function originSnapshotBytes(options: {
  payload?: unknown;
  envelope?: Record<string, unknown>;
  payloadBytes?: Uint8Array;
} = {}): Buffer {
  const payloadBytes = options.payloadBytes ?? Buffer.from(JSON.stringify(options.payload ?? originPayload()), 'utf8');
  const envelope = {
    profile: 'city-origin@0.1',
    scheme: 'eip712-secp256k1',
    signer: { method: 'secp256k1-key', address: originAddress(8) },
    payloadBase64: Buffer.from(payloadBytes).toString('base64'),
    signature: `0x${'11'.repeat(64)}1b`,
    ...options.envelope,
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export const digestBytes = (bytes: Uint8Array): `0x${string}` => keccak256(bytes);

export async function cleanupOriginArchive(sourceIds: string[]): Promise<void> {
  if (!sourceIds.length) return;
  const sql = getSql();
  await sql.begin(async (tx) => {
    const digests = await tx<{ digest: string }[]>`
      SELECT DISTINCT digest FROM origin_archive_fetch_jobs WHERE source_id IN ${tx(sourceIds)}
    `;
    await tx`DELETE FROM origin_archive_fetch_jobs WHERE source_id IN ${tx(sourceIds)}`;
    await tx`DELETE FROM origin_archive_sources WHERE source_id IN ${tx(sourceIds)}`;
    const values = digests.map(({ digest }) => digest);
    if (!values.length) return;
    await tx`DELETE FROM origin_archive_snapshot_entries WHERE snapshot_digest IN ${tx(values)}`;
    await tx`DELETE FROM origin_archive_snapshots WHERE digest IN ${tx(values)}`;
    await tx`DELETE FROM origin_archive_blobs b WHERE digest IN ${tx(values)}
      AND NOT EXISTS (SELECT 1 FROM origin_archive_fetch_jobs j WHERE j.digest = b.digest)
      AND NOT EXISTS (SELECT 1 FROM origin_archive_snapshot_entries e WHERE e.document_digest = b.digest)`;
  });
}
