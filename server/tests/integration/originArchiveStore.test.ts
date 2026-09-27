import { afterAll, afterEach, expect, it } from 'vitest';
import { closeSql, getSql } from '../../src/db/client.js';
import { originArchiveSourceId, type OriginArchiveConfig } from '../../src/connectors/originArchive/config.js';
import * as q from '../../src/db/queries/originArchive.js';
import { cleanupOriginArchive, digestBytes, originAddress, originConfig, originDigest, originPayload,
  originSnapshotBytes } from '../fixtures/originArchive.js';

const sources: string[] = [];
const now = '2026-09-26T12:00:00.000Z';
function owned(config: OriginArchiveConfig): OriginArchiveConfig { sources.push(originArchiveSourceId(config)); return config; }
afterEach(async () => { await cleanupOriginArchive(sources.splice(0)); });
afterAll(closeSql);

it('seeds only digest jobs and reads pending availability without causing writes', async () => {
  const config = owned(originConfig({ snapshotDigests: [originDigest(101), originDigest(102)] }));
  const seeded = await q.seedOriginArchiveSnapshots(config);
  expect(seeded).toMatchObject({ sourceId: originArchiveSourceId(config), availability: 'pending', lastAttemptAt: null });
  const before = await q.readOriginArchiveSnapshotStatus(originDigest(101));
  expect(before).toMatchObject({ digest: originDigest(101), acquisition: { state: 'pending' }, shape: { status: 'unavailable' }, entries: [] });
  expect(await q.readOriginArchiveSnapshotStatus(originDigest(101))).toEqual(before);
});

it('claims disjoint committed jobs, limits four, reclaims expired leases and CASes finishes', async () => {
  const documents = Array.from({ length: 5 }, (_, i) => Buffer.from(`lease-${i}`));
  const snapshot = originSnapshotBytes({ payload: originPayload({ entries: documents.map(digestBytes) }) });
  const config = owned(originConfig({ snapshotDigests: [digestBytes(snapshot)] }));
  const sourceId = originArchiveSourceId(config); await q.seedOriginArchiveSnapshots(config);
  const [snapshotJob] = await q.claimOriginArchiveJobs({ sourceId, limit: 4, now, leaseMs: 30000 });
  await q.finishOriginArchiveJob({ sourceId, kind: 'snapshot', digest: snapshotJob!.digest,
    expectedJobVersion: snapshotJob!.jobVersion, now, outcome: { kind: 'retained', bytes: snapshot } });
  const [a, b] = await Promise.all([
    q.claimOriginArchiveJobs({ sourceId, limit: 4, now, leaseMs: 1000 }),
    q.claimOriginArchiveJobs({ sourceId, limit: 4, now, leaseMs: 1000 }),
  ]);
  expect([a.length, b.length].sort((left, right) => left - right)).toEqual([1, 4]);
  expect(new Set([...a, ...b].map((job) => job.digest)).size).toBe(5);
  expect(await q.claimOriginArchiveJobs({ sourceId, limit: 4, now, leaseMs: 1000 })).toHaveLength(0);
  const reclaimed = await q.claimOriginArchiveJobs({ sourceId, limit: 4, now: '2026-09-26T12:00:01.001Z', leaseMs: 1000 });
  expect(reclaimed).toHaveLength(4); expect(reclaimed.every((job) => job.attempts === '2')).toBe(true);
  const stale = [...a, ...b].find((job) => job.digest === reclaimed[0]!.digest)!;
  await expect(q.finishOriginArchiveJob({ sourceId, kind: stale.kind, digest: stale.digest,
    expectedJobVersion: stale.jobVersion, now, outcome: { kind: 'retry', reason: 'unavailable',
      nextAttemptAt: '2026-09-26T12:00:02.000Z' } })).rejects.toThrow(/stale/);
  await expect(q.claimOriginArchiveJobs({ sourceId, limit: 5, now, leaseMs: 1000 })).rejects.toThrow();
  await expect(q.claimOriginArchiveJobs({ sourceId, limit: 1, now, leaseMs: 30001 })).rejects.toThrow();
});

