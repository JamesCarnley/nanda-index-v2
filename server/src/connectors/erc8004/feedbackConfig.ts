import type { FeedbackSource } from './feedbackTypes.js';
import { feedbackInteger, feedbackShape, validateFeedbackSource } from './feedbackValidation.js';
export type FeedbackFollowerConfig = FeedbackSource & { rpcUrl: string; pollMs: number; maxBlockSpan: number; documentUrls: string[] };
/** Canonical literal loopback only. Event URLs are compared exactly, never normalized. */
export function feedbackLocalUrl(input: unknown): string {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 2048 ||
    !/^http:\/\/127\.0\.0\.1(?::[1-9][0-9]*)?\//.test(input) || /[\s\u0000-\u001f\u007f\\]/.test(input)) {
    throw new Error('invalid feedback URL');
  }
  const url = new URL(input);
  if (url.href !== input || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
    url.username || url.password || input.includes('#')) throw new Error('invalid feedback URL');
  return input;
}
export function parseFeedbackFollowerConfig(raw: string | undefined): FeedbackFollowerConfig | null {
  if (!raw?.trim()) return null;
  const row = feedbackShape(JSON.parse(raw), ['chainId', 'genesisHash', 'identityRegistry', 'reputationRegistry',
    'startBlock', 'confirmations', 'rpcUrl', 'pollMs', 'maxBlockSpan', 'documentUrls'], 'config');
  if (!Array.isArray(row.documentUrls) || row.documentUrls.length > 64) throw new Error('invalid feedback allowlist');
  const documentUrls = row.documentUrls.map(feedbackLocalUrl);
  if (new Set(documentUrls).size !== documentUrls.length) throw new Error('invalid feedback allowlist');
  return { ...feedbackSourceFromConfig(row as FeedbackFollowerConfig), rpcUrl: feedbackLocalUrl(row.rpcUrl),
    pollMs: feedbackInteger(row.pollMs, 'pollMs', 100, 60000),
    maxBlockSpan: feedbackInteger(row.maxBlockSpan, 'maxBlockSpan', 1, 128), documentUrls };
}
export function feedbackSourceFromConfig(input: FeedbackFollowerConfig): FeedbackSource {
  return validateFeedbackSource({ chainId: input.chainId, genesisHash: input.genesisHash,
    identityRegistry: input.identityRegistry, reputationRegistry: input.reputationRegistry,
    startBlock: input.startBlock, confirmations: input.confirmations });
}
