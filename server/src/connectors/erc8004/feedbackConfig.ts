import type { FeedbackSource } from './feedbackTypes.js';
import { feedbackInteger, feedbackShape, validateFeedbackSource } from './feedbackValidation.js';
export type FeedbackFollowerConfig = FeedbackSource & { rpcUrl: string; rpcTransport?: 'configured-https';
  pollMs: number; maxBlockSpan: number; documentUrls: string[] };
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
/** An administrator-selected endpoint, not a DNS/public-IP firewall or document policy. */
export function feedbackRpcUrl(input: unknown, transport: unknown): string {
  if (transport === undefined) return feedbackLocalUrl(input);
  if (transport !== 'configured-https') throw new Error('invalid feedback RPC transport');
  try {
    if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 2048 ||
      /[\s\u0000-\u001f\u007f\\]/.test(input)) throw new Error();
    const url = new URL(input);
    if (url.href !== input || url.protocol !== 'https:' || url.username || url.password || input.includes('#')) throw new Error();
    return input;
  } catch { throw new Error('invalid feedback RPC URL'); }
}
export function parseFeedbackFollowerConfig(raw: string | undefined): FeedbackFollowerConfig | null {
  if (!raw?.trim()) return null;
  const input: unknown = JSON.parse(raw);
  const hasTransport = input !== null && typeof input === 'object' && Object.hasOwn(input, 'rpcTransport');
  const row = feedbackShape(input, ['chainId', 'genesisHash', 'identityRegistry', 'reputationRegistry',
    'startBlock', 'confirmations', 'rpcUrl', 'pollMs', 'maxBlockSpan', 'documentUrls', ...(hasTransport ? ['rpcTransport'] : [])], 'config');
  if (!Array.isArray(row.documentUrls) || row.documentUrls.length > 64) throw new Error('invalid feedback allowlist');
  const documentUrls = row.documentUrls.map(feedbackLocalUrl);
  if (new Set(documentUrls).size !== documentUrls.length) throw new Error('invalid feedback allowlist');
  return { ...feedbackSourceFromConfig(row as FeedbackFollowerConfig), rpcUrl: feedbackRpcUrl(row.rpcUrl, row.rpcTransport),
    ...(hasTransport ? { rpcTransport: 'configured-https' as const } : {}),
    pollMs: feedbackInteger(row.pollMs, 'pollMs', 100, 60000),
    maxBlockSpan: feedbackInteger(row.maxBlockSpan, 'maxBlockSpan', 1, 128), documentUrls };
}
export function feedbackSourceFromConfig(input: FeedbackFollowerConfig): FeedbackSource {
  return validateFeedbackSource({ chainId: input.chainId, genesisHash: input.genesisHash,
    identityRegistry: input.identityRegistry, reputationRegistry: input.reputationRegistry,
    startBlock: input.startBlock, confirmations: input.confirmations });
}
