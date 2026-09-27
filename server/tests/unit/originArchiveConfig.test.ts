import { expect, it } from 'vitest';
import { parseOriginArchiveConfig } from '../../src/connectors/originArchive/config.js';
import { originConfig, originDigest } from '../fixtures/originArchive.js';

it('is disabled when absent or blank and accepts the exact bounded configuration', () => {
  expect(parseOriginArchiveConfig(undefined)).toBeNull();
  expect(parseOriginArchiveConfig('  ')).toBeNull();
  const input = originConfig({ sourceBaseUrl: 'http://127.0.0.1:9400/public-origin/' });
  expect(parseOriginArchiveConfig(JSON.stringify(input))).toEqual(input);
});

it.each([
  'http://localhost:9400/public-origin/',
  'https://127.0.0.1:9400/public-origin/',
  'http://127.1:9400/public-origin/',
  'http://2130706433:9400/public-origin/',
  'http://[::1]:9400/public-origin/',
  'http://u:p@127.0.0.1:9400/public-origin/',
  'http://127.0.0.1/public-origin/',
  'http://127.0.0.1:0/public-origin/',
  'http://127.0.0.1:9400/public-origin',
  'http://127.0.0.1:9400/a/../public-origin/',
  'http://127.0.0.1:9400/public-origin/?q=1',
  'http://127.0.0.1:9400/public-origin/?',
  'http://127.0.0.1:9400/public-origin/#x',
  'http://127.0.0.1:9400/public-origin/#',
  'http://127.0.0.1:9400/public-origin/\n',
  'http://127.0.0.1:9400/public-origin/\\x',
  'http://127.0.0.1:9400/public-origin/%0A/',
  'http://127.0.0.1:9400/public-origin/%5C/',
])('rejects noncanonical or nonliteral loopback base URL %s', (sourceBaseUrl) => {
  expect(() => parseOriginArchiveConfig(JSON.stringify(originConfig({ sourceBaseUrl })))).toThrow(/origin archive/);
});

it('requires an exact shape, bounded poll and one or two unique lowercase nonzero digests', () => {
  const base = originConfig();
  const invalid = [
    { ...base, extra: true },
    { ...base, pollMs: 99 },
    { ...base, pollMs: 60001 },
    { ...base, snapshotDigests: [] },
    { ...base, snapshotDigests: [originDigest(1), originDigest(2), originDigest(3)] },
    { ...base, snapshotDigests: [originDigest(1), originDigest(1)] },
    { ...base, snapshotDigests: [`0x${'0'.repeat(64)}`] },
    { ...base, snapshotDigests: [`0x${'A'.repeat(64)}`] },
    { ...base, snapshotDigests: ['bad'] },
  ];
  for (const value of invalid) expect(() => parseOriginArchiveConfig(JSON.stringify(value))).toThrow(/origin archive/);
  expect(() => parseOriginArchiveConfig(JSON.stringify({ ...base,
    sourceBaseUrl: `http://127.0.0.1:9400/${'x'.repeat(2048)}/` }))).toThrow(/origin archive/);
});
