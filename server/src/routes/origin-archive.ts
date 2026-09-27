import type { FastifyInstance, FastifyReply } from 'fastify';
import { originArchiveDigest } from '../connectors/originArchive/validation.js';
import { readOriginArchiveDocumentBlob, readOriginArchiveSnapshotBlob,
  readOriginArchiveSnapshotStatus } from '../db/queries/originArchive.js';

function emptyQuery(input: unknown): void {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 0) {
    throw new Error('invalid origin archive query');
  }
}

function failure(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('invalid origin archive')) return reply.code(400).send({ error: 'INVALID_INPUT' });
  if (message === 'origin archive blob integrity failure') {
    return reply.code(500).send({ error: 'ORIGIN_ARCHIVE_INTEGRITY' });
  }
  return reply.code(500).send({ error: 'INTERNAL_ERROR' });
}

function binary(reply: FastifyReply, blob: { bytes: Buffer; byteLength: string }) {
  return reply.type('application/octet-stream').header('x-content-type-options', 'nosniff')
    .header('content-length', blob.byteLength).send(blob.bytes);
}

/** DB-only retained bytes and neutral availability. GET never seeds or acquires. */
export async function registerOriginArchiveRoutes(fastify: FastifyInstance): Promise<void> {
  const options = { onRequest: async (_request: unknown, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
  } };
  fastify.get<{ Params: { digest: string } }>('/api/ard/origin-archive/snapshots/:digest/status', options,
    async (request, reply) => {
      try {
        emptyQuery(request.query); const digest = originArchiveDigest(request.params.digest);
        const status = await readOriginArchiveSnapshotStatus(digest);
        return status ? { ...status, authenticity: 'not-evaluated' as const }
          : reply.code(404).send({ error: 'NOT_FOUND' });
      } catch (error) { return failure(reply, error); }
    });
  fastify.get<{ Params: { digest: string } }>('/api/ard/origin-archive/snapshots/:digest', options,
    async (request, reply) => {
      try {
        emptyQuery(request.query); const blob = await readOriginArchiveSnapshotBlob(originArchiveDigest(request.params.digest));
        return blob ? binary(reply, blob) : reply.code(404).send({ error: 'NOT_FOUND' });
      } catch (error) { return failure(reply, error); }
    });
  fastify.get<{ Params: { digest: string } }>('/api/ard/origin-archive/documents/:digest', options,
    async (request, reply) => {
      try {
        emptyQuery(request.query); const blob = await readOriginArchiveDocumentBlob(originArchiveDigest(request.params.digest));
        return blob ? binary(reply, blob) : reply.code(404).send({ error: 'NOT_FOUND' });
      } catch (error) { return failure(reply, error); }
    });
}
