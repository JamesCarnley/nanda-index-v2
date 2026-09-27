import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server.js';
import { closeSql, getSql } from '../../src/db/client.js';
import { originArchiveSourceId, type OriginArchiveConfig } from '../../src/connectors/originArchive/config.js';
import * as q from '../../src/db/queries/originArchive.js';
import { cleanupOriginArchive, digestBytes, originConfig, originDigest, originPayload, originSnapshotBytes } from '../fixtures/originArchive.js';

const root = '/api/ard/origin-archive';
const now = '2026-09-26T12:00:00.000Z';
const sources: string[] = [];
let app: FastifyInstance;

beforeAll(async () => { app = (await buildServer({ logger: false })).fastify; await app.ready(); });
afterEach(async () => { vi.restoreAllMocks(); await cleanupOriginArchive(sources.splice(0)); });
afterAll(async () => { await app.close(); await closeSql(); });

async function retainSnapshot(bytes: Uint8Array, config: OriginArchiveConfig = originConfig({ snapshotDigests: [digestBytes(bytes)] })) {
  sources.push(originArchiveSourceId(config)); await q.seedOriginArchiveSnapshots(config);
  const jobs = await q.claimOriginArchiveJobs({ sourceId: originArchiveSourceId(config), limit: 4, now, leaseMs: 30000 });
  const job = jobs.find((candidate) => candidate.kind === 'snapshot' && candidate.digest === digestBytes(bytes))!;
  await q.finishOriginArchiveJob({ sourceId: job.sourceId, kind: job.kind, digest: job.digest,
    expectedJobVersion: job.jobVersion, now, outcome: { kind: 'retained', bytes } });
  return { config, digest: digestBytes(bytes) };
}

it('serves status plus exact snapshot/document bytes with no-store and partial availability', async () => {
  const first = Buffer.from([0, 255, 1]); const second = Buffer.from('pending');
  const snapshot = originSnapshotBytes({ payload: originPayload({ entries: [digestBytes(first), digestBytes(second)] }) });
  const retained = await retainSnapshot(snapshot);
  const jobs = await q.claimOriginArchiveJobs({ sourceId: originArchiveSourceId(retained.config), limit: 4, now, leaseMs: 30000 });
  const firstJob = jobs.find((job) => job.digest === digestBytes(first))!;
  await q.finishOriginArchiveJob({ sourceId: firstJob.sourceId, kind: firstJob.kind, digest: firstJob.digest,
    expectedJobVersion: firstJob.jobVersion, now, outcome: { kind: 'retained', bytes: first } });

  const status = await app.inject(`${root}/snapshots/${retained.digest}/status`);
  expect(status.statusCode).toBe(200); expect(status.headers['cache-control']).toBe('no-store');
  expect(status.json()).toMatchObject({ authenticity: 'not-evaluated', acquisition: { state: 'retained' },
    shape: { status: 'valid' }, entries: [
      { ordinal: 0, digest: digestBytes(first), availability: 'retained' },
      { ordinal: 1, digest: digestBytes(second), availability: 'pending' },
    ], retainedVariants: expect.any(Array), variantsTruncated: false, relationships: expect.any(Array) });
  const snapshotResponse = await app.inject(`${root}/snapshots/${retained.digest}`);
  expect(snapshotResponse.rawPayload).toEqual(snapshot);
  expect(snapshotResponse.headers).toMatchObject({ 'cache-control': 'no-store', 'content-type': 'application/octet-stream',
    'x-content-type-options': 'nosniff', 'content-length': String(snapshot.byteLength) });
  const documentResponse = await app.inject(`${root}/documents/${digestBytes(first)}`);
  expect(documentResponse.rawPayload).toEqual(first);
  expect(documentResponse.headers).toMatchObject({ 'cache-control': 'no-store', 'content-type': 'application/octet-stream',
    'x-content-type-options': 'nosniff', 'content-length': String(first.byteLength) });
  expect((await app.inject(`${root}/documents/${digestBytes(second)}`)).statusCode).toBe(404);
});

it('keeps a valid oversized snapshot readable but unavailable when named as a document', async () => {
  const oversized = originSnapshotBytes({
    payload: originPayload({ entries: Array.from({ length: 96 }, (_, index) => originDigest(index + 1)) }),
  });
  expect(oversized.byteLength).toBeGreaterThan(6144);
  expect(oversized.byteLength).toBeLessThanOrEqual(32768);
  const reference = originSnapshotBytes({ payload: originPayload({ entries: [digestBytes(oversized)] }) });
  const source = await retainSnapshot(oversized);
  const referencing = await retainSnapshot(reference);

  const sourceRead = await app.inject(`${root}/snapshots/${source.digest}`);
  expect(sourceRead.statusCode).toBe(200);
  expect(sourceRead.rawPayload).toEqual(oversized);
  const status = await app.inject(`${root}/snapshots/${referencing.digest}/status`);
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject({ entries: [
    { ordinal: 0, digest: digestBytes(oversized), availability: 'pending' },
  ] });
  expect((await app.inject(`${root}/documents/${digestBytes(oversized)}`)).statusCode).toBe(404);

  await getSql()`UPDATE origin_archive_blobs SET bytes = ${Buffer.alloc(oversized.byteLength)}
    WHERE digest = ${digestBytes(oversized)}`;
  for (const url of [`${root}/snapshots/${source.digest}`, `${root}/snapshots/${referencing.digest}/status`,
    `${root}/documents/${digestBytes(oversized)}`]) {
    const corrupt = await app.inject(url);
    expect(corrupt.statusCode).toBe(500);
    expect(corrupt.json()).toEqual({ error: 'ORIGIN_ARCHIVE_INTEGRITY' });
  }
});

