import { applyIdentityBatch, markIdentityUnavailable, readIdentityCoverage,
  refreshIdentityCoverage, withdrawIdentitySource } from '../../db/queries/identityObservations.js';
import { identitySourceFromConfig, type IdentityFollowerConfig } from './config.js';
import { qualifyCityProfile } from './adapters/nandaCityV01.js';
import type { BlockRef, IdentityCoverage, IdentityObservation } from './types.js';
import type { ProfileInput } from './profileAdapter.js';

export type IdentityChainReader = {
  assertNetwork(signal?: AbortSignal): Promise<void>;
  block(tag: string, signal?: AbortSignal): Promise<BlockRef>;
  finalized(signal?: AbortSignal): Promise<BlockRef | null>;
  changedAgents(from: string, to: string, signal?: AbortSignal): Promise<string[]>;
  identity(agentId: string, at: BlockRef, signal?: AbortSignal): Promise<ProfileInput | 'missing'>;
};

function sameBlock(a: BlockRef, b: BlockRef): boolean {
  return a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp;
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('IDENTITY_TICK_ABORTED');
}
function isBudget(error: unknown): boolean {
  return error instanceof Error && error.message === 'IDENTITY_WORK_BUDGET';
}
async function readObservations(ids: string[], target: BlockRef,
  config: IdentityFollowerConfig, reader: IdentityChainReader,
  signal: AbortSignal): Promise<IdentityObservation[]> {
  const observations = new Array<IdentityObservation>(ids.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ids.length, 4) }, async () => {
    while (next < ids.length) {
      check(signal);
      const index = next++;
      const id = ids[index]!;
      const profile = await reader.identity(id, target, signal);
      check(signal);
      observations[index] = profile === 'missing' ? {
        agent: { chainId: config.chainId, registry: config.registry, agentId: id },
        block: target, owner: null, agentURI: null, agentUriDigest: null, agentUriByteLength: null,
        qualification: 'missing', reason: 'TOKEN_MISSING', declaration: null,
      } : qualifyCityProfile(profile);
    }
  }));
  return observations;
}

/** One bounded, non-overlapping scan. The caller owns scheduling and awaits this promise. */
export async function syncIdentityOnce(config: IdentityFollowerConfig,
  reader: IdentityChainReader, externalSignal?: AbortSignal): Promise<IdentityCoverage> {
  const source = identitySourceFromConfig(config);
  const deadline = AbortSignal.timeout(30_000);
  const signal = externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline;
  let coverage: IdentityCoverage | undefined;
  try {
    check(signal);
    coverage = await readIdentityCoverage(source);
    await reader.assertNetwork(signal);
    check(signal);
    const saved = coverage.checkpoint;
    if (saved) {
      const current = await reader.block(saved.number, signal);
      check(signal);
      if (!sameBlock(current, saved)) {
        return await withdrawIdentitySource(source, coverage.stateVersion, saved);
      }
    }
    const head = await reader.block('latest', signal);
    let finalizedBlock = await reader.finalized(signal);
    check(signal);
    if (finalizedBlock && BigInt(finalizedBlock.number) > BigInt(head.number)) {
      finalizedBlock = null;
    }
    const from = saved ? BigInt(saved.number) + 1n : BigInt(config.startBlock);
    const confirmed = BigInt(head.number) - BigInt(config.confirmations);
    if (confirmed < from) {
      if (finalizedBlock && !sameBlock(await reader.block(finalizedBlock.number, signal), finalizedBlock)) {
        finalizedBlock = null;
      }
      check(signal);
      return await refreshIdentityCoverage(source, coverage.stateVersion, head, finalizedBlock);
    }
    let end = from + BigInt(config.maxBlockSpan) - 1n;
    if (end > confirmed) end = confirmed;
    let ids: string[] = [];
    for (let reductions = 0; ; reductions++) {
      check(signal);
      try {
        ids = await reader.changedAgents(from.toString(), end.toString(), signal);
        ids = [...new Set(ids)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
        if (ids.length > 100) throw new Error('IDENTITY_WORK_BUDGET');
        break;
      } catch (error) {
        if (!isBudget(error) || reductions >= 8 || end === from) throw error;
        end = from + (end - from) / 2n;
      }
    }
    const target = await reader.block(end.toString(), signal);
    check(signal);
    const observations = await readObservations(ids, target, config, reader, signal);
    // A reorg before the saved cursor is as dangerous as one at the target.
    if (saved && !sameBlock(await reader.block(saved.number, signal), saved)) {
      check(signal);
      return await withdrawIdentitySource(source, coverage.stateVersion, saved);
    }
    if (!sameBlock(await reader.block(target.number, signal), target)) {
      check(signal);
      return await withdrawIdentitySource(source, coverage.stateVersion, saved);
    }
    if (finalizedBlock && !sameBlock(await reader.block(finalizedBlock.number, signal), finalizedBlock)) {
      finalizedBlock = null;
    }
    check(signal);
    return await applyIdentityBatch({ source, expectedVersion: coverage.stateVersion,
      expectedCheckpoint: saved, through: target, observedHead: head, finalizedBlock, observations });
  } catch (error) {
    if (coverage && !(error instanceof Error && /stale identity source state|fingerprint mismatch/.test(error.message))) {
      try { await markIdentityUnavailable(source, coverage.stateVersion); } catch { /* stale CAS preserves new owner state */ }
    }
    throw error;
  }
}
