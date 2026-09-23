import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, stringToBytes } from 'viem';
import { closeSql, getSql } from '../../src/db/client.js';
import {
  applyIdentityBatch, markIdentityUnavailable, readIdentityCoverage, readIdentityObservation,
  readLatestIdentity, refreshIdentityCoverage, withdrawIdentitySource,
} from '../../src/db/queries/identityObservations.js';
import { identityObservationId, identitySourceId } from '../../src/connectors/erc8004/validation.js';
import { replaceOrganizationServices } from '../../src/db/queries/serviceProjections.js';
import { searchServiceProjections } from '../../src/db/queries/serviceProjections.js';
import { batch, block, observation, source } from './identityFixture.js';

async function cleanup() {
  const sql = getSql();
  const sourceId = `erc8004-identity:${source.chainId}:${source.registry}`;
  await sql`DELETE FROM service_projections WHERE source_id = ${sourceId}`;
  await sql`DELETE FROM identity_latest WHERE source_id = ${sourceId}`;
  await sql`DELETE FROM identity_observations WHERE source_id = ${sourceId}`;
  await sql`DELETE FROM identity_sources WHERE source_id = ${sourceId}`;
}
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await closeSql();
});

describe('qualification and projection replacement', () => {
  it.each(['eligible', 'inactive', 'owner-mismatch', 'unsupported', 'invalid', 'missing'] as const)(
    'retains %s observation while showing only eligible subjects', async (qualification) => {
      await applyIdentityBatch(batch());
      const nextBlock = { number: '43',
        hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as const,
        timestamp: block.timestamp + 12 };
      const next = { ...observation, block: nextBlock, qualification,
        declaration: qualification === 'eligible' ? observation.declaration : null,
        reason: qualification === 'eligible' ? null : qualification.toUpperCase().replace('-', '_') };
      await applyIdentityBatch(batch({ expectedVersion: '1', expectedCheckpoint: block,
        through: nextBlock, observedHead: nextBlock, observations: [next] }));
      const result = await searchServiceProjections({
        filter: { areaServed: ['https://www.wikidata.org/entity/Q1297'] }, pageSize: 20,
      });
      expect(result.items.some((item) => item.identifier === observation.declaration!.identifier))
        .toBe(qualification === 'eligible');
      expect(result.coverage.identitySources[0]!.checkpoint).toEqual(nextBlock);
      expect(await readLatestIdentity(observation.agent)).toEqual(next);
      expect(await readIdentityObservation(identityObservationId(source, observation))).toEqual(observation);
    },
  );
});

it('requires oversized inline URI bytes to be represented by digest and length only', async () => {
  const largeUri = `data:application/json;base64,${Buffer.alloc(33 * 1024).toString('base64')}`;
  const tooLarge = { ...observation, agentURI: largeUri,
    agentUriDigest: keccak256(stringToBytes(largeUri)), agentUriByteLength: Buffer.byteLength(largeUri),
    qualification: 'unsupported' as const, reason: 'URI_TOO_LARGE', declaration: null };
  await expect(applyIdentityBatch(batch({ observations: [tooLarge] }))).rejects.toThrow('budget');
  const retained = { ...tooLarge, agentURI: null };
  await applyIdentityBatch(batch({ observations: [retained] }));
  expect(await readLatestIdentity(observation.agent)).toEqual(retained);
});

