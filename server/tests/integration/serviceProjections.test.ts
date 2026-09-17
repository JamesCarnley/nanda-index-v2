import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeSql, getSql } from '../../src/db/client.js';
import {
  replaceOrganizationServices,
  searchServiceProjections,
} from '../../src/db/queries/serviceProjections.js';
import { ServiceDiscoveryError } from '../../src/services/serviceDiscoveryInput.js';
import type { ServiceDeclaration } from '../../src/types/api/service-discovery.js';

const PREFIX = 'sd2city-task2-';
const CHICAGO = 'https://www.wikidata.org/entity/Q1297';
const BOSTON = 'https://www.wikidata.org/entity/Q100';
const NEW_YORK = 'https://www.wikidata.org/entity/Q60';
const CAPABILITY_ALPHA = 'urn:sd2city-task2:capability:alpha';
const CAPABILITY_BETA = 'urn:sd2city-task2:capability:beta';
const INTERFACE_A2A = 'application/a2a+json;version=0.3';
const INTERFACE_MCP = 'application/mcp+json';

let adminUserId: string;
let memberUserId: string;
let outsiderUserId: string;

function service(
  identifier: string,
  areaServed: string[],
  capabilityIds: string[] = [CAPABILITY_ALPHA],
  interfaces: string[] = [INTERFACE_A2A],
): ServiceDeclaration {
  return {
    identifier,
    displayName: `Display ${identifier}`,
    type: 'application/agent-card+json',
    url: `https://services.example.test/${encodeURIComponent(identifier)}`,
    description: `Description ${identifier}`,
    capabilityIds,
    areaServed,
    interfaces,
  };
}

