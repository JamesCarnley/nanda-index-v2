import type postgres from 'postgres';
import { keccak256 } from 'viem';
import { getSql } from '../client.js';
import { originArchiveConfigFingerprint, originArchiveSourceId, type OriginArchiveConfig } from '../../connectors/originArchive/config.js';
import { inspectOriginArchiveSnapshot, originArchiveDigest } from '../../connectors/originArchive/validation.js';
import type { OriginArchiveJob, OriginArchiveJobKind, OriginArchiveJobOutcome,
  OriginArchiveRelationship, OriginArchiveSnapshotPayload, OriginArchiveSnapshotShape, OriginDigest } from '../../connectors/originArchive/types.js';

type Tx = postgres.TransactionSql;
type SourceRow = { sourceId: string; configFingerprint: string; configJson: string;
  availability: 'pending' | 'available' | 'unavailable'; lastAttemptAt: Date | null; lastResult: string | null };
type JobRow = { sourceId: string; kind: OriginArchiveJobKind; digest: OriginDigest; jobVersion: string;
  attempts: string; nextAttemptAt: Date; lastAttemptAt: Date | null; leaseUntil: Date | null;
  state: OriginArchiveJob['state']; reason: string | null; actualHash: OriginDigest | null; actualSize: string | null };
type BlobRow = { digest: OriginDigest; bytes: Buffer; byteLength: number; retainedAt: Date };
type SnapshotRow = { digest: OriginDigest; shapeStatus: 'valid' | 'invalid'; shapeReason: string | null; claimedJson: string | null };

export type OriginArchiveSourceView = {
  sourceId: string;
  availability: SourceRow['availability'];
  lastAttemptAt: string | null;
  lastResult: string | null;
};

export type OriginArchiveSnapshotStatus = {
  digest: OriginDigest;
  acquisition: {
    state: 'pending' | 'retained';
    sources: Array<OriginArchiveSourceView & { job: OriginArchiveJob }>;
  };
  shape: OriginArchiveSnapshotShape | { status: 'unavailable' };
  entries: Array<{ ordinal: number; digest: OriginDigest; availability: 'retained' | 'pending' }>;
  retainedVariants: Array<{ digest: OriginDigest; claimed: OriginArchiveSnapshotPayload;
    entries: OriginDigest[]; authenticity: 'not-evaluated' }>;
  variantsTruncated: boolean;
  relationships: Array<{ leftDigest: OriginDigest; rightDigest: OriginDigest;
    relationship: OriginArchiveRelationship; prefixDigest?: OriginDigest; extensionDigest?: OriginDigest }>;
};

const SOURCE_ID = /^sha256:[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const REASON = /^[a-z0-9][a-z0-9-]{0,63}$/;

function sourceId(input: unknown): string {
  if (typeof input !== 'string' || !SOURCE_ID.test(input)) throw new Error('invalid origin archive sourceId');
  return input;
}
function decimal(input: unknown, field: string): string {
  if (typeof input !== 'string' || !DECIMAL.test(input)) throw new Error(`invalid origin archive ${field}`);
  return input;
}
function integer(input: unknown, field: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
    throw new Error(`invalid origin archive ${field}`);
  }
  return input;
}
function date(input: unknown, field: string): Date {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) {
    throw new Error(`invalid origin archive ${field}`);
  }
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) throw new Error(`invalid origin archive ${field}`);
  return parsed;
}
function kind(input: unknown): OriginArchiveJobKind {
  if (input !== 'snapshot' && input !== 'document') throw new Error('invalid origin archive job kind');
  return input;
}
function jobView(row: JobRow): OriginArchiveJob {
  return { sourceId: row.sourceId, kind: row.kind, digest: row.digest, jobVersion: String(row.jobVersion),
    attempts: String(row.attempts), nextAttemptAt: row.nextAttemptAt.toISOString(),
    leaseExpiresAt: row.leaseUntil?.toISOString() ?? null, lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    state: row.state, reason: row.reason, actualHash: row.actualHash,
    actualSize: row.actualSize === null ? null : String(row.actualSize) };
}
function sourceView(row: SourceRow): OriginArchiveSourceView {
  return { sourceId: row.sourceId, availability: row.availability,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null, lastResult: row.lastResult };
}
function checkedBlob(row: BlobRow): { digest: OriginDigest; bytes: Buffer; byteLength: string; retainedAt: string } {
  if (row.bytes.byteLength > 32768 || row.bytes.byteLength !== row.byteLength || keccak256(row.bytes) !== row.digest) {
    throw new Error('origin archive blob integrity failure');
  }
  return { digest: row.digest, bytes: row.bytes, byteLength: String(row.byteLength), retainedAt: row.retainedAt.toISOString() };
}
function checkedDocumentBlob(row: BlobRow): ReturnType<typeof checkedBlob> | null {
  const checked = checkedBlob(row);
  return Number(checked.byteLength) <= 6144 ? checked : null;
}

