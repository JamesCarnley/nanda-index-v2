import type postgres from 'postgres';
import { keccak256 } from 'viem';
import { getSql } from '../client.js';
import type { FeedbackBatch, FeedbackSource, FeedbackCoverage, FeedbackHistoryInput,
  FeedbackHistory, FeedbackEventRecord, FeedbackJob, FeedbackJobOutcome, RawFeedbackLog,
  DecodedEvent } from '../../connectors/erc8004/feedbackTypes.js';
import type { BlockRef, Hex } from '../../connectors/erc8004/types.js';
import { feedbackAcquisitionBlock, feedbackDecimal, feedbackEventId, feedbackHex, feedbackId,
  feedbackInteger, feedbackSourceFingerprint, feedbackSourceId, sameFeedbackBlock,
  validateFeedbackBatch, validateFeedbackBlock, validateFeedbackHeads,
  validateFeedbackSource } from '../../connectors/erc8004/feedbackValidation.js';

type Tx = postgres.TransactionSql;
type SourceRow = { sourceId: string; sourceFingerprint: string; sourceJson: string;
  stateVersion: string; generation: string; availability: 'available' | 'unavailable';
  checkpointJson: string | null; checkpointNumber: string | null; headJson: string | null;
  finalizedJson: string | null; rebuildingThrough: string | null;
  lastSuccessAt: Date | null; lastAttemptAt: Date | null };
type EventRow = { eventId: string; sourceId: string; insertionSequence: string; rawJson: string;
  decodedJson: string; observedAt: Date; blockNumber: string; transactionIndex: string; logIndex: string };
type JobRow = { eventId: string; sourceId: string; feedbackUriJson: string; feedbackHash: Hex;
  jobVersion: string; attempts: string; nextAttemptAt: Date; lastAttemptAt: Date | null;
  leaseUntil: Date | null; state: FeedbackJob['state']; reason: string | null;
  actualHash: Hex | null; actualSize: string | null };
type DocumentRow = { documentHash: Hex; bytes: Buffer; byteLength: number; retainedAt: Date };
const parseBlock = (value: string | null): BlockRef | null => value === null ? null : JSON.parse(value) as BlockRef;
const json = (block: BlockRef | null): string | null => block === null ? null : JSON.stringify(block);

