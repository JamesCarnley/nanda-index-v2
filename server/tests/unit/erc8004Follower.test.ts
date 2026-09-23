import { afterAll, beforeEach, expect, it } from 'vitest';
import { closeSql, getSql } from '../../src/db/client.js';
import { readIdentityCoverage, readLatestIdentity } from '../../src/db/queries/identityObservations.js';
import { syncIdentityOnce, type IdentityChainReader } from '../../src/connectors/erc8004/follower.js';
import { identitySourceFromConfig, type IdentityFollowerConfig } from '../../src/connectors/erc8004/config.js';
import { dataUriFor, originalRegistration, originalOwner } from '../fixtures/cityProfile.js';

const registry = `0x${'d1'.repeat(20)}` as `0x${string}`;
const hashes = ['aa', 'bb', 'cc', 'dd', 'ee'].map((part) => `0x${part.repeat(32)}` as `0x${string}`);
const at = (n: number) => ({ number: String(n), hash: hashes[n]!, timestamp: 1700000000 + n });
const config: IdentityFollowerConfig = { chainId: 11155111, registry, genesisHash: hashes[0]!,
  startBlock: '1', adapter: 'nandacity-0.1', confirmations: 0,
  rpcUrl: 'http://127.0.0.1:8545', pollMs: 2000, maxBlockSpan: 2 };
const agent = { chainId: config.chainId, registry, agentId: '7' };
let head = 3;
let changed = ['7'];
let fail = false;
let mutateCheckpointDuringRead = false;
function fakeReader(): IdentityChainReader {
  return {
    async assertNetwork() {},
    async block(tag) { return tag === 'latest' ? at(head) : at(Number(tag)); },
    async finalized() { return null; },
    async changedAgents() { if (fail) throw new Error('RPC_OUTAGE'); return changed; },
    async identity(id, block) {
      if (mutateCheckpointDuringRead) hashes[2] = `0x${'fa'.repeat(32)}`;
      return { agent: { ...agent, agentId: id }, block, owner: originalOwner,
        agentURI: dataUriFor({ ...originalRegistration, registrations: [{ agentId: 7,
          agentRegistry: `eip155:11155111:${registry}` }] }), };
    },
  };
}
async function cleanup() {
  const sql = getSql();
  const id = `erc8004-identity:${config.chainId}:${registry}`;
  await sql`DELETE FROM service_projections WHERE source_id = ${id}`;
  await sql`DELETE FROM identity_latest WHERE source_id = ${id}`;
  await sql`DELETE FROM identity_observations WHERE source_id = ${id}`;
  await sql`DELETE FROM identity_sources WHERE source_id = ${id}`;
}
beforeEach(async () => { await cleanup(); head = 3; changed = ['7']; fail = false;
  mutateCheckpointDuringRead = false; hashes[2] = `0x${'cc'.repeat(32)}`;
  hashes[3] = `0x${'dd'.repeat(32)}`; });
afterAll(async () => { await cleanup(); await closeSql(); });

it('commits bounded ranges including no-change blocks and keeps a durable checkpoint', async () => {
  const reader = fakeReader();
  expect(await syncIdentityOnce(config, reader)).toMatchObject({ checkpoint: at(2), progress: 'lagging' });
  expect((await readLatestIdentity(agent))?.qualification).toBe('eligible');
  changed = [];
  expect(await syncIdentityOnce(config, reader)).toMatchObject({ checkpoint: at(3), progress: 'synchronized' });
  expect((await readIdentityCoverage(identitySourceFromConfig(config))).stateVersion).toBe('2');
});

it('marks an RPC outage unavailable without moving the successful checkpoint, then retries', async () => {
  const reader = fakeReader();
  await syncIdentityOnce(config, reader);
  fail = true;
  await expect(syncIdentityOnce(config, reader)).rejects.toThrow('RPC_OUTAGE');
  expect(await readIdentityCoverage(identitySourceFromConfig(config)))
    .toMatchObject({ availability: 'unavailable', checkpoint: at(2) });
  fail = false; changed = [];
  expect(await syncIdentityOnce(config, reader)).toMatchObject({ availability: 'available', checkpoint: at(3) });
});

it('withdraws a saved checkpoint after a local reorganization', async () => {
  const reader = fakeReader();
  await syncIdentityOnce(config, reader);
  hashes[2] = `0x${'fe'.repeat(32)}`;
  expect(await syncIdentityOnce(config, reader)).toMatchObject({ checkpoint: null, progress: 'rebuilding' });
  expect(await readLatestIdentity(agent)).toBeNull();
});

