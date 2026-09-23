import type postgres from 'postgres';
import { getSql } from '../client.js';
import {
  decimal, identityObservationId, identitySourceId, parseObservationId,
  qualifiedIdentifier, sourceFingerprint, validateAgent, validateBatch,
  validateBlock, validateSource,
} from '../../connectors/erc8004/validation.js';
import type {
  AgentRef, BlockRef, IdentityBatch, IdentityCoverage, IdentityObservation, IdentitySource,
} from '../../connectors/erc8004/types.js';

type Tx = postgres.TransactionSql;
interface SourceRow {
  sourceId: string; sourceFingerprint: string; confirmations: number;
  stateVersion: string; generation: string; availability: 'available' | 'unavailable';
  rebuilding: boolean;
  checkpointNumber: string | null; checkpointHash: `0x${string}` | null; checkpointTimestamp: string | null;
  headNumber: string | null; headHash: `0x${string}` | null; headTimestamp: string | null;
  finalizedNumber: string | null; finalizedHash: `0x${string}` | null; finalizedTimestamp: string | null;
  lastSuccessAt: Date | null; lastAttemptAt: Date | null;
}
function block(number: string | null, hash: `0x${string}` | null, timestamp: string | null): BlockRef | null {
  return number === null ? null : { number: String(number), hash: hash!, timestamp: Number(timestamp) };
}
export function sourceRowCoverage(row: SourceRow): IdentityCoverage {
  const checkpoint = block(row.checkpointNumber, row.checkpointHash, row.checkpointTimestamp);
  const observedHead = block(row.headNumber, row.headHash, row.headTimestamp);
  const finalizedBlock = block(row.finalizedNumber, row.finalizedHash, row.finalizedTimestamp);
  let progress: IdentityCoverage['progress'] = 'initializing';
  if (row.rebuilding) progress = 'rebuilding';
  else if (checkpoint && observedHead) {
    progress = BigInt(checkpoint.number) + BigInt(row.confirmations) >= BigInt(observedHead.number)
      ? 'synchronized' : 'lagging';
  }
  return { sourceId: row.sourceId, stateVersion: String(row.stateVersion),
    availability: row.availability, progress, checkpoint, observedHead, finalizedBlock,
    confirmations: row.confirmations,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null };
}
function sameBlock(left: BlockRef | null, right: BlockRef | null): boolean {
  return left === null ? right === null : right !== null &&
    left.number === right.number && left.hash === right.hash && left.timestamp === right.timestamp;
}
function checkCas(row: SourceRow, source: IdentitySource, expectedVersion: string,
  expectedCheckpoint?: BlockRef | null): void {
  if (row.sourceFingerprint !== sourceFingerprint(source)) throw new Error('identity source fingerprint mismatch');
  if (String(row.stateVersion) !== expectedVersion ||
    (expectedCheckpoint !== undefined && !sameBlock(
      block(row.checkpointNumber, row.checkpointHash, row.checkpointTimestamp), expectedCheckpoint))) {
    throw new Error('stale identity source state');
  }
}
async function lockedSource(tx: Tx, source: IdentitySource): Promise<SourceRow> {
  const sourceId = identitySourceId(source);
  await tx`
    INSERT INTO identity_sources (source_id, source_fingerprint, confirmations)
    VALUES (${sourceId}, ${sourceFingerprint(source)}, ${source.confirmations})
    ON CONFLICT (source_id) DO NOTHING
  `;
  const [row] = await tx<SourceRow[]>`
    SELECT * FROM identity_sources WHERE source_id = ${sourceId} FOR UPDATE
  `;
  return row!;
}
async function coverageInTx(tx: Tx, sourceId: string): Promise<IdentityCoverage> {
  const [row] = await tx<SourceRow[]>`SELECT * FROM identity_sources WHERE source_id = ${sourceId}`;
  return sourceRowCoverage(row!);
}
export async function applyIdentityBatch(input: IdentityBatch): Promise<IdentityCoverage> {
  const batch = validateBatch(input); // Reject all malformed input before any write.
  const { source, through, observedHead, finalizedBlock, observations } = batch;
  const sourceId = identitySourceId(source);
  const sql = getSql();
  return sql.begin(async (tx) => {
    const row = await lockedSource(tx, source);
    checkCas(row, source, batch.expectedVersion, batch.expectedCheckpoint);
    if (row.checkpointNumber !== null && BigInt(through.number) <= BigInt(row.checkpointNumber)) {
      throw new Error('identity batch must advance checkpoint');
    }
    for (const observation of observations) {
      const observationId = identityObservationId(source, observation);
      const agentId = observation.agent.agentId;
      const inserted = await tx<{ observationId: string }[]>`
        INSERT INTO identity_observations
          (observation_id, source_id, generation, block_number, block_hash, agent_id, observation_json)
        VALUES (${observationId}, ${sourceId}, ${row.generation}, ${through.number}, ${through.hash},
          ${agentId}, ${JSON.stringify(observation)})
        ON CONFLICT (observation_id) DO NOTHING
        RETURNING observation_id
      `;
      if (inserted.length === 0) {
        const [existing] = await tx<{ sourceId: string; observationJson: string }[]>`
          SELECT source_id, observation_json FROM identity_observations
          WHERE observation_id = ${observationId}
        `;
        if (existing?.sourceId !== sourceId || existing.observationJson !== JSON.stringify(observation)) {
          throw new Error('identity observation integrity conflict');
        }
      }
      await tx`
        INSERT INTO identity_latest (source_id, agent_id, observation_id)
        VALUES (${sourceId}, ${agentId}, ${observationId})
        ON CONFLICT (source_id, agent_id) DO UPDATE SET observation_id = EXCLUDED.observation_id
      `;
      const identifier = qualifiedIdentifier(observation.agent);
      await tx`
        DELETE FROM service_projections
        WHERE source_id = ${sourceId} AND source_kind = 'erc8004-identity' AND identifier = ${identifier}
      `;
      if (observation.declaration) {
        const service = observation.declaration;
        await tx`
          INSERT INTO service_projections
            (source_id, identifier, source_kind, org_id, observation_id, display_name,
             media_type, url, description, capability_ids, area_served, interfaces,
             source_revision, observed_at)
          VALUES (${sourceId}, ${identifier}, 'erc8004-identity', NULL, ${observationId},
            ${service.displayName}, ${service.type}, ${service.url}, ${service.description},
            ${tx.array(service.capabilityIds)}, ${tx.array(service.areaServed)},
            ${tx.array(service.interfaces)}, ${observationId}, CURRENT_TIMESTAMP)
        `;
      }
    }
    await tx`
      UPDATE identity_sources SET
        checkpoint_number = ${through.number}, checkpoint_hash = ${through.hash},
        checkpoint_timestamp = ${through.timestamp},
        head_number = ${observedHead.number}, head_hash = ${observedHead.hash},
        head_timestamp = ${observedHead.timestamp},
        finalized_number = ${finalizedBlock?.number ?? null},
        finalized_hash = ${finalizedBlock?.hash ?? null},
        finalized_timestamp = ${finalizedBlock?.timestamp ?? null},
        state_version = state_version + 1, availability = 'available', rebuilding = false,
        last_success_at = CURRENT_TIMESTAMP, last_attempt_at = CURRENT_TIMESTAMP
      WHERE source_id = ${sourceId}
    `;
    return coverageInTx(tx, sourceId);
  });
}
export async function withdrawIdentitySource(input: IdentitySource, version: string,
  checkpoint: BlockRef | null): Promise<IdentityCoverage> {
  const source = validateSource(input);
  const expectedVersion = decimal(version, 'expectedVersion');
  const expectedCheckpoint = checkpoint === null ? null : validateBlock(checkpoint);
  const sourceId = identitySourceId(source);
  const sql = getSql();
  return sql.begin(async (tx) => {
    const row = await lockedSource(tx, source);
    checkCas(row, source, expectedVersion, expectedCheckpoint);
    await tx`DELETE FROM service_projections WHERE source_id = ${sourceId} AND source_kind = 'erc8004-identity'`;
    await tx`DELETE FROM identity_latest WHERE source_id = ${sourceId}`;
    await tx`
      UPDATE identity_sources SET generation = generation + 1, state_version = state_version + 1,
        checkpoint_number = NULL, checkpoint_hash = NULL, checkpoint_timestamp = NULL,
        rebuilding = true, availability = 'available', last_attempt_at = CURRENT_TIMESTAMP
      WHERE source_id = ${sourceId}
    `;
    return coverageInTx(tx, sourceId);
  });
}
export async function markIdentityUnavailable(input: IdentitySource, version: string): Promise<void> {
  const source = validateSource(input);
  const expectedVersion = decimal(version, 'expectedVersion');
  const sourceId = identitySourceId(source);
  const sql = getSql();
  await sql.begin(async (tx) => {
    const row = await lockedSource(tx, source);
    checkCas(row, source, expectedVersion);
    await tx`
      UPDATE identity_sources SET availability = 'unavailable', state_version = state_version + 1,
        last_attempt_at = CURRENT_TIMESTAMP WHERE source_id = ${sourceId}
    `;
  });
}
export async function refreshIdentityCoverage(input: IdentitySource, version: string,
  headInput: BlockRef, finalizedInput: BlockRef | null): Promise<IdentityCoverage> {
  const source = validateSource(input);
  const expectedVersion = decimal(version, 'expectedVersion');
  const head = validateBlock(headInput);
  const finalized = finalizedInput === null ? null : validateBlock(finalizedInput);
  if (finalized && BigInt(finalized.number) > BigInt(head.number)) throw new Error('invalid finality');
  const sourceId = identitySourceId(source);
  const sql = getSql();
  return sql.begin(async (tx) => {
    const row = await lockedSource(tx, source);
    checkCas(row, source, expectedVersion);
    await tx`
      UPDATE identity_sources SET
        head_number = ${head.number}, head_hash = ${head.hash}, head_timestamp = ${head.timestamp},
        finalized_number = ${finalized?.number ?? null}, finalized_hash = ${finalized?.hash ?? null},
        finalized_timestamp = ${finalized?.timestamp ?? null},
        availability = 'available', state_version = state_version + 1,
        last_success_at = CURRENT_TIMESTAMP, last_attempt_at = CURRENT_TIMESTAMP
      WHERE source_id = ${sourceId}
    `;
    return coverageInTx(tx, sourceId);
  });
}
export async function readIdentityCoverage(input: IdentitySource): Promise<IdentityCoverage> {
  const source = validateSource(input);
  const row = await getSql()<SourceRow[]>`
    SELECT * FROM identity_sources WHERE source_id = ${identitySourceId(source)}
  `;
  if (row[0] && row[0].sourceFingerprint !== sourceFingerprint(source)) {
    throw new Error('identity source fingerprint mismatch');
  }
  if (row[0]) return sourceRowCoverage(row[0]);
  return { sourceId: identitySourceId(source), stateVersion: '0', availability: 'available',
    progress: 'initializing', checkpoint: null, observedHead: null, finalizedBlock: null,
    confirmations: source.confirmations, lastSuccessAt: null, lastAttemptAt: null };
}
export async function readIdentityCoverageById(sourceId: string): Promise<IdentityCoverage | null> {
  const [row] = await getSql()<SourceRow[]>`SELECT * FROM identity_sources WHERE source_id = ${sourceId}`;
  return row ? sourceRowCoverage(row) : null;
}
export async function readLatestIdentity(input: AgentRef): Promise<IdentityObservation | null> {
  return (await readLatestIdentityRecord(input))?.observation ?? null;
}
export async function readLatestIdentityRecord(input: AgentRef): Promise<{
  observationId: string; observation: IdentityObservation;
} | null> {
  const agent = validateAgent(input);
  const sourceId = `erc8004-identity:${agent.chainId}:${agent.registry}`;
  const [row] = await getSql()<{ observationId: string; observationJson: string }[]>`
    SELECT o.observation_id, o.observation_json FROM identity_latest l
    JOIN identity_observations o ON o.source_id = l.source_id AND o.observation_id = l.observation_id
    WHERE l.source_id = ${sourceId} AND l.agent_id = ${agent.agentId}
  `;
  return row ? { observationId: row.observationId,
    observation: JSON.parse(row.observationJson) as IdentityObservation } : null;
}
export async function readIdentityObservation(id: string): Promise<IdentityObservation | null> {
  return (await readIdentityObservationRecord(id))?.observation ?? null;
}
export async function readIdentityObservationRecord(id: string): Promise<{
  observationId: string; observation: IdentityObservation; observationBytes: string;
} | null> {
  const observationId = parseObservationId(id);
  const [row] = await getSql()<{ observationJson: string }[]>`
    SELECT observation_json FROM identity_observations WHERE observation_id = ${observationId}
  `;
  return row ? { observationId, observation: JSON.parse(row.observationJson) as IdentityObservation,
    observationBytes: row.observationJson } : null;
}
