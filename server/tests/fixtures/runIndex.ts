import { buildServer } from '../../src/server.js';

const { fastify, config } = await buildServer({ logger: false });
process.on('SIGTERM', () => { void fastify.close().then(() => process.exit(0)); });
await fastify.listen({ host: '127.0.0.1', port: config.port });
