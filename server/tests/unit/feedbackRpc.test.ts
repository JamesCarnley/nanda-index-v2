import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { createFeedbackReader, FeedbackBudgetError } from '../../src/connectors/erc8004/feedbackRpc.js';
import { block, config, hash, log } from '../fixtures/feedback.js';

type Call = { id: number; method: string; params: unknown[] };
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function http(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closes.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
async function fixture() {
  const c = config(); const calls: Call[] = [];
  let result: (call: Call) => unknown | Promise<unknown> = (call) => {
    if (call.method === 'eth_chainId') return '0x7a69';
    if (call.method === 'eth_getBlockByNumber') {
      const tag = call.params[0] as string;
      return { number: tag === 'latest' || tag === 'finalized' ? '0xa' : tag,
        hash: tag === '0x0' ? c.genesisHash : hash(Number(BigInt(tag === 'latest' || tag === 'finalized' ? '0xa' : tag))), timestamp: '0x4d2' };
    }
    if (call.method === 'eth_call') return (call.params[0] as { data: string }).data === toFunctionSelector('getVersion()')
      ? encodeAbiParameters([{ type: 'string' }], ['2.0.0']) : encodeAbiParameters([{ type: 'address' }], [c.identityRegistry]);
    return [];
  };
  c.rpcUrl = await http((req, res) => {
    void (async () => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const call = JSON.parse(body) as Call; calls.push(call);
      const value = await result(call); if (res.destroyed) return;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: value }));
    })();
  });
  const raw = log(c);
  const wire = { blockNumber: '0xa', blockHash: raw.block.hash, transactionHash: raw.transactionHash,
    transactionIndex: '0x0', logIndex: '0x0', address: raw.address, topics: raw.topics, data: raw.data, removed: false };
  return { c, calls, reader: createFeedbackReader(c), raw, wire, get result() { return result; }, set result(v) { result = v; } };
}
it('qualifies chain, genesis and pinned version/link at the numbered basis', async () => {
  const f = await fixture(); await f.reader.assertNetwork(); await f.reader.assertRegistry(block());
  expect(f.calls.filter((c) => c.method === 'eth_call').map((c) => c.params[1])).toEqual(['0xa', '0xa']);
  expect(await f.reader.block('latest')).toEqual(block()); expect(await f.reader.finalized()).toEqual(block());
});
it('treats absent or explicitly unsupported finalized tags as unknown, but not transport failures', async () => {
  const f = await fixture(); f.result = () => null; expect(await f.reader.finalized()).toBeNull();
  const unsupported = await http((req, res) => { void (async () => { let body = ''; for await (const chunk of req) body += String(chunk);
    const { id } = JSON.parse(body) as Call; res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tag' } })); })(); });
  expect(await createFeedbackReader({ ...f.c, rpcUrl: unsupported }).finalized()).toBeNull();
  const failed = await http((_req, res) => { res.statusCode = 503; res.end(); });
  await expect(createFeedbackReader({ ...f.c, rpcUrl: failed }).finalized()).rejects.toThrow();
});
it.each(['chain', 'genesis', 'version', 'identity'])('rejects wrong %s qualification', async (kind) => {
  const f = await fixture(); const original = f.result;
  f.result = (c) => kind === 'chain' && c.method === 'eth_chainId' ? '0x1'
    : kind === 'genesis' && c.method === 'eth_getBlockByNumber' ? { number: '0x0', hash: hash(999), timestamp: '0x0' }
      : kind === 'version' && c.method === 'eth_call' ? encodeAbiParameters([{ type: 'string' }], ['3.0.0'])
        : kind === 'identity' && c.method === 'eth_call' && (c.params[0] as { data: string }).data !== toFunctionSelector('getVersion()')
          ? encodeAbiParameters([{ type: 'address' }], ['0x0000000000000000000000000000000000000001']) : original(c);
  await expect(kind === 'chain' || kind === 'genesis' ? f.reader.assertNetwork() : f.reader.assertRegistry(block())).rejects.toThrow();
});
it('retains full shuffled/duplicate three-event logs, numeric order and one header per block', async () => {
  const f = await fixture(); const original = f.result;
  const raws = [log(f.c, { index: '10', kind: 'ResponseAppended' }), log(f.c, { index: '2', kind: 'FeedbackRevoked' }), f.raw];
  f.result = (c) => c.method === 'eth_getLogs' ? [raws[0], raws[1], raws[2], raws[2]].map((r) =>
    ({ ...f.wire, topics: r!.topics, data: r!.data, logIndex: `0x${BigInt(r!.logIndex).toString(16)}` })) : original(c);
  const logs = await f.reader.logs('10', '12');
  expect(logs.map((l) => l.logIndex)).toEqual(['0', '0', '2', '10']);
  expect(logs[0]).toEqual(f.raw);
  expect(f.calls.filter((c) => c.method === 'eth_getBlockByNumber')).toHaveLength(1);
  expect(f.calls[0]!.params).toEqual([{ address: f.c.reputationRegistry, fromBlock: '0xa', toBlock: '0xc', topics: [expect.arrayContaining(f.raw.topics.slice(0, 1))] }]);
  expect((f.calls[0]!.params[0] as { topics: string[][] }).topics[0]).toHaveLength(3);
});
it.each([{ removed: true }, { removed: null }, { blockHash: null }, { transactionHash: null }, { logIndex: null },
  { blockNumber: '0xb' }, { blockNumber: '0x09' }, { topics: [hash(900)] }, { address: '0x0000000000000000000000000000000000000000' },
  { data: '0xzz' }, { blockHash: hash(999) }])('rejects every malformed/removed/wrong-domain log %j', async (change) => {
  const f = await fixture(); const original = f.result;
  f.result = (c) => c.method === 'eth_getLogs' ? [f.wire, { ...f.wire, ...change }] : original(c);
  await expect(f.reader.logs('10', '10')).rejects.toThrow();
});
it('bounds header fanout at four and rejects out-of-range requested header heights', async () => {
  const f = await fixture(); let active = 0; let max = 0; const original = f.result;
  f.result = async (c) => {
    if (c.method === 'eth_getLogs') return Array.from({ length: 8 }, (_, i) => ({ ...f.wire, blockNumber: `0x${(i + 10).toString(16)}`, blockHash: hash(i + 10) }));
    active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 15)); active--; return original(c);
  };
  expect(await f.reader.logs('10', '17')).toHaveLength(8); expect(max).toBeLessThanOrEqual(4);
  f.result = () => ({ number: '0xb', hash: hash(11), timestamp: '0x4d2' });
  await expect(f.reader.block('10')).rejects.toThrow();
});
it('distinguishes explicit log/body budget overflow from malformed data', async () => {
  const f = await fixture(); f.result = () => Array.from({ length: 1001 }, () => f.wire);
  await expect(f.reader.logs('10', '10')).rejects.toBeInstanceOf(FeedbackBudgetError);
  f.result = () => 'x'.repeat(2 * 1024 * 1024);
  await expect(f.reader.logs('10', '10')).rejects.toBeInstanceOf(FeedbackBudgetError);
  f.result = () => ({ bad: true }); await expect(f.reader.logs('10', '10')).rejects.not.toBeInstanceOf(FeedbackBudgetError);
});
it('does not redirect/retry and cancels the deadline even after headers arrive', async () => {
  let hits = 0; const destination = await http((_req, res) => { hits++; res.end('{}'); });
  const redirect = await http((_req, res) => { res.writeHead(302, { location: destination }); res.end(); });
  await expect(createFeedbackReader({ ...config(), rpcUrl: redirect }).assertNetwork()).rejects.toThrow(); expect(hits).toBe(0);
  const hanging = await http((_req, res) => { hits++; res.writeHead(200); res.write('{'); });
  const started = Date.now(); await expect(createFeedbackReader({ ...config(), rpcUrl: hanging }).assertNetwork()).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(6500); expect(hits).toBe(1);
}, 9000);
