import type { FastifyInstance } from 'fastify';
import { feedbackSourceFromConfig, type FeedbackFollowerConfig } from '../connectors/erc8004/feedbackConfig.js';
import { createFeedbackReader, FeedbackBudgetError, type FeedbackReader } from '../connectors/erc8004/feedbackRpc.js';
import { syncFeedbackOnce } from '../connectors/erc8004/feedbackFollower.js';
import { sweepFeedbackDocuments } from '../connectors/erc8004/feedbackAcquisition.js';
import { feedbackSourceId } from '../connectors/erc8004/feedbackValidation.js';
import { markFeedbackUnavailable, readFeedbackCoverage } from '../db/queries/feedbackObservations.js';
declare module 'fastify' { interface FastifyInstance { stopFeedbackFollower?: () => Promise<void>; } }
function waitPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(stop, ms); signal.addEventListener('abort', stop, { once: true });
  });
}
export async function registerFeedbackFollower(fastify: FastifyInstance, config: FeedbackFollowerConfig | null,
  readerFactory: (config: FeedbackFollowerConfig) => FeedbackReader = createFeedbackReader): Promise<void> {
  if (!config) return;
  const source = feedbackSourceFromConfig(config); const sourceId = feedbackSourceId(source);
  const controller = new AbortController(); let scan: Promise<void> | undefined; let acquisition: Promise<void> | undefined;
  let starting: Promise<void> | undefined; let stopPromise: Promise<void> | undefined; let initialized = false;
  const stop = () => {
    stopPromise ??= (async () => {
      controller.abort(); await starting?.catch(() => {}); await Promise.all([scan, acquisition]);
      if (initialized) try {
        const coverage = await readFeedbackCoverage(source);
        if (coverage.availability === 'available') await markFeedbackUnavailable({ source, expectedVersion: coverage.stateVersion });
      } catch { fastify.log.warn({ sourceId, reason: 'feedback-stop-status-failed' }, 'feedback follower status'); }
    })();
    return stopPromise;
  };
  fastify.decorate('stopFeedbackFollower', stop);
  fastify.addHook('onReady', async () => {
    starting = (async () => {
      if (controller.signal.aborted) return;
      const old = await readFeedbackCoverage(source); await markFeedbackUnavailable({ source, expectedVersion: old.stateVersion }); initialized = true;
      if (controller.signal.aborted) return;
      const reader = readerFactory(config);
      const loop = async (work: () => Promise<unknown>, failure: string) => {
        while (!controller.signal.aborted) {
          try { await work(); }
          catch (error) { if (!controller.signal.aborted) fastify.log.warn({ sourceId,
            reason: error instanceof FeedbackBudgetError ? 'feedback-rpc-budget' : failure }, 'feedback worker failed'); }
          await waitPoll(config.pollMs, controller.signal);
        }
      };
      // Independent scheduling: a stalled scan never delays already-observed document acquisition.
      scan = loop(() => syncFeedbackOnce(config, reader, controller.signal), 'feedback-scan-failed');
      acquisition = loop(() => sweepFeedbackDocuments(config, controller.signal), 'feedback-sweep-failed');
    })();
    await starting;
  });
  fastify.addHook('onClose', stop);
}