it('withdraws when the prior checkpoint changes during the same tick', async () => {
  const reader = fakeReader();
  await syncIdentityOnce(config, reader);
  mutateCheckpointDuringRead = true;
  expect(await syncIdentityOnce(config, reader)).toMatchObject({ checkpoint: null, progress: 'rebuilding' });
});

it('does not commit a target below head when the chain changes after its logs are read', async () => {
  const base = fakeReader();
  const reader = { ...base, async changedAgents() {
    hashes[2] = `0x${'fa'.repeat(32)}`;
    return [];
  } };
  expect(await syncIdentityOnce(config, reader)).toMatchObject({ checkpoint: null, progress: 'rebuilding' });
  expect(await readLatestIdentity(agent)).toBeNull();
});

it('refuses a genesis reset after log reads, before a null-cursor commit', async () => {
  const base = fakeReader();
  let checks = 0;
  const reader = { ...base, async assertNetwork() {
    checks++;
    if (checks === 2) throw new Error('IDENTITY_NETWORK_MISMATCH');
  } };
  await expect(syncIdentityOnce(config, reader)).rejects.toThrow('IDENTITY_NETWORK_MISMATCH');
  expect(checks).toBe(2);
  expect(await readIdentityCoverage(identitySourceFromConfig(config)))
    .toMatchObject({ availability: 'unavailable', checkpoint: null });
  expect(await readLatestIdentity(agent)).toBeNull();
});

it('reduces an over-budget range and advances only the bounded prefix', async () => {
  const calls: string[] = [];
  const reader = { ...fakeReader(), async changedAgents(_from: string, to: string) {
    calls.push(to);
    if (to !== '1') throw new Error('IDENTITY_WORK_BUDGET');
    return [];
  } };
  expect(await syncIdentityOnce(config, reader)).toMatchObject({ checkpoint: at(1), progress: 'lagging' });
  expect(calls).toEqual(['2', '1']);
});

it('does not advance an over-budget single block', async () => {
  const reader = { ...fakeReader(), async changedAgents() {
    throw new Error('IDENTITY_WORK_BUDGET');
  } };
  await expect(syncIdentityOnce(config, reader)).rejects.toThrow('IDENTITY_WORK_BUDGET');
  expect(await readIdentityCoverage(identitySourceFromConfig(config)))
    .toMatchObject({ availability: 'unavailable', checkpoint: null });
});

it('deduplicates out-of-order composite changes before committing observations', async () => {
  const base = fakeReader();
  const reader = { ...base, async changedAgents() { return ['8', '7', '8', '7']; },
    async identity(id: string, atBlock: ReturnType<typeof at>) {
      const profile = await base.identity(id, atBlock);
      if (profile === 'missing') return profile;
      return { ...profile, agentURI: dataUriFor({ ...originalRegistration,
        registrations: [{ agentId: Number(id), agentRegistry: `eip155:11155111:${registry}` }] }) };
    } };
  await syncIdentityOnce(config, reader);
  expect((await readLatestIdentity({ ...agent, agentId: '8' }))?.qualification).toBe('eligible');
  expect((await readIdentityCoverage(identitySourceFromConfig(config))).checkpoint).toEqual(at(2));
});

it('keeps a valid subject when another URI would exceed the serialized observation budget', async () => {
  const base = fakeReader();
  const reader = { ...base, async changedAgents() { return ['7', '8']; },
    async identity(id: string, atBlock: ReturnType<typeof at>) {
      const profile = await base.identity(id, atBlock);
      if (profile === 'missing') return profile;
      return id === '7' ? { ...profile, agentURI: '"'.repeat(40_000) } :
        { ...profile, agentURI: dataUriFor({ ...originalRegistration,
          registrations: [{ agentId: 8, agentRegistry: `eip155:11155111:${registry}` }] }) };
    } };
  await syncIdentityOnce(config, reader);
  expect(await readLatestIdentity(agent)).toMatchObject({ qualification: 'unsupported',
    reason: 'UNSUPPORTED_URI', agentURI: null, agentUriByteLength: 40_000 });
  expect((await readLatestIdentity({ ...agent, agentId: '8' }))?.qualification).toBe('eligible');
});

