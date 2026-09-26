import { expect, it } from 'vitest';
import { parseFeedbackFollowerConfig, feedbackSourceFromConfig } from '../../src/connectors/erc8004/feedbackConfig.js';
import { config } from '../fixtures/feedback.js';

it('is disabled when absent and accepts an explicit source without an API_BASE_URL', () => {
  expect(parseFeedbackFollowerConfig(undefined)).toBeNull(); expect(parseFeedbackFollowerConfig('  ')).toBeNull();
  const input = config();
  expect(parseFeedbackFollowerConfig(JSON.stringify(input))).toEqual(input);
  expect(feedbackSourceFromConfig(input)).not.toHaveProperty('documentUrls');
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
