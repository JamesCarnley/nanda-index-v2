import { readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http,
  parseAbi, parseEventLogs, parseEther, zeroAddress, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withOwnedAnvil } from '../fixtures/ownedAnvil.js';
import { originalRegistration, newRegistration } from '../fixtures/cityProfile.js';
import { encodeRegistration } from '../../src/connectors/erc8004/vendor/nandacity/profile.js';
import { createIdentityChainReader } from '../../src/connectors/erc8004/rpc.js';
import { syncIdentityOnce } from '../../src/connectors/erc8004/follower.js';
import { identitySourceFromConfig, type IdentityFollowerConfig } from '../../src/connectors/erc8004/config.js';
import { readIdentityCoverage, readLatestIdentity } from '../../src/db/queries/identityObservations.js';
import { getSql, closeSql } from '../../src/db/client.js';
import { buildServer } from '../../src/server.js';

type Artifact = { abi: Abi; bytecode: Hex };
const artifact = JSON.parse(readFileSync(new URL('../fixtures/referenceRegistry.json', import.meta.url), 'utf8')) as {
  identityRegistry: Artifact; minimalUups: Artifact; erc1967Proxy: Artifact;
};
const adminAbi = parseAbi(['function initialize()', 'function upgradeToAndCall(address,bytes) payable']);
const agentAbi = parseAbi(['event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'function register() returns (uint256)', 'function setAgentURI(uint256,string)',
  'function transferFrom(address,address,uint256)']);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owned Index port missing');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
    const done = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', done);
  });
}
async function withOwnedIndexProcess(config: IdentityFollowerConfig, check: () => Promise<void>) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('../fixtures/runIndex.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), API_BASE_URL: `http://127.0.0.1:${port}`,
      ERC8004_IDENTITY_CONFIG: JSON.stringify(config) },
  });
  try {
    let live = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
        if (response.ok) { live = true; break; }
      } catch { /* server is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(live).toBe(true);
    await check();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (!await waitForExit(child, 2_000)) {
      child.kill('SIGKILL');
      if (!await waitForExit(child, 2_000)) throw new Error('owned Index did not exit');
    }
  }
}

afterAll(async () => { await closeSql(); });

it('follows a genuine local reference registry across updates, transfer, restart and revert', async () => {
  await withOwnedAnvil(async (rpcUrl) => {
    const transport = http(rpcUrl, { retryCount: 0, timeout: 5000 });
    const publicClient = createPublicClient({ transport });
    const testClient = createTestClient({ mode: 'anvil', transport });
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    const replacement = privateKeyToAccount(generatePrivateKey());
    for (const account of [admin, owner, replacement]) {
      await testClient.setBalance({ address: account.address, value: parseEther('10') });
    }
    const adminWallet = createWalletClient({ account: admin, transport });
    const ownerWallet = createWalletClient({ account: owner, transport });
    const replacementWallet = createWalletClient({ account: replacement, transport });
    async function receipt(hash: Hex) {
      const result = await publicClient.waitForTransactionReceipt({ hash, timeout: 10000 });
      expect(result.status).toBe('success');
      return result;
    }
    async function deploy(contract: Artifact, args: readonly unknown[] = []) {
      const result = await receipt(await adminWallet.deployContract({
        abi: contract.abi, bytecode: contract.bytecode, args, chain: null,
      }));
      return result.contractAddress!;
    }
    const minimal = await deploy(artifact.minimalUups);
    const registry = await deploy(artifact.erc1967Proxy, [minimal,
      encodeFunctionData({ abi: parseAbi(['function initialize(address)']),
        functionName: 'initialize', args: [zeroAddress] })]);
    const real = await deploy(artifact.identityRegistry);
    await receipt(await adminWallet.writeContract({ address: registry, abi: adminAbi,
      functionName: 'upgradeToAndCall', args: [real,
        encodeFunctionData({ abi: adminAbi, functionName: 'initialize' })], chain: null }));
    const genesis = await publicClient.getBlock({ blockNumber: 0n });
    const config: IdentityFollowerConfig = { rpcUrl, chainId: 31337, registry,
      genesisHash: genesis.hash!, startBlock: '1', adapter: 'nandacity-0.1',
      confirmations: 0, pollMs: 2000, maxBlockSpan: 200 };
    const sourceId = `erc8004-identity:31337:${registry.toLowerCase()}`;
    const sql = getSql();
    try {
      const register = await receipt(await ownerWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'register', chain: null }));
      const logs = parseEventLogs({ abi: agentAbi, eventName: 'Registered', logs: register.logs });
      const id = logs[0]!.args.agentId.toString();
      const agent = { chainId: 31337, registry, agentId: id };
      const reader = createIdentityChainReader(config);
      expect((await syncIdentityOnce(config, reader)).checkpoint?.number).toBe(register.blockNumber.toString());
      expect((await readLatestIdentity(agent))?.qualification).toBe('unsupported');
      const current = await reader.block('latest');
      expect(await reader.identity('999', current)).toBe('missing');

      const secondRegister = await receipt(await ownerWallet.writeContract({ address: registry,
        abi: agentAbi, functionName: 'register', chain: null }));
      const secondId = parseEventLogs({ abi: agentAbi, eventName: 'Registered',
        logs: secondRegister.logs })[0]!.args.agentId.toString();
      const secondProfile = { ...originalRegistration,
        registrations: [{ agentId: Number(secondId), agentRegistry: `eip155:31337:${registry}` }],
        'x-nandacity': { ...originalRegistration['x-nandacity'], ownerAtPublication: owner.address } };
      await testClient.setBlockGasLimit({ gasLimit: 100_000_000n });
      await receipt(await ownerWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'setAgentURI', args: [BigInt(id),
          `data:application/json;base64,${Buffer.alloc(32 * 1024 + 1).toString('base64')}`], chain: null }));
      await receipt(await ownerWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'setAgentURI', args: [BigInt(secondId), encodeRegistration(secondProfile)], chain: null }));
      await syncIdentityOnce(config, reader);
      expect(await readLatestIdentity(agent)).toMatchObject({
        qualification: 'invalid', reason: 'URI_TOO_LARGE', agentURI: null,
      });
      expect((await readLatestIdentity({ ...agent, agentId: secondId }))?.qualification).toBe('eligible');

      const profile = { ...originalRegistration,
        registrations: [{ agentId: Number(id), agentRegistry: `eip155:31337:${registry}` }],
        'x-nandacity': { ...originalRegistration['x-nandacity'], ownerAtPublication: owner.address } };
      await receipt(await ownerWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'setAgentURI', args: [BigInt(id), encodeRegistration(profile)], chain: null }));
      expect((await syncIdentityOnce(config, reader)).progress).toBe('synchronized');
      expect((await readLatestIdentity(agent))?.qualification).toBe('eligible');

      const updated = { ...newRegistration,
        registrations: [{ agentId: Number(id), agentRegistry: `eip155:31337:${registry}` }],
        'x-nandacity': { ...newRegistration['x-nandacity'], ownerAtPublication: owner.address } };
      await receipt(await ownerWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'setAgentURI', args: [BigInt(id), encodeRegistration(updated)], chain: null }));
      await syncIdentityOnce(config, reader);
      expect((await readLatestIdentity(agent))?.declaration?.areaServed)
        .toEqual(['https://www.wikidata.org/entity/Q100']);

      await receipt(await ownerWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'transferFrom', args: [owner.address, replacement.address, BigInt(id)], chain: null }));
      await syncIdentityOnce(config, reader);
      expect((await readLatestIdentity(agent))?.qualification).toBe('owner-mismatch');

      const newProfile = { ...updated,
        'x-nandacity': { ...updated['x-nandacity'], ownerAtPublication: replacement.address } };
      await receipt(await replacementWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'setAgentURI', args: [BigInt(id), encodeRegistration(newProfile)], chain: null }));
      await syncIdentityOnce(config, createIdentityChainReader(config));
      const beforeRestart = (await readIdentityCoverage(identitySourceFromConfig(config))).stateVersion;
      await withOwnedIndexProcess(config, async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          if ((await readIdentityCoverage(identitySourceFromConfig(config))).availability === 'available') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect((await readIdentityCoverage(identitySourceFromConfig(config))).availability).toBe('available');
      });
      expect((await readIdentityCoverage(identitySourceFromConfig(config))).availability).toBe('unavailable');
      await withOwnedIndexProcess(config, async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          if ((await readIdentityCoverage(identitySourceFromConfig(config))).availability === 'available') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const resumed = await readIdentityCoverage(identitySourceFromConfig(config));
        expect(resumed.availability).toBe('available');
        expect(BigInt(resumed.stateVersion)).toBeGreaterThan(BigInt(beforeRestart));
        expect((await readLatestIdentity(agent))?.qualification).toBe('eligible');
      });
      const snapshot = await testClient.snapshot();
      await receipt(await replacementWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'setAgentURI', args: [BigInt(id), encodeRegistration({ ...newProfile, active: false })], chain: null }));
      await syncIdentityOnce(config, reader);
      expect((await readLatestIdentity(agent))?.qualification).toBe('inactive');
      await testClient.revert({ id: snapshot });
      await receipt(await replacementWallet.writeContract({ address: registry, abi: agentAbi,
        functionName: 'setAgentURI', args: [BigInt(id), encodeRegistration({ ...newProfile,
          description: 'Reorganized active profile' })], chain: null }));
      expect(await syncIdentityOnce(config, reader)).toMatchObject({ checkpoint: null, progress: 'rebuilding' });
      expect(await readLatestIdentity(agent)).toBeNull();
      await syncIdentityOnce(config, reader);
      expect((await readLatestIdentity(agent))?.qualification).toBe('eligible');
      expect((await readIdentityCoverage(identitySourceFromConfig(config))).progress).toBe('synchronized');
    } finally {
      await sql`DELETE FROM service_projections WHERE source_id = ${sourceId}`;
      await sql`DELETE FROM identity_latest WHERE source_id = ${sourceId}`;
      await sql`DELETE FROM identity_observations WHERE source_id = ${sourceId}`;
      await sql`DELETE FROM identity_sources WHERE source_id = ${sourceId}`;
    }
  }, { genesisMarker: { blockNumber: 0n, timestamp: BigInt(Math.floor(Date.now() / 1000)) + 31n } });
}, 60_000);

it('keeps the full API usable with disabled support and an enabled RPC outage', async () => {
  const previousConfig = process.env['ERC8004_IDENTITY_CONFIG'];
  const previousBase = process.env['API_BASE_URL'];
  const offlineConfig: IdentityFollowerConfig = { rpcUrl: 'http://127.0.0.1:1',
    chainId: 31337, registry: `0x${'d3'.repeat(20)}`, genesisHash: `0x${'ab'.repeat(32)}`,
    startBlock: '1', adapter: 'nandacity-0.1', confirmations: 0,
    pollMs: 2000, maxBlockSpan: 200 };
  const sourceId = `erc8004-identity:31337:${offlineConfig.registry}`;
  try {
    delete process.env['ERC8004_IDENTITY_CONFIG'];
    let app = await buildServer({ logger: false });
    await app.fastify.ready();
    expect((await app.fastify.inject('/health')).statusCode).toBe(200);
    await app.fastify.close();

    process.env['ERC8004_IDENTITY_CONFIG'] = JSON.stringify(offlineConfig);
    process.env['API_BASE_URL'] = 'http://127.0.0.1:3001';
    app = await buildServer({ logger: false });
    await app.fastify.ready();
    expect((await app.fastify.inject('/health')).statusCode).toBe(200);
    const response = await app.fastify.inject({ method: 'POST', url: '/api/ard/services/search',
      payload: { filter: { capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'] } } });
    expect(response.statusCode).toBe(200);
    expect(response.json().coverage.identitySources).toContainEqual(expect.objectContaining({
      sourceId, availability: 'unavailable', checkpoint: null,
    }));
    await app.fastify.close();
  } finally {
    if (previousConfig === undefined) delete process.env['ERC8004_IDENTITY_CONFIG'];
    else process.env['ERC8004_IDENTITY_CONFIG'] = previousConfig;
    if (previousBase === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = previousBase;
    const sql = getSql();
    await sql`DELETE FROM identity_sources WHERE source_id = ${sourceId}`;
  }
}, 30_000);