export async function seedOriginArchiveSnapshots(config: OriginArchiveConfig): Promise<OriginArchiveSourceView> {
  const id = originArchiveSourceId(config); const fingerprint = originArchiveConfigFingerprint(config);
  const configJson = JSON.stringify(config);
  return getSql().begin(async (tx) => {
    await tx`INSERT INTO origin_archive_sources (source_id, config_fingerprint, config_json)
      VALUES (${id}, ${fingerprint}, ${configJson}) ON CONFLICT DO NOTHING`;
    const [source] = await tx<SourceRow[]>`SELECT * FROM origin_archive_sources WHERE source_id = ${id} FOR UPDATE`;
    if (!source || source.configFingerprint !== fingerprint || source.configJson !== configJson) {
      throw new Error('origin archive source fingerprint mismatch');
    }
    for (const digest of config.snapshotDigests) {
      await tx`INSERT INTO origin_archive_fetch_jobs (source_id, kind, digest)
        VALUES (${id}, 'snapshot', ${digest}) ON CONFLICT DO NOTHING`;
    }
    return sourceView(source);
  });
}

export async function claimOriginArchiveJobs(input: {
  sourceId: string; limit: number; now: string; leaseMs: number;
}): Promise<OriginArchiveJob[]> {
  const id = sourceId(input.sourceId); const limit = integer(input.limit, 'job limit', 1, 4);
  const now = date(input.now, 'now'); const leaseMs = integer(input.leaseMs, 'leaseMs', 1, 30000);
  const lease = new Date(now.getTime() + leaseMs);
  return getSql().begin(async (tx) => {
    const rows = await tx<JobRow[]>`WITH due AS (
        SELECT source_id, kind, digest FROM origin_archive_fetch_jobs
        WHERE source_id = ${id} AND state = 'pending' AND next_attempt_at <= ${now}
          AND (lease_until IS NULL OR lease_until <= ${now})
        ORDER BY next_attempt_at, kind, digest LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) UPDATE origin_archive_fetch_jobs j SET job_version = j.job_version + 1, attempts = j.attempts + 1,
        last_attempt_at = ${now}, lease_until = ${lease}, next_attempt_at = ${lease}
      FROM due WHERE j.source_id = due.source_id AND j.kind = due.kind AND j.digest = due.digest RETURNING j.*`;
    return rows.map(jobView).sort((left, right) => left.kind.localeCompare(right.kind) || left.digest.localeCompare(right.digest));
  });
}