async function upsertFixtureUser(label: string): Promise<string> {
  const sql = getSql();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, display_name, provider, provider_id)
    VALUES (
      ${`${PREFIX}${label}@example.test`},
      ${`Service projection ${label}`},
      'github',
      ${`${PREFIX}${label}`}
    )
    ON CONFLICT (provider, provider_id)
    DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
    RETURNING id
  `;
  return row!.id;
}

async function seedOrganization(
  suffix: string,
  options: { status?: 'pending' | 'active' | 'suspended'; tags?: string[] } = {},
): Promise<string> {
  const sql = getSql();
  const orgId = `${PREFIX}${suffix}`;
  await sql`
    INSERT INTO organizations
      (org_id, display_name, domain, contact_email, registry_url,
       email_verified, status, tags)
    VALUES (
      ${orgId},
      ${`Service projection ${suffix}`},
      ${`${orgId}.example.test`},
      ${`${suffix}@example.test`},
      ${`https://${orgId}.example.test/registry`},
      true,
      ${options.status ?? 'active'},
      ${sql.array(options.tags ?? [])}
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

async function seedThreeCityOrganizations(): Promise<{
  orgIds: string[];
  expectedCityIdentifiers: string[];
}> {
  const orgIds: string[] = [];
  const expectedCityIdentifiers: string[] = [];

  for (const suffix of ['city-a', 'city-b', 'city-c']) {
    const orgId = await seedOrganization(suffix);
    orgIds.push(orgId);
    await addMembership(orgId, adminUserId, 'admin');
  }

  const declarations: ServiceDeclaration[][] = [
    [
      service(`${PREFIX}service-a-chicago`, [CHICAGO]),
      service(`${PREFIX}service-a-boston`, [BOSTON]),
      service(`${PREFIX}service-a-unknown`, [], [], []),
    ],
    [
      service(`${PREFIX}service-b-chicago`, [CHICAGO], [CAPABILITY_ALPHA], [INTERFACE_MCP]),
      service(`${PREFIX}service-b-boston`, [BOSTON], [CAPABILITY_ALPHA], [INTERFACE_MCP]),
    ],
    [
      service(`${PREFIX}service-c-chicago`, [CHICAGO], [CAPABILITY_BETA], [INTERFACE_A2A]),
      service(`${PREFIX}service-c-boston`, [BOSTON], [CAPABILITY_BETA], [INTERFACE_A2A]),
    ],
  ];

  for (let index = 0; index < orgIds.length; index += 1) {
    await replaceOrganizationServices(orgIds[index]!, adminUserId, declarations[index]!);
  }

  for (const group of declarations) {
    for (const declaration of group) {
      if (declaration.areaServed.length > 0) {
        expectedCityIdentifiers.push(declaration.identifier);
      }
    }
  }
  expectedCityIdentifiers.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return { orgIds, expectedCityIdentifiers };
}

async function seedIrrelevantRows(count: number): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO service_projections
      (source_id, identifier, source_kind, org_id, display_name, media_type,
       url, description, capability_ids, area_served, interfaces,
       source_revision, observed_at)
    SELECT
      ${`${PREFIX}noise-source`},
      ${`${PREFIX}noise-`} || LPAD(series::text, 3, '0'),
      'internal-test-connector',
      NULL,
      'Irrelevant service ' || series::text,
      'application/agent-card+json',
      'https://noise.example.test/' || series::text,
      NULL,
      ARRAY[${CAPABILITY_ALPHA}]::text[],
      ARRAY[${NEW_YORK}]::text[],
      ARRAY[${INTERFACE_A2A}]::text[],
      'noise-revision',
      CURRENT_TIMESTAMP
    FROM generate_series(1, ${count}) AS series
  `;
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
  adminUserId = await upsertFixtureUser('admin');
  memberUserId = await upsertFixtureUser('member');
  outsiderUserId = await upsertFixtureUser('outsider');
});

beforeEach(async () => {
  await cleanupFixtures();
});

afterAll(async () => {
  await cleanupFixtures();
  const sql = getSql();
  await sql`DELETE FROM users WHERE provider_id LIKE ${`${PREFIX}%`}`;
  await closeSql();
});

describe('service projection storage and replacement', () => {
  it('provides the source-scoped projection table required for service declarations', async () => {
    const sql = getSql();
    const rows = await sql`SELECT source_id, identifier FROM service_projections LIMIT 0`;

    expect(rows).toEqual([]);
  });

  it('replaces normalized declarations and derives one stable content revision', async () => {
    const orgId = await seedOrganization('replace');
    await addMembership(orgId, adminUserId, 'admin');
    const alpha = service(`${PREFIX}replace-alpha`, [CHICAGO]);
    const stale = service(`${PREFIX}replace-stale`, [BOSTON]);

    const first = await replaceOrganizationServices(orgId, adminUserId, [stale, alpha]);

    expect(first).toMatchObject({
      sourceId: `org:${orgId}`,
      serviceCount: 2,
    });
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(first.observedAt).toISOString()).toBe(first.observedAt);

    const sql = getSql();
    const firstRows = await sql<{
      identifier: string;
      sourceRevision: string;
      observedAt: Date;
    }[]>`
      SELECT identifier, source_revision, observed_at
      FROM service_projections
      WHERE source_id = ${first.sourceId}
      ORDER BY identifier
    `;
    expect(firstRows.map((row) => row.identifier)).toEqual([
      alpha.identifier,
      stale.identifier,
    ]);
    expect(firstRows.every((row) => row.sourceRevision === first.revision)).toBe(true);
    expect(firstRows.every((row) => row.observedAt.toISOString() === first.observedAt)).toBe(true);

    const semanticallySame = await replaceOrganizationServices(orgId, adminUserId, [
      {
        interfaces: [...alpha.interfaces],
        areaServed: [...alpha.areaServed],
        capabilityIds: [...alpha.capabilityIds],
        description: alpha.description,
        url: alpha.url,
        type: alpha.type,
        displayName: alpha.displayName,
        identifier: alpha.identifier,
      },
      {
        interfaces: [...stale.interfaces],
        areaServed: [...stale.areaServed],
        capabilityIds: [...stale.capabilityIds],
        description: stale.description,
        url: stale.url,
        type: stale.type,
        displayName: stale.displayName,
        identifier: stale.identifier,
      },
    ]);
    expect(semanticallySame.revision).toBe(first.revision);

    const updatedAlpha = {
      ...alpha,
      displayName: 'Updated alpha',
      capabilityIds: [CAPABILITY_BETA],
    };
    const replacement = await replaceOrganizationServices(
      orgId,
      adminUserId,
      [updatedAlpha],
    );
    const repeated = await replaceOrganizationServices(
      orgId,
      adminUserId,
      [updatedAlpha],
    );

    expect(replacement.revision).not.toBe(first.revision);
    expect(repeated.revision).toBe(replacement.revision);
    const replacementRows = await sql<{
      identifier: string;
      displayName: string;
      capabilityIds: string[];
    }[]>`
      SELECT identifier, display_name, capability_ids
      FROM service_projections
      WHERE source_id = ${first.sourceId}
    `;
    expect(replacementRows).toEqual([{
      identifier: alpha.identifier,
      displayName: 'Updated alpha',
      capabilityIds: [CAPABILITY_BETA],
    }]);
  });

  it('serializes concurrent replacements so the committed source is never a mixture', async () => {
    const orgId = await seedOrganization('concurrent');
    await addMembership(orgId, adminUserId, 'admin');
    const firstSet = [
      service(`${PREFIX}concurrent-a-1`, [CHICAGO]),
      service(`${PREFIX}concurrent-a-2`, [CHICAGO]),
    ];
    const secondSet = [
      service(`${PREFIX}concurrent-b-1`, [BOSTON]),
      service(`${PREFIX}concurrent-b-2`, [BOSTON]),
    ];

    await Promise.all([
      replaceOrganizationServices(orgId, adminUserId, firstSet),
      replaceOrganizationServices(orgId, adminUserId, secondSet),
    ]);

    const sql = getSql();
    const rows = await sql<{ identifier: string; sourceRevision: string }[]>`
      SELECT identifier, source_revision
      FROM service_projections
      WHERE source_id = ${`org:${orgId}`}
      ORDER BY identifier
    `;
    const identifiers = rows.map((row) => row.identifier);
    const firstIdentifiers = firstSet.map((item) => item.identifier);
    const secondIdentifiers = secondSet.map((item) => item.identifier);
    expect(
      JSON.stringify(identifiers) === JSON.stringify(firstIdentifiers)
      || JSON.stringify(identifiers) === JSON.stringify(secondIdentifiers),
    ).toBe(true);
    expect(new Set(rows.map((row) => row.sourceRevision)).size).toBe(1);
  });

  it('rejects missing organizations and non-admin writes before deleting existing rows', async () => {
    await expect(replaceOrganizationServices(
      `${PREFIX}missing`,
      outsiderUserId,
      [],
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const orgId = await seedOrganization('authorization');
    await addMembership(orgId, adminUserId, 'admin');
    await addMembership(orgId, memberUserId, 'member');
    const existing = service(`${PREFIX}authorization-existing`, [CHICAGO]);
    await replaceOrganizationServices(orgId, adminUserId, [existing]);

    await expect(replaceOrganizationServices(
      orgId,
      memberUserId,
      [service(`${PREFIX}authorization-new`, [BOSTON])],
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(replaceOrganizationServices(orgId, memberUserId, []))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(replaceOrganizationServices(orgId, outsiderUserId, []))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    const sql = getSql();
    const rows = await sql<{ identifier: string }[]>`
      SELECT identifier FROM service_projections WHERE source_id = ${`org:${orgId}`}
    `;
    expect(rows.map((row) => row.identifier)).toEqual([existing.identifier]);
  });

  it('clears only the organization source and preserves another source for the same subject', async () => {
    const orgId = await seedOrganization('provenance');
    await addMembership(orgId, adminUserId, 'admin');
    const identifier = `${PREFIX}shared-subject`;
    await replaceOrganizationServices(orgId, adminUserId, [service(identifier, [CHICAGO])]);

    const sql = getSql();
    await sql`
      INSERT INTO service_projections
        (source_id, identifier, source_kind, org_id, display_name, media_type,
         url, description, capability_ids, area_served, interfaces,
         source_revision, observed_at)
      VALUES (
        ${`${PREFIX}connector`}, ${identifier}, 'internal-test-connector', NULL,
        'Connector view', 'application/agent-card+json',
        'https://connector.example.test/shared', NULL,
        ${sql.array([CAPABILITY_ALPHA])}, ${sql.array([CHICAGO])},
        ${sql.array([INTERFACE_A2A])}, 'connector-revision', CURRENT_TIMESTAMP
      )
    `;

    const before = await searchServiceProjections({
      filter: { areaServed: [CHICAGO] },
      pageSize: 10,
    });
    expect(before.items.map((item) => item.provenance.sourceId)).toEqual([
      `org:${orgId}`,
      `${PREFIX}connector`,
    ]);

    const cleared = await replaceOrganizationServices(orgId, adminUserId, []);
    expect(cleared.serviceCount).toBe(0);
    const after = await searchServiceProjections({
      filter: { areaServed: [CHICAGO] },
      pageSize: 10,
    });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.provenance).toMatchObject({
      sourceId: `${PREFIX}connector`,
      sourceKind: 'internal-test-connector',
      organizationId: null,
    });
  });
});

describe('service projection search', () => {
  it('filters before the page limit and ORs values within the area field', async () => {
    const { expectedCityIdentifiers } = await seedThreeCityOrganizations();
    await seedIrrelevantRows(101);

    const chicago = await searchServiceProjections({
      filter: { areaServed: [CHICAGO] },
      pageSize: 100,
    });
    expect(chicago.items.map((item) => item.identifier)).toEqual([
      `${PREFIX}service-a-chicago`,
      `${PREFIX}service-b-chicago`,
      `${PREFIX}service-c-chicago`,
    ]);
    expect(chicago.pageToken).toBeNull();
    expect(chicago.coverage).toEqual({
      scope: 'local-projection',
      upstreamSearch: 'not-attempted',
      paginationConsistency: 'live-keyset',
      readAt: expect.any(String),
    });

    const eitherCity = await searchServiceProjections({
      filter: { areaServed: [BOSTON, CHICAGO] },
      pageSize: 100,
    });
    expect(eitherCity.items.map((item) => item.identifier)).toEqual(expectedCityIdentifiers);
    expect(eitherCity.items).toHaveLength(6);
  });

  it('ANDs present capability, area and interface predicates', async () => {
    await seedThreeCityOrganizations();

    const response = await searchServiceProjections({
      filter: {
        capabilityIds: [CAPABILITY_ALPHA],
        areaServed: [CHICAGO],
        interfaces: [INTERFACE_A2A],
      },
      pageSize: 100,
    });

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      identifier: `${PREFIX}service-a-chicago`,
      displayName: `Display ${PREFIX}service-a-chicago`,
      type: 'application/agent-card+json',
      capabilityIds: [CAPABILITY_ALPHA],
      areaServed: [CHICAGO],
      interfaces: [INTERFACE_A2A],
      provenance: {
        sourceKind: 'organization-declaration',
        organizationId: `${PREFIX}city-a`,
      },
    });
    expect(response.items[0]).not.toHaveProperty('score');
  });

  it('does not treat unknown service coverage or organization tags as service facts', async () => {
    const orgId = await seedOrganization('unknown', { tags: [CHICAGO, CAPABILITY_ALPHA] });
    await addMembership(orgId, adminUserId, 'admin');
    await replaceOrganizationServices(orgId, adminUserId, [
      service(`${PREFIX}unknown-coverage`, [], [], []),
    ]);

    const response = await searchServiceProjections({
      filter: { areaServed: [CHICAGO] },
      pageSize: 20,
    });

    expect(response.items).toEqual([]);
  });

  it('concatenates unchanged keyset pages without duplicates or omissions in C order', async () => {
    const sql = getSql();
    const identifierA = `${PREFIX}page-a`;
    const identifierZ = `${PREFIX}page-z`;
    const identifierUnicode = `${PREFIX}page-ä`;
    await sql`
      INSERT INTO service_projections
        (source_id, identifier, source_kind, display_name, media_type, url,
         capability_ids, area_served, interfaces, source_revision)
      VALUES
        (${`${PREFIX}page-source-b`}, ${identifierA}, 'internal-test-connector',
         'A from B', 'application/agent-card+json', 'https://page.example.test/a-b',
         ${sql.array([CAPABILITY_ALPHA])}, ${sql.array([])}, ${sql.array([])}, 'page-revision'),
        (${`${PREFIX}page-source-a`}, ${identifierA}, 'internal-test-connector',
         'A from A', 'application/agent-card+json', 'https://page.example.test/a-a',
         ${sql.array([CAPABILITY_ALPHA])}, ${sql.array([])}, ${sql.array([])}, 'page-revision'),
        (${`${PREFIX}page-source-a`}, ${identifierZ}, 'internal-test-connector',
         'Z', 'application/agent-card+json', 'https://page.example.test/z',
         ${sql.array([CAPABILITY_ALPHA])}, ${sql.array([])}, ${sql.array([])}, 'page-revision'),
        (${`${PREFIX}page-source-a`}, ${identifierUnicode}, 'internal-test-connector',
         'Unicode', 'application/agent-card+json', 'https://page.example.test/unicode',
         ${sql.array([CAPABILITY_ALPHA])}, ${sql.array([])}, ${sql.array([])}, 'page-revision')
    `;

    const seen: string[] = [];
    let pageToken: string | undefined;
    do {
      const response = await searchServiceProjections({
        filter: { capabilityIds: [CAPABILITY_ALPHA] },
        pageSize: 1,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      seen.push(...response.items.map(
        (item) => `${item.identifier}|${item.provenance.sourceId}`,
      ));
      pageToken = response.pageToken ?? undefined;
    } while (pageToken !== undefined);

    expect(seen).toEqual([
      `${identifierA}|${PREFIX}page-source-a`,
      `${identifierA}|${PREFIX}page-source-b`,
      `${identifierZ}|${PREFIX}page-source-a`,
      `${identifierUnicode}|${PREFIX}page-source-a`,
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor bound to a different normalized filter', async () => {
    const sql = getSql();
    await sql`
      INSERT INTO service_projections
        (source_id, identifier, source_kind, display_name, media_type, url,
         capability_ids, area_served, interfaces, source_revision)
      VALUES
        (${`${PREFIX}cursor-source`}, ${`${PREFIX}cursor-a`}, 'internal-test-connector',
         'Cursor A', 'application/agent-card+json', 'https://cursor.example.test/a',
         ${sql.array([CAPABILITY_ALPHA])}, ${sql.array([])}, ${sql.array([])}, 'cursor-revision'),
        (${`${PREFIX}cursor-source`}, ${`${PREFIX}cursor-b`}, 'internal-test-connector',
         'Cursor B', 'application/agent-card+json', 'https://cursor.example.test/b',
         ${sql.array([CAPABILITY_ALPHA])}, ${sql.array([])}, ${sql.array([])}, 'cursor-revision')
    `;
    const first = await searchServiceProjections({
      filter: { capabilityIds: [CAPABILITY_ALPHA] },
      pageSize: 1,
    });
    expect(first.pageToken).not.toBeNull();

    try {
      await searchServiceProjections({
        filter: { capabilityIds: [CAPABILITY_BETA] },
        pageSize: 1,
        pageToken: first.pageToken!,
      });
      throw new Error('expected ServiceDiscoveryError');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceDiscoveryError);
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('excludes inactive parents and loses deleted organization rows while retaining parentless sources', async () => {
    const orgId = await seedOrganization('lifecycle');
    await addMembership(orgId, adminUserId, 'admin');
    await replaceOrganizationServices(orgId, adminUserId, [
      service(`${PREFIX}lifecycle-org`, [CHICAGO]),
    ]);
    const sql = getSql();
    await sql`
      INSERT INTO service_projections
        (source_id, identifier, source_kind, display_name, media_type, url,
         capability_ids, area_served, interfaces, source_revision)
      VALUES (
        ${`${PREFIX}lifecycle-connector`}, ${`${PREFIX}lifecycle-parentless`},
        'internal-test-connector', 'Parentless connector', 'application/agent-card+json',
        'https://lifecycle.example.test/parentless', ${sql.array([CAPABILITY_ALPHA])},
        ${sql.array([CHICAGO])}, ${sql.array([INTERFACE_A2A])}, 'lifecycle-revision'
      )
    `;

    await sql`UPDATE organizations SET status = 'suspended' WHERE org_id = ${orgId}`;
    const suspended = await searchServiceProjections({
      filter: { areaServed: [CHICAGO] },
      pageSize: 20,
    });
    expect(suspended.items.map((item) => item.identifier)).toEqual([
      `${PREFIX}lifecycle-parentless`,
    ]);

    await sql`DELETE FROM organizations WHERE org_id = ${orgId}`;
    const deleted = await searchServiceProjections({
      filter: { areaServed: [CHICAGO] },
      pageSize: 20,
    });
    expect(deleted.items.map((item) => item.identifier)).toEqual([
      `${PREFIX}lifecycle-parentless`,
    ]);
    const [count] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM service_projections
      WHERE source_id = ${`org:${orgId}`}
    `;
    expect(count!.count).toBe('0');
  });
});