function initialCoverage(source: FeedbackSource): FeedbackCoverage {
  return { sourceId: feedbackSourceId(source), source, stateVersion: '0', generation: '0', availability: 'available',
    progress: 'initializing', checkpoint: null, observedHead: null, finalizedBlock: null, rebuildingThrough: null,
    lastSuccessAt: null, lastAttemptAt: null, retention: { retained: '0', pending: '0', blocked: '0' } };
}
async function coverage(tx: Tx, row: SourceRow): Promise<FeedbackCoverage> {
  const source = JSON.parse(row.sourceJson) as FeedbackSource;
  const result = initialCoverage(source);
  result.stateVersion = String(row.stateVersion); result.generation = String(row.generation);
  result.availability = row.availability;
  result.checkpoint = parseBlock(row.checkpointJson); result.observedHead = parseBlock(row.headJson);
  result.finalizedBlock = parseBlock(row.finalizedJson);
  result.rebuildingThrough = row.rebuildingThrough === null ? null : String(row.rebuildingThrough);
  result.lastSuccessAt = row.lastSuccessAt?.toISOString() ?? null;
  result.lastAttemptAt = row.lastAttemptAt?.toISOString() ?? null;
  if (row.rebuildingThrough !== null) result.progress = 'rebuilding';
  else if (result.checkpoint && result.observedHead) {
    result.progress = BigInt(result.checkpoint.number) + BigInt(source.confirmations) >= BigInt(result.observedHead.number)
      ? 'synchronized' : 'lagging';
  }
  const [counts] = await tx<{ retained: string; pending: string; blocked: string }[]>`
    SELECT count(*) FILTER (WHERE d.document_hash IS NOT NULL)::text AS retained,
      count(*) FILTER (WHERE d.document_hash IS NULL AND j.state = 'pending')::text AS pending,
      count(*) FILTER (WHERE d.document_hash IS NULL AND j.state = 'blocked')::text AS blocked
    FROM feedback_membership m JOIN feedback_events e USING (source_id, event_id)
    JOIN feedback_fetch_jobs j USING (source_id, event_id)
    LEFT JOIN feedback_documents d ON d.document_hash = j.feedback_hash
    WHERE m.source_id = ${row.sourceId} AND m.generation = ${row.generation} AND m.status = 'canonical'
      AND e.block_number <= ${row.checkpointNumber}::numeric
  `;
  result.retention = counts!;
  return result;
}
async function getSource(tx: Tx, sourceId: string): Promise<SourceRow | null> {
  const [row] = await tx<SourceRow[]>`SELECT * FROM feedback_sources WHERE source_id = ${sourceId}`;
  return row ?? null;
}
async function lockedSource(tx: Tx, source: FeedbackSource, version: string, checkpoint?: BlockRef | null): Promise<SourceRow> {
  const sourceId = feedbackSourceId(source); const fingerprint = feedbackSourceFingerprint(source);
  await tx`INSERT INTO feedback_sources (source_id, source_fingerprint, source_json)
    VALUES (${sourceId}, ${fingerprint}, ${JSON.stringify(source)}) ON CONFLICT DO NOTHING`;
  const [row] = await tx<SourceRow[]>`SELECT * FROM feedback_sources WHERE source_id = ${sourceId} FOR UPDATE`;
  if (row!.sourceFingerprint !== fingerprint) throw new Error('feedback source fingerprint mismatch');
  if (String(row!.stateVersion) !== version || (checkpoint !== undefined && !sameFeedbackBlock(parseBlock(row!.checkpointJson), checkpoint))) {
    throw new Error('stale feedback source state');
  }
  return row!;
}
async function currentCoverage(tx: Tx, sourceId: string): Promise<FeedbackCoverage> {
  return coverage(tx, (await getSource(tx, sourceId))!);
}
function checkSavedBasis(row: SourceRow, head: BlockRef, finalized: BlockRef | null): void {
  const checkpoint = parseBlock(row.checkpointJson);
  const source = JSON.parse(row.sourceJson) as FeedbackSource;
  if (checkpoint && BigInt(checkpoint.number) + BigInt(source.confirmations) > BigInt(head.number)) {
    throw new Error('feedback checkpoint no longer confirmed; withdrawal required');
  }
  if (checkpoint && (BigInt(head.number) < BigInt(checkpoint.number) ||
    (head.number === checkpoint.number && !sameFeedbackBlock(head, checkpoint)) ||
    (finalized?.number === checkpoint.number && !sameFeedbackBlock(finalized, checkpoint)))) {
    throw new Error('feedback checkpoint conflict requires withdrawal');
  }
}

