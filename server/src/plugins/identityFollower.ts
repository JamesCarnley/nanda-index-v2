import type { FastifyInstance } from 'fastify';
import { identitySourceFromConfig, type IdentityFollowerConfig } from '../connectors/erc8004/config.js';
import { createIdentityChainReader } from '../connectors/erc8004/rpc.js';
import { syncIdentityOnce, type IdentityChainReader } from '../connectors/erc8004/follower.js';
import { identitySourceId } from '../connectors/erc8004/validation.js';
import { markIdentityUnavailable, readIdentityCoverage } from '../db/queries/identityObservations.js';

declare module 'fastify' {
  interface FastifyInstance {
    stopIdentityFollower?: () => Promise<void>;
  }
}

function boundedReason(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) return error.message;
  return 'FOLLOWER_TICK_FAILED';
}

function waitPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

export async function registerIdentityFollower(fastify: FastifyInstance,
  config: IdentityFollowerConfig | null,
  readerFactory: (config: IdentityFollowerConfig) => IdentityChainReader = createIdentityChainReader): Promise<void> {
  if (!config) return;
  const source = identitySourceFromConfig(config);
  const sourceId = identitySourceId(source);
  const controller = new AbortController();
  let loop: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= (async () => {
      controller.abort(new Error('IDENTITY_TICK_ABORTED'));
      await loop;
      // Availability is last-observed state, not an assertion that a stopped worker is live.
      try {
        const coverage = await readIdentityCoverage(source);
        if (coverage.lastSuccessAt && coverage.availability === 'available') {
          await markIdentityUnavailable(source, coverage.stateVersion);
        }
      } catch {
        fastify.log.warn({ sourceId, reason: 'FOLLOWER_STOP_STATUS_FAILED' }, 'identity follower status');
      }
    })();
    return stopPromise;
  };
  fastify.decorate('stopIdentityFollower', stop);
  fastify.addHook('onReady', async () => {
    // Preserve durable projections, but expose this process as unavailable until
    // its own first successful chain read. Also creates initializing coverage.
    const old = await readIdentityCoverage(source);
    await markIdentityUnavailable(source, old.stateVersion);
    const reader = readerFactory(config);
    loop = (async () => {
      while (!controller.signal.aborted) {
        try { await syncIdentityOnce(config, reader, controller.signal); }
        catch (error) {
          if (!controller.signal.aborted) fastify.log.warn({ sourceId,
            reason: boundedReason(error) }, 'identity follower tick failed');
        }
        await waitPoll(config.pollMs, controller.signal);
      }
    })();
  });
  fastify.addHook('onClose', stop);
}
