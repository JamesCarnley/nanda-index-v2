import { expect, it } from 'vitest';
import { parseFeedbackFollowerConfig, feedbackSourceFromConfig } from '../../src/connectors/erc8004/feedbackConfig.js';
import { feedbackSourceFingerprint, feedbackSourceId } from '../../src/connectors/erc8004/feedbackValidation.js';
import { config, hash } from '../fixtures/feedback.js';

it('is disabled when absent and accepts an explicit source without an API_BASE_URL', () => {
  expect(parseFeedbackFollowerConfig(undefined)).toBeNull(); expect(parseFeedbackFollowerConfig('  ')).toBeNull();
  const input = config();
  expect(parseFeedbackFollowerConfig(JSON.stringify(input))).toEqual(input);
  expect(parseFeedbackFollowerConfig(JSON.stringify(input))).not.toHaveProperty('rpcTransport');
  expect(feedbackSourceFromConfig(input)).not.toHaveProperty('documentUrls');
});
it('requires administrator HTTPS opt-in and preserves the exact configured endpoint', () => {
  const input = { ...config(), rpcUrl: 'https://feedback-rpc.invalid/private-path?key=synthetic' };
  expect(() => parseFeedbackFollowerConfig(JSON.stringify(input))).toThrow();
  const configured = { ...input, rpcTransport: 'configured-https' };
  expect(parseFeedbackFollowerConfig(JSON.stringify(configured))).toEqual(configured);
});
it.each([null, '', 'https', 'loopback', false, 1, {}, []])('rejects unsupported RPC transport %j', (rpcTransport) => {
  for (const rpcUrl of [config().rpcUrl, 'https://feedback-rpc.invalid/']) {
    expect(() => parseFeedbackFollowerConfig(JSON.stringify({ ...config(), rpcTransport, rpcUrl }))).toThrow();
  }
});
it.each(['http://127.0.0.1:8545/', 'http://feedback-rpc.invalid/', 'https://feedback-rpc.invalid',
  'HTTPS://feedback-rpc.invalid/', 'https://FEEDBACK-RPC.invalid/', 'https://feedback-rpc.invalid:443/',
  'https://feedback-rpc.invalid:0444/', 'https://feedback-rpc.invalid:99999/private?key=synthetic',
  'https://u:p@feedback-rpc.invalid/', 'https://@feedback-rpc.invalid/', 'https://feedback-rpc.invalid/#',
  'https://feedback-rpc.invalid/#fragment', 'https://feedback-rpc.invalid/a/../b', 'https://feedback-rpc.invalid/%2e/b',
  'https://feedback-rpc.invalid/a b', 'https://feedback-rpc.invalid/\n', 'https://feedback-rpc.invalid/\u0000',
  'https://feedback-rpc.invalid/\u007f', 'https://feedback-rpc.invalid/a\\b', 'https:///feedback-rpc.invalid/',
  'https://[not-an-ip]/private?key=synthetic', '//feedback-rpc.invalid/', 'https://feedback-rpc.invalid/é'])
  ('rejects ambiguous or malformed configured HTTPS URL %s', (rpcUrl) => {
    expect(() => parseFeedbackFollowerConfig(JSON.stringify({ ...config(), rpcTransport: 'configured-https', rpcUrl }))).toThrow();
  });
it('bounds configured HTTPS URLs without normalizing paths or queries', () => {
  const prefix = 'https://feedback-rpc.invalid/';
  const input = { ...config(), rpcTransport: 'configured-https', rpcUrl: prefix + 'x'.repeat(2048 - prefix.length) };
  expect(parseFeedbackFollowerConfig(JSON.stringify(input))!.rpcUrl).toBe(input.rpcUrl);
  expect(() => parseFeedbackFollowerConfig(JSON.stringify({ ...input, rpcUrl: input.rpcUrl + 'x' }))).toThrow();
  for (const rpcUrl of ['https://feedback-rpc.invalid:8443/a%2Fb?q=1&key=synthetic', 'https://feedback-rpc.invalid/a/b?q=1&key=synthetic']) {
    expect(parseFeedbackFollowerConfig(JSON.stringify({ ...input, rpcUrl }))!.rpcUrl).toBe(rpcUrl);
  }
});
it('does not extend document URL policy when configured HTTPS RPC is enabled', () => {
  const input = { ...config(), rpcTransport: 'configured-https', rpcUrl: 'https://feedback-rpc.invalid/' };
  expect(() => parseFeedbackFollowerConfig(JSON.stringify({ ...input, documentUrls: ['https://documents.invalid/review'] }))).toThrow();
  expect(parseFeedbackFollowerConfig(JSON.stringify({ ...input, documentUrls: ['http://127.0.0.1:9000/review'] }))!.documentUrls)
    .toEqual(['http://127.0.0.1:9000/review']);
});
it('keeps transport settings out of legacy source IDs and fingerprints', () => {
  const legacy = { ...config(), genesisHash: hash(1) };
  const configured = parseFeedbackFollowerConfig(JSON.stringify({ ...legacy, rpcTransport: 'configured-https',
    rpcUrl: 'https://feedback-rpc.invalid/private?key=synthetic' }))!;
  const source = feedbackSourceFromConfig(configured);
  expect(source).toEqual(feedbackSourceFromConfig(legacy));
  expect(feedbackSourceId(source)).toBe('sha256:af70ca7f98881eed52824b2a015c93719fd5b121f91ccfe13ebc34530a3bbd12');
  expect(feedbackSourceFingerprint(source)).toBe('sha256:50f4f49545421e106f41761289a38c8ec8c46f91d1a6a74d2dc1d2db59845d62');
});
it.each(['http://localhost:9/', 'https://127.0.0.1/', 'http://127.1/', 'http://2130706433/',
  'http://[::1]/', 'http://u:p@127.0.0.1:9/', 'http://127.0.0.1:9/a#x', 'http://127.0.0.1:9',
  'http://127.0.0.1:80/', 'http://127.0.0.1:9/a/../b', 'http://127.0.0.1:9/\n', 'http://127.0.0.1:0/',
  'http://127.0.0.1:9/a\\b'])('rejects noncanonical or nonliteral loopback URL %s', (url) => {
  expect(() => parseFeedbackFollowerConfig(JSON.stringify({ ...config(), rpcUrl: url }))).toThrow();
  expect(() => parseFeedbackFollowerConfig(JSON.stringify({ ...config(), documentUrls: [url] }))).toThrow();
});
it('bounds config shape, counters and exact deduplicated allowlist', () => {
  for (const change of [{ extra: true }, { pollMs: 99 }, { pollMs: 60001 }, { maxBlockSpan: 129 }, { maxBlockSpan: 0 },
    { confirmations: -1 }, { startBlock: '01' }, { documentUrls: ['http://127.0.0.1:9/a', 'http://127.0.0.1:9/a'] },
    { documentUrls: Array.from({ length: 65 }, (_, i) => `http://127.0.0.1:9/${i}`) },
    { rpcUrl: 'http://127.0.0.1:9/' + 'x'.repeat(2048) }]) {
    expect(() => parseFeedbackFollowerConfig(JSON.stringify({ ...config(), ...change }))).toThrow();
  }
  const input = { ...config(), documentUrls: ['http://127.0.0.1:9/a%2Fb?q=1', 'http://127.0.0.1:9/a/b?q=1'] };
  expect(parseFeedbackFollowerConfig(JSON.stringify(input))!.documentUrls).toEqual(input.documentUrls);
});
