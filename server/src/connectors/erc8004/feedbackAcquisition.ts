import type { Hex } from './types.js';
import { keccak256 } from 'viem';
import { feedbackLocalUrl, feedbackSourceFromConfig, type FeedbackFollowerConfig } from './feedbackConfig.js';
import { feedbackDecimal, feedbackSourceId } from './feedbackValidation.js';
import { claimDueFeedbackJobs, finishFeedbackJob, readFeedbackDocument } from '../../db/queries/feedbackObservations.js';
export type FeedbackFetchResult = { kind: 'retained'; bytes: Uint8Array } | { kind: 'retry'; reason: string; actualHash?: Hex; actualSize?: string };
export function feedbackRetryDelay(attempts: string): number {
  const count = BigInt(feedbackDecimal(attempts, 'attempts')); const exponent = count > 10n ? 9n : count > 0n ? count - 1n : 0n;
  return Math.min(300000, 1000 * 2 ** Number(exponent));
}
/** Exact binary acquisition only; no parsing, signature validation or response-document resolver. */
export async function fetchFeedbackDocument(uri: string, hash: Hex, parent?: AbortSignal): Promise<FeedbackFetchResult> {
  feedbackLocalUrl(uri);
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 5000);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  let body: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(uri, { method: 'GET', redirect: 'error', credentials: 'omit', signal,
      headers: { 'accept-encoding': 'identity' } });
    if (response.status !== 200) return { kind: 'retry', reason: 'http-status' };
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding')!.toLowerCase() !== 'identity') {
      return { kind: 'retry', reason: 'content-encoding' };
    }
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && BigInt(length) > 6144n) return { kind: 'retry', reason: 'body-too-large' };
    if (!response.body) return { kind: 'retry', reason: 'missing-body' };
    body = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await body.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 6144) return { kind: 'retry', reason: 'body-too-large', actualSize: String(size) };
      chunks.push(chunk.value);
    }
    signal.throwIfAborted(); const bytes = Buffer.concat(chunks); const actualHash = keccak256(bytes);
    return actualHash === hash ? { kind: 'retained', bytes }
      : { kind: 'retry', reason: 'hash-mismatch', actualHash, actualSize: String(size) };
  } catch {
    parent?.throwIfAborted();
    return { kind: 'retry', reason: deadline.signal.aborted ? 'fetch-timeout' : 'fetch-failed' };
  } finally { deadline.abort(); clearTimeout(timer); await body?.cancel().catch(() => {}); }
}
export async function sweepFeedbackDocuments(config: FeedbackFollowerConfig, signal?: AbortSignal, clock: () => Date = () => new Date()): Promise<void> {
  if (signal?.aborted) return;
  const jobs = await claimDueFeedbackJobs({ sourceId: feedbackSourceId(feedbackSourceFromConfig(config)),
    limit: 4, now: clock().toISOString(), leaseMs: 30000 });
  // Claims are committed before HTTP. All work, including each finish CAS, is awaited before the next sweep/close.
  const results = await Promise.allSettled(jobs.map(async (job) => {
    try {
      signal?.throwIfAborted();
      const document = await readFeedbackDocument(job.feedbackHash); signal?.throwIfAborted();
      let result: FeedbackFetchResult;
      if (document) result = { kind: 'retained', bytes: document.bytes };
      else {
        let allowed = false;
        try { allowed = job.feedbackURI !== null && feedbackLocalUrl(job.feedbackURI) === job.feedbackURI && config.documentUrls.includes(job.feedbackURI); }
        catch { /* A valid Solidity URI is not necessarily an administratively allowed canonical URL. */ }
        result = allowed ? await fetchFeedbackDocument(job.feedbackURI!, job.feedbackHash, signal)
          : { kind: 'retry', reason: 'url-not-allowed' };
      }
      signal?.throwIfAborted(); const now = clock();
      await finishFeedbackJob({ eventId: job.eventId, expectedJobVersion: job.jobVersion, now: now.toISOString(),
        outcome: result.kind === 'retained' ? result : { ...result, nextAttemptAt: new Date(now.getTime() + feedbackRetryDelay(job.attempts)).toISOString() } });
    } catch (error) { if (!signal?.aborted) throw error; /* Let a shutdown-aborted lease expire. */ }
  }));
  if (results.some((result) => result.status === 'rejected')) throw new Error('feedback-sweep-failed');
}
