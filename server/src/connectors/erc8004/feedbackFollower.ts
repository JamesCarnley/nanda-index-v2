import { feedbackSourceFromConfig, type FeedbackFollowerConfig } from './feedbackConfig.js';
import { FeedbackBudgetError, type FeedbackReader } from './feedbackRpc.js';
import type { FeedbackCoverage, RawFeedbackLog } from './feedbackTypes.js';
import type { BlockRef } from './types.js';
import { sameFeedbackBlock } from './feedbackValidation.js';
import { applyFeedbackBatch, markFeedbackUnavailable, readFeedbackCoverage, refreshFeedbackCoverage,
  withdrawFeedbackSource } from '../../db/queries/feedbackObservations.js';

/** RPC-qualified last observation, not a state proof or a promise of RPC completeness. */
export async function syncFeedbackOnce(config: FeedbackFollowerConfig, reader: FeedbackReader, external?: AbortSignal): Promise<FeedbackCoverage> {
  const source = feedbackSourceFromConfig(config); const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30000);
  const signal = external ? AbortSignal.any([external, deadline.signal]) : deadline.signal;
  let basis: FeedbackCoverage | undefined;
  try {
    signal.throwIfAborted(); basis = await readFeedbackCoverage(source); signal.throwIfAborted();
    const saved = basis.checkpoint; const version = basis.stateVersion;
    const withdraw = (previous?: BlockRef, replacement?: BlockRef) => {
      signal.throwIfAborted();
      return withdrawFeedbackSource({ source, expectedVersion: version, expectedCheckpoint: saved,
        ...(previous && replacement && previous.number === replacement.number && previous.hash !== replacement.hash
          ? { conflict: { previous, replacement } } : {}) });
    };
    await reader.assertNetwork(signal); const head = await reader.block('latest', signal); signal.throwIfAborted();
    if (saved && BigInt(head.number) < BigInt(saved.number)) return await withdraw();
    if (saved) {
      const current = await reader.block(saved.number, signal);
      if (!sameFeedbackBlock(saved, current)) return await withdraw(saved, current);
      if (BigInt(saved.number) + BigInt(config.confirmations) > BigInt(head.number)) return await withdraw();
    }
    let finalizedBlock = await reader.finalized(signal);
    if (finalizedBlock && BigInt(finalizedBlock.number) > BigInt(head.number)) finalizedBlock = null;
    const from = saved ? BigInt(saved.number) + 1n : BigInt(config.startBlock);
    const confirmed = BigInt(head.number) - BigInt(config.confirmations);
    let through: BlockRef | null = null; let logs: RawFeedbackLog[] = [];
    if (from <= confirmed) {
      let end = from + BigInt(config.maxBlockSpan) - 1n; if (end > confirmed) end = confirmed;
      for (let reductions = 0; ; reductions++) {
        signal.throwIfAborted();
        try {
          through = await reader.block(end.toString(), signal);
          logs = await reader.logs(from.toString(), end.toString(), signal); break;
        } catch (error) {
          if (!(error instanceof FeedbackBudgetError) || end === from || reductions >= 7) throw error;
          end = from + (end - from) / 2n;
        }
      }
    }
    await reader.assertRegistry(through ?? head, signal);
    if (saved) { const current = await reader.block(saved.number, signal);
      if (!sameFeedbackBlock(saved, current)) return await withdraw(saved, current); }
    if (through) { const current = await reader.block(through.number, signal);
      if (!sameFeedbackBlock(through, current)) return await withdraw(through, current); }
    const currentHead = await reader.block(head.number, signal);
    if (!sameFeedbackBlock(head, currentHead)) return await withdraw(head, currentHead);
    if (finalizedBlock && !sameFeedbackBlock(finalizedBlock, await reader.block(finalizedBlock.number, signal))) finalizedBlock = null;
    await reader.assertNetwork(signal); signal.throwIfAborted();
    return through ? await applyFeedbackBatch({ source, expectedVersion: version, expectedCheckpoint: saved,
      through, observedHead: head, finalizedBlock, logs })
      : await refreshFeedbackCoverage({ source, expectedVersion: version, observedHead: head, finalizedBlock });
  } catch (error) {
    // Original CAS only: a late failing worker must never withdraw a newer winner.
    if (basis) try { await markFeedbackUnavailable({ source, expectedVersion: basis.stateVersion }); } catch { /* stale/fingerprint */ }
    throw error;
  } finally { clearTimeout(timer); deadline.abort(); }
}
