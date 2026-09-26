import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, afterEach, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { closeSql } from '../../src/db/client.js';
import * as q from '../../src/db/queries/feedbackObservations.js';
import { feedbackEventId, feedbackSourceId } from '../../src/connectors/erc8004/feedbackValidation.js';
import { feedbackSourceFromConfig, type FeedbackFollowerConfig } from '../../src/connectors/erc8004/feedbackConfig.js';
import { feedbackRetryDelay, fetchFeedbackDocument, sweepFeedbackDocuments } from '../../src/connectors/erc8004/feedbackAcquisition.js';
import { syncFeedbackOnce } from '../../src/connectors/erc8004/feedbackFollower.js';
import type { FeedbackReader } from '../../src/connectors/erc8004/feedbackRpc.js';
import { block, cleanupSources, config, hash, log } from '../fixtures/feedback.js';
const owned: FeedbackFollowerConfig[] = []; const closes: (() => Promise<void>)[] = [];
const fresh = () => { const c = config(); owned.push(c); return c; };
afterEach(async () => { for (const close of closes.splice(0)) await close(); await cleanupSources(owned.map(feedbackSourceFromConfig)); owned.length = 0; });
afterAll(closeSql);
async function http(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closes.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
async function seed(c: FeedbackFollowerConfig, raws = [log(c)]) {
  await q.applyFeedbackBatch({ source: feedbackSourceFromConfig(c), expectedVersion: '0', expectedCheckpoint: null,
    through: block(), observedHead: block(), finalizedBlock: null, logs: raws });
}
const bytes = new Uint8Array([91, 83, 88, 0, 255]); const digest = keccak256(bytes);
it('caps backoff using BigInt before numeric conversion, always positive, without an attempt limit', () => {
  expect(['1', '2', '9', '10', '999999999999999999999999'].map(feedbackRetryDelay)).toEqual([1000, 2000, 256000, 300000, 300000]);
});
it('retains exact opaque bytes, identity encoding and no credentials', async () => {
  const url = await http((req, res) => { expect(req.headers['accept-encoding']).toBe('identity'); expect(req.headers.authorization).toBeUndefined();
    res.write(bytes.slice(0, 2)); res.end(bytes.slice(2)); });
  expect(await fetchFeedbackDocument(url, digest)).toEqual({ kind: 'retained', bytes: Buffer.from(bytes) });
});
it.each(['chunked', 'length', 'encoding', 'http', 'wrong-hash'])('returns bounded retry details for %s', async (failure) => {
  const url = await http((_req, res) => {
    if (failure === 'encoding') res.setHeader('content-encoding', 'gzip');
    if (failure === 'http') res.statusCode = 503;
    if (failure === 'length') res.setHeader('content-length', '9000');
    if (failure === 'chunked' || failure === 'length') { res.write(Buffer.alloc(5000)); res.end(Buffer.alloc(1200)); } else res.end(bytes);
  });
  const result = await fetchFeedbackDocument(url, failure === 'wrong-hash' ? hash(999) : digest);
  expect(result).toMatchObject({ kind: 'retry', reason: { chunked: 'body-too-large', length: 'body-too-large', encoding: 'content-encoding', http: 'http-status', 'wrong-hash': 'hash-mismatch' }[failure] });
  if (failure === 'wrong-hash') expect(result).toMatchObject({ actualHash: digest, actualSize: String(bytes.length) });
});
it('never hits redirect destinations and aborts a hanging body after headers', async () => {
  let hits = 0; const target = await http((_req, res) => { hits++; res.end(bytes); });
  const redirect = await http((_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  expect(await fetchFeedbackDocument(redirect, digest)).toMatchObject({ kind: 'retry' }); expect(hits).toBe(0);
  const hang = await http((_req, res) => { res.writeHead(200); res.write(bytes.slice(0, 1)); });
  const start = Date.now(); expect(await fetchFeedbackDocument(hang, digest)).toMatchObject({ kind: 'retry', reason: 'fetch-timeout' });
  expect(Date.now() - start).toBeLessThan(6500);
}, 9000);
it('does no HTTP for unlisted exact path/query or noncanonical spelling, then accepts a current allowlist update', async () => {
  let hits = 0; const base = await http((_req, res) => { hits++; res.end(bytes); });
  const c = fresh(); const uri = `${base}a%2Fb?q=1`; const raw = log(c, { uri, bytes }); await seed(c, [raw]);
  let now = new Date(Date.now() + 1000); const clock = () => now;
  c.documentUrls = [`${base}a/b?q=1`, `${base}a%2Fb?q=2`]; await sweepFeedbackDocuments(c, undefined, clock);
  expect(hits).toBe(0); expect((await q.readFeedbackEvent(feedbackEventId(feedbackSourceFromConfig(c), raw)))!.document.job)
    .toMatchObject({ state: 'pending', reason: 'url-not-allowed', attempts: '1' });
  now = new Date(now.getTime() + 1001); c.documentUrls = [uri]; await sweepFeedbackDocuments(c, undefined, clock);
  expect(hits).toBe(1); expect((await q.readFeedbackDocument(digest))!.bytes).toEqual(Buffer.from(bytes));
});
it('retries wrong bytes after correction without a new block and also acquires during RPC outage/orphaning', async () => {
  let correct = false; const uri = await http((_req, res) => res.end(correct ? bytes : Buffer.from([5])));
  const c = fresh(); c.documentUrls = [uri]; const raw = log(c, { uri, bytes }); await seed(c, [raw]);
  let now = new Date(Date.now() + 1000); const clock = () => now;
  await sweepFeedbackDocuments(c, undefined, clock); expect(await q.readFeedbackDocument(digest)).toBeNull();
  const reader: FeedbackReader = { async assertNetwork() { throw new Error('offline'); }, async block() { return block(); },
    async finalized() { return null; }, async assertRegistry() {}, async logs() { return []; } };
  await expect(syncFeedbackOnce(c, reader)).rejects.toThrow();
  const before = await q.readFeedbackCoverage(feedbackSourceFromConfig(c));
  await q.withdrawFeedbackSource({ source: feedbackSourceFromConfig(c), expectedVersion: before.stateVersion, expectedCheckpoint: block(),
    conflict: { previous: block(), replacement: block('10', hash(999)) } });
  correct = true; now = new Date(now.getTime() + 1001); await sweepFeedbackDocuments(c, undefined, clock);
  expect((await q.readFeedbackEvent(feedbackEventId(feedbackSourceFromConfig(c), raw)))!).toMatchObject({ canonicality: 'orphaned', document: { availability: 'retained' } });
});
it('does not starve older eligible jobs behind four denied jobs and never claims more than four', async () => {
  let hits = 0; const uri = await http((_req, res) => { hits++; res.end(bytes); }); const c = fresh(); c.documentUrls = [uri];
  const s = feedbackSourceFromConfig(c);
  const raws = Array.from({ length: 5 }, (_, i) => log(c, { index: String(i), uri: `${uri}${i}`, bytes: new Uint8Array([i]) }));
  // Event ID depends on provenance, not URI/digest: put the eligible job last in the real FIFO tiebreak order.
  raws.sort((a, b) => feedbackEventId(s, a).localeCompare(feedbackEventId(s, b)));
  raws[4] = log(c, { index: raws[4]!.logIndex, uri, bytes });
  await seed(c, raws); const now = new Date(Date.now() + 1000); const clock = () => now;
  await sweepFeedbackDocuments(c, undefined, clock); expect(hits).toBe(0);
  expect((await q.readFeedbackEvent(feedbackEventId(s, raws[4]!)))!.document.job!.attempts).toBe('0');
  await sweepFeedbackDocuments(c, undefined, clock);
  expect(hits).toBe(1);
  expect((await q.readFeedbackCoverage(feedbackSourceFromConfig(c))).retention).toEqual({ retained: '1', pending: '4', blocked: '0' });
});
it('bounds actual HTTP fanout at four and waits for all finishes before returning', async () => {
  let active = 0; let maximum = 0; let hits = 0;
  const uri = await http((_req, res) => { hits++; active++; maximum = Math.max(maximum, active);
    setTimeout(() => { active--; res.end(bytes); }, 40); });
  const c = fresh(); c.documentUrls = [uri]; await seed(c, Array.from({ length: 5 }, (_, i) => log(c, { index: String(i), uri, bytes })));
  await sweepFeedbackDocuments(c);
  expect(hits).toBe(4); expect(maximum).toBe(4); expect(active).toBe(0);
  const coverage = await q.readFeedbackCoverage(feedbackSourceFromConfig(c));
  const page = await q.readFeedbackHistory({ sourceId: coverage.sourceId, agentId: '7', view: 'all-retained', pageSize: 20 });
  expect(page.records.filter((r) => r.document.job!.state === 'retained')).toHaveLength(4);
  await sweepFeedbackDocuments(c); expect(hits).toBe(4); // the fifth association reuses the blob
});
it('uses a shared verified blob before allowlisting and never fetches zero-hash or response documents', async () => {
  let hits = 0; const uri = await http((_req, res) => { hits++; res.end(bytes); });
  const a = fresh(); const b = fresh(); a.documentUrls = [uri];
  await seed(a, [log(a, { uri, bytes })]); await seed(b, [log(b, { uri: `${uri}denied`, bytes }),
    log(b, { index: '1', uri, digest: hash(0) }), log(b, { index: '2', kind: 'ResponseAppended' })]);
  await sweepFeedbackDocuments(a); await sweepFeedbackDocuments(b);
  expect(hits).toBe(1); expect((await q.readFeedbackCoverage(feedbackSourceFromConfig(b))).retention).toEqual({ retained: '1', pending: '0', blocked: '1' });
});
it('leaves shutdown-aborted claims leased for expiry, then a restarted sweep can reclaim', async () => {
  let enter!: () => void; const entered = new Promise<void>((r) => { enter = r; }); let hang = true;
  const uri = await http((_req, res) => { if (hang) { res.writeHead(200); res.write('x'); enter(); } else res.end(bytes); });
  const c = fresh(); c.documentUrls = [uri]; const raw = log(c, { uri, bytes }); await seed(c, [raw]);
  const controller = new AbortController(); const work = sweepFeedbackDocuments(c, controller.signal); await entered; controller.abort(); await work;
  const job = (await q.readFeedbackEvent(feedbackEventId(feedbackSourceFromConfig(c), raw)))!.document.job!;
  expect(job).toMatchObject({ state: 'pending', jobVersion: '1', reason: null }); expect(job.leaseExpiresAt).not.toBeNull();
  hang = false; await sweepFeedbackDocuments(c, undefined, () => new Date(Date.parse(job.leaseExpiresAt!) + 1));
  expect((await q.readFeedbackDocument(digest))!.bytes).toEqual(Buffer.from(bytes));
});
