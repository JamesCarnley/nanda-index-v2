import { afterAll, afterEach, expect, it } from 'vitest';
import { closeSql } from '../../src/db/client.js';
import * as q from '../../src/db/queries/feedbackObservations.js';
import { syncFeedbackOnce } from '../../src/connectors/erc8004/feedbackFollower.js';
import { FeedbackBudgetError, type FeedbackReader } from '../../src/connectors/erc8004/feedbackRpc.js';
import { feedbackSourceFromConfig, type FeedbackFollowerConfig } from '../../src/connectors/erc8004/feedbackConfig.js';
import { feedbackSourceId } from '../../src/connectors/erc8004/feedbackValidation.js';
import { block, cleanupSources, config, hash, log } from '../fixtures/feedback.js';
const owned: FeedbackFollowerConfig[] = [];
const fresh = () => { const c = config(); owned.push(c); return c; };
afterEach(async () => { await cleanupSources(owned.map(feedbackSourceFromConfig)); owned.length = 0; });
afterAll(closeSql);
function fake(c: FeedbackFollowerConfig) {
  const calls: string[] = []; let head = 10;
  const reader: FeedbackReader = {
    async assertNetwork() { calls.push('network'); }, async assertRegistry(at) { calls.push(`registry:${at.number}`); },
    async finalized() { return null; }, async block(tag) { calls.push(`block:${tag}`); return block(tag === 'latest' ? String(head) : tag); },
    async logs(from, to) { calls.push(`logs:${from}:${to}`); return from === '10' ? [log(c)] : []; },
  };
  return { reader, calls, set head(n: number) { head = n; } };
}
it('commits the full three-event history, huge agent IDs and exact duplicate bytes once', async () => {
  const c = fresh(); const f = fake(c); const huge = (2n ** 256n - 1n).toString();
  const raws = [log(c, { index: '9', kind: 'ResponseAppended', agentId: huge }), log(c, { index: '1', agentId: huge }),
    log(c, { index: '4', kind: 'FeedbackRevoked', agentId: huge })];
  f.reader.logs = async () => [...raws, raws[1]!];
  expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ checkpoint: block(), availability: 'available' });
  const page = await q.readFeedbackHistory({ sourceId: feedbackSourceId(feedbackSourceFromConfig(c)), agentId: huge, view: 'canonical-prefix', pageSize: 20 });
  expect(page.records.map((r) => r.decoded.kind)).toEqual(['NewFeedback', 'FeedbackRevoked', 'ResponseAppended']);
  expect(f.calls).toContain('registry:10'); expect(f.calls.filter((s) => s === 'network')).toHaveLength(2);
});
it('advances an empty contiguous range and refreshes without logs during confirmation wait', async () => {
  const c = fresh(); c.confirmations = 2; const f = fake(c); f.head = 11;
  expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ checkpoint: null, observedHead: block('11') });
  expect(f.calls).not.toContain('logs:10:10'); expect(f.calls).toContain('registry:11');
  f.head = 12; f.reader.logs = async () => [];
  expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ checkpoint: block() });
});
it.each(['network', 'registry', 'malformed', 'missing'])('fails closed on %s without storing a partial range', async (failure) => {
  const c = fresh(); const f = fake(c);
  if (failure === 'network') f.reader.assertNetwork = async () => { throw new Error('wrong chain'); };
  if (failure === 'registry') f.reader.assertRegistry = async () => { throw new Error('wrong linkage'); };
  if (failure === 'malformed') f.reader.logs = async () => [log(c), { ...log(c, { index: '1' }), data: '0x12' }];
  if (failure === 'missing') f.reader.block = async () => { throw new Error('not found'); };
  await expect(syncFeedbackOnce(c, f.reader)).rejects.toThrow();
  expect(await q.readFeedbackCoverage(feedbackSourceFromConfig(c))).toMatchObject({ checkpoint: null, availability: 'unavailable' });
});
it('halves overflow from the same start with a fresh bracket and stalls an oversized singleton', async () => {
  const c = fresh(); const f = fake(c); f.head = 137;
  f.reader.logs = async (from, to) => { f.calls.push(`logs:${from}:${to}`); if (from !== to) throw new FeedbackBudgetError(); return [log(c)]; };
  expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ checkpoint: block() });
  expect(f.calls.filter((s) => s.startsWith('logs:'))).toEqual([137, 73, 41, 25, 17, 13, 11, 10].map((n) => `logs:10:${n}`));
  for (const n of [137, 73, 41, 25, 17, 13, 11, 10]) expect(f.calls).toContain(`block:${n}`);
  f.reader.logs = async () => { throw new FeedbackBudgetError(); };
  await expect(syncFeedbackOnce(c, f.reader)).rejects.toThrow();
  expect(await q.readFeedbackCoverage(feedbackSourceFromConfig(c))).toMatchObject({ checkpoint: block(), availability: 'unavailable' });
});
it('does not reduce arbitrary provider errors or overwrite a winner after a stale failure', async () => {
  const c = fresh(); const f = fake(c); f.head = 100;
  f.reader.logs = async () => { await q.refreshFeedbackCoverage({ source: feedbackSourceFromConfig(c), expectedVersion: '0', observedHead: block('100'), finalizedBlock: null });
    throw new Error('rpc failure'); };
  await expect(syncFeedbackOnce(c, f.reader)).rejects.toThrow();
  expect(await q.readFeedbackCoverage(feedbackSourceFromConfig(c))).toMatchObject({ stateVersion: '1', availability: 'available' });
});
it('CASes competing complete scans without a loser marking the winner unavailable', async () => {
  const c = fresh(); const f = fake(c); let arrivals = 0; let release!: () => void;
  const both = new Promise<void>((r) => { release = r; });
  f.reader.assertNetwork = async () => { arrivals++; if (arrivals <= 2) { if (arrivals === 2) release(); await both; } };
  const results = await Promise.allSettled([syncFeedbackOnce(c, f.reader), syncFeedbackOnce(c, f.reader)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await q.readFeedbackCoverage(feedbackSourceFromConfig(c))).toMatchObject({ stateVersion: '1', checkpoint: block(), availability: 'available' });
});
it.each(['head-retreat', 'lost-confirmations', 'missing-saved', 'explicit-conflict'])('qualifies saved checkpoint change: %s', async (change) => {
  const c = fresh(); c.confirmations = 2; const f = fake(c); f.head = 12;
  await syncFeedbackOnce(c, f.reader); f.calls.length = 0;
  if (change === 'head-retreat') f.head = 9;
  if (change === 'lost-confirmations') f.head = 11;
  const original = f.reader.block;
  if (change === 'missing-saved' || change === 'explicit-conflict') f.reader.block = async (tag) => {
    if (tag === '10') { if (change === 'missing-saved') throw new Error('not found'); return block('10', hash(999)); } return original(tag); };
  if (change === 'missing-saved') await expect(syncFeedbackOnce(c, f.reader)).rejects.toThrow(); else await syncFeedbackOnce(c, f.reader);
  const page = await q.readFeedbackHistory({ sourceId: feedbackSourceId(feedbackSourceFromConfig(c)), agentId: '7', view: 'all-retained', pageSize: 20 });
  expect(page.records[0]!.canonicality).toBe(change === 'explicit-conflict' ? 'orphaned' : change === 'missing-saved' ? 'canonical' : 'withdrawn');
  expect(page.coverage!.availability).toBe(change === 'missing-saved' ? 'unavailable' : 'available');
  if (change !== 'missing-saved') expect(page.coverage).toMatchObject({ checkpoint: null, progress: 'rebuilding' });
});
it.each(['saved', 'through', 'head', 'network'])('withdraws or marks unavailable when %s changes before CAS', async (change) => {
  const c = fresh(); const f = fake(c); await syncFeedbackOnce(c, f.reader); f.head = 12;
  const original = f.reader.block; let late = false;
  f.reader.logs = async () => { late = true; return []; };
  f.reader.block = async (tag) => late && tag === (change === 'saved' ? '10' : '12') && change !== 'network'
    ? block(tag, hash(999)) : original(tag);
  if (change === 'network') f.reader.assertNetwork = async () => { if (late) throw new Error('changed network'); };
  if (change === 'head') c.maxBlockSpan = 1;
  if (change === 'network') await expect(syncFeedbackOnce(c, f.reader)).rejects.toThrow(); else await syncFeedbackOnce(c, f.reader);
  expect(await q.readFeedbackCoverage(feedbackSourceFromConfig(c))).toMatchObject({ availability: change === 'network' ? 'unavailable' : 'available', checkpoint: change === 'network' ? block() : null });
});
it('rechecks an unchanged head, discards changed finality and detects a post-commit reorg on the next scan', async () => {
  const c = fresh(); const f = fake(c); f.reader.finalized = async () => block('9');
  const original = f.reader.block; f.reader.block = async (tag) => tag === '9' ? block('9', hash(999)) : original(tag);
  expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ finalizedBlock: null });
  f.calls.length = 0; await syncFeedbackOnce(c, f.reader);
  expect(f.calls.filter((s) => s === 'block:10')).toHaveLength(3); expect(f.calls).toContain('registry:10');
  f.reader.block = async (tag) => block(tag === 'latest' ? '10' : tag, hash(999));
  expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ generation: '1', checkpoint: null });
});
it('replays unchanged prefix while preserving the maximum horizon across repeated reorgs', async () => {
  const c = fresh(); const f = fake(c); f.head = 100; await syncFeedbackOnce(c, f.reader);
  f.head = 9; expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ rebuildingThrough: '100' });
  f.head = 10; expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ rebuildingThrough: '100', checkpoint: block() });
  f.head = 9; expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ rebuildingThrough: '100' });
  f.head = 100; expect(await syncFeedbackOnce(c, f.reader)).toMatchObject({ rebuildingThrough: null, checkpoint: block('100') });
});
