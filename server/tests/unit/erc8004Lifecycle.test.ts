import Fastify from 'fastify';
import { afterAll, expect, it } from 'vitest';
import { registerDb } from '../../src/plugins/db.js';
import { registerIdentityFollower } from '../../src/plugins/identityFollower.js';
import { getSql, closeSql } from '../../src/db/client.js';
import type { IdentityFollowerConfig } from '../../src/connectors/erc8004/config.js';
import type { IdentityChainReader } from '../../src/connectors/erc8004/follower.js';

const config: IdentityFollowerConfig = { rpcUrl: 'http://127.0.0.1:8545', pollMs: 2000,
  maxBlockSpan: 200, chainId: 31337, registry: `0x${'d2'.repeat(20)}`,
  genesisHash: `0x${'aa'.repeat(32)}`, startBlock: '1', adapter: 'nandacity-0.1', confirmations: 0 };
afterAll(async () => { const sql = getSql();
  await sql`DELETE FROM identity_sources WHERE source_id = ${`erc8004-identity:31337:${config.registry}`}`;
  await closeSql(); });

it('starts no worker when disabled and awaits its enabled cancellation before the DB pool closes', async () => {
  const disabled = Fastify({ logger: false });
  await registerDb(disabled);
  await registerIdentityFollower(disabled, null, () => { throw new Error('disabled reader created'); });
  await disabled.ready();
  await disabled.close();

  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let sawOpenPool = false;
  const reader: IdentityChainReader = {
    async assertNetwork(signal) {
      entered();
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      const [{ alive }] = await getSql()<[{ alive: number }]>`SELECT 1 AS alive`;
      sawOpenPool = alive === 1;
      throw new Error('IDENTITY_TICK_ABORTED');
    },
    async block() { throw new Error('unexpected block'); },
    async finalized() { return null; },
    async changedAgents() { return []; },
    async identity() { return 'missing'; },
  };
  const enabled = Fastify({ logger: false });
  await registerDb(enabled);
  await registerIdentityFollower(enabled, config, () => reader);
  await enabled.ready();
  await started;
  await enabled.close();
  expect(sawOpenPool).toBe(true);
});
