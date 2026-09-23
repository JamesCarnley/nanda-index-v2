import { expect, it } from 'vitest';
import { parseIdentityFollowerConfig } from '../../src/connectors/erc8004/config.js';

const enabled = { rpcUrl: 'http://127.0.0.1:8545', chainId: 31337,
  registry: `0x${'11'.repeat(20)}`, genesisHash: `0x${'aa'.repeat(32)}`,
  startBlock: '1', adapter: 'nandacity-0.1', confirmations: 0,
  pollMs: 2000, maxBlockSpan: 200 };

it('is disabled by default and strictly validates enabled settings', () => {
  expect(parseIdentityFollowerConfig(undefined, undefined)).toBeNull();
  expect(parseIdentityFollowerConfig(JSON.stringify(enabled), 'http://localhost:3001'))
    .toEqual(enabled);
  expect(() => parseIdentityFollowerConfig(JSON.stringify(enabled), undefined)).toThrow('API_BASE_URL');
  for (const wrong of [
    { ...enabled, signingKey: 'secret' }, { ...enabled, chainId: 0 },
    { ...enabled, genesisHash: '0x12' }, { ...enabled, adapter: 'other' },
    { ...enabled, rpcUrl: 'file:///tmp/socket' },
    { ...enabled, startBlock: '-1' }, { ...enabled, confirmations: -1 },
  ]) expect(() => parseIdentityFollowerConfig(JSON.stringify(wrong), 'https://index.example'))
    .toThrow();
});
