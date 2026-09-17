import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  replaceOrganizationServices,
  searchServiceProjections,
} from '../db/queries/serviceProjections.js';
import {
  parseServiceReplacement,
  parseServiceSearch,
  ServiceDiscoveryError,
} from '../services/serviceDiscoveryInput.js';

const SERVICE_DISCOVERY_BODY_LIMIT = 256 * 1024;

function errorStatus(error: ServiceDiscoveryError): 400 | 403 | 404 {
  switch (error.code) {
    case 'INVALID_INPUT':
      return 400;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
  }
}

function sendServiceDiscoveryError(
  error: ServiceDiscoveryError,
  reply: FastifyReply,
) {
  return reply.code(errorStatus(error)).send({
    error: error.code,
    detail: error.message,
  });
}

/**
 * Source-local structured service discovery. The public search wire shape is
 * camelCase; the authenticated organization replacement shape is native
 * snake_case. Both raw bodies are parsed exactly once by the strict parsers,
 * without an AJV body schema that could coerce or remove caller input first.
 */
export async function registerServiceDiscoveryRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: unknown }>('/api/ard/services/search', {
    bodyLimit: SERVICE_DISCOVERY_BODY_LIMIT,
    schema: {
      tags: ['ard'],
      summary: 'Search locally projected service declarations',
      description:
        'Exact structured filters over the local projection; no federation, chain lookup, or ranking.',
    },
  }, async (request, reply) => {
    try {
      const query = parseServiceSearch(request.body);
      const response = await searchServiceProjections(query);
      return reply.code(200).send(response);
    } catch (error) {
      if (error instanceof ServiceDiscoveryError) {
        return sendServiceDiscoveryError(error, reply);
      }
      throw error;
    }
  });

  fastify.put<{ Params: { org_id: string }; Body: unknown }>(
    '/api/v1/orgs/:org_id/services',
    {
      bodyLimit: SERVICE_DISCOVERY_BODY_LIMIT,
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['orgs'],
        summary: 'Replace an organization service declaration set',
      },
    },
    async (request, reply) => {
      try {
        const services = parseServiceReplacement(request.body);
        const result = await replaceOrganizationServices(
          request.params.org_id,
          request.user.userId,
          services,
        );
        return reply.code(200).send({
          source_id: result.sourceId,
          revision: result.revision,
          service_count: result.serviceCount,
          observed_at: result.observedAt,
        });
      } catch (error) {
        if (error instanceof ServiceDiscoveryError) {
          return sendServiceDiscoveryError(error, reply);
        }
        throw error;
      }
    },
  );
}
