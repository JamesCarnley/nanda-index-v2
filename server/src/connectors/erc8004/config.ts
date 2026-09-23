import type { IdentitySource } from './types.js';
import { validateSource } from './validation.js';

export type IdentityFollowerConfig = IdentitySource & {
  rpcUrl: string; pollMs: number; maxBlockSpan: number;
};

export function parseIdentityFollowerConfig(raw: string | undefined,
  apiBaseUrl: string | undefined): IdentityFollowerConfig | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (!apiBaseUrl || apiBaseUrl.trim() === '') throw new Error('API_BASE_URL is required for ERC8004 identity follower');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('ERC8004_IDENTITY_CONFIG must be strict JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ERC8004_IDENTITY_CONFIG must be an object');
  }
  const object = value as Record<string, unknown>;
  const keys = ['rpcUrl', 'pollMs', 'maxBlockSpan', 'chainId', 'registry',
    'genesisHash', 'startBlock', 'adapter', 'confirmations'];
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) {
    throw new Error('ERC8004_IDENTITY_CONFIG has missing or unknown fields');
  }
  const source = validateSource({ chainId: object.chainId, registry: object.registry,
    genesisHash: object.genesisHash, startBlock: object.startBlock,
    adapter: object.adapter, confirmations: object.confirmations });
  if (typeof object.rpcUrl !== 'string' || object.rpcUrl.length > 2048 ||
      object.rpcUrl.trim() !== object.rpcUrl) throw new Error('invalid follower RPC URL');
  let url: URL;
  try { url = new URL(object.rpcUrl); } catch { throw new Error('invalid follower RPC URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('invalid follower RPC URL');
  }
  if (typeof object.pollMs !== 'number' || !Number.isSafeInteger(object.pollMs) ||
      object.pollMs < 100 || object.pollMs > 60_000) throw new Error('invalid follower pollMs');
  if (typeof object.maxBlockSpan !== 'number' || !Number.isSafeInteger(object.maxBlockSpan) ||
      object.maxBlockSpan < 1 || object.maxBlockSpan > 10_000) throw new Error('invalid follower maxBlockSpan');
  return { ...source, rpcUrl: object.rpcUrl, pollMs: object.pollMs, maxBlockSpan: object.maxBlockSpan };
}

export function identitySourceFromConfig(config: IdentityFollowerConfig): IdentitySource {
  const { chainId, registry, genesisHash, startBlock, adapter, confirmations } = config;
  return { chainId, registry, genesisHash, startBlock, adapter, confirmations };
}
