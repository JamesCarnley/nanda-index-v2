import type { FastifyInstance } from 'fastify';
import {
  readIdentityObservationRecord, readLatestIdentityWithCoverage,
} from '../db/queries/identityObservations.js';
import { parseObservationId, validateAgent } from '../connectors/erc8004/validation.js';

function invalid(reply: import('fastify').FastifyReply) {
  return reply.code(400).send({ error: 'INVALID_INPUT' });
}

/** Public bounded observation reads. Connector mutation is never an HTTP route. */
export async function registerIdentityObservationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { chainId: string; registry: string; agentId: string } }>(
    '/api/ard/erc8004/:chainId/:registry/:agentId',
    { schema: { tags: ['ard'], summary: 'Read the latest ERC-8004 observation and source coverage' } },
    async (request, reply) => {
      let agent;
      try {
        const { chainId, registry, agentId } = request.params;
        if (!/^[1-9][0-9]{0,15}$/.test(chainId) || agentId.length > 78) return invalid(reply);
        agent = validateAgent({ chainId: Number(chainId), registry, agentId });
      } catch { return invalid(reply); }
      const record = await readLatestIdentityWithCoverage(agent);
      if (!record) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.code(200).send(record);
    },
  );

  fastify.get<{ Params: { observationId: string } }>(
    '/api/ard/identity-observations/:observationId',
    { schema: { tags: ['ard'], summary: 'Read one retained immutable identity observation' } },
    async (request, reply) => {
      let observationId;
      try { observationId = parseObservationId(request.params.observationId); }
      catch { return invalid(reply); }
      const record = await readIdentityObservationRecord(observationId);
      if (!record) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.code(200).send(record);
    },
  );
}