it('rolls back a mixed invalid batch without creating a cursor or partial projection', async () => {
  const wrong = { ...observation, block: { ...block, number: '41' } };
  await expect(applyIdentityBatch(batch({ observations: [observation, wrong] }))).rejects.toThrow();
  expect((await readIdentityCoverage(source)).stateVersion).toBe('0');
  expect(await readLatestIdentity(observation.agent)).toBeNull();
  const sql = getSql();
  const [count] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM identity_observations
    WHERE source_id = ${identitySourceId(source)}
  `;
  expect(count!.count).toBe('0');
});

it('does not accept an eligible declaration without an observed owner', async () => {
  await expect(applyIdentityBatch(batch({ observations: [
    { ...observation, owner: null },
  ] }))).rejects.toThrow('eligible');
  expect((await readIdentityCoverage(source)).stateVersion).toBe('0');
});

it('retains a uint256 agent ID beyond the City codec range as unsupported without rounding', async () => {
  const agentId = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  const unsupported = { ...observation, agent: { ...observation.agent, agentId },
    owner: null, agentURI: null, agentUriDigest: null, agentUriByteLength: null,
    qualification: 'unsupported' as const, reason: 'UNSAFE_AGENT_ID', declaration: null };
  await applyIdentityBatch(batch({ observations: [unsupported] }));
  expect(await readLatestIdentity(unsupported.agent)).toEqual(unsupported);
  expect((await readIdentityCoverage(source)).checkpoint).toEqual(block);
});

it('does not project a City-eligible service for an ID outside its safe-number codec', async () => {
  const unsafe = { ...observation, agent: { ...observation.agent, agentId: '9007199254740992' },
    declaration: { ...observation.declaration!,
      identifier: `eip155:${source.chainId}/erc721:${source.registry}/9007199254740992` } };
  await expect(applyIdentityBatch(batch({ observations: [unsafe] }))).rejects.toThrow('unsupported');
});

it('rejects a through/head hash disagreement at the same height', async () => {
  const conflictingHead = { ...block,
    hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as const };
  await expect(applyIdentityBatch(batch({ observedHead: conflictingHead }))).rejects.toThrow('bounds');
  expect((await readIdentityCoverage(source)).stateVersion).toBe('0');
});

it('allows only one concurrent CAS writer and rejects a pre-rebuild worker after cursor reset', async () => {
  const attempts = await Promise.allSettled([applyIdentityBatch(batch()), applyIdentityBatch(batch())]);
  expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
  const withdrawn = await withdrawIdentitySource(source, '1', block);
  expect(withdrawn).toMatchObject({ stateVersion: '2', checkpoint: null, progress: 'rebuilding' });
  expect(await readLatestIdentity(observation.agent)).toBeNull();
  expect(await readIdentityObservation(identityObservationId(source, observation))).toEqual(observation);
  await expect(applyIdentityBatch(batch())).rejects.toThrow('stale');
  expect((await readIdentityCoverage(source)).stateVersion).toBe('2');
});

it('can replay an unchanged retained observation after source withdrawal', async () => {
  await applyIdentityBatch(batch());
  await withdrawIdentitySource(source, '1', block);
  const replayed = await applyIdentityBatch(batch({ expectedVersion: '2' }));
  expect(replayed).toMatchObject({ stateVersion: '3', checkpoint: block, progress: 'synchronized' });
  expect(await readLatestIdentity(observation.agent)).toEqual(observation);
  const sql = getSql();
  const [count] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM identity_observations
    WHERE source_id = ${identitySourceId(source)}
  `;
  expect(count!.count).toBe('1');
});