it('retains hash-matching invalid snapshots without seeding documents', async () => {
  const snapshot = originSnapshotBytes({ payload: { ...originPayload(), extra: true } });
  const config = owned(originConfig({ snapshotDigests: [digestBytes(snapshot)] }));
  const sourceId = originArchiveSourceId(config); await q.seedOriginArchiveSnapshots(config);
  const [job] = await q.claimOriginArchiveJobs({ sourceId, limit: 1, now, leaseMs: 1000 });
  await q.finishOriginArchiveJob({ sourceId, kind: job!.kind, digest: job!.digest,
    expectedJobVersion: job!.jobVersion, now, outcome: { kind: 'retained', bytes: snapshot } });
  expect(await q.readOriginArchiveSnapshotStatus(job!.digest)).toMatchObject({
    acquisition: { state: 'retained' }, shape: { status: 'invalid' }, entries: [],
  });
  expect(await q.claimOriginArchiveJobs({ sourceId, limit: 4, now, leaseMs: 1000 })).toHaveLength(0);
});

it('treats a zero reviewer as an unverified lowercase label and seeds its declared document', async () => {
  const document = Buffer.from('zero-reviewer-public-document');
  const snapshot = originSnapshotBytes({
    payload: originPayload({ reviewer: originAddress(0), entries: [digestBytes(document)] }),
    envelope: { signer: { method: 'secp256k1-key', address: originAddress(8) } },
  });
  const config = owned(originConfig({ snapshotDigests: [digestBytes(snapshot)] }));
  const sourceId = originArchiveSourceId(config); await q.seedOriginArchiveSnapshots(config);
  const [snapshotJob] = await q.claimOriginArchiveJobs({ sourceId, limit: 1, now, leaseMs: 1000 });
  await q.finishOriginArchiveJob({ sourceId, kind: 'snapshot', digest: snapshotJob!.digest,
    expectedJobVersion: snapshotJob!.jobVersion, now, outcome: { kind: 'retained', bytes: snapshot } });
  expect(await q.readOriginArchiveSnapshotStatus(digestBytes(snapshot))).toMatchObject({
    shape: { status: 'valid', claimed: { reviewer: originAddress(0) } },
    entries: [{ ordinal: 0, digest: digestBytes(document), availability: 'pending' }],
    retainedVariants: [{ authenticity: 'not-evaluated' }],
  });
  expect(await q.claimOriginArchiveJobs({ sourceId, limit: 4, now, leaseMs: 1000 }))
    .toMatchObject([{ kind: 'document', digest: digestBytes(document) }]);
});

it('atomically seeds ordered unique documents and reports partial retention independently of source state', async () => {
  const first = Buffer.from([0, 1, 255]); const second = Buffer.alloc(6144, 7);
  const snapshot = originSnapshotBytes({ payload: originPayload({ entries: [digestBytes(first), digestBytes(second)] }) });
  const config = owned(originConfig({ snapshotDigests: [digestBytes(snapshot)] }));
  const sourceId = originArchiveSourceId(config); await q.seedOriginArchiveSnapshots(config);
  const [job] = await q.claimOriginArchiveJobs({ sourceId, limit: 1, now, leaseMs: 1000 });
  await q.finishOriginArchiveJob({ sourceId, kind: 'snapshot', digest: job!.digest,
    expectedJobVersion: job!.jobVersion, now, outcome: { kind: 'retained', bytes: snapshot } });
  const documentJobs = await q.claimOriginArchiveJobs({ sourceId, limit: 4, now, leaseMs: 1000 });
  const retained = documentJobs.find((candidate) => candidate.digest === digestBytes(first))!;
  await q.finishOriginArchiveJob({ sourceId, kind: 'document', digest: retained.digest,
    expectedJobVersion: retained.jobVersion, now, outcome: { kind: 'retained', bytes: first } });
  expect(await q.readOriginArchiveSnapshotStatus(digestBytes(snapshot))).toMatchObject({
    shape: { status: 'valid', claimed: { entries: [digestBytes(first), digestBytes(second)] } },
    entries: [
      { ordinal: 0, digest: digestBytes(first), availability: 'retained' },
      { ordinal: 1, digest: digestBytes(second), availability: 'pending' },
    ],
  });
  expect((await q.readOriginArchiveBlob(digestBytes(first)))!.bytes).toEqual(first);
  await expect(q.finishOriginArchiveJob({ sourceId, kind: 'document', digest: documentJobs[1]!.digest,
    expectedJobVersion: documentJobs[1]!.jobVersion, now, outcome: { kind: 'retained', bytes: Buffer.alloc(6145) } }))
    .rejects.toThrow(/size/);
});

