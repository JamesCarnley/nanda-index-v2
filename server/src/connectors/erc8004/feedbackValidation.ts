import { createHash } from 'node:crypto';
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256, toEventSelector } from 'viem';
import type { FeedbackBatch, FeedbackSource, RawFeedbackLog, DecodedEvent } from './feedbackTypes.js';
import type { BlockRef, Hex } from './types.js';
import { feedbackEvents } from './feedbackAbi.js';

function fail(field: string): never { throw new Error(`invalid feedback ${field}`); }
export function feedbackShape(input: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(field);
  const row = input as Record<string, unknown>;
  if (Reflect.ownKeys(row).some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(row, key))) fail(field);
  return row;
}
export function feedbackDecimal(input: unknown, field: string, bits = 256): string {
  if (typeof input !== 'string' || input.length > 78 || !/^(0|[1-9][0-9]*)$/.test(input) ||
    BigInt(input) >= (1n << BigInt(bits))) fail(field);
  return input;
}
export function feedbackInteger(input: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) fail(field);
  return input;
}
export function feedbackHex(input: unknown, field: string, bytes: number): Hex {
  if (typeof input !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(input)) fail(field);
  return input.toLowerCase() as Hex;
}
export function feedbackId(input: unknown): string {
  if (typeof input !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input)) fail('ID');
  return input;
}
export function validateFeedbackBlock(input: unknown): BlockRef {
  const row = feedbackShape(input, ['number', 'hash', 'timestamp'], 'block');
  return { number: feedbackDecimal(row.number, 'block.number'), hash: feedbackHex(row.hash, 'block.hash', 32),
    timestamp: feedbackInteger(row.timestamp, 'block.timestamp') };
}
export function validateFeedbackSource(input: unknown): FeedbackSource {
  const row = feedbackShape(input, ['chainId', 'genesisHash', 'identityRegistry', 'reputationRegistry', 'startBlock', 'confirmations'], 'source');
  return { chainId: feedbackInteger(row.chainId, 'chainId', 1), genesisHash: feedbackHex(row.genesisHash, 'genesisHash', 32),
    identityRegistry: feedbackHex(row.identityRegistry, 'identityRegistry', 20),
    reputationRegistry: feedbackHex(row.reputationRegistry, 'reputationRegistry', 20),
    startBlock: feedbackDecimal(row.startBlock, 'startBlock'), confirmations: feedbackInteger(row.confirmations, 'confirmations') };
}
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export function feedbackSourceId(input: FeedbackSource): string {
  const s = validateFeedbackSource(input);
  return digest(['erc8004-feedback-source-v1', s.chainId, s.genesisHash, s.identityRegistry, s.reputationRegistry]);
}
export function feedbackSourceFingerprint(input: FeedbackSource): string { return digest(validateFeedbackSource(input)); }
export function feedbackEventId(source: FeedbackSource, raw: RawFeedbackLog): string {
  return digest(['erc8004-feedback-event-v1', feedbackSourceId(source),
    feedbackHex(raw.block.hash, 'block.hash', 32), feedbackHex(raw.transactionHash, 'transactionHash', 32),
    feedbackDecimal(raw.logIndex, 'logIndex', 64)]);
}
export function sameFeedbackBlock(a: BlockRef | null, b: BlockRef | null): boolean {
  return a === null ? b === null : b !== null && a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp;
}
export function validateFeedbackHeads(headInput: unknown, finalizedInput: unknown): { observedHead: BlockRef; finalizedBlock: BlockRef | null } {
  const observedHead = validateFeedbackBlock(headInput);
  const finalizedBlock = finalizedInput === null ? null : validateFeedbackBlock(finalizedInput);
  if (finalizedBlock && (BigInt(finalizedBlock.number) > BigInt(observedHead.number) ||
    (finalizedBlock.number === observedHead.number && !sameFeedbackBlock(finalizedBlock, observedHead)))) fail('finality');
  return { observedHead, finalizedBlock };
}
function rawLog(input: unknown): RawFeedbackLog {
  const row = feedbackShape(input, ['block', 'transactionHash', 'transactionIndex', 'logIndex', 'address', 'topics', 'data'], 'log');
  if (!Array.isArray(row.topics) || row.topics.length !== 4 || typeof row.data !== 'string' ||
    row.data.length > 2 + 65536 * 2) fail('log budget/shape');
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(row.data)) fail('data');
  const result: RawFeedbackLog = { block: validateFeedbackBlock(row.block),
    transactionHash: feedbackHex(row.transactionHash, 'transactionHash', 32),
    transactionIndex: feedbackDecimal(row.transactionIndex, 'transactionIndex', 64),
    logIndex: feedbackDecimal(row.logIndex, 'logIndex', 64), address: feedbackHex(row.address, 'address', 20),
    topics: row.topics.map((topic) => feedbackHex(topic, 'topic', 32)), data: row.data.toLowerCase() as Hex };
  // Wire bytes plus the fixed provenance fields; excludes JSON's hexadecimal expansion.
  if (rawLogSize(result) > 65536) fail('log budget');
  return result;
}
function rawLogSize(raw: RawFeedbackLog): number {
  return (raw.data.length - 2) / 2 + raw.topics.length * 32 + 32 + 32 + 20 + 32 + 8 + 8 + 8;
}
const newFeedbackData = [{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' },
  { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes32' }] as const;
const responseData = [{ type: 'uint64' }, { type: 'bytes' }, { type: 'bytes32' }] as const;
const selectors = feedbackEvents.map((event) => toEventSelector(event));
function decode(raw: RawFeedbackLog): DecodedEvent {
  const kind = feedbackEvents[selectors.indexOf(raw.topics[0]!)]?.name;
  if (!kind) fail('event signature');
  const [agentId] = decodeAbiParameters([{ type: 'uint256' }], raw.topics[1]!);
  const [reviewer] = decodeAbiParameters([{ type: 'address' }], raw.topics[2]!);
  const key = { agentId: agentId.toString(), reviewer: feedbackHex(reviewer, 'reviewer', 20) };
  const encodedTopics: Hex[] = [raw.topics[0]!, encodeAbiParameters([{ type: 'uint256' }], [agentId]),
    encodeAbiParameters([{ type: 'address' }], [reviewer])];
  const invalidTextFields: string[] = [];
  const text = (value: Hex, field: string): string | null => {
    try {
      // Solidity strings are arbitrary bytes. Invalid/unrepresentable text is a
      // qualified projection, never grounds to discard a valid raw event.
      const result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hexToBytes(value));
      if (result.includes('\u0000')) throw new Error('NUL text projection');
      return result;
    } catch { invalidTextFields.push(field); return null; }
  };
  let decoded: DecodedEvent; let encodedData: Hex;
  if (kind === 'NewFeedback') {
    const values = decodeAbiParameters(newFeedbackData, raw.data);
    const [feedbackIndex, value, valueDecimals, tag1, tag2, endpoint, uri, feedbackHash] = values;
    if (value < -(10n ** 38n) || value > 10n ** 38n || valueDecimals > 18 ||
      keccak256(tag1) !== raw.topics[3]) fail('value/tag');
    decoded = { ...key, kind, feedbackIndex: feedbackIndex.toString(), value: value.toString(), valueDecimals,
      indexedTag1: raw.topics[3]!, tag1: text(tag1, 'tag1'), tag2: text(tag2, 'tag2'), endpoint: text(endpoint, 'endpoint'),
      feedbackURI: text(uri, 'feedbackURI'), feedbackHash, invalidTextFields };
    encodedData = encodeAbiParameters(newFeedbackData, values); encodedTopics.push(keccak256(tag1));
  } else if (kind === 'FeedbackRevoked') {
    const [feedbackIndex] = decodeAbiParameters([{ type: 'uint64' }], raw.topics[3]!);
    decoded = { ...key, kind, feedbackIndex: feedbackIndex.toString() }; encodedData = '0x';
    encodedTopics.push(encodeAbiParameters([{ type: 'uint64' }], [feedbackIndex]));
  } else {
    const values = decodeAbiParameters(responseData, raw.data);
    const [feedbackIndex, uri, responseHash] = values;
    const [responder] = decodeAbiParameters([{ type: 'address' }], raw.topics[3]!);
    decoded = { ...key, kind, feedbackIndex: feedbackIndex.toString(), responder: feedbackHex(responder, 'responder', 20),
      responseURI: text(uri, 'responseURI'), responseHash, invalidTextFields };
    encodedData = encodeAbiParameters(responseData, values);
    encodedTopics.push(encodeAbiParameters([{ type: 'address' }], [responder]));
  }
  if (decoded.feedbackIndex === '0') fail('feedbackIndex');
  if (encodedData !== raw.data || JSON.stringify(encodedTopics) !== JSON.stringify(raw.topics)) fail('ABI integrity');
  return decoded;
}
export function validateFeedbackBatch(input: FeedbackBatch): FeedbackBatch & { events: { raw: RawFeedbackLog; decoded: DecodedEvent }[] } {
  const row = feedbackShape(input, ['source', 'expectedVersion', 'expectedCheckpoint', 'through', 'observedHead', 'finalizedBlock', 'logs'], 'batch');
  const source = validateFeedbackSource(row.source);
  const expectedVersion = feedbackDecimal(row.expectedVersion, 'expectedVersion');
  const expectedCheckpoint = row.expectedCheckpoint === null ? null : validateFeedbackBlock(row.expectedCheckpoint);
  const through = validateFeedbackBlock(row.through);
  const { observedHead, finalizedBlock } = validateFeedbackHeads(row.observedHead, row.finalizedBlock);
  const from = expectedCheckpoint ? BigInt(expectedCheckpoint.number) + 1n : BigInt(source.startBlock);
  if (BigInt(through.number) < from || BigInt(through.number) + BigInt(source.confirmations) > BigInt(observedHead.number)) fail('range/confirmations');
  if (!Array.isArray(row.logs) || row.logs.length > 1000) fail('batch budget');
  const blocks = new Map<string, BlockRef>();
  function remember(block: BlockRef): void {
    const previous = blocks.get(block.number);
    if (previous && !sameFeedbackBlock(previous, block)) fail('conflicting block');
    blocks.set(block.number, block);
  }
  for (const b of [through, observedHead, finalizedBlock, expectedCheckpoint]) if (b) remember(b);
  let total = 0;
  const positions = new Map<string, string>();
  const transactions = new Map<string, string>();
  const transactionHashes = new Map<string, string>();
  const logs = row.logs.map((value) => {
    const raw = rawLog(value); total += rawLogSize(raw);
    if (total > 2 * 1024 * 1024) fail('batch budget');
    if (raw.address !== source.reputationRegistry || BigInt(raw.block.number) < from || BigInt(raw.block.number) > BigInt(through.number)) fail('log source/range');
    remember(raw.block);
    const position = `${raw.block.number}:${raw.logIndex}`;
    const serialization = JSON.stringify(raw);
    if (positions.has(position) && positions.get(position) !== serialization) fail('conflicting position');
    positions.set(position, serialization);
    const transaction = `${raw.block.number}:${raw.transactionIndex}`;
    if (transactions.has(transaction) && transactions.get(transaction) !== raw.transactionHash) fail('conflicting transaction');
    transactions.set(transaction, raw.transactionHash);
    const transactionHash = `${raw.block.number}:${raw.transactionHash}`;
    if (transactionHashes.has(transactionHash) && transactionHashes.get(transactionHash) !== raw.transactionIndex) fail('conflicting transaction index');
    transactionHashes.set(transactionHash, raw.transactionIndex);
    return raw;
  });
  // A transaction's logs cannot go backwards in block-level log order.
  const sorted = [...logs].sort((a, b) => BigInt(a.block.number) < BigInt(b.block.number) ? -1 :
    BigInt(a.block.number) > BigInt(b.block.number) ? 1 : BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : 1);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!; const b = sorted[i]!;
    if (a.block.number === b.block.number && BigInt(a.transactionIndex) > BigInt(b.transactionIndex)) fail('transaction order');
  }
  return { source, expectedVersion, expectedCheckpoint, through, observedHead, finalizedBlock, logs,
    events: logs.map((raw) => ({ raw, decoded: decode(raw) })) };
}
/** Intrinsic limitations only. Administrator URL allowlisting belongs to the worker. */
export function feedbackAcquisitionBlock(uri: string | null, hash: string): string | null {
  if (/^0x0{64}$/.test(hash)) return 'zero-hash';
  if (uri === null) return 'unsupported-text-uri';
  if (!uri) return 'empty-uri';
  if (Buffer.byteLength(uri, 'utf8') > 2048) return 'uri-too-large';
  if (!/^http:\/\/127\.0\.0\.1(?::[0-9]+)?(?:\/|\?|$)/.test(uri) || /[\s\u0000-\u001f\\]/.test(uri)) return 'unsupported-uri';
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || uri.includes('#')) return 'unsupported-uri';
    return null;
  } catch { return 'malformed-uri'; }
}
