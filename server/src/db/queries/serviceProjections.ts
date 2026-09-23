import { createHash } from 'node:crypto';
import { getSql } from '../client.js';
import { buildConfig } from '../../config/index.js';
import { sourceRowCoverage } from './identityObservations.js';
import type { IdentityObservation } from '../../connectors/erc8004/types.js';
import {
  decodeServiceCursor,
  encodeServiceCursor,
  ServiceDiscoveryError,
} from '../../services/serviceDiscoveryInput.js';
import type {
  ServiceDeclaration,
  ServiceProjection,
  ServiceSearchQuery,
  ServiceSearchResponse,
} from '../../types/api/service-discovery.js';

const ORGANIZATION_SOURCE_KIND = 'organization-declaration';

interface ServiceProjectionRow {
  sourceId: string;
  identifier: string;
  sourceKind: string;
  orgId: string | null;
  displayName: string;
  mediaType: string;
  url: string;
  description: string | null;
  capabilityIds: string[];
  areaServed: string[];
  interfaces: string[];
  sourceRevision: string;
  observedAt: Date;
  observationId: string | null;
  observationJson: string | null;
  identitySources: Array<Record<string, unknown>>;
  readAt: Date;
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function contentRevision(services: ServiceDeclaration[]): string {
  const ordered = [...services]
    .sort((left, right) => compareOrdinal(left.identifier, right.identifier))
    .map((service) => ({
      identifier: service.identifier,
      displayName: service.displayName,
      type: service.type,
      url: service.url,
      description: service.description,
      capabilityIds: service.capabilityIds,
      areaServed: service.areaServed,
      interfaces: service.interfaces,
    }));
  return createHash('sha256')
    .update(JSON.stringify(ordered), 'utf8')
    .digest('hex');
}

function toProjection(row: ServiceProjectionRow): ServiceProjection {
  const projection: ServiceProjection = {
    identifier: row.identifier,
    displayName: row.displayName,
    type: row.mediaType,
    url: row.url,
    description: row.description,
    capabilityIds: row.capabilityIds,
    areaServed: row.areaServed,
    interfaces: row.interfaces,
    provenance: {
      sourceId: row.sourceId,
      sourceKind: row.sourceKind,
      organizationId: row.orgId,
      revision: row.sourceRevision,
      observedAt: row.observedAt.toISOString(),
    },
  };
  if (row.sourceKind === 'erc8004-identity') {
    const observation = JSON.parse(row.observationJson!) as IdentityObservation;
    projection.provenance.authority = { kind: 'erc8004-identity', agent: observation.agent,
      block: observation.block, observationId: row.observationId! };
  }
  return projection;
}

export async function replaceOrganizationServices(
  orgId: string,
  userId: string,
  services: ServiceDeclaration[],
): Promise<{
  sourceId: string;
  revision: string;
  serviceCount: number;
  observedAt: string;
}> {
  const sql = getSql();
  const sourceId = `org:${orgId}`;
  const revision = contentRevision(services);

  return sql.begin(async (tx) => {
    const organizations = await tx<{ orgId: string }[]>`
      SELECT org_id
      FROM organizations
      WHERE org_id = ${orgId}
      FOR UPDATE
    `;
    if (!organizations[0]) {
      throw new ServiceDiscoveryError('NOT_FOUND', 'organization not found');
    }

    const memberships = await tx<{ role: string }[]>`
      SELECT role
      FROM org_memberships
      WHERE org_id = ${orgId} AND user_id = ${userId}
      LIMIT 1
    `;
    if (memberships[0]?.role !== 'admin') {
      throw new ServiceDiscoveryError(
        'FORBIDDEN',
        'organization admin membership required',
      );
    }

    const [clock] = await tx<{ observedAt: Date }[]>`
      SELECT CURRENT_TIMESTAMP AS observed_at
    `;
    const observedAt = clock!.observedAt;

    await tx`
      DELETE FROM service_projections
      WHERE source_kind = ${ORGANIZATION_SOURCE_KIND}
        AND org_id = ${orgId} AND source_id = ${sourceId}
    `;

    for (const service of services) {
      await tx`
        INSERT INTO service_projections
          (source_id, identifier, source_kind, org_id, display_name, media_type,
           url, description, capability_ids, area_served, interfaces,
           source_revision, observed_at)
        VALUES (
          ${sourceId},
          ${service.identifier},
          ${ORGANIZATION_SOURCE_KIND},
          ${orgId},
          ${service.displayName},
          ${service.type},
          ${service.url},
          ${service.description},
          ${tx.array(service.capabilityIds)},
          ${tx.array(service.areaServed)},
          ${tx.array(service.interfaces)},
          ${revision},
          ${observedAt}
        )
      `;
    }

    return {
      sourceId,
      revision,
      serviceCount: services.length,
      observedAt: observedAt.toISOString(),
    };
  });
}

export async function searchServiceProjections(
  query: ServiceSearchQuery,
): Promise<ServiceSearchResponse> {
  const sql = getSql();
  const after = query.pageToken
    ? decodeServiceCursor(query.filter, query.pageToken)
    : null;
  const capabilityClause = query.filter.capabilityIds
    ? sql`AND p.capability_ids && ${sql.array(query.filter.capabilityIds)}::text[]`
    : sql``;
  const areaClause = query.filter.areaServed
    ? sql`AND p.area_served && ${sql.array(query.filter.areaServed)}::text[]`
    : sql``;
  const interfaceClause = query.filter.interfaces
    ? sql`AND p.interfaces && ${sql.array(query.filter.interfaces)}::text[]`
    : sql``;
  const cursorClause = after
    ? sql`AND (p.identifier COLLATE "C", p.source_id COLLATE "C")
          > (${after.identifier}, ${after.sourceId})`
    : sql``;

  const rows = await sql<ServiceProjectionRow[]>`
    WITH page AS (
    SELECT
      p.source_id,
      p.identifier,
      p.source_kind,
      p.org_id,
      p.display_name,
      p.media_type,
      p.url,
      p.description,
      p.capability_ids,
      p.area_served,
      p.interfaces,
      p.source_revision,
      p.observed_at,
      p.observation_id,
      io.observation_json
    FROM service_projections p
    LEFT JOIN organizations o ON o.org_id = p.org_id
    LEFT JOIN identity_observations io
      ON io.source_id = p.source_id AND io.observation_id = p.observation_id
    WHERE (p.org_id IS NULL OR o.status = 'active')
      ${capabilityClause}
      ${areaClause}
      ${interfaceClause}
      ${cursorClause}
    ORDER BY p.identifier COLLATE "C" ASC, p.source_id COLLATE "C" ASC
    LIMIT ${query.pageSize + 1}
    ), coverage AS (
      SELECT COALESCE(json_agg(row_to_json(s) ORDER BY s.source_id), '[]'::json) AS identity_sources
      FROM (
        SELECT source_id, source_fingerprint, confirmations,
          state_version::text AS state_version, generation::text AS generation,
          availability, rebuilding,
          checkpoint_number::text AS checkpoint_number, checkpoint_hash,
          checkpoint_timestamp::text AS checkpoint_timestamp,
          head_number::text AS head_number, head_hash, head_timestamp::text AS head_timestamp,
          finalized_number::text AS finalized_number, finalized_hash,
          finalized_timestamp::text AS finalized_timestamp,
          last_success_at, last_attempt_at
        FROM identity_sources
      ) s
    )
    SELECT page.*, coverage.identity_sources, CURRENT_TIMESTAMP AS read_at
    FROM coverage LEFT JOIN page ON true
    ORDER BY page.identifier COLLATE "C" ASC, page.source_id COLLATE "C" ASC
  `;

  const items = rows.filter((row) => row.sourceId !== null);
  const hasMore = items.length > query.pageSize;
  const page = hasMore ? items.slice(0, query.pageSize) : items;
  const last = page[page.length - 1];
  const sourceRows = rows[0]?.identitySources ?? [];
  const identitySources = sourceRows.map((raw) => {
    const normalized = Object.fromEntries(Object.entries(raw).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value,
    ]));
    for (const key of ['lastSuccessAt', 'lastAttemptAt']) {
      if (normalized[key]) normalized[key] = new Date(normalized[key] as string);
    }
    return sourceRowCoverage(normalized as unknown as Parameters<typeof sourceRowCoverage>[0]);
  });

  return {
    items: page.map(toProjection),
    observerOrigin: buildConfig().apiBaseUrl.replace(/\/+$/, ''),
    pageToken: hasMore && last
      ? encodeServiceCursor(query.filter, {
          identifier: last.identifier,
          sourceId: last.sourceId,
        })
      : null,
    coverage: {
      scope: 'local-projection',
      upstreamSearch: 'not-attempted',
      paginationConsistency: 'live-keyset',
      readAt: (rows[0]?.readAt ?? new Date()).toISOString(),
      identitySources,
    },
  };
}
