import Fastify from 'fastify';
import { createServer } from 'node:http';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { buildConfig } from '../../src/config/index.js';
import { registerDb } from '../../src/plugins/db.js';
import { registerOriginArchive } from '../../src/plugins/originArchive.js';
import { closeSql } from '../../src/db/client.js';
import { originArchiveSourceId } from '../../src/connectors/originArchive/config.js';
import { readOriginArchiveSnapshotStatus } from '../../src/db/queries/originArchive.js';
import { cleanupOriginArchive, digestBytes, originConfig, originSnapshotBytes } from '../fixtures/originArchive.js';

const sources: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await cleanupOriginArchive(sources.splice(0)); });
afterAll(closeSql);

it('creates no worker or durable source when disabled', async () => {
  vi.stubEnv('ORIGIN_ARCHIVE_CONFIG', '');
  expect(buildConfig().originArchive).toBeNull();
  const app = Fastify({ logger: false }); await registerDb(app); await registerOriginArchive(app, null);
  await app.ready(); expect(app.stopOriginArchive).toBeUndefined(); await app.close();
});

it('wires only the explicit origin archive configuration', () => {
  const config = originConfig(); vi.stubEnv('ORIGIN_ARCHIVE_CONFIG', JSON.stringify(config));
  vi.stubEnv('ERC8004_IDENTITY_CONFIG', ''); vi.stubEnv('ERC8004_FEEDBACK_CONFIG', ''); vi.stubEnv('API_BASE_URL', '');
  expect(buildConfig()).toMatchObject({ originArchive: config, identityFollower: null, feedbackFollower: null });
});

it('seeds on ready, aborts and awaits a hanging body, and leaves the committed lease recoverable', async () => {
  const snapshot = originSnapshotBytes(); let entered!: () => void; let disconnected!: () => void;
  const bodyStarted = new Promise<void>((resolve) => { entered = resolve; });
  const bodyClosed = new Promise<void>((resolve) => { disconnected = resolve; });
  const source = createServer((_req, res) => { res.on('close', disconnected); res.writeHead(200); res.write('x'); entered(); });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const port = (source.address() as { port: number }).port;
  const config = originConfig({ sourceBaseUrl: `http://127.0.0.1:${port}/public-origin/`, snapshotDigests: [digestBytes(snapshot)] });
  const sourceId = originArchiveSourceId(config); sources.push(sourceId);
  const app = Fastify({ logger: false }); await registerDb(app); await registerOriginArchive(app, config);
  try {
    await app.ready(); await bodyStarted;
    await app.close(); await bodyClosed; await app.stopOriginArchive!();
    expect(await readOriginArchiveSnapshotStatus(digestBytes(snapshot))).toMatchObject({
      acquisition: { state: 'pending', sources: [{ job: { attempts: '1', state: 'pending', leaseExpiresAt: expect.any(String) } }] },
      shape: { status: 'unavailable' },
    });
  } finally {
    await app.close(); source.closeAllConnections(); await new Promise<void>((resolve) => source.close(() => resolve()));
  }
});