it('reports equal, prefix-extension and non-prefix relationships without treating claimed grouping as authority', async () => {
  const a = originDigest(11); const b = originDigest(12); const c = originDigest(13);
  const variants = [
    originSnapshotBytes({ payload: originPayload({ snapshotId: 'equal-a', entries: [a] }) }),
    originSnapshotBytes({ payload: originPayload({ snapshotId: 'equal-b', entries: [a] }) }),
    originSnapshotBytes({ payload: originPayload({ snapshotId: 'prefix', entries: [a, b] }) }),
    originSnapshotBytes({ payload: originPayload({ snapshotId: 'non-prefix', entries: [c] }) }),
  ];
  for (const bytes of variants) await retainSnapshot(bytes);
  const response = await app.inject(`${root}/snapshots/${digestBytes(variants[0]!)}/status`);
  expect(response.statusCode).toBe(200);
  const json = response.json();
  expect(json.retainedVariants).toHaveLength(4);
  expect(json.retainedVariants.every((variant: Record<string, unknown>) => variant.authenticity === 'not-evaluated')).toBe(true);
  expect(new Set(json.relationships.map((item: { relationship: string }) => item.relationship)))
    .toEqual(new Set(['equal', 'prefix-extension', 'non-prefix']));
});

it('returns only the first 32 digest-ordered variants and marks incomplete inspection', async () => {
  const variants: Buffer[] = [];
  for (let i = 0; i < 33; i++) {
    const bytes = originSnapshotBytes({ payload: originPayload({ snapshotId: `variant-${i}`, entries: [originDigest(i + 1)] }) });
    variants.push(bytes); await retainSnapshot(bytes);
  }
  const response = await app.inject(`${root}/snapshots/${digestBytes(variants[0]!)}/status`);
  const json = response.json();
  expect(json.variantsTruncated).toBe(true); expect(json.retainedVariants).toHaveLength(32);
  const digests = json.retainedVariants.map((variant: { digest: string }) => variant.digest);
  expect(digests).toEqual([...digests].sort());
});

it('bounds relationship output for two full 256-entry variants', async () => {
  const entries = Array.from({ length: 256 }, (_, index) => originDigest(index + 1));
  const extended = [...entries]; extended[255] = originDigest(900);
  const first = originSnapshotBytes({ payload: originPayload({ snapshotId: 'full-a', entries }) });
  const second = originSnapshotBytes({ payload: originPayload({ snapshotId: 'full-b', entries: extended }) });
  const config = originConfig({ snapshotDigests: [digestBytes(first), digestBytes(second)] });
  sources.push(originArchiveSourceId(config)); await q.seedOriginArchiveSnapshots(config);
  const jobs = await q.claimOriginArchiveJobs({ sourceId: originArchiveSourceId(config), limit: 4, now, leaseMs: 30000 });
  for (const job of jobs) {
    const bytes = job.digest === digestBytes(first) ? first : second;
    await q.finishOriginArchiveJob({ sourceId: job.sourceId, kind: job.kind, digest: job.digest,
      expectedJobVersion: job.jobVersion, now, outcome: { kind: 'retained', bytes } });
  }
  const json = (await app.inject(`${root}/snapshots/${digestBytes(first)}/status`)).json();
  expect(json.retainedVariants.map((variant: { entries: unknown[] }) => variant.entries.length)).toEqual([256, 256]);
  expect(json.relationships).toHaveLength(1);
  expect(json.relationships[0].relationship).toBe('non-prefix');
});

it('never fetches or mutates on GET and distinguishes malformed, missing and corrupt blobs', async () => {
  const snapshot = originSnapshotBytes(); const retained = await retainSnapshot(snapshot);
  const before = await q.readOriginArchiveSnapshotStatus(retained.digest);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('GET fetched'); });
  for (const url of [`${root}/snapshots/${retained.digest}/status`, `${root}/snapshots/${retained.digest}`]) {
    expect((await app.inject(url)).statusCode).toBe(200);
  }
  expect(fetch).not.toHaveBeenCalled(); expect(await q.readOriginArchiveSnapshotStatus(retained.digest)).toEqual(before);
  for (const url of [`${root}/snapshots/bad/status`, `${root}/snapshots/bad`, `${root}/documents/bad`]) {
    const response = await app.inject(url); expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'INVALID_INPUT' }); expect(response.headers['cache-control']).toBe('no-store');
  }
  for (const url of [`${root}/snapshots/${originDigest(777)}/status`, `${root}/snapshots/${originDigest(777)}`,
    `${root}/documents/${originDigest(777)}`]) {
    const response = await app.inject(url); expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'NOT_FOUND' });
  }
  await getSql()`UPDATE origin_archive_blobs SET bytes = ${Buffer.alloc(snapshot.byteLength)} WHERE digest = ${retained.digest}`;
  const corrupt = await app.inject(`${root}/snapshots/${retained.digest}`);
  expect(corrupt.statusCode).toBe(500); expect(corrupt.json()).toEqual({ error: 'ORIGIN_ARCHIVE_INTEGRITY' });
  expect(corrupt.rawPayload).not.toEqual(snapshot);
  const corruptStatus = await app.inject(`${root}/snapshots/${retained.digest}/status`);
  expect(corruptStatus.statusCode).toBe(500);
  expect(corruptStatus.json()).toEqual({ error: 'ORIGIN_ARCHIVE_INTEGRITY' });
});

it('rejects all query parameters on every read route', async () => {
  const snapshot = originSnapshotBytes(); const retained = await retainSnapshot(snapshot);
  for (const url of [`${root}/snapshots/${retained.digest}/status?x=1`, `${root}/snapshots/${retained.digest}?x=1`,
    `${root}/documents/${originDigest(9)}?x=1`]) {
    expect((await app.inject(url)).statusCode).toBe(400);
  }
});
