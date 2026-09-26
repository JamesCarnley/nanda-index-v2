import Fastify from 'fastify';
import { createServer } from 'node:http';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { registerDb } from '../../src/plugins/db.js';
import { registerFeedbackFollower } from '../../src/plugins/feedbackFollower.js';
import { closeSql, getSql } from '../../src/db/client.js';
import { buildConfig } from '../../src/config/index.js';
import * as q from '../../src/db/queries/feedbackObservations.js';
import type { FeedbackReader } from '../../src/connectors/erc8004/feedbackRpc.js';
import { feedbackSourceFromConfig, type FeedbackFollowerConfig } from '../../src/connectors/erc8004/feedbackConfig.js';
import { block, cleanupSources, config, log } from '../fixtures/feedback.js';
const owned: FeedbackFollowerConfig[] = [];
const fresh = () => { const c = config(); owned.push(c); return c; };
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await cleanupSources(owned.map(feedbackSourceFromConfig)); owned.length = 0; });
afterAll(closeSql);
it('creates no worker or source when disabled', async () => {
  vi.stubEnv('ERC8004_FEEDBACK_CONFIG', ''); expect(buildConfig().feedbackFollower).toBeNull();
  const app = Fastify({ logger: false }); await registerDb(app);
  await registerFeedbackFollower(app, null, () => { throw new Error('disabled reader created'); });
  await app.ready(); expect(app.stopFeedbackFollower).toBeUndefined(); await app.close();
});
it('wires only its explicit configuration with no identity or API base requirement', () => {
  const c = fresh(); vi.stubEnv('ERC8004_FEEDBACK_CONFIG', JSON.stringify(c)); vi.stubEnv('ERC8004_IDENTITY_CONFIG', ''); vi.stubEnv('API_BASE_URL', '');
  expect(buildConfig()).toMatchObject({ feedbackFollower: c, identityFollower: null });
});
it('starts scan and acquisition independently; aborts and awaits both DB paths before pool close, with idempotent stop', async () => {
  const c = fresh(); const bytes = new Uint8Array([99, 17, 0, 255]);
  const server = createServer((_req, res) => res.end(bytes));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const uri = `http://127.0.0.1:${(server.address() as { port: number }).port}/`; c.documentUrls = [uri];
  await q.applyFeedbackBatch({ source: feedbackSourceFromConfig(c), expectedVersion: '0', expectedCheckpoint: null,
    through: block(), observedHead: block(), finalizedBlock: null, logs: [log(c, { uri, bytes })] });
  const sql = getSql(); let scanEntered!: () => void; let finishEntered!: () => void; let releaseFinish!: () => void;
  const scanStarted = new Promise<void>((r) => { scanEntered = r; }); const finishStarted = new Promise<void>((r) => { finishEntered = r; });
  const resumed = new Promise<void>((r) => { releaseFinish = r; }); let scanAlive = false; let finishAlive = false; let scans = 0;
  const originalFinish = q.finishFeedbackJob;
  vi.spyOn(q, 'finishFeedbackJob').mockImplementation(async (input) => { finishEntered(); await resumed;
    finishAlive = (await sql`SELECT 1 AS alive`)[0]!.alive === 1; return originalFinish(input); });
  const reader: FeedbackReader = {
    async assertNetwork(signal) { scans++; scanEntered(); await new Promise<void>((r) => signal!.addEventListener('abort', () => r(), { once: true }));
      scanAlive = (await sql`SELECT 1 AS alive`)[0]!.alive === 1; releaseFinish(); throw new Error('aborted'); },
    async block() { return block(); }, async finalized() { return null; }, async assertRegistry() {}, async logs() { return []; },
  };
  const app = Fastify({ logger: false }); await registerDb(app); await registerFeedbackFollower(app, c, () => reader);
  try {
    await app.ready(); await Promise.all([scanStarted, finishStarted]); // acquisition reached its DB finish while scan is still hung
    await new Promise((r) => setTimeout(r, 150)); expect(scans).toBe(1);
    await app.close(); await app.stopFeedbackFollower!();
    expect(scanAlive).toBe(true); expect(finishAlive).toBe(true);
    expect(await q.readFeedbackCoverage(feedbackSourceFromConfig(c))).toMatchObject({ availability: 'unavailable', retention: { retained: '1' } });
  } finally { releaseFinish(); await app.close(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
it('cancels a real acquisition body as well as a hanging scan and leaves the durable lease recoverable', async () => {
  const c = fresh(); let entered!: () => void; const bodyStarted = new Promise<void>((r) => { entered = r; });
  let disconnected!: () => void; const bodyClosed = new Promise<void>((r) => { disconnected = r; });
  const server = createServer((_req, res) => { res.on('close', disconnected); res.writeHead(200); res.write('x'); entered(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const uri = `http://127.0.0.1:${(server.address() as { port: number }).port}/`; c.documentUrls = [uri];
  await q.applyFeedbackBatch({ source: feedbackSourceFromConfig(c), expectedVersion: '0', expectedCheckpoint: null,
    through: block(), observedHead: block(), finalizedBlock: null, logs: [log(c, { uri })] });
  let scans = 0;
  const reader: FeedbackReader = { async assertNetwork(signal) { scans++; await new Promise<void>((r) => signal!.addEventListener('abort', () => r(), { once: true })); throw new Error('aborted'); },
    async block() { return block(); }, async finalized() { return null; }, async assertRegistry() {}, async logs() { return []; } };
  const app = Fastify({ logger: false }); await registerDb(app); await registerFeedbackFollower(app, c, () => reader);
  try { await app.ready(); await bodyStarted; await new Promise((r) => setTimeout(r, 150)); expect(scans).toBe(1);
    await app.close(); await bodyClosed;
    const coverage = await q.readFeedbackCoverage(feedbackSourceFromConfig(c));
    const page = await q.readFeedbackHistory({ sourceId: coverage.sourceId, agentId: '7', view: 'all-retained', pageSize: 20 });
    expect(page.records[0]!.document.job).toMatchObject({ state: 'pending', attempts: '1', reason: null, leaseExpiresAt: expect.any(String) });
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
