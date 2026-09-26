import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFeedbackDocument, readFeedbackEventWithCoverage, readFeedbackHistory, readFeedbackSource } from '../db/queries/feedbackObservations.js';
import { feedbackDecimal, feedbackHex, feedbackId } from '../connectors/erc8004/feedbackValidation.js';
import type { FeedbackHistoryInput } from '../connectors/erc8004/feedbackTypes.js';

function query(input: unknown, allowed: string[] = []): Record<string, string> {
  if (!input || typeof input !== 'object' || Object.entries(input).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')) {
    throw new Error('invalid feedback query');
  }
  return input as Record<string, string>;
}
function failure(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'stale feedback cursor generation') return reply.code(409).send({ error: 'STALE_FEEDBACK_CURSOR' });
  if (/^invalid feedback /.test(message)) return reply.code(400).send({ error: 'INVALID_INPUT' });
  if (message === 'feedback document integrity failure') return reply.code(500).send({ error: 'FEEDBACK_DOCUMENT_INTEGRITY' });
  return reply.code(500).send({ error: 'INTERNAL_ERROR' });
}
const semantics = 'not-evaluated' as const;
/** Read-only observations; no fetch, job creation, publication or active-review verdict. */
export async function registerFeedbackObservationRoutes(fastify: FastifyInstance): Promise<void> {
  const options = { onRequest: async (_request: unknown, reply: FastifyReply) => { reply.header('cache-control', 'no-store'); } };
  fastify.get<{ Params: { sourceId: string } }>('/api/ard/feedback/sources/:sourceId', options, async (request, reply) => {
    try {
      query(request.query); const coverage = await readFeedbackSource(feedbackId(request.params.sourceId));
      if (!coverage) return reply.code(404).send({ error: 'NOT_FOUND' });
      const counts = coverage.retention;
      return { coverage, retention: { scope: 'canonical-prefix', newFeedbackEvents:
        (BigInt(counts.retained) + BigInt(counts.pending) + BigInt(counts.blocked)).toString(), ...counts }, semantics };
    } catch (error) { return failure(reply, error); }
  });
  fastify.get<{ Params: { sourceId: string; agentId: string } }>('/api/ard/feedback/sources/:sourceId/agents/:agentId', options, async (request, reply) => {
    try {
      const values = query(request.query, ['reviewer', 'view', 'pageSize', 'cursor']);
      const pageSize = values.pageSize ?? '20'; const view = values.view ?? 'canonical-prefix';
      if (!/^[1-9][0-9]{0,2}$/.test(pageSize) || Number(pageSize) > 100 || !['canonical-prefix', 'all-retained'].includes(view)) {
        throw new Error('invalid feedback query');
      }
      const page = await readFeedbackHistory({ sourceId: feedbackId(request.params.sourceId), agentId: feedbackDecimal(request.params.agentId, 'agentId'),
        pageSize: Number(pageSize), view: view as FeedbackHistoryInput['view'],
        ...(values.reviewer === undefined ? {} : { reviewer: feedbackHex(values.reviewer, 'reviewer', 20) }),
        ...(values.cursor === undefined ? {} : { cursor: values.cursor }) });
      if (!page.coverage) return reply.code(404).send({ error: 'NOT_FOUND' });
      const { records, ...rest } = page; return { ...rest, items: records };
    } catch (error) { return failure(reply, error); }
  });
  fastify.get<{ Params: { eventId: string } }>('/api/ard/feedback/events/:eventId', options, async (request, reply) => {
    try {
      query(request.query); const result = await readFeedbackEventWithCoverage(feedbackId(request.params.eventId));
      return result ? { ...result, semantics } : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return failure(reply, error); }
  });
  fastify.get<{ Params: { digest: string } }>('/api/ard/feedback/documents/:digest', options, async (request, reply) => {
    try {
      query(request.query); const document = await readFeedbackDocument(feedbackHex(request.params.digest, 'digest', 32));
      if (!document) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.type('application/octet-stream').header('x-content-type-options', 'nosniff')
        .header('content-length', document.byteLength).send(document.bytes);
    } catch (error) { return failure(reply, error); }
  });
}