/** Reads never initialize sources or schedule acquisition. Multi-query views use one MVCC snapshot. */
export async function readFeedbackCoverage(input: FeedbackSource): Promise<FeedbackCoverage> {
  const source = validateFeedbackSource(input);
  return getSql().begin('isolation level repeatable read read only', async (tx) => {
    const row = await getSource(tx, feedbackSourceId(source));
    if (!row) return initialCoverage(source);
    if (row.sourceFingerprint !== feedbackSourceFingerprint(source)) throw new Error('feedback source fingerprint mismatch');
    return coverage(tx, row);
  });
}
export async function readFeedbackSource(id: string): Promise<FeedbackCoverage | null> {
  const sourceId = feedbackId(id);
  return getSql().begin('isolation level repeatable read read only', async (tx) => {
    const row = await getSource(tx, sourceId); return row ? coverage(tx, row) : null;
  });
}
export async function applyFeedbackBatch(input: FeedbackBatch): Promise<FeedbackCoverage> {
  const batch = validateFeedbackBatch(input); // ALL input and ABI decoding precede writes.
  const { source, through, observedHead, finalizedBlock } = batch;
  const sourceId = feedbackSourceId(source);
  return getSql().begin(async (tx) => {
    const row = await lockedSource(tx, source, batch.expectedVersion, batch.expectedCheckpoint);
    checkSavedBasis(row, observedHead, finalizedBlock);
    for (const { raw, decoded } of batch.events) {
      const eventId = feedbackEventId(source, raw);
      const rawJson = JSON.stringify(raw); const decodedJson = JSON.stringify(decoded);
      const inserted = await tx`INSERT INTO feedback_events (event_id, source_id, block_number, block_hash,
        transaction_index, log_index, agent_id, reviewer, feedback_index, kind, raw_json, decoded_json)
        VALUES (${eventId}, ${sourceId}, ${raw.block.number}, ${raw.block.hash}, ${raw.transactionIndex}, ${raw.logIndex},
          ${decoded.agentId}, ${decoded.reviewer}, ${decoded.feedbackIndex}, ${decoded.kind}, ${rawJson}, ${decodedJson})
        ON CONFLICT (event_id) DO NOTHING RETURNING event_id`;
      if (inserted.length === 0) {
        const [old] = await tx<EventRow[]>`SELECT * FROM feedback_events WHERE event_id = ${eventId}`;
        if (!old || old.sourceId !== sourceId || old.rawJson !== rawJson || old.decodedJson !== decodedJson) {
          throw new Error('feedback event integrity conflict');
        }
      }
      await tx`INSERT INTO feedback_membership (source_id, event_id, generation, status)
        VALUES (${sourceId}, ${eventId}, ${row.generation}, 'canonical')
        ON CONFLICT (source_id, event_id, generation) DO UPDATE SET status = 'canonical'`;
      if (decoded.kind === 'NewFeedback') {
        const [document] = await tx<DocumentRow[]>`SELECT * FROM feedback_documents WHERE document_hash = ${decoded.feedbackHash}`;
        if (document) checkedDocument(document);
        const reason = feedbackAcquisitionBlock(decoded.feedbackURI, decoded.feedbackHash);
        const state = document ? 'retained' : reason ? 'blocked' : 'pending';
        await tx`INSERT INTO feedback_fetch_jobs (event_id, source_id, feedback_uri_json, feedback_hash, state, reason, retained_hash)
          VALUES (${eventId}, ${sourceId}, ${JSON.stringify(decoded.feedbackURI)}, ${decoded.feedbackHash}, ${state},
            ${document ? null : reason}, ${document ? decoded.feedbackHash : null}) ON CONFLICT (event_id) DO NOTHING`;
      }
    }
    await tx`UPDATE feedback_sources SET checkpoint_number = ${through.number}, checkpoint_json = ${json(through)},
      head_json = ${json(observedHead)}, finalized_json = ${json(finalizedBlock)},
      rebuilding_through = CASE WHEN rebuilding_through <= ${through.number}::numeric THEN NULL ELSE rebuilding_through END,
      state_version = state_version + 1, availability = 'available', last_success_at = now(), last_attempt_at = now()
      WHERE source_id = ${sourceId}`;
    return currentCoverage(tx, sourceId);
  });
}
export async function refreshFeedbackCoverage(input: {source: FeedbackSource; expectedVersion: string; observedHead: BlockRef; finalizedBlock: BlockRef | null}): Promise<FeedbackCoverage> {
  const source = validateFeedbackSource(input.source); const version = feedbackDecimal(input.expectedVersion, 'expectedVersion');
  const { observedHead, finalizedBlock } = validateFeedbackHeads(input.observedHead, input.finalizedBlock);
  return getSql().begin(async (tx) => {
    const row = await lockedSource(tx, source, version); checkSavedBasis(row, observedHead, finalizedBlock);
    await tx`UPDATE feedback_sources SET head_json = ${json(observedHead)}, finalized_json = ${json(finalizedBlock)},
      state_version = state_version + 1, availability = 'available', last_success_at = now(), last_attempt_at = now()
      WHERE source_id = ${row.sourceId}`;
    return currentCoverage(tx, row.sourceId);
  });
}
export async function markFeedbackUnavailable(input: {source: FeedbackSource; expectedVersion: string}): Promise<FeedbackCoverage> {
  const source = validateFeedbackSource(input.source); const version = feedbackDecimal(input.expectedVersion, 'expectedVersion');
  return getSql().begin(async (tx) => {
    const row = await lockedSource(tx, source, version);
    await tx`UPDATE feedback_sources SET availability = 'unavailable', state_version = state_version + 1,
      last_attempt_at = now() WHERE source_id = ${row.sourceId}`;
    return currentCoverage(tx, row.sourceId);
  });
}
export async function withdrawFeedbackSource(input: {source: FeedbackSource; expectedVersion: string; expectedCheckpoint: BlockRef | null; conflict?: {previous: BlockRef; replacement: BlockRef}}): Promise<FeedbackCoverage> {
  const source = validateFeedbackSource(input.source); const version = feedbackDecimal(input.expectedVersion, 'expectedVersion');
  const checkpoint = input.expectedCheckpoint === null ? null : validateFeedbackBlock(input.expectedCheckpoint);
  const conflict = input.conflict ? { previous: validateFeedbackBlock(input.conflict.previous), replacement: validateFeedbackBlock(input.conflict.replacement) } : null;
  if (conflict && (conflict.previous.number !== conflict.replacement.number || conflict.previous.hash === conflict.replacement.hash)) {
    throw new Error('invalid explicit feedback block conflict');
  }
  return getSql().begin(async (tx) => {
    const row = await lockedSource(tx, source, version, checkpoint);
    await tx`UPDATE feedback_membership SET status = 'withdrawn' WHERE source_id = ${row.sourceId} AND status = 'canonical'`;
    if (conflict) {
      await tx`UPDATE feedback_membership m SET status = 'orphaned' FROM feedback_events e
        WHERE m.source_id = ${row.sourceId} AND e.source_id = m.source_id AND e.event_id = m.event_id
          AND e.block_number = ${conflict.previous.number} AND e.block_hash = ${conflict.previous.hash}`;
    }
    await tx`UPDATE feedback_sources SET generation = generation + 1, state_version = state_version + 1,
      rebuilding_through = greatest(rebuilding_through, checkpoint_number), checkpoint_json = NULL, checkpoint_number = NULL,
      availability = 'available', last_attempt_at = now() WHERE source_id = ${row.sourceId}`;
    return currentCoverage(tx, row.sourceId);
  });
}