it('rejects wrong hashes and bounded retry metadata without mutating retained history', async () => {
  const config = owned(originConfig({ snapshotDigests: [originDigest(801)] }));
  const sourceId = originArchiveSourceId(config); await q.seedOriginArchiveSnapshots(config);
  const [job] = await q.claimOriginArchiveJobs({ sourceId, limit: 1, now, leaseMs: 1000 });
  await expect(q.finishOriginArchiveJob({ sourceId, kind: job!.kind, digest: job!.digest,
    expectedJobVersion: job!.jobVersion, now, outcome: { kind: 'retained', bytes: Buffer.from('wrong') } }))
    .rejects.toThrow(/hash/);
  for (const nextAttemptAt of [now, '2026-09-26T12:05:00.001Z']) {
    await expect(q.finishOriginArchiveJob({ sourceId, kind: job!.kind, digest: job!.digest,
      expectedJobVersion: job!.jobVersion, now, outcome: { kind: 'retry', reason: 'unavailable', nextAttemptAt } }))
      .rejects.toThrow(/backoff/);
  }
  await q.finishOriginArchiveJob({ sourceId, kind: job!.kind, digest: job!.digest,
    expectedJobVersion: job!.jobVersion, now, outcome: { kind: 'retry', reason: 'hash-mismatch',
      actualHash: originDigest(999), actualSize: '5', nextAttemptAt: '2026-09-26T12:00:01.000Z' } });
  expect(await q.readOriginArchiveSnapshotStatus(job!.digest)).toMatchObject({
    acquisition: { sources: [{ availability: 'unavailable', job: { reason: 'hash-mismatch', actualHash: originDigest(999), actualSize: '5' } }] },
    shape: { status: 'unavailable' },
  });
});

it('rejects a pre-existing snapshot association that disagrees with the retained claimed bytes', async () => {
  const document = Buffer.from('immutable association');
  const snapshot = originSnapshotBytes({ payload: originPayload({ entries: [digestBytes(document)] }) });
  const first = owned(originConfig({ snapshotDigests: [digestBytes(snapshot)] }));
  await q.seedOriginArchiveSnapshots(first);
  const [firstJob] = await q.claimOriginArchiveJobs({ sourceId: originArchiveSourceId(first), limit: 1, now, leaseMs: 1000 });
  await q.finishOriginArchiveJob({ sourceId: firstJob!.sourceId, kind: firstJob!.kind, digest: firstJob!.digest,
    expectedJobVersion: firstJob!.jobVersion, now, outcome: { kind: 'retained', bytes: snapshot } });
  await getSql()`UPDATE origin_archive_snapshot_entries SET document_digest = ${originDigest(991)}
    WHERE snapshot_digest = ${digestBytes(snapshot)} AND ordinal = 0`;

  const second = owned(originConfig({ snapshotDigests: [digestBytes(snapshot)] }));
  await q.seedOriginArchiveSnapshots(second);
  const [secondJob] = await q.claimOriginArchiveJobs({ sourceId: originArchiveSourceId(second), limit: 1, now, leaseMs: 1000 });
  await expect(q.finishOriginArchiveJob({ sourceId: secondJob!.sourceId, kind: secondJob!.kind, digest: secondJob!.digest,
    expectedJobVersion: secondJob!.jobVersion, now, outcome: { kind: 'retained', bytes: snapshot } }))
    .rejects.toThrow(/integrity/);
});
