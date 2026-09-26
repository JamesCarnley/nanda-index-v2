import type { BlockRef, Hex } from './types.js';

export type FeedbackSource = { chainId: number; genesisHash: Hex; identityRegistry: Hex;
  reputationRegistry: Hex; startBlock: string; confirmations: number };
export type RawFeedbackLog = { block: BlockRef; transactionHash: Hex; transactionIndex: string;
  logIndex: string; address: Hex; topics: Hex[]; data: Hex };
export type LogicalKey = { agentId: string; reviewer: Hex; feedbackIndex: string };
/** Solidity strings are arbitrary bytes. Null text + invalidTextFields means the
 * UTF-8/NUL-free text projection is unavailable; raw log bytes remain authoritative. */
export type DecodedEvent = LogicalKey & (
  | { kind: 'NewFeedback'; value: string; valueDecimals: number; indexedTag1: Hex;
      tag1: string | null; tag2: string | null; endpoint: string | null; feedbackURI: string | null;
      feedbackHash: Hex; invalidTextFields: string[] }
  | { kind: 'FeedbackRevoked' }
  | { kind: 'ResponseAppended'; responder: Hex; responseURI: string | null; responseHash: Hex; invalidTextFields: string[] });
export type FeedbackBatch = { source: FeedbackSource; expectedVersion: string;
  expectedCheckpoint: BlockRef | null; through: BlockRef; observedHead: BlockRef;
  finalizedBlock: BlockRef | null; logs: RawFeedbackLog[] };
export type FeedbackCoverage = { sourceId: string; source: FeedbackSource; stateVersion: string;
  generation: string; availability: 'available' | 'unavailable';
  progress: 'initializing' | 'lagging' | 'synchronized' | 'rebuilding';
  checkpoint: BlockRef | null; observedHead: BlockRef | null; finalizedBlock: BlockRef | null;
  rebuildingThrough: string | null; lastSuccessAt: string | null; lastAttemptAt: string | null;
  retention: { retained: string; pending: string; blocked: string } };
export type FeedbackJob = { eventId: string; sourceId: string; feedbackURI: string | null;
  feedbackHash: Hex; jobVersion: string; attempts: string; nextAttemptAt: string;
  leaseExpiresAt: string | null;
  lastAttemptAt: string | null; state: 'pending' | 'retained' | 'blocked';
  reason: string | null; actualHash: Hex | null; actualSize: string | null };
export type FeedbackJobOutcome = { kind: 'retained'; bytes: Uint8Array }
  | { kind: 'retry'; reason: string; nextAttemptAt: string; actualHash?: Hex; actualSize?: string }
  | { kind: 'blocked'; reason: string; actualHash?: Hex; actualSize?: string };
export type FeedbackEventRecord = { eventId: string; sourceId: string; raw: RawFeedbackLog;
  decoded: DecodedEvent; insertionSequence: string; observedAt: string;
  canonicality: 'canonical' | 'withdrawn' | 'orphaned';
  document: { availability: 'retained' | 'pending' | 'blocked' | 'not-requested';
    hash: Hex | null; byteLength: string | null; retainedAt: string | null; job: FeedbackJob | null };
  semantics: 'not-evaluated' };
export type FeedbackHistoryInput = { sourceId: string; agentId: string; reviewer?: Hex;
  view: 'canonical-prefix' | 'all-retained'; pageSize: number; cursor?: string };
export type FeedbackHistory = { coverage: FeedbackCoverage | null; records: FeedbackEventRecord[];
  canonicalityBasis: 'current-coverage';
  /** Client-tamperable continuation scope, not authenticated chain authority.
   * Freezes event selection only; membership is read at current coverage. */
  basis: { generation: string; through: BlockRef | null; insertionSequence: string } | null;
  view: FeedbackHistoryInput['view']; nextCursor: string | null; semantics: 'not-evaluated' };