function date(input: unknown, field: string): Date {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) throw new Error(`invalid feedback ${field}`);
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) throw new Error(`invalid feedback ${field}`);
  return parsed;
}
function jobView(row: JobRow): FeedbackJob {
  return { eventId: row.eventId, sourceId: row.sourceId, feedbackURI: JSON.parse(row.feedbackUriJson) as string | null,
    feedbackHash: row.feedbackHash, jobVersion: String(row.jobVersion), attempts: String(row.attempts),
    nextAttemptAt: row.nextAttemptAt.toISOString(), lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    leaseExpiresAt: row.leaseUntil?.toISOString() ?? null,
    state: row.state, reason: row.reason, actualHash: row.actualHash, actualSize: row.actualSize === null ? null : String(row.actualSize) };
}
export async function claimDueFeedbackJobs(input: {sourceId: string; limit: number; now: string; leaseMs: number}): Promise<FeedbackJob[]> {
  const sourceId = feedbackId(input.sourceId); const limit = feedbackInteger(input.limit, 'job limit', 1, 4);
  const now = date(input.now, 'now'); const leaseMs = feedbackInteger(input.leaseMs, 'leaseMs', 1, 30000);
  const lease = new Date(now.getTime() + leaseMs);
  return getSql().begin(async (tx) => {
    const rows = await tx<JobRow[]>`WITH due AS (
        SELECT event_id FROM feedback_fetch_jobs WHERE source_id = ${sourceId} AND state = 'pending'
          AND next_attempt_at <= ${now} AND (lease_until IS NULL OR lease_until <= ${now})
        ORDER BY next_attempt_at, event_id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) UPDATE feedback_fetch_jobs j SET job_version = job_version + 1, attempts = attempts + 1,
        last_attempt_at = ${now}, lease_until = ${lease}, next_attempt_at = ${lease}
      FROM due WHERE j.event_id = due.event_id RETURNING j.*`;
    return rows.map(jobView).sort((a, b) => a.eventId.localeCompare(b.eventId));
  });
}
function checkedDocument(row: DocumentRow): { documentHash: Hex; bytes: Buffer; byteLength: string; retainedAt: string } {
  if (row.bytes.byteLength > 6144 || row.bytes.byteLength !== row.byteLength || keccak256(row.bytes) !== row.documentHash) {
    throw new Error('feedback document integrity failure');
  }
  return { documentHash: row.documentHash, bytes: row.bytes, byteLength: String(row.byteLength), retainedAt: row.retainedAt.toISOString() };
}
export async function finishFeedbackJob(input: {eventId: string; expectedJobVersion: string; now: string; outcome: FeedbackJobOutcome}): Promise<FeedbackJob> {
  const eventId = feedbackId(input.eventId); const version = feedbackDecimal(input.expectedJobVersion, 'jobVersion');
  const now = date(input.now, 'now'); const outcome = input.outcome;
  let bytes: Buffer | null = null; let actualHash: Hex | null = null; let actualSize: string | null = null;
  let reason: string | null = null; let next: Date | null = null;
  if (outcome.kind === 'retained') {
    if (!(outcome.bytes instanceof Uint8Array) || outcome.bytes.byteLength > 6144) throw new Error('feedback document size/bytes');
    bytes = Buffer.from(outcome.bytes); actualHash = keccak256(bytes); actualSize = String(bytes.byteLength);
  } else if (outcome.kind === 'retry' || outcome.kind === 'blocked') {
    if (typeof outcome.reason !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(outcome.reason)) throw new Error('invalid feedback job reason');
    reason = outcome.reason;
    actualHash = outcome.actualHash === undefined ? null : feedbackHex(outcome.actualHash, 'actualHash', 32);
    actualSize = outcome.actualSize === undefined ? null : feedbackDecimal(outcome.actualSize, 'actualSize');
    if (outcome.kind === 'retry') {
      next = date(outcome.nextAttemptAt, 'nextAttemptAt');
      if (next.getTime() <= now.getTime() || next.getTime() > now.getTime() + 300000) throw new Error('feedback retry backoff must be positive and at most 300s');
    }
  } else throw new Error('invalid feedback job outcome');
  return getSql().begin(async (tx) => {
    const [job] = await tx<JobRow[]>`SELECT * FROM feedback_fetch_jobs WHERE event_id = ${eventId} FOR UPDATE`;
    if (!job || String(job.jobVersion) !== version || job.state !== 'pending' || !job.leaseUntil ||
      job.leaseUntil <= now || !job.lastAttemptAt || now < job.lastAttemptAt) throw new Error('stale feedback job claim');
    if (outcome.kind === 'blocked' && reason !== feedbackAcquisitionBlock(JSON.parse(job.feedbackUriJson) as string | null, job.feedbackHash)) {
      throw new Error('feedback blocked outcome must be intrinsic');
    }
    if (bytes) {
      if (actualHash !== job.feedbackHash || /^0x0{64}$/.test(job.feedbackHash)) throw new Error('feedback document hash mismatch');
      await tx`INSERT INTO feedback_documents (document_hash, bytes, byte_length, retained_at)
        VALUES (${job.feedbackHash}, ${bytes}, ${bytes.byteLength}, ${now}) ON CONFLICT (document_hash) DO NOTHING`;
      const [stored] = await tx<DocumentRow[]>`SELECT * FROM feedback_documents WHERE document_hash = ${job.feedbackHash}`;
      checkedDocument(stored!);
      if (!stored!.bytes.equals(bytes)) throw new Error('feedback document integrity conflict');
    }
    const state = outcome.kind === 'retry' ? 'pending' : outcome.kind;
    const [finished] = await tx<JobRow[]>`UPDATE feedback_fetch_jobs SET state = ${state}, job_version = job_version + 1,
      lease_until = NULL, next_attempt_at = ${next ?? now}, reason = ${reason}, actual_hash = ${actualHash}, actual_size = ${actualSize},
      retained_hash = ${bytes ? job.feedbackHash : null} WHERE event_id = ${eventId} RETURNING *`;
    return jobView(finished!);
  });
}
export async function readFeedbackDocument(input: string): Promise<{ documentHash: Hex; bytes: Buffer; byteLength: string; retainedAt: string } | null> {
  const hash = feedbackHex(input, 'documentHash', 32);
  const [row] = await getSql()<DocumentRow[]>`SELECT * FROM feedback_documents WHERE document_hash = ${hash}`;
  return row ? checkedDocument(row) : null;
}
async function eventRecord(tx: Tx, row: EventRow, source: SourceRow): Promise<FeedbackEventRecord> {
  const [membership] = await tx<{ generation: string; status: FeedbackEventRecord['canonicality'] }[]>`
    SELECT generation, status FROM feedback_membership WHERE source_id = ${row.sourceId} AND event_id = ${row.eventId}
      ORDER BY generation DESC LIMIT 1`;
  const canonicality = membership?.status === 'canonical' && String(membership.generation) === String(source.generation)
    && source.checkpointNumber !== null && BigInt(row.blockNumber) <= BigInt(source.checkpointNumber)
    ? 'canonical' : membership?.status === 'orphaned' ? 'orphaned' : 'withdrawn';
  const [job] = await tx<JobRow[]>`SELECT * FROM feedback_fetch_jobs WHERE event_id = ${row.eventId}`;
  const [document] = job ? await tx<DocumentRow[]>`SELECT * FROM feedback_documents WHERE document_hash = ${job.feedbackHash}` : [];
  return { eventId: row.eventId, sourceId: row.sourceId, insertionSequence: String(row.insertionSequence),
    raw: JSON.parse(row.rawJson) as RawFeedbackLog, decoded: JSON.parse(row.decodedJson) as DecodedEvent,
    observedAt: row.observedAt.toISOString(), canonicality, semantics: 'not-evaluated',
    document: { availability: document ? 'retained' : job ? job.state === 'blocked' ? 'blocked' : 'pending' : 'not-requested',
      hash: job?.feedbackHash ?? null, byteLength: document ? String(document.byteLength) : null,
      retainedAt: document?.retainedAt.toISOString() ?? null, job: job ? jobView(job) : null } };
}
export async function readFeedbackEvent(input: string): Promise<FeedbackEventRecord | null> {
  const eventId = feedbackId(input);
  return getSql().begin('isolation level repeatable read read only', async (tx) => {
    const [row] = await tx<EventRow[]>`SELECT * FROM feedback_events WHERE event_id = ${eventId}`;
    return row ? eventRecord(tx, row, (await getSource(tx, row.sourceId))!) : null;
  });
}
/** Event membership/document availability and source coverage share one read-only SQL snapshot. */
export async function readFeedbackEventWithCoverage(input: string): Promise<{ coverage: FeedbackCoverage; item: FeedbackEventRecord } | null> {
  const eventId = feedbackId(input);
  return getSql().begin('isolation level repeatable read read only', async (tx) => {
    const [row] = await tx<EventRow[]>`SELECT * FROM feedback_events WHERE event_id = ${eventId}`;
    if (!row) return null;
    const source = (await getSource(tx, row.sourceId))!;
    return { coverage: await coverage(tx, source), item: await eventRecord(tx, row, source) };
  });
}
type Cursor = { version: 1; sourceId: string; agentId: string; reviewer: string | null;
  view: FeedbackHistoryInput['view']; pageSize: number; order: 'block-transaction-log-event';
  generation: string; through: BlockRef | null; sequence: string;
  after: [string, string, string, string] };
