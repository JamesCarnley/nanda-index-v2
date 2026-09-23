import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createIdentityChainReader } from '../../src/connectors/erc8004/rpc.js';
import type { IdentityFollowerConfig } from '../../src/connectors/erc8004/config.js';

const base: IdentityFollowerConfig = { rpcUrl: '', pollMs: 2000, maxBlockSpan: 200,
  chainId: 31337, registry: `0x${'11'.repeat(20)}`, genesisHash: `0x${'aa'.repeat(32)}`,
  startBlock: '1', adapter: 'nandacity-0.1', confirmations: 0 };

it('aborts an RPC response whose headers arrived but body stalled', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"jsonrpc":"2.0","id":');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test listener missing');
  const controller = new AbortController();
  try {
    const started = Date.now();
    const request = createIdentityChainReader({ ...base,
      rpcUrl: `http://127.0.0.1:${address.port}` }).assertNetwork(controller.signal);
    setTimeout(() => controller.abort(new Error('test tick cancelled')), 100);
    await expect(request).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('rejects an RPC redirect instead of following it', async () => {
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url === '/destination') {
      redirected++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"jsonrpc":"2.0","id":1,"result":"0x7a69"}');
    } else {
      response.writeHead(302, { location: '/destination' });
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test listener missing');
  try {
    await expect(createIdentityChainReader({ ...base,
      rpcUrl: `http://127.0.0.1:${address.port}` }).assertNetwork()).rejects.toThrow();
    expect(redirected).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('reports unknown finality when the provider rejects the finalized tag', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const id = (JSON.parse(body) as { id: number }).id;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id,
        error: { code: -32602, message: 'invalid finalized block tag' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test listener missing');
  try {
    expect(await createIdentityChainReader({ ...base,
      rpcUrl: `http://127.0.0.1:${address.port}` }).finalized()).toBeNull();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('times out a stalled response body within the five-second request deadline', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"jsonrpc":"2.0","id":');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test listener missing');
  try {
    const started = Date.now();
    await expect(createIdentityChainReader({ ...base,
      rpcUrl: `http://127.0.0.1:${address.port}` }).assertNetwork()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(6_500);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 9_000);

it('rejects a response above the two-MiB body budget', async () => {
  const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(oversized);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test listener missing');
  try {
    await expect(createIdentityChainReader({ ...base,
      rpcUrl: `http://127.0.0.1:${address.port}` }).assertNetwork()).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('classifies only an oversized log response as reducible work', async () => {
  const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(oversized);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test listener missing');
  try {
    const reader = createIdentityChainReader({ ...base, rpcUrl: `http://127.0.0.1:${address.port}` });
    await expect(reader.changedAgents('1', '2')).rejects.toThrow('IDENTITY_WORK_BUDGET');
    await expect(reader.identity('7', { number: '2', hash: base.genesisHash, timestamp: 1 }))
      .rejects.not.toThrow('IDENTITY_WORK_BUDGET');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
