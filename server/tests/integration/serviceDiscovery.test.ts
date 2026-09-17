import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { closeSql, getSql } from '../../src/db/client.js';
import { buildServer } from '../../src/server.js';

const PREFIX = 'sd3http-task3-';
const CHICAGO = 'https://www.wikidata.org/entity/Q1297';
const BOSTON = 'https://www.wikidata.org/entity/Q100';
const CAPABILITY = 'urn:example:nanda-city:capability:weather-advice:v1';
const INTERFACE = 'application/a2a-agent-card+json';

interface ServiceWireDeclaration {
  identifier: string;
  display_name: string;
  type: string;
  url: string;
  description: string;
  capability_ids: string[];
  area_served: string[];
  interfaces: string[];
}

let fastify: FastifyInstance;
let adminUserId: string;
let memberUserId: string;
let outsiderUserId: string;
let adminToken: string;
let memberToken: string;
let outsiderToken: string;

async function upsertFixtureUser(label: string): Promise<string> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, display_name, provider, provider_id)
    VALUES (
      ${`${PREFIX}${label}@example.test`},
      ${`Service discovery HTTP ${label}`},
      'github',
      ${`${PREFIX}${label}`}
    )
    ON CONFLICT (provider, provider_id)
    DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
    RETURNING id
  `;
  return row!.id;
}

async function seedOrganization(suffix: string): Promise<string> {
  const sql = getSql();
  const orgId = `${PREFIX}${suffix}`;
  const verifyToken = randomBytes(16).toString('hex');
  await sql`
    INSERT INTO organizations
      (org_id, display_name, domain, contact_email, registry_url,
       verify_token, email_verified, status)
    VALUES (
      ${orgId},
      ${`Service discovery HTTP ${suffix}`},
      ${`${orgId}.example.test`},
      ${`${suffix}@example.test`},
      ${`https://${orgId}.example.test/registry`},
      ${verifyToken},
      true,
      'active'
    )
  `;
  return orgId;
}

async function addMembership(
  orgId: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO org_memberships (user_id, org_id, role)
    VALUES (${userId}, ${orgId}, ${role})
  `;
}

function declaration(identifier: string, areaServed: string): ServiceWireDeclaration {
  return {
    identifier,
    display_name: `Display ${identifier}`,
    type: 'application/a2a-agent-card+json',
    url: `https://services.example.test/${encodeURIComponent(identifier)}`,
    description: `Description ${identifier}`,
    capability_ids: [CAPABILITY],
    area_served: [areaServed],
    interfaces: [INTERFACE],
  };
}

async function replaceServices(
  orgId: string,
  token: string,
  services: ServiceWireDeclaration[],
) {
  return fastify.inject({
    method: 'PUT',
    url: `/api/v1/orgs/${orgId}/services`,
    headers: { authorization: `Bearer ${token}` },
    payload: { services },
  });
}

async function cleanupFixtures(): Promise<void> {
  const sql = getSql();
  await sql`
    DELETE FROM service_projections
    WHERE source_id LIKE ${`${PREFIX}%`}
       OR source_id LIKE ${`org:${PREFIX}%`}
       OR identifier LIKE ${`${PREFIX}%`}
  `;
  await sql`DELETE FROM organizations WHERE org_id LIKE ${`${PREFIX}%`}`;
}

beforeAll(async () => {
  const built = await buildServer({ logger: false });
  fastify = built.fastify;
  await fastify.ready();

  adminUserId = await upsertFixtureUser('admin');
  memberUserId = await upsertFixtureUser('member');
  outsiderUserId = await upsertFixtureUser('outsider');
  adminToken = fastify.jwt.sign({
    userId: adminUserId,
    email: `${PREFIX}admin@example.test`,
    displayName: null,
  });
  memberToken = fastify.jwt.sign({
    userId: memberUserId,
    email: `${PREFIX}member@example.test`,
    displayName: null,
  });
  outsiderToken = fastify.jwt.sign({
    userId: outsiderUserId,
    email: `${PREFIX}outsider@example.test`,
    displayName: null,
  });
});