function decodeCursor(encoded: string, filter: Omit<Cursor, 'version' | 'generation' | 'through' | 'sequence' | 'after'>): Cursor {
  if (typeof encoded !== 'string' || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid feedback cursor');
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Cursor; }
  catch { throw new Error('invalid feedback cursor'); }
  if (!cursor || typeof cursor !== 'object' || cursor.version !== 1 ||
    Object.keys(cursor).length !== 11 || Object.entries(filter).some(([key, value]) => cursor[key as keyof Cursor] !== value) ||
    !Array.isArray(cursor.after) || cursor.after.length !== 4) throw new Error('invalid feedback cursor filters');
  feedbackDecimal(cursor.generation, 'cursor generation'); feedbackDecimal(cursor.sequence, 'cursor sequence');
  if (cursor.through !== null) validateFeedbackBlock(cursor.through);
  feedbackDecimal(cursor.after[0], 'cursor block'); feedbackDecimal(cursor.after[1], 'cursor transaction', 64);
  feedbackDecimal(cursor.after[2], 'cursor log', 64); feedbackId(cursor.after[3]);
  return cursor;
}
export async function readFeedbackHistory(input: FeedbackHistoryInput): Promise<FeedbackHistory> {
  const sourceId = feedbackId(input.sourceId); const agentId = feedbackDecimal(input.agentId, 'agentId');
  const reviewer = input.reviewer === undefined ? null : feedbackHex(input.reviewer, 'reviewer', 20);
  const pageSize = feedbackInteger(input.pageSize, 'pageSize', 1, 100); const view = input.view;
  if (view !== 'canonical-prefix' && view !== 'all-retained') throw new Error('invalid feedback view');
  const filter = { sourceId, agentId, reviewer, pageSize, view, order: 'block-transaction-log-event' as const };
  const previous = input.cursor === undefined ? null : decodeCursor(input.cursor, filter);
  return getSql().begin('isolation level repeatable read read only', async (tx) => {
    const source = await getSource(tx, sourceId);
    if (!source) {
      if (previous) throw new Error('stale feedback cursor generation');
      return { coverage: null, basis: null, view, records: [], nextCursor: null,
        canonicalityBasis: 'current-coverage' as const, semantics: 'not-evaluated' as const };
    }
    if (previous && previous.generation !== String(source.generation)) throw new Error('stale feedback cursor generation');
    const [fence] = await tx<{ sequence: string }[]>`SELECT coalesce(max(insertion_sequence),0)::text AS sequence FROM feedback_events WHERE source_id = ${sourceId}`;
    const through = previous ? previous.through : parseBlock(source.checkpointJson);
    const sequence = previous?.sequence ?? fence!.sequence;
    if (previous?.through && source.checkpointNumber === previous.through.number &&
      !sameFeedbackBlock(previous.through, parseBlock(source.checkpointJson))) throw new Error('invalid feedback cursor checkpoint');
    if (previous && (BigInt(sequence) > BigInt(fence!.sequence) || (view === 'canonical-prefix' && through !== null &&
      (source.checkpointNumber === null || BigInt(through.number) > BigInt(source.checkpointNumber))))) throw new Error('invalid feedback cursor basis');
    const rows = await tx<EventRow[]>`SELECT e.* FROM feedback_events e
      WHERE e.source_id = ${sourceId} AND e.agent_id = ${agentId}
        AND (${reviewer}::text IS NULL OR e.reviewer = ${reviewer}) AND e.insertion_sequence <= ${sequence}
        AND (${view} = 'all-retained' OR (e.block_number <= ${through?.number ?? null}::numeric AND EXISTS (
          SELECT 1 FROM feedback_membership m WHERE m.source_id = e.source_id AND m.event_id = e.event_id
            AND m.generation = ${source.generation} AND m.status = 'canonical')))
        ${previous ? tx`AND (e.block_number, e.transaction_index, e.log_index, e.event_id) >
          (${previous.after[0]}::numeric, ${previous.after[1]}::numeric, ${previous.after[2]}::numeric, ${previous.after[3]}::text)` : tx``}
      ORDER BY e.block_number, e.transaction_index, e.log_index, e.event_id LIMIT ${pageSize + 1}`;
    const shown = rows.slice(0, pageSize); const records: FeedbackEventRecord[] = [];
    for (const row of shown) records.push(await eventRecord(tx, row, source));
    const last = shown.at(-1);
    const basis = { generation: String(source.generation), through, insertionSequence: sequence };
    const cursor: Cursor | null = rows.length > pageSize && last ? { ...filter, version: 1,
      generation: basis.generation, through, sequence,
      after: [String(last.blockNumber), String(last.transactionIndex), String(last.logIndex), last.eventId] } : null;
    return { coverage: await coverage(tx, source), basis, view, records, canonicalityBasis: 'current-coverage' as const,
      nextCursor: cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null, semantics: 'not-evaluated' as const };
  });
}
