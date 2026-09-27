import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, afterEach, expect, it } from 'vitest';
import { closeSql } from '../../src/db/client.js';
import { originArchiveSourceId, type OriginArchiveConfig } from '../../src/connectors/originArchive/config.js';
import { fetchOriginArchiveBlob, originArchiveRetryDelay, sweepOriginArchive } from '../../src/connectors/originArchive/acquisition.js';
import { claimOriginArchiveJobs, finishOriginArchiveJob, readOriginArchiveSnapshotStatus,
  seedOriginArchiveSnapshots } from '../../src/db/queries/originArchive.js';
import { cleanupOriginArchive, digestBytes, originConfig, originDigest, originPayload, originSnapshotBytes } from '../fixtures/originArchive.js';

const closes: (() => Promise<void>)[] = [];
const sources: string[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  await cleanupOriginArchive(sources.splice(0));
});
afterAll(closeSql);

async function http(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closes.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/public-origin/`;
}

function owned(config: OriginArchiveConfig): OriginArchiveConfig {
  sources.push(originArchiveSourceId(config)); return config;
}

it('caps exponential retry using BigInt with no terminal attempt count', () => {
  expect(['1', '2', '9', '10', '999999999999999999'].map(originArchiveRetryDelay))
    .toEqual([1000, 2000, 256000, 300000, 300000]);
});

it('retains exact bytes with identity encoding, no credentials and the per-kind streaming cap', async () => {
  const snapshot = originSnapshotBytes();
  const base = await http((req, res) => {
    expect(req.headers['accept-encoding']).toBe('identity');
    expect(req.headers.authorization).toBeUndefined();
    res.write(snapshot.subarray(0, 3)); res.end(snapshot.subarray(3));
  });
  expect(await fetchOriginArchiveBlob(`${base}snapshots/${digestBytes(snapshot)}`, digestBytes(snapshot), 'snapshot'))
    .toEqual({ kind: 'retained', bytes: snapshot });

  const tooLarge = Buffer.alloc(6145);
  const documentBase = await http((_req, res) => { res.write(tooLarge.subarray(0, 5000)); res.end(tooLarge.subarray(5000)); });
  expect(await fetchOriginArchiveBlob(`${documentBase}documents/${digestBytes(tooLarge)}`, digestBytes(tooLarge), 'document'))
    .toMatchObject({ kind: 'retry', reason: 'body-too-large' });
});

it('never follows redirects, rejects declared oversize and times out through EOF', async () => {
  let hits = 0;
  const target = await http((_req, res) => { hits++; res.end('target'); });
  const redirect = await http((_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  expect(await fetchOriginArchiveBlob(`${redirect}snapshots/${originDigest(91)}`, originDigest(91), 'snapshot'))
    .toMatchObject({ kind: 'retry' });
  expect(hits).toBe(0);
  const length = await http((_req, res) => { res.setHeader('content-length', '32769'); res.end(); });
  expect(await fetchOriginArchiveBlob(`${length}snapshots/${originDigest(92)}`, originDigest(92), 'snapshot'))
    .toMatchObject({ kind: 'retry', reason: 'body-too-large' });
  const hang = await http((_req, res) => { res.writeHead(200); res.write('x'); });
  const started = Date.now();
  expect(await fetchOriginArchiveBlob(`${hang}documents/${originDigest(93)}`, originDigest(93), 'document'))
    .toMatchObject({ kind: 'retry', reason: 'fetch-timeout' });
  expect(Date.now() - started).toBeLessThan(6500);
}, 9000);

it('derives only pinned snapshot and validated entry URLs, bounds fanout at four and reuses retained blobs', async () => {
  const documents = Array.from({ length: 5 }, (_, i) => Buffer.from(`document-${i}`));
  const snapshot = originSnapshotBytes({ payload: originPayload({ entries: documents.map(digestBytes) }) });
  const paths: string[] = []; let active = 0; let maximum = 0;
  const base = await http((req, res) => {
    paths.push(req.url!); active++; maximum = Math.max(maximum, active);
    const digest = req.url!.split('/').at(-1)!;
    const bytes = req.url!.includes('/snapshots/') ? snapshot : documents.find((value) => digestBytes(value) === digest)!;
    setTimeout(() => { active--; res.end(bytes); }, 20);
  });
  const config = owned(originConfig({ sourceBaseUrl: base, snapshotDigests: [digestBytes(snapshot)] }));
  await seedOriginArchiveSnapshots(config);
  await sweepOriginArchive(config);
  expect(paths).toEqual([`/public-origin/snapshots/${digestBytes(snapshot)}`]);
  await sweepOriginArchive(config);
  expect(paths).toHaveLength(5); expect(maximum).toBe(4); expect(active).toBe(0);
  await sweepOriginArchive(config);
  expect(paths).toHaveLength(6);
  const status = await readOriginArchiveSnapshotStatus(digestBytes(snapshot));
  expect(status!.entries.filter((entry) => entry.availability === 'retained')).toHaveLength(5);
  await sweepOriginArchive(config);
  expect(paths).toHaveLength(6);
});

it('keeps an oversized snapshot-only shared blob on a bounded document retry without fetching', async () => {
  const oversized = originSnapshotBytes({
    payload: originPayload({ entries: Array.from({ length: 96 }, (_, index) => originDigest(index + 1)) }),
  });
  expect(oversized.byteLength).toBeGreaterThan(6144);
  const oversizedConfig = owned(originConfig({ snapshotDigests: [digestBytes(oversized)] }));
  await seedOriginArchiveSnapshots(oversizedConfig);
  const [oversizedJob] = await claimOriginArchiveJobs({ sourceId: originArchiveSourceId(oversizedConfig),
    limit: 1, now: '2026-09-26T12:00:00.000Z', leaseMs: 1000 });
  await finishOriginArchiveJob({ sourceId: oversizedJob!.sourceId, kind: oversizedJob!.kind,
    digest: oversizedJob!.digest, expectedJobVersion: oversizedJob!.jobVersion,
    now: '2026-09-26T12:00:00.000Z', outcome: { kind: 'retained', bytes: oversized } });

  let hits = 0;
  const base = await http((_req, res) => { hits++; res.statusCode = 500; res.end(); });
  const reference = originSnapshotBytes({ payload: originPayload({ entries: [digestBytes(oversized)] }) });
  const config = owned(originConfig({ sourceBaseUrl: base, snapshotDigests: [digestBytes(reference)] }));
  await seedOriginArchiveSnapshots(config);
  const [referenceJob] = await claimOriginArchiveJobs({ sourceId: originArchiveSourceId(config),
    limit: 1, now: '2026-09-26T12:00:00.000Z', leaseMs: 1000 });
  await finishOriginArchiveJob({ sourceId: referenceJob!.sourceId, kind: referenceJob!.kind,
    digest: referenceJob!.digest, expectedJobVersion: referenceJob!.jobVersion,
    now: '2026-09-26T12:00:00.000Z', outcome: { kind: 'retained', bytes: reference } });

  await sweepOriginArchive(config, undefined, () => new Date('2026-09-26T12:00:10.000Z'));
  expect(hits).toBe(0);
  expect(await claimOriginArchiveJobs({ sourceId: originArchiveSourceId(config), limit: 1,
    now: '2026-09-26T12:00:10.999Z', leaseMs: 1000 })).toHaveLength(0);
  expect(await claimOriginArchiveJobs({ sourceId: originArchiveSourceId(config), limit: 1,
    now: '2026-09-26T12:00:11.001Z', leaseMs: 1000 })).toMatchObject([{
      kind: 'document', digest: digestBytes(oversized), attempts: '2', reason: 'body-too-large',
      actualSize: String(oversized.byteLength),
    }]);
});

it('keeps an empty database plus unavailable configured source as pending unavailable input', async () => {
  const base = await http((_req, res) => { res.statusCode = 503; res.end(); });
  const config = owned(originConfig({ sourceBaseUrl: base, snapshotDigests: [originDigest(701)] }));
  await seedOriginArchiveSnapshots(config);
  await sweepOriginArchive(config, undefined, () => new Date('2026-09-26T12:00:00.000Z'));
  expect(await readOriginArchiveSnapshotStatus(originDigest(701))).toMatchObject({
    acquisition: { state: 'pending', sources: [{ availability: 'unavailable', job: { reason: 'http-status', attempts: '1' } }] },
    shape: { status: 'unavailable' }, entries: [],
  });
});