it('retains last basis during outage and refreshes lag/catch-up without rewriting old observations', async () => {
  await applyIdentityBatch(batch());
  await markIdentityUnavailable(source, '1');
  expect(await readIdentityCoverage(source)).toMatchObject({ availability: 'unavailable',
    stateVersion: '2', checkpoint: block });
  const head = { ...block, number: '50',
    hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' as const };
  const refreshed = await refreshIdentityCoverage(source, '2', head, null);
  expect(refreshed).toMatchObject({ availability: 'available', progress: 'lagging',
    checkpoint: block, observedHead: head, stateVersion: '3' });
  expect(refreshed.lastSuccessAt).toEqual(expect.any(String));
  const caughtUp = await applyIdentityBatch(batch({ expectedVersion: '3', expectedCheckpoint: block,
    through: head, observedHead: head, observations: [] }));
  expect(caughtUp).toMatchObject({ progress: 'synchronized', checkpoint: head });
  expect(await readLatestIdentity(observation.agent)).toEqual(observation);
});

it('keeps an organization declaration separate from an identical chain subject', async () => {
  const sql = getSql();
  const orgId = 'city-task1-org';
  await sql`DELETE FROM organizations WHERE org_id = ${orgId}`;
  await sql`DELETE FROM users WHERE provider_id = 'city-task1-user'`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, display_name, provider, provider_id)
    VALUES ('city-task1@example.test', 'City fixture', 'github', 'city-task1-user') RETURNING id
  `;
  const userId = user!.id;
  await sql`INSERT INTO organizations (org_id, display_name, domain, contact_email, email_verified, status)
    VALUES (${orgId}, 'City fixture', 'city-task1.example.test', 'city-task1@example.test', true, 'active')`;
  await sql`INSERT INTO org_memberships (user_id, org_id, role) VALUES (${userId}, ${orgId}, 'admin')`;
  try {
    await replaceOrganizationServices(orgId, userId, [observation.declaration!]);
    await applyIdentityBatch(batch());
    const result = await searchServiceProjections({ filter: {
      areaServed: ['https://www.wikidata.org/entity/Q1297'] }, pageSize: 20 });
    const same = result.items.filter((item) => item.identifier === observation.declaration!.identifier);
    expect(same.map((item) => item.provenance.sourceKind)).toEqual([
      'erc8004-identity', 'organization-declaration',
    ]);
    expect(same[0]!.provenance.authority).toMatchObject({ kind: 'erc8004-identity' });
    expect(same[1]!.provenance.authority).toBeUndefined();
    const first = await searchServiceProjections({ filter: {
      areaServed: ['https://www.wikidata.org/entity/Q1297'] }, pageSize: 1 });
    const second = await searchServiceProjections({ filter: {
      areaServed: ['https://www.wikidata.org/entity/Q1297'] }, pageSize: 1,
      pageToken: first.pageToken! });
    expect(first.items[0]!.provenance.sourceKind).toBe('erc8004-identity');
    expect(second.items[0]!.provenance.sourceKind).toBe('organization-declaration');
    expect(second.pageToken).toBeNull();
    await replaceOrganizationServices(orgId, userId, []);
    expect((await searchServiceProjections({ filter: { areaServed: ['https://www.wikidata.org/entity/Q1297'] },
      pageSize: 20 })).items.filter((item) => item.identifier === observation.declaration!.identifier))
      .toHaveLength(1);
  } finally {
    await sql`DELETE FROM organizations WHERE org_id = ${orgId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
  }
});

it('rejects organization rows that select connector provenance at the SQL boundary', async () => {
  const sql = getSql();
  await expect(sql`
    INSERT INTO service_projections
      (source_id, identifier, source_kind, org_id, observation_id, display_name,
       media_type, url, source_revision)
    VALUES ('org:fake', 'fake', 'erc8004-identity', NULL, NULL, 'fake',
      'application/agent-card+json', 'https://fake.example', 'fake')
  `).rejects.toThrow();
});

it('reports distinct configured observer origins for the same persisted source', async () => {
  await applyIdentityBatch(batch());
  const previous = process.env['API_BASE_URL'];
  try {
    process.env['API_BASE_URL'] = 'https://index-a.example/';
    const a = await searchServiceProjections({ filter: { areaServed: ['https://www.wikidata.org/entity/Q1297'] },
      pageSize: 1 });
    process.env['API_BASE_URL'] = 'https://index-b.example/';
    const b = await searchServiceProjections({ filter: { areaServed: ['https://www.wikidata.org/entity/Q1297'] },
      pageSize: 1 });
    expect(a.observerOrigin).toBe('https://index-a.example');
    expect(b.observerOrigin).toBe('https://index-b.example');
    expect(a.items[0]!.provenance.authority).toEqual(b.items[0]!.provenance.authority);
  } finally {
    if (previous === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = previous;
  }
});

describe('atomic identity observation batch', () => {
  it('projects an eligible City registration with coverage and rejects stale checkpoint CAS', async () => {
    await applyIdentityBatch(batch());
    const result = await searchServiceProjections({
      filter: { areaServed: ['https://www.wikidata.org/entity/Q1297'] }, pageSize: 20,
    });
    expect(result.items.map((item) => item.identifier)).toContain(observation.declaration!.identifier);
    expect(result.coverage.identitySources[0]!.checkpoint).toEqual(block);
    await expect(applyIdentityBatch(batch({ observations: [] }))).rejects.toThrow();
    expect((await readIdentityCoverage(source)).checkpoint).toEqual(block);
    expect(await readLatestIdentity(observation.agent)).toEqual(observation);
  });
});