export async function finishOriginArchiveJob(input: {
  sourceId: string; kind: OriginArchiveJobKind; digest: string; expectedJobVersion: string;
  now: string; outcome: OriginArchiveJobOutcome;
}): Promise<OriginArchiveJob> {
  const id = sourceId(input.sourceId); const jobKind = kind(input.kind);
  const digest = originArchiveDigest(input.digest); const version = decimal(input.expectedJobVersion, 'jobVersion');
  const now = date(input.now, 'now'); const outcome = input.outcome;
  let bytes: Buffer | null = null; let actualHash: OriginDigest | null = null;
  let actualSize: string | null = null; let reason: string | null = null; let next: Date | null = null;
  let shape: OriginArchiveSnapshotShape | null = null;
  if (outcome.kind === 'retained') {
    const max = jobKind === 'snapshot' ? 32768 : 6144;
    if (!(outcome.bytes instanceof Uint8Array) || outcome.bytes.byteLength > max) throw new Error('origin archive size/bytes');
    bytes = Buffer.from(outcome.bytes); actualHash = keccak256(bytes); actualSize = String(bytes.byteLength);
    if (actualHash !== digest) throw new Error('origin archive blob hash mismatch');
    if (jobKind === 'snapshot') shape = inspectOriginArchiveSnapshot(bytes);
  } else if (outcome.kind === 'retry') {
    if (typeof outcome.reason !== 'string' || !REASON.test(outcome.reason)) throw new Error('invalid origin archive job reason');
    reason = outcome.reason;
    actualHash = outcome.actualHash === undefined ? null : originArchiveDigest(outcome.actualHash, 'actualHash');
    actualSize = outcome.actualSize === undefined ? null : decimal(outcome.actualSize, 'actualSize');
    next = date(outcome.nextAttemptAt, 'nextAttemptAt');
    if (next.getTime() <= now.getTime() || next.getTime() > now.getTime() + 300000) {
      throw new Error('origin archive retry backoff must be positive and at most 300s');
    }
  } else throw new Error('invalid origin archive job outcome');

  return getSql().begin(async (tx) => {
    const [job] = await tx<JobRow[]>`SELECT * FROM origin_archive_fetch_jobs
      WHERE source_id = ${id} AND kind = ${jobKind} AND digest = ${digest} FOR UPDATE`;
    if (!job || String(job.jobVersion) !== version || job.state !== 'pending' || !job.leaseUntil ||
      job.leaseUntil <= now || !job.lastAttemptAt || now < job.lastAttemptAt) throw new Error('stale origin archive job claim');
    if (bytes) {
      await tx`INSERT INTO origin_archive_blobs (digest, bytes, byte_length, retained_at)
        VALUES (${digest}, ${bytes}, ${bytes.byteLength}, ${now}) ON CONFLICT DO NOTHING`;
      const [stored] = await tx<BlobRow[]>`SELECT * FROM origin_archive_blobs WHERE digest = ${digest}`;
      checkedBlob(stored!);
      if (!stored!.bytes.equals(bytes)) throw new Error('origin archive blob integrity conflict');
      if (jobKind === 'snapshot') await retainSnapshot(tx, digest, shape!, id);
    }
    const [finished] = await tx<JobRow[]>`UPDATE origin_archive_fetch_jobs
      SET state = ${bytes ? 'retained' : 'pending'}, job_version = job_version + 1, lease_until = NULL,
        next_attempt_at = ${next ?? now}, reason = ${reason}, actual_hash = ${actualHash}, actual_size = ${actualSize},
        retained_digest = ${bytes ? digest : null}
      WHERE source_id = ${id} AND kind = ${jobKind} AND digest = ${digest} RETURNING *`;
    await tx`UPDATE origin_archive_sources SET availability = ${bytes ? 'available' : 'unavailable'},
      last_attempt_at = ${now}, last_result = ${bytes ? 'retained' : reason} WHERE source_id = ${id}`;
    return jobView(finished!);
  });
}

