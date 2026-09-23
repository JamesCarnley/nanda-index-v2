import type { AgentRef, BlockRef, IdentityCoverage } from '../../connectors/erc8004/types.js';

export interface ServiceFilter {
  capabilityIds?: string[];
  areaServed?: string[];
  interfaces?: string[];
}

export interface ServiceSearchQuery {
  filter: ServiceFilter;
  pageSize: number;
  pageToken?: string;
}

export interface ServiceDeclaration {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  description: string | null;
  capabilityIds: string[];
  areaServed: string[];
  interfaces: string[];
}

export interface ServiceProjection extends ServiceDeclaration {
  provenance: {
    sourceId: string;
    sourceKind: string;
    organizationId: string | null;
    revision: string;
    observedAt: string;
    authority?: {
      kind: 'erc8004-identity'; agent: AgentRef; block: BlockRef; observationId: string;
    };
  };
}

export interface ServiceSearchResponse {
  items: ServiceProjection[];
  pageToken: string | null;
  observerOrigin: string;
  coverage: {
    scope: 'local-projection';
    upstreamSearch: 'not-attempted';
    paginationConsistency: 'live-keyset';
    readAt: string;
    identitySources: IdentityCoverage[];
  };
}
