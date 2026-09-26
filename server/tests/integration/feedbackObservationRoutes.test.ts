import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { buildServer } from '../../src/server.js';
import { closeSql, getSql } from '../../src/db/client.js';
import * as client from '../../src/db/client.js';
import * as q from '../../src/db/queries/feedbackObservations.js';
import { feedbackEventId, feedbackSourceId } from '../../src/connectors/erc8004/feedbackValidation.js';
import type { FeedbackSource } from '../../src/connectors/erc8004/feedbackTypes.js';
import { block, cleanupSources, hash, log, source } from '../fixtures/feedback.js';
const owned: FeedbackSource[] = []; let fastify: FastifyInstance;
const root = '/api/ard/feedback';
const bytes = new Uint8Array([90, 67, 0, 255]); const digest = keccak256(bytes);
async function seed() {
  const s = source(); owned.push(s); const raws = [log(s, { bytes }), log(s, { index: '1', kind: 'FeedbackRevoked' }), log(s, { index: '2', kind: 'ResponseAppended' })];
  await q.applyFeedbackBatch({ source: s, expectedVersion: '0', expectedCheckpoint: null, through: block(), observedHead: block(), finalizedBlock: null, logs: raws });
  return { s, raws, id: feedbackSourceId(s), eventId: feedbackEventId(s, raws[0]!) };
}
beforeAll(async () => { fastify = (await buildServer({ logger: false })).fastify; await fastify.ready(); });
afterEach(async () => { vi.restoreAllMocks(); await cleanupSources(owned); owned.length = 0; });
afterAll(async () => { await fastify.close(); await closeSql(); });
it('serves source, history, exact raw event and opaque binary shapes while workers are disabled', async () => {
  const f = await seed(); const now = new Date(Date.now() + 1000).toISOString();
  const [job] = await q.claimDueFeedbackJobs({ sourceId: f.id, limit: 4, now, leaseMs: 30000 });
  await q.finishFeedbackJob({ eventId: job!.eventId, expectedJobVersion: job!.jobVersion, now, outcome: { kind: 'retained', bytes } });
  const sourceResponse = await fastify.inject(`${root}/sources/${f.id}`);
  expect(sourceResponse.statusCode).toBe(200); expect(sourceResponse.headers['cache-control']).toBe('no-store');
  expect(sourceResponse.json()).toMatchObject({ coverage: { sourceId: f.id }, retention: { scope: 'canonical-prefix', newFeedbackEvents: '1', retained: '1', pending: '0', blocked: '0' }, semantics: 'not-evaluated' });
  const page = await fastify.inject(`${root}/sources/${f.id}/agents/7`);
  expect(page.json()).toMatchObject({ view: 'canonical-prefix', basis: { through: block() }, items: expect.any(Array), canonicalityBasis: 'current-coverage', semantics: 'not-evaluated' });
  expect(page.json().items).toHaveLength(3);
  const event = await fastify.inject(`${root}/events/${f.eventId}`);
  expect(event.json()).toMatchObject({ coverage: { stateVersion: '1' }, item: { raw: f.raws[0], document: { availability: 'retained' } }, semantics: 'not-evaluated' });
  expect(event.headers['cache-control']).toBe('no-store');
  const blob = await fastify.inject(`${root}/documents/${digest}`);
  expect(blob.rawPayload).toEqual(Buffer.from(bytes)); expect(blob.headers['content-type']).toBe('application/octet-stream');
  expect(blob.headers['x-content-type-options']).toBe('nosniff'); expect(blob.headers['content-length']).toBe('4');
});
it('distinguishes unknown source from a known empty uint256 subject with no network or mutations on GET', async () => {
  const f = await seed(); const before = await q.readFeedbackSource(f.id);
  const noFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('GET fetched'); });
  const huge = (2n ** 256n - 1n).toString(); const empty = await fastify.inject(`${root}/sources/${f.id}/agents/${huge}`);
  expect(empty.statusCode).toBe(200); expect(empty.json()).toMatchObject({ coverage: { sourceId: f.id }, items: [] });
  for (const suffix of [`sources/sha256:${'a'.repeat(64)}`, `sources/sha256:${'a'.repeat(64)}/agents/7`, `events/sha256:${'b'.repeat(64)}`, `documents/${hash(987654)}`]) {
    const response = await fastify.inject(`${root}/${suffix}`); expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'NOT_FOUND' }); expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(noFetch).not.toHaveBeenCalled(); expect(await q.readFeedbackSource(f.id)).toEqual(before);
});
it.each(['?extra=1', '?pageSize=0', '?pageSize=101', '?pageSize=01', '?pageSize=2&pageSize=3', '?view=active', '?reviewer=bad', '?cursor=%25', `?cursor=${'a'.repeat(4097)}`])('rejects invalid and extra history query %s', async (query) => {
  const f = await seed(); const response = await fastify.inject(`${root}/sources/${f.id}/agents/7${query}`);
  expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: 'INVALID_INPUT' }); expect(response.headers['cache-control']).toBe('no-store');
});
it('validates IDs and rejects all extra query keys on other reads', async () => {
  const f = await seed(); for (const suffix of ['sources/bad', `sources/${f.id}/agents/07`, `sources/${f.id}/agents/${'9'.repeat(79)}`,
    'events/bad', 'documents/bad', `sources/${f.id}?x=1`, `events/${f.eventId}?view=x`, `documents/${digest}?x=1`]) {
    expect((await fastify.inject(`${root}/${suffix}`)).statusCode).toBe(400);
  }
});
it('keeps a continuation basis across heartbeat/append, but returns a stale generation distinctly', async () => {
  const f = await seed(); const url = `${root}/sources/${f.id}/agents/7?pageSize=1`;
  const first = (await fastify.inject(url)).json();
  await q.refreshFeedbackCoverage({ source: f.s, expectedVersion: '1', observedHead: block('11'), finalizedBlock: null });
  await q.applyFeedbackBatch({ source: f.s, expectedVersion: '2', expectedCheckpoint: block(), through: block('11'), observedHead: block('11'), finalizedBlock: null,
    logs: [log(f.s, { block: block('11') })] });
  const second = (await fastify.inject(`${url}&cursor=${first.nextCursor}`)).json();
  expect(second.basis).toEqual(first.basis); expect(second.coverage.checkpoint).toEqual(block('11'));
  await q.withdrawFeedbackSource({ source: f.s, expectedVersion: '3', expectedCheckpoint: block('11') });
  const stale = await fastify.inject(`${url}&cursor=${second.nextCursor}`);
  expect(stale.statusCode).toBe(409); expect(stale.json()).toEqual({ error: 'STALE_FEEDBACK_CURSOR' });
});
it('distinguishes an unknown initial source from a well-formed but unavailable continuation scope', async () => {
  const f = await seed(); const first = (await fastify.inject(`${root}/sources/${f.id}/agents/7?pageSize=1`)).json();
  const unknown = `sha256:${'c'.repeat(64)}`; const url = `${root}/sources/${unknown}/agents/7?pageSize=1`;
  expect((await fastify.inject(url)).statusCode).toBe(404);
  // Continuations are client-tamperable event-selection scope, not authenticated source observations.
  const cursor = JSON.parse(Buffer.from(first.nextCursor as string, 'base64url').toString('utf8')) as Record<string, unknown>;
  cursor.sourceId = unknown;
  const unavailable = await fastify.inject(`${url}&cursor=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`);
  expect(unavailable.statusCode).toBe(409); expect(unavailable.json()).toEqual({ error: 'STALE_FEEDBACK_CURSOR' });
  expect(unavailable.headers['cache-control']).toBe('no-store');
  expect((await fastify.inject(`${url}&cursor=${first.nextCursor}`)).statusCode).toBe(400); // filter mismatch, not an unknown generation
});
it('never pairs pre-withdrawal event membership with post-withdrawal source coverage', async () => {
  const f = await seed(); const sql = getSql(); let first = true; let entered!: () => void; let release!: () => void;
  const paused = new Promise<void>((r) => { entered = r; }); const resumed = new Promise<void>((r) => { release = r; });
  const spy = vi.spyOn(client, 'getSql').mockReturnValue(new Proxy(sql, { get(target, key, receiver) {
    if (key !== 'begin') return Reflect.get(target, key, receiver);
    return (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('read only')) {
        const callback = args[1] as (tx: postgres.TransactionSql) => Promise<unknown>;
        args[1] = (tx: postgres.TransactionSql) => callback(new Proxy(tx, { apply(query, thisArg, values) {
          const pending = Reflect.apply(query, thisArg, values) as Promise<unknown>; if (!first) return pending; first = false;
          return Promise.resolve(pending).then(async (rows) => { entered(); await resumed; return rows; });
        } }));
      }
      return Reflect.apply(target.begin, target, args);
    };
  } }));
  try {
    const response = Promise.resolve(fastify.inject(`${root}/events/${f.eventId}`)); await paused;
    await q.withdrawFeedbackSource({ source: f.s, expectedVersion: '1', expectedCheckpoint: block() }); release();
    expect((await response).json()).toMatchObject({ coverage: { generation: '0', checkpoint: block() }, item: { canonicality: 'canonical' } });
  } finally { release(); spy.mockRestore(); }
  expect((await fastify.inject(`${root}/events/${f.eventId}`)).json()).toMatchObject({ coverage: { generation: '1', checkpoint: null }, item: { canonicality: 'withdrawn' } });
});
it('returns no bytes and a distinct integrity error for a corrupt retained digest', async () => {
  const f = await seed(); const now = new Date(Date.now() + 1000).toISOString(); const [job] = await q.claimDueFeedbackJobs({ sourceId: f.id, limit: 4, now, leaseMs: 30000 });
  await q.finishFeedbackJob({ eventId: job!.eventId, expectedJobVersion: job!.jobVersion, now, outcome: { kind: 'retained', bytes } });
  await getSql()`UPDATE feedback_documents SET bytes = ${Buffer.from([1, 2, 3, 4])} WHERE document_hash = ${digest}`;
  const response = await fastify.inject(`${root}/documents/${digest}`);
  expect(response.statusCode).toBe(500); expect(response.json()).toEqual({ error: 'FEEDBACK_DOCUMENT_INTEGRITY' });
  expect(response.headers['cache-control']).toBe('no-store');
});