async function retainSnapshot(tx: Tx, digest: OriginDigest, shape: OriginArchiveSnapshotShape, id: string): Promise<void> {
  const claimedJson = shape.status === 'valid' ? JSON.stringify(shape.claimed) : null;
  const reason = shape.status === 'invalid' ? shape.reason : null;
  await tx`INSERT INTO origin_archive_snapshots (digest, shape_status, shape_reason, claimed_json)
    VALUES (${digest}, ${shape.status}, ${reason}, ${claimedJson}) ON CONFLICT DO NOTHING`;
  const [stored] = await tx<SnapshotRow[]>`SELECT * FROM origin_archive_snapshots WHERE digest = ${digest}`;
  if (!stored || stored.shapeStatus !== shape.status || stored.shapeReason !== reason || stored.claimedJson !== claimedJson) {
    throw new Error('origin archive snapshot integrity conflict');
  }
  if (shape.status !== 'valid') return;
  for (const [ordinal, documentDigest] of shape.claimed.entries.entries()) {
    await tx`INSERT INTO origin_archive_snapshot_entries (snapshot_digest, ordinal, document_digest)
      VALUES (${digest}, ${ordinal}, ${documentDigest}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO origin_archive_fetch_jobs (source_id, kind, digest)
      VALUES (${id}, 'document', ${documentDigest}) ON CONFLICT DO NOTHING`;
  }
  const entries = await tx<{ ordinal: number; documentDigest: OriginDigest }[]>`
    SELECT ordinal, document_digest FROM origin_archive_snapshot_entries
    WHERE snapshot_digest = ${digest} ORDER BY ordinal`;
  if (entries.length !== shape.claimed.entries.length || entries.some((entry, ordinal) =>
    entry.ordinal !== ordinal || entry.documentDigest !== shape.claimed.entries[ordinal])) {
    throw new Error('origin archive snapshot entry integrity conflict');
  }
}

export async function readOriginArchiveBlob(input: string): Promise<{
  digest: OriginDigest; bytes: Buffer; byteLength: string; retainedAt: string;
} | null> {
  const digest = originArchiveDigest(input);
  const [row] = await getSql()<BlobRow[]>`SELECT * FROM origin_archive_blobs WHERE digest = ${digest}`;
  return row ? checkedBlob(row) : null;
}

export async function readOriginArchiveSnapshotBlob(input: string): Promise<{
  digest: OriginDigest; bytes: Buffer; byteLength: string; retainedAt: string;
} | null> {
  const digest = originArchiveDigest(input);
  const [row] = await getSql()<BlobRow[]>`SELECT b.* FROM origin_archive_blobs b
    JOIN origin_archive_snapshots s USING (digest) WHERE b.digest = ${digest}`;
  return row ? checkedBlob(row) : null;
}

export async function readOriginArchiveDocumentBlob(input: string): Promise<{
  digest: OriginDigest; bytes: Buffer; byteLength: string; retainedAt: string;
} | null> {
  const digest = originArchiveDigest(input);
  const [row] = await getSql()<BlobRow[]>`SELECT b.* FROM origin_archive_blobs b WHERE b.digest = ${digest}
    AND EXISTS (SELECT 1 FROM origin_archive_snapshot_entries e WHERE e.document_digest = b.digest)`;
  return row ? checkedDocumentBlob(row) : null;
}

function relationship(left: { digest: OriginDigest; entries: OriginDigest[] },
  right: { digest: OriginDigest; entries: OriginDigest[] }): OriginArchiveSnapshotStatus['relationships'][number] {
  const prefix = (short: OriginDigest[], long: OriginDigest[]) =>
    short.length <= long.length && short.every((entry, index) => entry === long[index]);
  if (left.entries.length === right.entries.length && prefix(left.entries, right.entries)) {
    return { leftDigest: left.digest, rightDigest: right.digest, relationship: 'equal' };
  }
  if (prefix(left.entries, right.entries)) return { leftDigest: left.digest, rightDigest: right.digest,
    relationship: 'prefix-extension', prefixDigest: left.digest, extensionDigest: right.digest };
  if (prefix(right.entries, left.entries)) return { leftDigest: left.digest, rightDigest: right.digest,
    relationship: 'prefix-extension', prefixDigest: right.digest, extensionDigest: left.digest };
  return { leftDigest: left.digest, rightDigest: right.digest, relationship: 'non-prefix' };
}

