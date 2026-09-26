import { decodeFunctionResult, encodeFunctionData, toEventSelector } from 'viem';
import { feedbackLocalUrl, type FeedbackFollowerConfig } from './feedbackConfig.js';
import type { RawFeedbackLog } from './feedbackTypes.js';
import type { BlockRef, Hex } from './types.js';
import { feedbackEvents, feedbackRegistryReads } from './feedbackAbi.js';
import { feedbackDecimal, feedbackHex } from './feedbackValidation.js';
export interface FeedbackReader {
  assertNetwork(signal?: AbortSignal): Promise<void>;
  block(tag: string, signal?: AbortSignal): Promise<BlockRef>;
  finalized(signal?: AbortSignal): Promise<BlockRef | null>;
  assertRegistry(at: BlockRef, signal?: AbortSignal): Promise<void>;
  logs(from: string, to: string, signal?: AbortSignal): Promise<RawFeedbackLog[]>;
}
export class FeedbackBudgetError extends Error { constructor() { super('feedback-rpc-budget'); } }
class RpcFault extends Error { constructor(readonly code: number) { super('feedback-rpc-fault'); } }
const invalid = (): never => { throw new Error('feedback-rpc-invalid'); };
const quantity = (value: unknown, bits = 256): string => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || value.length > 66) invalid();
  return feedbackDecimal(BigInt(value as string).toString(), 'RPC quantity', bits);
};
const tagHex = (value: string): string => `0x${BigInt(feedbackDecimal(value, 'block tag')).toString(16)}`;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
};
const limit = 2 * 1024 * 1024;
export function createFeedbackReader(config: FeedbackFollowerConfig): FeedbackReader {
  const url = feedbackLocalUrl(config.rpcUrl); let requestId = 0;
  async function rpc(method: string, params: unknown[], parent?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let body: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const id = ++requestId;
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal, redirect: 'error', credentials: 'omit' });
      if (response.status !== 200 || !response.body ||
        (response.headers.get('content-encoding') && response.headers.get('content-encoding')!.toLowerCase() !== 'identity')) invalid();
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(limit)) throw new FeedbackBudgetError();
      body = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const chunk = await body.read(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > limit) throw new FeedbackBudgetError(); chunks.push(chunk.value); }
      signal.throwIfAborted();
      const result = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      if (result.jsonrpc !== '2.0' || result.id !== id) invalid();
      if (Object.hasOwn(result, 'error')) {
        const error = object(result.error); if (typeof error.code !== 'number' || !Number.isSafeInteger(error.code)) invalid();
        throw new RpcFault(error.code as number);
      }
      if (!Object.hasOwn(result, 'result')) invalid(); return result.result;
    } catch (error) {
      if (error instanceof FeedbackBudgetError || error instanceof RpcFault) throw error;
      throw new Error(signal.aborted ? 'feedback-rpc-aborted' : 'feedback-rpc-failed');
    } finally { controller.abort(); clearTimeout(timer); await body?.cancel().catch(() => {}); }
  }
  function header(value: unknown, tag: string): BlockRef {
    const row = object(value);
    const number = quantity(row.number); const timestamp = Number(quantity(row.timestamp));
    if ((tag !== 'latest' && tag !== 'finalized' && number !== tag) || !Number.isSafeInteger(timestamp)) invalid();
    return { number, hash: feedbackHex(row.hash, 'RPC block hash', 32), timestamp };
  }
  async function block(tag: string, signal?: AbortSignal): Promise<BlockRef> {
    const requested = tag === 'latest' || tag === 'finalized' ? tag : tagHex(tag);
    return header(await rpc('eth_getBlockByNumber', [requested, false], signal), tag);
  }
  const selectors = feedbackEvents.map(toEventSelector);
  return {
    block,
    async finalized(signal) {
      try { const value = await rpc('eth_getBlockByNumber', ['finalized', false], signal); return value === null ? null : header(value, 'finalized'); }
      catch (error) { if (error instanceof RpcFault && [-32601, -32602].includes(error.code)) return null; throw error; }
    },
    async assertNetwork(signal) {
      if (quantity(await rpc('eth_chainId', [], signal)) !== String(config.chainId) ||
        (await block('0', signal)).hash !== config.genesisHash) throw new Error('feedback-network-mismatch');
    },
    async assertRegistry(at, signal) {
      const read = async (functionName: 'getVersion' | 'getIdentityRegistry') => {
        const data = await rpc('eth_call', [{ to: config.reputationRegistry,
          data: encodeFunctionData({ abi: feedbackRegistryReads, functionName }) }, tagHex(at.number)], signal);
        if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) invalid();
        return decodeFunctionResult({ abi: feedbackRegistryReads, functionName, data: data as Hex });
      };
      if (await read('getVersion') !== '2.0.0' ||
        String(await read('getIdentityRegistry')).toLowerCase() !== config.identityRegistry) throw new Error('feedback-registry-mismatch');
    },
    async logs(from, to, parent) {
      const start = BigInt(feedbackDecimal(from, 'from')); const end = BigInt(feedbackDecimal(to, 'to'));
      if (end < start || end - start >= 128n) invalid();
      const rows = await rpc('eth_getLogs', [{ address: config.reputationRegistry, fromBlock: tagHex(from),
        toBlock: tagHex(to), topics: [selectors] }], parent);
      if (!Array.isArray(rows)) invalid();
      if ((rows as unknown[]).length > 1000) throw new FeedbackBudgetError();
      const prepared = (rows as unknown[]).map((input) => {
        const row = object(input); const number = quantity(row.blockNumber);
        if (row.removed !== false || BigInt(number) < start || BigInt(number) > end ||
          !Array.isArray(row.topics) || row.topics.length !== 4 || typeof row.data !== 'string' ||
          !/^0x(?:[0-9a-fA-F]{2})*$/.test(row.data)) invalid();
        const topics = (row.topics as unknown[]).map((value) => feedbackHex(value, 'RPC topic', 32));
        if (!selectors.includes(topics[0]!)) invalid();
        const data = (row.data as string).toLowerCase() as Hex;
        if ((data.length - 2) / 2 + 268 > 65536) throw new FeedbackBudgetError();
        const address = feedbackHex(row.address, 'RPC address', 20);
        if (address !== config.reputationRegistry) invalid();
        return { number, hash: feedbackHex(row.blockHash, 'RPC blockHash', 32), address, topics, data,
          transactionHash: feedbackHex(row.transactionHash, 'RPC transactionHash', 32),
          transactionIndex: quantity(row.transactionIndex, 64), logIndex: quantity(row.logIndex, 64) };
      });
      const heights = [...new Set(prepared.map((row) => row.number))];
      const headers = new Map<string, BlockRef>(); let next = 0; let failure: unknown;
      const abort = new AbortController(); const signal = parent ? AbortSignal.any([parent, abort.signal]) : abort.signal;
      // Await all workers on failure, including any in-flight request body.
      await Promise.all(Array.from({ length: Math.min(4, heights.length) }, async () => {
        try { while (!signal.aborted && next < heights.length) { const height = heights[next++]!; headers.set(height, await block(height, signal)); } }
        catch (error) { failure ??= error; abort.abort(); }
      }));
      if (failure) throw failure; parent?.throwIfAborted();
      const logs = prepared.map(({ number, hash, ...raw }): RawFeedbackLog => {
        const header = headers.get(number); if (!header || header.hash !== hash) invalid();
        return { ...raw, block: header! };
      });
      if (Buffer.byteLength(JSON.stringify(logs), 'utf8') > limit) throw new FeedbackBudgetError();
      logs.sort((a, b) => { for (const [x, y] of [[a.block.number, b.block.number], [a.transactionIndex, b.transactionIndex], [a.logIndex, b.logIndex]]) {
        if (BigInt(x!) < BigInt(y!)) return -1; if (BigInt(x!) > BigInt(y!)) return 1; } return 0; });
      return logs;
    },
  };
}