it('refreshes coverage without a cursor when confirmation depth exceeds the head', async () => {
  const result = await syncIdentityOnce({ ...config, confirmations: 5 }, fakeReader());
  expect(result).toMatchObject({ checkpoint: null, observedHead: at(3), progress: 'initializing' });
});

it('does not publish a stale head when it reorgs during a coverage-only refresh', async () => {
  const base = fakeReader();
  const oldHead = at(3);
  const reader = { ...base, async finalized() {
    hashes[3] = `0x${'fa'.repeat(32)}`;
    return null;
  } };
  expect(await syncIdentityOnce({ ...config, confirmations: 5 }, reader))
    .toMatchObject({ checkpoint: null, observedHead: null, progress: 'rebuilding' });
  expect(oldHead.hash).not.toBe(hashes[3]);
});

it('records a deterministic missing token but does not turn transport failures into missing', async () => {
  const base = fakeReader();
  await syncIdentityOnce(config, { ...base, async identity() { return 'missing'; } });
  expect((await readLatestIdentity(agent))?.qualification).toBe('missing');
  head = 4;
  await expect(syncIdentityOnce(config, { ...base, async identity() {
    throw new Error('RPC_TRANSPORT_FAILURE');
  } })).rejects.toThrow('RPC_TRANSPORT_FAILURE');
  expect(await readIdentityCoverage(identitySourceFromConfig(config)))
    .toMatchObject({ availability: 'unavailable', checkpoint: at(2) });
  expect((await readLatestIdentity(agent))?.qualification).toBe('missing');
});

it('does not commit after cancellation during the read path', async () => {
  const abort = new AbortController();
  const reader = { ...fakeReader(), async changedAgents(_from: string, _to: string, signal?: AbortSignal) {
    abort.abort(new Error('IDENTITY_TICK_ABORTED'));
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    return ['7'];
  } };
  await expect(syncIdentityOnce(config, reader, abort.signal)).rejects.toThrow('IDENTITY_TICK_ABORTED');
  expect((await readIdentityCoverage(identitySourceFromConfig(config))).checkpoint).toBeNull();
  expect(await readLatestIdentity(agent)).toBeNull();
});

it('cancels and awaits sibling reads before reporting the first subject failure', async () => {
  const started: string[] = [];
  let cancelled = 0;
  const reader: IdentityChainReader = { ...fakeReader(),
    async changedAgents() { return ['7', '8', '9', '10', '11']; },
    async identity(id, _at, signal) {
      started.push(id);
      if (id === '7') throw new Error('FIRST_ID_FAILURE');
      return await new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('STALLED_READ')), 50);
        signal?.addEventListener('abort', () => {
          cancelled++;
          clearTimeout(timeout);
          reject(new Error('SIBLING_CANCELLED'));
        }, { once: true });
      });
    },
  };
  await expect(syncIdentityOnce(config, reader)).rejects.toThrow('FIRST_ID_FAILURE');
  expect(cancelled).toBe(3);
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(started).toEqual(['7', '8', '9', '10']);
  expect((await readIdentityCoverage(identitySourceFromConfig(config))).checkpoint).toBeNull();
});

it('refuses a reset genesis without advancing its cursor', async () => {
  const reader = { ...fakeReader(), async assertNetwork() {
    throw new Error('IDENTITY_NETWORK_MISMATCH');
  } };
  await expect(syncIdentityOnce(config, reader)).rejects.toThrow('IDENTITY_NETWORK_MISMATCH');
  expect(await readIdentityCoverage(identitySourceFromConfig(config)))
    .toMatchObject({ availability: 'unavailable', checkpoint: null });
});

it('rejects stale competing ticks instead of advancing a shared cursor twice', async () => {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reader = () => ({ ...fakeReader(), async changedAgents() {
    arrivals++;
    if (arrivals === 2) release();
    await gate;
    return ['7'];
  } });
  const outcomes = await Promise.allSettled([
    syncIdentityOnce(config, reader()), syncIdentityOnce(config, reader()),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect((await readIdentityCoverage(identitySourceFromConfig(config))).checkpoint).toEqual(at(2));
});

it('does not claim finality when the finalized block changes during the tick', async () => {
  const base = fakeReader();
  const reader: IdentityChainReader = { ...base,
    async finalized() { return at(1); },
    async block(tag) { return tag === '1' ? { ...at(1), hash: `0x${'ef'.repeat(32)}` } : base.block(tag); },
  };
  expect(await syncIdentityOnce(config, reader)).toMatchObject({ checkpoint: at(2), finalizedBlock: null });
});
