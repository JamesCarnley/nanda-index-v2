import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from 'viem';
import { closeSql, getSql } from '../../src/db/client.js';
import * as client from '../../src/db/client.js';
import * as q from '../../src/db/queries/feedbackObservations.js';
import { feedbackEventId, feedbackSourceId } from '../../src/connectors/erc8004/feedbackValidation.js';
import type { FeedbackBatch, FeedbackSource, RawFeedbackLog } from '../../src/connectors/erc8004/feedbackTypes.js';
import type { BlockRef, Hex } from '../../src/connectors/erc8004/types.js';

const H = (value: number): Hex => `0x${value.toString(16).padStart(64, '0')}`;
const A = (value: number): Hex => `0x${value.toString(16).padStart(40, '0')}`;
const B = (number = '10', hash = H(Number(number) % 10000)): BlockRef => ({ number, hash, timestamp: 1234 });
const bytes = new Uint8Array([0, 255, 1]);
const digest = keccak256(bytes);
const now = '2026-01-01T00:00:00.000Z';
let domain = 1000;
const source = (): FeedbackSource => ({ chainId: 31337, genesisHash: H(++domain),
  identityRegistry: A(2), reputationRegistry: A(3), startBlock: '10', confirmations: 0 });
const abi = parseAbi([
  'event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)',
  'event FeedbackRevoked(uint256 indexed agentId,address indexed clientAddress,uint64 indexed feedbackIndex)',
  'event ResponseAppended(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,address indexed responder,string responseURI,bytes32 responseHash)',
]);
function log(s: FeedbackSource, index = '0', options: { block?: BlockRef; kind?: 'NewFeedback' | 'FeedbackRevoked' | 'ResponseAppended';
  agentId?: string; feedbackIndex?: string; uri?: string; hash?: Hex } = {}): RawFeedbackLog {
  const agentId = BigInt(options.agentId ?? '7'); const feedbackIndex = BigInt(options.feedbackIndex ?? '1');
  const kind = options.kind ?? 'NewFeedback'; let topics: Hex[]; let data: Hex;
  if (kind === 'NewFeedback') {
    topics = encodeEventTopics({ abi, eventName: kind, args: { agentId, clientAddress: A(5), indexedTag1: '' } }) as Hex[];
    data = encodeAbiParameters([{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' },
      { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
    [feedbackIndex, -35n, 1, '', '', '', options.uri ?? 'http://127.0.0.1:9876/review', options.hash ?? digest]);
  } else if (kind === 'FeedbackRevoked') {
    topics = encodeEventTopics({ abi, eventName: kind, args: { agentId, clientAddress: A(5), feedbackIndex } }) as Hex[]; data = '0x';
  } else {
    topics = encodeEventTopics({ abi, eventName: kind, args: { agentId, clientAddress: A(5), responder: A(6) } }) as Hex[];
    data = encodeAbiParameters([{ type: 'uint64' }, { type: 'string' }, { type: 'bytes32' }], [feedbackIndex, 'response', H(7)]);
  }
  return { block: options.block ?? B(), transactionHash: H(8), transactionIndex: '0', logIndex: index,
    address: s.reputationRegistry, topics, data };
}
const batch = (s: FeedbackSource, overrides: Partial<FeedbackBatch> = {}): FeedbackBatch => ({ source: s,
  expectedVersion: '0', expectedCheckpoint: null, through: B(), observedHead: B(), finalizedBlock: null,
  logs: [log(s)], ...overrides });
const history = (s: FeedbackSource, options = {}) => q.readFeedbackHistory({ sourceId: feedbackSourceId(s),
  agentId: '7', view: 'canonical-prefix', pageSize: 100, ...options });
beforeEach(async () => {
  const sql = getSql();
  await sql`DELETE FROM feedback_fetch_jobs`; await sql`DELETE FROM feedback_membership`;
  await sql`DELETE FROM feedback_events`; await sql`DELETE FROM feedback_sources`;
  await sql`DELETE FROM feedback_documents`;
});
afterAll(closeSql);

it('reads unknown sources without initializing or mutating anything, with JSON-safe initializing coverage', async () => {
  const s = source();
  expect(await q.readFeedbackCoverage(s)).toMatchObject({ stateVersion: '0', generation: '0', progress: 'initializing',
    checkpoint: null, retention: { retained: '0', pending: '0', blocked: '0' } });
  expect(await q.readFeedbackSource(feedbackSourceId(s))).toBeNull();
  expect(await history(s)).toEqual({ coverage: null, basis: null, view: 'canonical-prefix', records: [], nextCursor: null,
    canonicalityBasis: 'current-coverage', semantics: 'not-evaluated' });
  expect(await q.readFeedbackEvent(feedbackEventId(s, log(s)))).toBeNull();
  expect(await q.readFeedbackDocument(H(991))).toBeNull();
});
it('atomically retains duplicate raw logs once, decodes three event kinds and seeds only NewFeedback jobs', async () => {
  const s = source(); const raw = log(s);
  const coverage = await q.applyFeedbackBatch(batch(s, { logs: [raw, raw, log(s, '1', { kind: 'FeedbackRevoked' }),
    log(s, '2', { kind: 'ResponseAppended' })] }));
  expect(coverage).toMatchObject({ stateVersion: '1', progress: 'synchronized', retention: { retained: '0', pending: '1', blocked: '0' } });
  const page = await history(s);
  expect(page.records.map((r) => r.decoded.kind)).toEqual(['NewFeedback', 'FeedbackRevoked', 'ResponseAppended']);
  expect(page.records[0]).toMatchObject({ raw, canonicality: 'canonical', semantics: 'not-evaluated', document: { availability: 'pending' } });
  expect(page.records[2]).toMatchObject({ decoded: { responder: A(6) }, document: { availability: 'not-requested' } });
  expect((await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 })).length).toBe(1);
});
it('validates the entire batch before writes and rolls back source creation on malformed input', async () => {
  const s = source();
  await expect(q.applyFeedbackBatch(batch(s, { logs: [log(s), { ...log(s, '1'), data: '0x12' }] }))).rejects.toThrow();
  expect(await q.readFeedbackSource(feedbackSourceId(s))).toBeNull();
});
it('rolls back earlier event and job inserts when a retained same-ID log conflicts during replay', async () => {
  const s = source(); const original = log(s, '2');
  await q.applyFeedbackBatch(batch(s, { logs: [original] }));
  await q.withdrawFeedbackSource({ source: s, expectedVersion: '1', expectedCheckpoint: B() });
  await expect(q.applyFeedbackBatch(batch(s, { expectedVersion: '2', logs: [log(s, '0'), log(s, '2', { uri: 'http://127.0.0.1:9876/changed' })] })))
    .rejects.toThrow(/integrity/);
  expect(await q.readFeedbackEvent(feedbackEventId(s, log(s, '0')))).toBeNull();
  expect((await q.readFeedbackCoverage(s)).stateVersion).toBe('2');
  expect((await history(s)).records).toHaveLength(0);
});
it('CASes competing writers, rejects fingerprints and checkpoint mismatch, and advances empty batches', async () => {
  const s = source();
  const results = await Promise.allSettled([q.applyFeedbackBatch(batch(s)), q.applyFeedbackBatch(batch(s))]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  await expect(q.applyFeedbackBatch(batch(s, { source: { ...s, confirmations: 1 }, expectedVersion: '1', expectedCheckpoint: B(),
    through: B('11'), observedHead: B('12'), logs: [] }))).rejects.toThrow(/fingerprint/);
  await expect(q.applyFeedbackBatch(batch(s, { expectedVersion: '1', expectedCheckpoint: B('10', H(33)), through: B('11'),
    observedHead: B('11'), logs: [] }))).rejects.toThrow(/stale/);
  expect(await q.applyFeedbackBatch(batch(s, { expectedVersion: '1', expectedCheckpoint: B(), through: B('11'),
    observedHead: B('11'), logs: [] }))).toMatchObject({ stateVersion: '2', checkpoint: B('11') });
});
it('keeps exact large subject, feedback and log indices in numeric order without bigint truncation', async () => {
  const s = source(); const agentId = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  await q.applyFeedbackBatch(batch(s, { logs: [log(s, '18446744073709551615', { agentId, feedbackIndex: '18446744073709551615' }),
    log(s, '9223372036854775808', { agentId }), log(s, '9', { agentId })] }));
  const records = (await history(s, { agentId })).records;
  expect(records.map((r) => r.raw.logIndex)).toEqual(['9', '9223372036854775808', '18446744073709551615']);
  expect(records[2]!.decoded.feedbackIndex).toBe('18446744073709551615');
  expect(records[2]!.decoded.agentId).toBe(agentId);
  expect(() => JSON.stringify(records)).not.toThrow();
});
it('retains opaque hash-matching bytes and preserves them across revocation, withdrawal and proven orphaning', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { logs: [log(s), log(s, '1', { kind: 'FeedbackRevoked' })] }));
  const [job] = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 });
  await q.finishFeedbackJob({ eventId: job!.eventId, expectedJobVersion: job!.jobVersion, now, outcome: { kind: 'retained', bytes } });
  expect(await q.readFeedbackDocument(digest)).toMatchObject({ documentHash: digest, byteLength: '3', bytes: Buffer.from(bytes) });
  await q.withdrawFeedbackSource({ source: s, expectedVersion: '1', expectedCheckpoint: B(),
    conflict: { previous: B(), replacement: B('10', H(99)) } });
  expect((await history(s)).records).toHaveLength(0);
  const record = await q.readFeedbackEvent(job!.eventId);
  expect(record).toMatchObject({ canonicality: 'orphaned', document: { availability: 'retained' }, semantics: 'not-evaluated' });
  expect((await history(s, { view: 'all-retained' })).records).toHaveLength(2);
  expect((await q.readFeedbackDocument(digest))!.bytes).toEqual(Buffer.from(bytes));
});
it('replays the unchanged prefix and preserves the maximum recovery horizon across repeated reorgs', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { through: B('100'), observedHead: B('100') }));
  await q.withdrawFeedbackSource({ source: s, expectedVersion: '1', expectedCheckpoint: B('100') });
  expect(await q.applyFeedbackBatch(batch(s, { expectedVersion: '2' }))).toMatchObject({ progress: 'rebuilding', rebuildingThrough: '100' });
  expect((await history(s)).records[0]!.canonicality).toBe('canonical');
  await q.withdrawFeedbackSource({ source: s, expectedVersion: '3', expectedCheckpoint: B() });
  expect(await q.applyFeedbackBatch(batch(s, { expectedVersion: '4', through: B('20'), observedHead: B('100') })))
    .toMatchObject({ progress: 'rebuilding', rebuildingThrough: '100' });
  expect(await q.applyFeedbackBatch(batch(s, { expectedVersion: '5', expectedCheckpoint: B('20'), through: B('100'), observedHead: B('100'), logs: [] })))
    .toMatchObject({ progress: 'synchronized', rebuildingThrough: null });
  expect((await history(s, { view: 'all-retained' })).records).toHaveLength(1);
});
it('keeps outage/lagging coverage separate from retention and rejects an invalid explicit conflict', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s));
  await q.markFeedbackUnavailable({ source: s, expectedVersion: '1' });
  expect(await q.readFeedbackCoverage(s)).toMatchObject({ availability: 'unavailable', checkpoint: B(), stateVersion: '2' });
  expect(await q.refreshFeedbackCoverage({ source: s, expectedVersion: '2', observedHead: B('20'), finalizedBlock: B() }))
    .toMatchObject({ availability: 'available', progress: 'lagging', stateVersion: '3' });
  await expect(q.withdrawFeedbackSource({ source: s, expectedVersion: '3', expectedCheckpoint: B(),
    conflict: { previous: B(), replacement: B('11') } })).rejects.toThrow();
  expect((await q.readFeedbackCoverage(s)).stateVersion).toBe('3');
});
it('rejects a coverage refresh that would unconfirm an already admitted checkpoint', async () => {
  const s = { ...source(), confirmations: 2 };
  await q.applyFeedbackBatch(batch(s, { observedHead: B('12') }));
  await expect(q.refreshFeedbackCoverage({ source: s, expectedVersion: '1', observedHead: B('11'), finalizedBlock: null }))
    .rejects.toThrow(/confirm/);
  expect((await q.readFeedbackCoverage(s)).stateVersion).toBe('1');
});
it('retains arbitrary text bytes through SQL and blocks only unsupported document acquisition', async () => {
  const s = source(); const raw = log(s);
  raw.data = encodeAbiParameters([{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' },
    { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes32' }],
  [1n, -35n, 1, '0x00', '0xefbbbf71', '0xff', '0x00', H(23)]);
  raw.topics[3] = keccak256('0x00');
  await q.applyFeedbackBatch(batch(s, { logs: [raw, log(s, '1', { kind: 'FeedbackRevoked' })] }));
  const page = await history(s);
  expect(page.records[0]).toMatchObject({ raw, decoded: { tag1: null, tag2: '\ufeffq', endpoint: null, feedbackURI: null },
    document: { availability: 'blocked', job: { feedbackURI: null, reason: 'unsupported-text-uri' } } });
  expect(page.records[1]!.decoded.kind).toBe('FeedbackRevoked');
});
it('rejects a tampered same-height cursor hash and out-of-range fence without state mutation', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { logs: [log(s), log(s, '1')] }));
  const page = await history(s, { pageSize: 1 });
  const parsed = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString()) as Record<string, unknown>;
  for (const change of [{ through: B('10', H(99)) }, { sequence: '999999999999999999999' }, { sourceId: feedbackSourceId(source()) }]) {
    const cursor = Buffer.from(JSON.stringify({ ...parsed, ...change })).toString('base64url');
    await expect(history(s, { pageSize: 1, cursor })).rejects.toThrow(/cursor/);
  }
  expect((await q.readFeedbackCoverage(s)).stateVersion).toBe('1');
});
it('records blocked intrinsic jobs and never creates response-document jobs', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { logs: [log(s, '0', { hash: H(0) }),
    log(s, '1', { uri: '' }), log(s, '2', { uri: 'x'.repeat(2049) }), log(s, '3', { kind: 'ResponseAppended' })] }));
  expect((await q.readFeedbackCoverage(s)).retention).toEqual({ retained: '0', pending: '0', blocked: '3' });
  expect((await history(s)).records.slice(0, 3).map((r) => r.document.job!.reason))
    .toEqual(['zero-hash', 'empty-uri', 'uri-too-large']);
  expect(await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 })).toHaveLength(0);
});
it('rejects wrong-hash and oversized retention atomically, including stale finish writes', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s));
  const [job] = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 });
  for (const payload of [new Uint8Array([9]), new Uint8Array(6145)]) {
    await expect(q.finishFeedbackJob({ eventId: job!.eventId, expectedJobVersion: job!.jobVersion, now,
      outcome: { kind: 'retained', bytes: payload } })).rejects.toThrow();
  }
  expect((await q.readFeedbackEvent(job!.eventId))!.document.job!.state).toBe('pending');
  await q.finishFeedbackJob({ eventId: job!.eventId, expectedJobVersion: job!.jobVersion, now,
    outcome: { kind: 'retained', bytes } });
  await expect(q.finishFeedbackJob({ eventId: job!.eventId, expectedJobVersion: job!.jobVersion, now,
    outcome: { kind: 'retained', bytes: new Uint8Array([9]) } })).rejects.toThrow();
});
it('claims at most four disjoint jobs, retries after lease expiry and rejects previous lease tokens', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { logs: Array.from({ length: 9 }, (_, i) => log(s, String(i), { hash: H(i + 100) })) }));
  const [a, b] = await Promise.all([q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 }),
    q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 })]);
  expect(a).toHaveLength(4); expect(b).toHaveLength(4);
  expect(new Set([...a, ...b].map((j) => j.eventId)).size).toBe(8);
  const final = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 });
  expect(final).toHaveLength(1);
  expect(await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 })).toHaveLength(0);
  const retried = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now: '2026-01-01T00:00:01.001Z', leaseMs: 1000 });
  expect(retried.every((j) => j.attempts === '2' && j.jobVersion === '2')).toBe(true);
  const old = [...a, ...b, ...final].find((j) => j.eventId === retried[0]!.eventId)!;
  await expect(q.finishFeedbackJob({ eventId: old.eventId, expectedJobVersion: old.jobVersion, now,
    outcome: { kind: 'retry', reason: 'unavailable', nextAttemptAt: '2026-01-01T00:00:02.000Z' } })).rejects.toThrow(/stale/);
  await expect(q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 5, now, leaseMs: 1000 })).rejects.toThrow();
  await expect(q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 1, now, leaseMs: 30001 })).rejects.toThrow();
});
it('persists retries, backoff and observed failure metadata across client restart and withdrawal', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { logs: [log(s, '0', { hash: H(721) })] }));
  const [job] = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 1, now, leaseMs: 1000 });
  await q.finishFeedbackJob({ eventId: job!.eventId, expectedJobVersion: job!.jobVersion, now,
    outcome: { kind: 'retry', reason: 'url-not-allowed', nextAttemptAt: '2026-01-01T00:01:00.000Z', actualHash: H(33), actualSize: '6500' } });
  await closeSql();
  expect((await q.readFeedbackEvent(job!.eventId))!.document.job).toMatchObject({ state: 'pending', reason: 'url-not-allowed',
    attempts: '1', actualHash: H(33), actualSize: '6500' });
  await q.withdrawFeedbackSource({ source: s, expectedVersion: '1', expectedCheckpoint: B() });
  expect(await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 1, now, leaseMs: 1000 })).toHaveLength(0);
  const [next] = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 1, now: '2026-01-01T00:01:00.000Z', leaseMs: 1000 });
  expect(next!.attempts).toBe('2');
  expect((await q.readFeedbackEvent(next!.eventId))!.canonicality).toBe('withdrawn');
});
it('reports shared digest availability even while another association job is backed off or blocked', async () => {
  const s = source(); const sharedBytes = new Uint8Array([11, 12]); const sharedHash = keccak256(sharedBytes);
  await q.applyFeedbackBatch(batch(s, { logs: [log(s, '0', { hash: sharedHash }), log(s, '1', { hash: sharedHash }),
    log(s, '2', { hash: sharedHash, uri: '' })] }));
  const jobs = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 });
  await q.finishFeedbackJob({ eventId: jobs[0]!.eventId, expectedJobVersion: jobs[0]!.jobVersion, now,
    outcome: { kind: 'retry', reason: 'unavailable', nextAttemptAt: '2026-01-01T00:01:00.000Z' } });
  await q.finishFeedbackJob({ eventId: jobs[1]!.eventId, expectedJobVersion: jobs[1]!.jobVersion, now,
    outcome: { kind: 'retained', bytes: sharedBytes } });
  expect((await history(s)).records.every((r) => r.document.availability === 'retained')).toBe(true);
  expect((await q.readFeedbackSource(feedbackSourceId(s)))!.retention).toEqual({ retained: '3', pending: '0', blocked: '0' });
  await q.applyFeedbackBatch(batch(s, { expectedVersion: '1', expectedCheckpoint: B(), through: B('11'), observedHead: B('11'),
    logs: [log(s, '0', { block: B('11'), hash: sharedHash })] }));
  expect((await history(s)).records[3]!.document.job!.state).toBe('retained');
});
it('freezes canonical pagination through-block across heartbeats and new batches, rejects changed filters and generations', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { logs: [log(s), log(s, '1'), log(s, '2')] }));
  const page = await history(s, { pageSize: 1 }); expect(page.nextCursor).not.toBeNull();
  await q.refreshFeedbackCoverage({ source: s, expectedVersion: '1', observedHead: B('11'), finalizedBlock: null });
  await q.applyFeedbackBatch(batch(s, { expectedVersion: '2', expectedCheckpoint: B(), through: B('11'), observedHead: B('11'),
    logs: [log(s, '0', { block: B('11') })] }));
  const second = await history(s, { pageSize: 1, cursor: page.nextCursor! });
  const third = await history(s, { pageSize: 1, cursor: second.nextCursor! });
  expect(second.basis).toEqual(page.basis); expect(third.basis).toEqual(page.basis);
  expect(third.basis).toMatchObject({ generation: '0', through: B() });
  expect(third.coverage!.checkpoint).toEqual(B('11'));
  expect([second.records[0]!.raw.logIndex, third.records[0]!.raw.logIndex]).toEqual(['1', '2']);
  expect(third.nextCursor).toBeNull();
  for (const changes of [{ agentId: '8' }, { pageSize: 2 }, { reviewer: A(9) }, { view: 'all-retained' }]) {
    await expect(history(s, { pageSize: 1, cursor: page.nextCursor!, ...changes })).rejects.toThrow(/cursor/);
  }
  await q.withdrawFeedbackSource({ source: s, expectedVersion: '3', expectedCheckpoint: B('11') });
  await expect(history(s, { pageSize: 1, cursor: page.nextCursor! })).rejects.toThrow(/generation/);
});
it('all-retained pagination includes withdrawn history after reset but freezes later insertions', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { logs: [log(s, '1'), log(s, '3')] }));
  await q.withdrawFeedbackSource({ source: s, expectedVersion: '1', expectedCheckpoint: B() });
  const page = await history(s, { view: 'all-retained', pageSize: 1 });
  await q.applyFeedbackBatch(batch(s, { expectedVersion: '2', logs: [log(s, '1'), log(s, '2'), log(s, '3')] }));
  const next = await history(s, { view: 'all-retained', pageSize: 1, cursor: page.nextCursor! });
  expect(next.records.map((r) => r.raw.logIndex)).toEqual(['3']); expect(next.nextCursor).toBeNull();
  expect(page.records[0]!.canonicality).toBe('withdrawn');
  expect(next.records[0]!.canonicality).toBe('canonical');
  expect(next.basis).toEqual(page.basis);
  expect(next.canonicalityBasis).toBe('current-coverage');
  expect((await history(s, { view: 'all-retained' })).records).toHaveLength(3);
});
it('detects stored document corruption on read and has no identity/search foreign-key retention dependency', async () => {
  const s = source(); const original = new Uint8Array([73]); const hash = keccak256(original);
  await q.applyFeedbackBatch(batch(s, { logs: [log(s, '0', { hash })] }));
  const [job] = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 1, now, leaseMs: 1000 });
  await q.finishFeedbackJob({ eventId: job!.eventId, expectedJobVersion: job!.jobVersion, now,
    outcome: { kind: 'retained', bytes: original } });
  const sql = getSql();
  const dependencies = await sql<{ tableName: string }[]>`SELECT c.confrelid::regclass::text AS table_name
    FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid IN
    ('feedback_sources'::regclass, 'feedback_events'::regclass, 'feedback_membership'::regclass,
      'feedback_documents'::regclass, 'feedback_fetch_jobs'::regclass)`;
  expect(dependencies.every((r) => r.tableName.startsWith('feedback_'))).toBe(true);
  await sql`UPDATE feedback_documents SET bytes = ${Buffer.from([74])} WHERE document_hash = ${hash}`;
  await expect(q.readFeedbackDocument(hash)).rejects.toThrow(/integrity/);
});
it('reads coverage, membership and event rows in one snapshot while withdrawal commits between queries', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s));
  const sql = getSql();
  let signalRead!: () => void; let releaseRead!: () => void;
  const sourceWasRead = new Promise<void>((resolve) => { signalRead = resolve; });
  const resume = new Promise<void>((resolve) => { releaseRead = resolve; });
  let first = true;
  // Pause after the real source SELECT; no SQL result or transaction behavior is mocked.
  const spy = vi.spyOn(client, 'getSql').mockReturnValue(new Proxy(sql, {
    get(target, key, receiver) {
      if (key !== 'begin') return Reflect.get(target, key, receiver);
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('read only')) {
          const callback = args[1] as (tx: postgres.TransactionSql) => Promise<unknown>;
          args[1] = (tx: postgres.TransactionSql) => callback(new Proxy(tx, {
            apply(query, thisArg, values) {
              const pending = Reflect.apply(query, thisArg, values) as Promise<unknown>;
              if (!first) return pending;
              first = false;
              return Promise.resolve(pending).then(async (rows) => { signalRead(); await resume; return rows; });
            },
          }));
        }
        return Reflect.apply(target.begin, target, args);
      };
    },
  }));
  try {
    const read = history(s);
    await sourceWasRead;
    await q.withdrawFeedbackSource({ source: s, expectedVersion: '1', expectedCheckpoint: B() });
    releaseRead();
    const page = await read;
    expect(page.coverage!.generation).toBe('0');
    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.canonicality).toBe('canonical');
    expect(page.coverage!.retention.pending).toBe('1');
  } finally { releaseRead(); spy.mockRestore(); }
  expect((await history(s)).coverage!.generation).toBe('1');
});
it('supports full-width block numbers and never uses the identity bigint validator', async () => {
  const number = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  const s = { ...source(), startBlock: number }; const block = B(number, H(987));
  await q.applyFeedbackBatch(batch(s, { through: block, observedHead: block, logs: [log(s, '0', { block })] }));
  expect((await history(s)).records[0]!.raw.block.number).toBe(number);
});
it('keeps feedback after real identity observation and service projection deletion', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s));
  const sql = getSql(); const identitySource = `erc8004-identity:31337:${A(987654)}`;
  const observationId = `sha256:${'d'.repeat(64)}`;
  await sql`INSERT INTO identity_sources (source_id, source_fingerprint, confirmations) VALUES (${identitySource}, 'synthetic', 0)`;
  await sql`INSERT INTO identity_observations (observation_id, source_id, generation, block_number, block_hash, agent_id, observation_json)
    VALUES (${observationId}, ${identitySource}, 0, 10, ${H(10)}, '7', '{}')`;
  await sql`INSERT INTO identity_latest (source_id, agent_id, observation_id) VALUES (${identitySource}, '7', ${observationId})`;
  await sql`INSERT INTO service_projections (source_id, identifier, source_kind, observation_id, display_name, media_type, url, source_revision)
    VALUES (${identitySource}, 'synthetic-feedback-subject', 'erc8004-identity', ${observationId}, 'Synthetic', 'application/json',
      'http://127.0.0.1:9876/synthetic', 'synthetic')`;
  await sql`DELETE FROM service_projections WHERE source_id = ${identitySource}`;
  await sql`DELETE FROM identity_latest WHERE source_id = ${identitySource}`;
  await sql`DELETE FROM identity_observations WHERE source_id = ${identitySource}`;
  await sql`DELETE FROM identity_sources WHERE source_id = ${identitySource}`;
  expect((await history(s)).records).toHaveLength(1);
});
it('roundtrips exactly 6144 opaque bytes and an empty document', async () => {
  const s = source(); const payloads = [new Uint8Array(6144).fill(255), new Uint8Array()];
  await q.applyFeedbackBatch(batch(s, { logs: payloads.map((payload, i) => log(s, String(i), { hash: keccak256(payload) })) }));
  const jobs = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 4, now, leaseMs: 1000 });
  for (const payload of payloads) {
    const job = jobs.find((candidate) => candidate.feedbackHash === keccak256(payload))!;
    await q.finishFeedbackJob({ eventId: job.eventId, expectedJobVersion: job.jobVersion, now,
      outcome: { kind: 'retained', bytes: payload } });
    expect((await q.readFeedbackDocument(job.feedbackHash))!.bytes).toEqual(Buffer.from(payload));
  }
});
it('enforces future bounded retries, intrinsic blocking and lease expiry, while due ordering is fair', async () => {
  const s = source(); await q.applyFeedbackBatch(batch(s, { logs: [log(s), log(s, '1')] }));
  const jobs = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 2, now, leaseMs: 1000 });
  const first = jobs[0]!; const second = jobs[1]!;
  for (const nextAttemptAt of [now, '2026-01-01T00:05:00.001Z']) {
    await expect(q.finishFeedbackJob({ eventId: first.eventId, expectedJobVersion: first.jobVersion, now,
      outcome: { kind: 'retry', reason: 'unavailable', nextAttemptAt } })).rejects.toThrow(/backoff/);
  }
  await expect(q.finishFeedbackJob({ eventId: first.eventId, expectedJobVersion: first.jobVersion, now,
    outcome: { kind: 'blocked', reason: 'url-not-allowed' } })).rejects.toThrow(/intrinsic/);
  await expect(q.finishFeedbackJob({ eventId: first.eventId, expectedJobVersion: first.jobVersion,
    now: '2026-01-01T00:00:01.000Z', outcome: { kind: 'retained', bytes } })).rejects.toThrow(/stale/);
  await q.finishFeedbackJob({ eventId: first.eventId, expectedJobVersion: first.jobVersion, now,
    outcome: { kind: 'retry', reason: 'url-not-allowed', nextAttemptAt: '2026-01-01T00:01:00.000Z' } });
  await q.finishFeedbackJob({ eventId: second.eventId, expectedJobVersion: second.jobVersion, now,
    outcome: { kind: 'retry', reason: 'unavailable', nextAttemptAt: '2026-01-01T00:00:01.000Z' } });
  const [due] = await q.claimDueFeedbackJobs({ sourceId: feedbackSourceId(s), limit: 1,
    now: '2026-01-01T00:01:00.000Z', leaseMs: 1000 });
  expect(due!.eventId).toBe(second.eventId);
  expect(due!.leaseExpiresAt).toBe('2026-01-01T00:01:01.000Z');
});