export async function readOriginArchiveSnapshotStatus(input: string): Promise<OriginArchiveSnapshotStatus | null> {
  const digest = originArchiveDigest(input);
  return getSql().begin('isolation level repeatable read read only', async (tx) => {
    const jobs = await tx<(JobRow & SourceRow)[]>`SELECT j.*, s.config_fingerprint, s.config_json,
      s.availability, s.last_attempt_at AS source_last_attempt_at, s.last_result
      FROM origin_archive_fetch_jobs j JOIN origin_archive_sources s USING (source_id)
      WHERE j.kind = 'snapshot' AND j.digest = ${digest} ORDER BY j.source_id`;
    const [snapshot] = await tx<SnapshotRow[]>`SELECT * FROM origin_archive_snapshots WHERE digest = ${digest}`;
    if (!snapshot && jobs.length === 0) return null;
    const sources = jobs.map((row) => ({
      sourceId: row.sourceId, availability: row.availability,
      lastAttemptAt: (row as unknown as { sourceLastAttemptAt: Date | null }).sourceLastAttemptAt?.toISOString() ?? null,
      lastResult: row.lastResult, job: jobView(row),
    }));
    let shape: OriginArchiveSnapshotStatus['shape'] = { status: 'unavailable' };
    if (snapshot) {
      const [blob] = await tx<BlobRow[]>`SELECT * FROM origin_archive_blobs WHERE digest = ${digest}`;
      if (!blob) throw new Error('origin archive blob integrity failure');
      checkedBlob(blob);
      if (snapshot.shapeStatus === 'valid') shape = { status: 'valid', claimed: JSON.parse(snapshot.claimedJson!) as OriginArchiveSnapshotPayload };
      else shape = { status: 'invalid', reason: snapshot.shapeReason! };
    }
    const rows = snapshot ? await tx<{ ordinal: number; documentDigest: OriginDigest; blobDigest: OriginDigest | null;
      bytes: Buffer | null; byteLength: number | null; retainedAt: Date | null }[]>`
      SELECT e.ordinal, e.document_digest, b.digest AS blob_digest, b.bytes, b.byte_length, b.retained_at
      FROM origin_archive_snapshot_entries e LEFT JOIN origin_archive_blobs b ON b.digest = e.document_digest
      WHERE e.snapshot_digest = ${digest} ORDER BY e.ordinal` : [];
    const retainedDocuments = new Set<OriginDigest>();
    for (const row of rows) {
      if (row.blobDigest !== null) {
        const checked = checkedDocumentBlob({ digest: row.blobDigest, bytes: row.bytes!,
          byteLength: row.byteLength!, retainedAt: row.retainedAt! });
        if (checked) retainedDocuments.add(row.documentDigest);
      }
    }
    let retainedVariants: OriginArchiveSnapshotStatus['retainedVariants'] = [];
    let variantsTruncated = false;
    if (shape.status === 'valid') {
      const variants = await tx<{ digest: OriginDigest; claimedJson: string; bytes: Buffer; byteLength: number; retainedAt: Date }[]>`
        SELECT s.digest, s.claimed_json, b.bytes, b.byte_length, b.retained_at
        FROM origin_archive_snapshots s JOIN origin_archive_blobs b USING (digest)
        WHERE s.shape_status = 'valid'
          AND s.claimed_json::jsonb->>'reviewer' = ${shape.claimed.reviewer}
          AND s.claimed_json::jsonb->'service'->>'method' = ${shape.claimed.service.method}
          AND s.claimed_json::jsonb->'service'->>'identityUrl' = ${shape.claimed.service.identityUrl}
        ORDER BY s.digest LIMIT 33`;
      variantsTruncated = variants.length > 32;
      retainedVariants = variants.slice(0, 32).map((variant) => {
        checkedBlob(variant);
        const claimed = JSON.parse(variant.claimedJson) as OriginArchiveSnapshotPayload;
        return { digest: variant.digest, claimed, entries: claimed.entries, authenticity: 'not-evaluated' as const };
      });
    }
    const relationships: OriginArchiveSnapshotStatus['relationships'] = [];
    for (let left = 0; left < retainedVariants.length; left++) {
      for (let right = left + 1; right < retainedVariants.length; right++) {
        relationships.push(relationship(retainedVariants[left]!, retainedVariants[right]!));
      }
    }
    return { digest, acquisition: { state: snapshot ? 'retained' : 'pending', sources }, shape,
      entries: rows.map((row) => ({ ordinal: row.ordinal, digest: row.documentDigest,
        availability: retainedDocuments.has(row.documentDigest) ? 'retained' : 'pending' })),
      retainedVariants, variantsTruncated, relationships };
  });
}
