import { keccak256 } from 'viem';
import type { OriginArchiveConfig } from './config.js';
import { originArchiveSourceId } from './config.js';
import type { OriginArchiveJobKind, OriginDigest } from './types.js';
import { claimOriginArchiveJobs, finishOriginArchiveJob, readOriginArchiveBlob } from '../../db/queries/originArchive.js';

export type OriginArchiveFetchResult =
  | { kind: 'retained'; bytes: Uint8Array }
  | { kind: 'retry'; reason: string; actualHash?: OriginDigest; actualSize?: string };

export function originArchiveRetryDelay(attempts: string): number {
  const count = BigInt(attempts);
  const exponent = count > 10n ? 9n : count > 0n ? count - 1n : 0n;
  return Math.min(300000, 1000 * 2 ** Number(exponent));
}

export async function fetchOriginArchiveBlob(url: string, digest: OriginDigest, kind: OriginArchiveJobKind,
  parent?: AbortSignal): Promise<OriginArchiveFetchResult> {
  const maxBytes = kind === 'snapshot' ? 32768 : 6144;
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 5000);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  let body: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal,
      headers: { 'accept-encoding': 'identity' } });
    if (response.status !== 200) return { kind: 'retry', reason: 'http-status' };
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') return { kind: 'retry', reason: 'content-encoding' };
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maxBytes))) {
      return { kind: 'retry', reason: 'body-too-large' };
    }
    if (!response.body) return { kind: 'retry', reason: 'missing-body' };
    body = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await body.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) return { kind: 'retry', reason: 'body-too-large', actualSize: String(size) };
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks); const actualHash = keccak256(bytes);
    return actualHash === digest ? { kind: 'retained', bytes }
      : { kind: 'retry', reason: 'hash-mismatch', actualHash, actualSize: String(size) };
  } catch {
    parent?.throwIfAborted();
    return { kind: 'retry', reason: deadline.signal.aborted ? 'fetch-timeout' : 'fetch-failed' };
  } finally {
    deadline.abort(); clearTimeout(timer);
    if (body) await Promise.race([
      body.cancel().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
  }
}

export async function sweepOriginArchive(config: OriginArchiveConfig, signal?: AbortSignal,
  clock: () => Date = () => new Date()): Promise<void> {
  if (signal?.aborted) return;
  const sourceId = originArchiveSourceId(config);
  const jobs = await claimOriginArchiveJobs({ sourceId, limit: 4, now: clock().toISOString(), leaseMs: 30000 });
  const results = await Promise.allSettled(jobs.map(async (job) => {
    try {
      signal?.throwIfAborted();
      const retained = await readOriginArchiveBlob(job.digest); signal?.throwIfAborted();
      let result: OriginArchiveFetchResult;
      if (retained && (job.kind === 'snapshot' || Number(retained.byteLength) <= 6144)) {
        result = { kind: 'retained', bytes: retained.bytes };
      } else if (retained) {
        result = { kind: 'retry', reason: 'body-too-large', actualSize: retained.byteLength };
      } else {
        const directory = job.kind === 'snapshot' ? 'snapshots' : 'documents';
        result = await fetchOriginArchiveBlob(`${config.sourceBaseUrl}${directory}/${job.digest}`, job.digest, job.kind, signal);
      }
      signal?.throwIfAborted(); const now = clock();
      await finishOriginArchiveJob({ sourceId, kind: job.kind, digest: job.digest,
        expectedJobVersion: job.jobVersion, now: now.toISOString(), outcome: result.kind === 'retained' ? result : {
          ...result, nextAttemptAt: new Date(now.getTime() + originArchiveRetryDelay(job.attempts)).toISOString(),
        } });
    } catch (error) {
      if (!signal?.aborted) throw error;
      // An aborted claim remains leased and is reclaimed by the next worker.
    }
  }));
  if (results.some((result) => result.status === 'rejected')) throw new Error('origin-archive-sweep-failed');
}
