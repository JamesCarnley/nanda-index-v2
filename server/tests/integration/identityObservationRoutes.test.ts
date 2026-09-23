import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { closeSql, getSql } from '../../src/db/client.js';
import { applyIdentityBatch } from '../../src/db/queries/identityObservations.js';
import { identityObservationId, identitySourceId } from '../../src/connectors/erc8004/validation.js';
import { batch, observation, source } from './identityFixture.js';

const routeRegistry = '0x6666666666666666666666666666666666666666' as const;
const routeSource = { ...source, registry: routeRegistry };
const routeObservation = { ...observation,
  agent: { ...observation.agent, registry: routeRegistry },
  declaration: { ...observation.declaration!,
    identifier: `eip155:${source.chainId}/erc721:${routeRegistry}/7` },
};
const largeId = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const unsupportedObservation = { ...routeObservation, agent: { ...routeObservation.agent, agentId: largeId },
  owner: null, agentURI: null, agentUriDigest: null, agentUriByteLength: null,
  qualification: 'unsupported' as const, reason: 'UNSAFE_AGENT_ID', declaration: null };
let fastify: FastifyInstance;
async function cleanup() {
  const sql = getSql();
  const sourceId = identitySourceId(routeSource);
  await sql`DELETE FROM service_projections WHERE source_id = ${sourceId}`;
  await sql`DELETE FROM identity_latest WHERE source_id = ${sourceId}`;
  await sql`DELETE FROM identity_observations WHERE source_id = ${sourceId}`;
  await sql`DELETE FROM identity_sources WHERE source_id = ${sourceId}`;
}
beforeAll(async () => {
  await cleanup();
  fastify = (await buildServer({ logger: false })).fastify;
  await fastify.ready();
  await applyIdentityBatch(batch({ source: routeSource, observations: [routeObservation, unsupportedObservation] }));
});

it('serves an unsupported uint256-sized subject without rounding its ID', async () => {
  const response = await fastify.inject({ method: 'GET',
    url: `/api/ard/erc8004/${source.chainId}/${routeRegistry}/${largeId}` });
  expect(response.statusCode).toBe(200);
  expect(response.json().observation).toMatchObject({ qualification: 'unsupported',
    agent: { agentId: largeId } });
});
afterAll(async () => {
  await fastify.close();
  await cleanup();
  await closeSql();
});

it('returns latest qualification with coverage and an independently addressable retained observation', async () => {
  const id = identityObservationId(routeSource, routeObservation);
  const latest = await fastify.inject({ method: 'GET',
    url: `/api/ard/erc8004/${source.chainId}/${routeRegistry}/7` });
  expect(latest.statusCode).toBe(200);
  expect(latest.json()).toMatchObject({ observationId: id,
    observation: routeObservation, coverage: { checkpoint: routeObservation.block, stateVersion: '1' } });
  const historical = await fastify.inject({ method: 'GET',
    url: `/api/ard/identity-observations/${id}` });
  expect(historical.statusCode).toBe(200);
  expect(historical.json()).toMatchObject({ observationId: id, observation: routeObservation });
  expect(historical.json().observationBytes).toBe(JSON.stringify(routeObservation));
});

it('advertises the versioned provenance and direct-read extension', async () => {
  const descriptor = await fastify.inject({ method: 'GET', url: '/api/ard' });
  expect(descriptor.statusCode).toBe(200);
  expect(descriptor.json()['x-nanda-index-service-discovery']).toMatchObject({
    version: '0.2',
    provenance: { observerOrigin: 'configured-api-base-url', authority: 'erc8004-identity' },
    directReads: {
      latest: expect.stringContaining('/api/ard/erc8004/'),
      observation: expect.stringContaining('/api/ard/identity-observations/'),
    },
  });
});

it.each([
  [`/api/ard/erc8004/0/${routeRegistry}/7`, 400],
  [`/api/ard/erc8004/11155111/not-an-address/7`, 400],
  [`/api/ard/erc8004/11155111/${routeRegistry}/07`, 400],
  [`/api/ard/erc8004/11155111/${routeRegistry}/${'1'.repeat(513)}`, 400],
  [`/api/ard/erc8004/11155111/${routeRegistry}/${'9'.repeat(79)}`, 400],
  ['/api/ard/identity-observations/sha256:xyz', 400],
  [`/api/ard/identity-observations/sha256:${'a'.repeat(64)}`, 404],
])('bounds malformed and unknown direct reads: %s', async (url, status) => {
  const response = await fastify.inject({ method: 'GET', url });
  expect(response.statusCode).toBe(status);
});

it('never pairs a pre-withdrawal latest observation with post-withdrawal coverage', async () => {
  const sql = postgres(process.env['DATABASE_URL']!, { max: 1, transform: postgres.camel });
  const sourceId = identitySourceId(routeSource);
  let pendingRead: Promise<Awaited<ReturnType<typeof fastify.inject>>> | undefined;
  try {
    await sql.begin(async (tx) => {
      await tx`LOCK TABLE identity_sources IN ACCESS EXCLUSIVE MODE`;
      pendingRead = Promise.resolve(fastify.inject({ method: 'GET',
        url: `/api/ard/erc8004/${source.chainId}/${routeRegistry}/7` }));
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await tx`SELECT pg_stat_clear_snapshot()`;
        const [status] = await tx<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
              AND query LIKE '%identity_sources%'
          ) AS blocked
        `;
        blocked = status!.blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await tx`DELETE FROM service_projections WHERE source_id = ${sourceId}`;
      await tx`DELETE FROM identity_latest WHERE source_id = ${sourceId}`;
      await tx`
        UPDATE identity_sources SET state_version = state_version + 1,
          generation = generation + 1, rebuilding = true,
          checkpoint_number = NULL, checkpoint_hash = NULL, checkpoint_timestamp = NULL
        WHERE source_id = ${sourceId}
      `;
    });
  } finally {
    await sql.end();
  }
  const response = await pendingRead!;
  if (response.statusCode === 200) {
    expect(response.json().coverage).toMatchObject({ stateVersion: '1', checkpoint: routeObservation.block });
  } else {
    expect(response.statusCode).toBe(404);
  }
});