beforeEach(async () => {
  await cleanupFixtures();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await cleanupFixtures();
  const sql = getSql();
  await sql`DELETE FROM users WHERE provider_id LIKE ${`${PREFIX}%`}`;
  await fastify.close();
  await closeSql();
});

describe('POST /api/ard/services/search', () => {
  it.each([
    ['an unknown filter field', { filter: { city: ['Chicago'] } }],
    ['an empty filter object', { filter: {} }],
    ['an empty present filter array', { filter: { areaServed: [] } }],
    ['a numeric-string page size', { filter: { interfaces: [INTERFACE] }, pageSize: '20' }],
  ])('returns 400 for %s without dropping or coercing input', async (_label, payload) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/ard/services/search',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'INVALID_INPUT' });
  });

  it('rejects request bodies over 256 KiB', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/ard/services/search',
      payload: {
        filter: { interfaces: [INTERFACE] },
        padding: 'x'.repeat(257 * 1024),
      },
    });

    expect(response.statusCode).toBe(413);
  });

  it('returns exactly three Chicago services from six declarations without federation', async () => {
    const chicagoIdentifiers: string[] = [];
    for (const operator of ['alpha', 'bravo', 'charlie']) {
      const orgId = await seedOrganization(operator);
      await addMembership(orgId, adminUserId, 'admin');
      const chicagoIdentifier = `${PREFIX}${operator}-chicago`;
      chicagoIdentifiers.push(chicagoIdentifier);
      const replacement = await replaceServices(orgId, adminToken, [
        declaration(chicagoIdentifier, CHICAGO),
        declaration(`${PREFIX}${operator}-boston`, BOSTON),
      ]);
      expect(replacement.statusCode).toBe(200);
    }

    const fetchTrap = vi.fn(() => {
      throw new Error('service discovery must not fetch or federate');
    });
    vi.stubGlobal('fetch', fetchTrap);

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/ard/services/search',
      payload: {
        filter: {
          capabilityIds: [CAPABILITY],
          areaServed: [CHICAGO],
          interfaces: [INTERFACE],
        },
        pageSize: 100,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { identifier: string }) => item.identifier))
      .toEqual(chicagoIdentifiers.sort());
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toMatchObject({
      displayName: expect.any(String),
      capabilityIds: [CAPABILITY],
      areaServed: [CHICAGO],
      interfaces: [INTERFACE],
      provenance: {
        sourceKind: 'organization-declaration',
        organizationId: expect.stringMatching(new RegExp(`^${PREFIX}`)),
      },
    });
    expect(body.items[0]).not.toHaveProperty('display_name');
    expect(body.coverage).toEqual({
      scope: 'local-projection',
      upstreamSearch: 'not-attempted',
      paginationConsistency: 'live-keyset',
      readAt: expect.any(String),
    });
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  it('passes a page token through the strict parser for live keyset pagination', async () => {
    const orgId = await seedOrganization('pagination');
    await addMembership(orgId, adminUserId, 'admin');
    const replacement = await replaceServices(orgId, adminToken, [
      declaration(`${PREFIX}page-a`, CHICAGO),
      declaration(`${PREFIX}page-b`, CHICAGO),
    ]);
    expect(replacement.statusCode).toBe(200);

    const first = await fastify.inject({
      method: 'POST',
      url: '/api/ard/services/search',
      payload: { filter: { areaServed: [CHICAGO] }, pageSize: 1 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((item: { identifier: string }) => item.identifier))
      .toEqual([`${PREFIX}page-a`]);
    expect(first.json().pageToken).toEqual(expect.any(String));

    const second = await fastify.inject({
      method: 'POST',
      url: '/api/ard/services/search',
      payload: {
        filter: { areaServed: [CHICAGO] },
        pageSize: 1,
        pageToken: first.json().pageToken,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((item: { identifier: string }) => item.identifier))
      .toEqual([`${PREFIX}page-b`]);
    expect(second.json().pageToken).toBeNull();
  });

  it('continues after an escaping-heavy identifier through HTTP and PostgreSQL', async () => {
    const orgId = await seedOrganization('pagination-escaping');
    await addMembership(orgId, adminUserId, 'admin');
    const longIdentifier = `${PREFIX}${'\u0001'.repeat(512 - PREFIX.length)}`;
    const nextIdentifier = `${PREFIX}z-after-escaping`;
    const boundaryService = {
      ...declaration(longIdentifier, CHICAGO),
      display_name: 'Escaping-heavy page boundary',
    };
    const replacement = await replaceServices(orgId, adminToken, [
      boundaryService,
      declaration(nextIdentifier, CHICAGO),
    ]);
    expect(replacement.statusCode).toBe(200);

    const first = await fastify.inject({
      method: 'POST',
      url: '/api/ard/services/search',
      payload: { filter: { areaServed: [CHICAGO] }, pageSize: 1 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((item: { identifier: string }) => item.identifier))
      .toEqual([longIdentifier]);
    expect(first.json().pageToken.length).toBeGreaterThan(4096);

    const second = await fastify.inject({
      method: 'POST',
      url: '/api/ard/services/search',
      payload: {
        filter: { areaServed: [CHICAGO] },
        pageSize: 1,
        pageToken: first.json().pageToken,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((item: { identifier: string }) => item.identifier))
      .toEqual([nextIdentifier]);
    expect(second.json().pageToken).toBeNull();
  });
});

describe('PUT /api/v1/orgs/:org_id/services', () => {
  it('requires authentication', async () => {
    const orgId = await seedOrganization('unauthenticated');
    await addMembership(orgId, adminUserId, 'admin');

    const response = await fastify.inject({
      method: 'PUT',
      url: `/api/v1/orgs/${orgId}/services`,
      payload: { services: [] },
    });

    expect(response.statusCode).toBe(401);
  });

  it('forbids both a non-admin member and a user from another organization', async () => {
    const orgId = await seedOrganization('forbidden');
    await addMembership(orgId, adminUserId, 'admin');
    await addMembership(orgId, memberUserId, 'member');

    const memberResponse = await replaceServices(orgId, memberToken, []);
    const outsiderResponse = await replaceServices(orgId, outsiderToken, []);

    expect(memberResponse.statusCode).toBe(403);
    expect(memberResponse.json()).toMatchObject({ error: 'FORBIDDEN' });
    expect(outsiderResponse.statusCode).toBe(403);
    expect(outsiderResponse.json()).toMatchObject({ error: 'FORBIDDEN' });
  });

  it('maps a missing organization to 404', async () => {
    const response = await replaceServices(`${PREFIX}missing`, adminToken, []);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('lets an admin atomically replace declarations and returns native snake_case', async () => {
    const orgId = await seedOrganization('admin');
    await addMembership(orgId, adminUserId, 'admin');
    const service = declaration(`${PREFIX}admin-chicago`, CHICAGO);
    const rawPayload = { services: [service] };

    const response = await fastify.inject({
      method: 'PUT',
      url: `/api/v1/orgs/${orgId}/services`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: rawPayload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      source_id: `org:${orgId}`,
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
      service_count: 1,
      observed_at: expect.any(String),
    });
    expect(body).not.toHaveProperty('sourceId');
    expect(rawPayload.services[0]).toEqual(service);

    const search = await fastify.inject({
      method: 'POST',
      url: '/api/ard/services/search',
      payload: { filter: { areaServed: [CHICAGO] } },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toHaveLength(1);
    expect(search.json().items[0]).toMatchObject({
      identifier: service.identifier,
      displayName: service.display_name,
    });
  });
});

describe('GET /api/ard descriptor', () => {
  it('advertises the namespaced local service-discovery extension', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/api/ard' });

    expect(response.statusCode).toBe(200);
    expect(response.json()['x-nanda-index-service-discovery']).toEqual({
      version: '0.1',
      endpoint: {
        method: 'POST',
        url: expect.stringMatching(/\/api\/ard\/services\/search$/),
      },
      acceptedFields: ['capabilityIds', 'areaServed', 'interfaces'],
      semantics: {
        acrossFields: 'AND',
        withinField: 'OR',
      },
      maxPageSize: 100,
      scope: 'local-projection',
      upstreamSearch: 'not-attempted',
      paginationConsistency: 'live-keyset',
    });
  });
});
