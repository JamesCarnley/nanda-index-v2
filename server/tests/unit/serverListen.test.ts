import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { listenServer } from '../../src/server.js';

it('binds the actual listener to the configured loopback address', async () => {
  const fastify = Fastify({ logger: false });
  try {
    await listenServer(fastify, { port: 0, bindHost: '127.0.0.1' });
    expect((fastify.server.address() as AddressInfo).address).toBe('127.0.0.1');
  } finally {
    await fastify.close();
  }
});
