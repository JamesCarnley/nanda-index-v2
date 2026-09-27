import type { FastifyInstance } from 'fastify';
import type { OriginArchiveConfig } from '../connectors/originArchive/config.js';
import { sweepOriginArchive } from '../connectors/originArchive/acquisition.js';
import { seedOriginArchiveSnapshots } from '../db/queries/originArchive.js';

declare module 'fastify' {
  interface FastifyInstance {
    stopOriginArchive?: () => Promise<void>;
  }
}

function waitPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(stop, ms); signal.addEventListener('abort', stop, { once: true });
  });
}

export async function registerOriginArchive(fastify: FastifyInstance, config: OriginArchiveConfig | null): Promise<void> {
  if (!config) return;
  const controller = new AbortController(); let starting: Promise<void> | undefined;
  let acquisition: Promise<void> | undefined; let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= (async () => {
      controller.abort(); await starting?.catch(() => {}); await acquisition;
    })();
    return stopPromise;
  };
  fastify.decorate('stopOriginArchive', stop);
  fastify.addHook('onReady', async () => {
    starting = seedOriginArchiveSnapshots(config).then(() => {});
    await starting;
    if (controller.signal.aborted) return;
    acquisition = (async () => {
      while (!controller.signal.aborted) {
        try { await sweepOriginArchive(config, controller.signal); }
        catch { if (!controller.signal.aborted) fastify.log.warn({ reason: 'origin-archive-sweep-failed' }, 'origin archive worker failed'); }
        await waitPoll(config.pollMs, controller.signal);
      }
    })();
  });
  fastify.addHook('onClose', stop);
}
