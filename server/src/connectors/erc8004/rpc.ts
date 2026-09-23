import { createPublicClient, http, parseEventLogs } from 'viem';
import { identityEvents, identityReadAbi } from './abi.js';
import type { IdentityFollowerConfig } from './config.js';
import type { IdentityChainReader } from './follower.js';
import type { BlockRef } from './types.js';

function clientFor(config: IdentityFollowerConfig, signal?: AbortSignal) {
  return createPublicClient({ transport: http(config.rpcUrl, {
    retryCount: 0, timeout: 5_000, maxResponseBodySize: 2 * 1024 * 1024,
    fetchOptions: signal ? { signal } : undefined,
    fetchFn: (input, init) => {
      const signals = [AbortSignal.timeout(5_000)];
      if (init?.signal) signals.push(init.signal);
      return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
    },
  }) });
}

function blockRef(block: { number: bigint | null; hash: `0x${string}` | null;
  timestamp: bigint }): BlockRef {
  if (block.number === null || block.hash === null) throw new Error('UNNUMBERED_IDENTITY_BLOCK');
  const timestamp = Number(block.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('UNSAFE_IDENTITY_BLOCK_TIME');
  return { number: block.number.toString(), hash: block.hash.toLowerCase() as `0x${string}`, timestamp };
}

function nonexistent(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 6 && current && typeof current === 'object'; i++) {
    const candidate = current as { name?: string; data?: { errorName?: string }; cause?: unknown };
    if (candidate.name === 'ContractFunctionRevertedError' &&
      candidate.data?.errorName === 'ERC721NonexistentToken') return true;
    current = candidate.cause;
  }
  return false;
}

export function createIdentityChainReader(config: IdentityFollowerConfig): IdentityChainReader {
  return {
    async assertNetwork(signal) {
      const client = clientFor(config, signal);
      const [chainId, genesis] = await Promise.all([
        client.getChainId(), client.getBlock({ blockNumber: 0n }),
      ]);
      if (chainId !== config.chainId || genesis.hash?.toLowerCase() !== config.genesisHash) {
        throw new Error('IDENTITY_NETWORK_MISMATCH');
      }
    },
    async block(tag, signal) {
      const client = clientFor(config, signal);
      const result = tag === 'latest' ? await client.getBlock({ blockTag: 'latest' }) :
        await client.getBlock({ blockNumber: BigInt(tag) });
      return blockRef(result);
    },
    async finalized(signal) {
      try {
        return blockRef(await clientFor(config, signal).getBlock({ blockTag: 'finalized' }));
      } catch (error) {
        if (error instanceof Error &&
          ['BlockNotFoundError', 'MethodNotFoundRpcError', 'InvalidParamsRpcError'].includes(error.name)) {
          return null;
        }
        throw error;
      }
    },
    async changedAgents(from, to, signal) {
      const logs = await clientFor(config, signal).getLogs({
        address: config.registry, events: identityEvents,
        fromBlock: BigInt(from), toBlock: BigInt(to),
      });
      if (logs.length > 1000) throw new Error('IDENTITY_WORK_BUDGET');
      const ids = new Set<string>();
      for (const log of parseEventLogs({ abi: identityEvents, logs, strict: true })) {
        if (log.eventName === 'Registered' || log.eventName === 'URIUpdated') {
          ids.add(log.args.agentId.toString());
        } else if (log.eventName === 'Transfer') {
          ids.add(log.args.tokenId.toString());
        }
        if (ids.size > 100) throw new Error('IDENTITY_WORK_BUDGET');
      }
      return [...ids].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    },
    async identity(agentId, at, signal) {
      const client = clientFor(config, signal);
      const tokenId = BigInt(agentId);
      let owner: `0x${string}`;
      try {
        owner = await client.readContract({ address: config.registry, abi: identityReadAbi,
          functionName: 'ownerOf', args: [tokenId], blockNumber: BigInt(at.number) });
      } catch (error) {
        if (nonexistent(error)) return 'missing';
        throw error;
      }
      const agentURI = await client.readContract({ address: config.registry, abi: identityReadAbi,
        functionName: 'tokenURI', args: [tokenId], blockNumber: BigInt(at.number) });
      return { agent: { chainId: config.chainId, registry: config.registry, agentId },
        block: at, owner: owner.toLowerCase() as `0x${string}`, agentURI };
    },
  };
}
