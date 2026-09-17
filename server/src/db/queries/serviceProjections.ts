import { createHash } from 'node:crypto';
import { getSql } from '../client.js';
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
  return {
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
      WHERE source_id = ${sourceId}
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
      p.observed_at
    FROM service_projections p
    LEFT JOIN organizations o ON o.org_id = p.org_id
    WHERE (p.org_id IS NULL OR o.status = 'active')
      ${capabilityClause}
      ${areaClause}
      ${interfaceClause}
      ${cursorClause}
    ORDER BY p.identifier COLLATE "C" ASC, p.source_id COLLATE "C" ASC
    LIMIT ${query.pageSize + 1}
  `;

  const hasMore = rows.length > query.pageSize;
  const page = hasMore ? rows.slice(0, query.pageSize) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(toProjection),
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
      readAt: new Date().toISOString(),
    },
  };
}
