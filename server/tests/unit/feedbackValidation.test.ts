import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import * as v from '../../src/connectors/erc8004/feedbackValidation.js';
import type { FeedbackBatch, FeedbackSource, RawFeedbackLog } from '../../src/connectors/erc8004/feedbackTypes.js';
import type { BlockRef, Hex } from '../../src/connectors/erc8004/types.js';

const hash = (digit: string): Hex => `0x${digit.repeat(64)}`;
export const source: FeedbackSource = { chainId: 31337, genesisHash: hash('1'),
  identityRegistry: `0x${'2'.repeat(40)}`, reputationRegistry: `0x${'3'.repeat(40)}`,
  startBlock: '10', confirmations: 0 };
export const block = (number = '10'): BlockRef => ({ number, hash: hash('4'), timestamp: 1234 });
const reviewer = `0x${'5'.repeat(40)}` as const;
// Independent literals copied from the pinned Solidity event declarations, not the implementation ABI.
const fixtureAbi = parseAbi([
  'event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)',
  'event FeedbackRevoked(uint256 indexed agentId,address indexed clientAddress,uint64 indexed feedbackIndex)',
  'event ResponseAppended(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,address indexed responder,string responseURI,bytes32 responseHash)',
]);
export function log(options: { kind?: 'NewFeedback' | 'FeedbackRevoked' | 'ResponseAppended'; index?: string;
  agentId?: string; feedbackIndex?: string; value?: bigint; decimals?: number; uri?: string; digest?: Hex;
  block?: BlockRef } = {}): RawFeedbackLog {
  const kind = options.kind ?? 'NewFeedback';
  const agentId = BigInt(options.agentId ?? '7');
  const feedbackIndex = BigInt(options.feedbackIndex ?? '1');
  let topics: Hex[]; let data: Hex;
  if (kind === 'NewFeedback') {
    topics = encodeEventTopics({ abi: fixtureAbi, eventName: kind,
      args: { agentId, clientAddress: reviewer, indexedTag1: 'quality' } }) as Hex[];
    data = encodeAbiParameters([{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' },
      { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
    [feedbackIndex, options.value ?? -35n, options.decimals ?? 1, 'quality', 'synthetic', '',
      options.uri ?? 'http://127.0.0.1:9876/review', options.digest ?? keccak256(new Uint8Array([0, 255, 1]))]);
  } else if (kind === 'FeedbackRevoked') {
    topics = encodeEventTopics({ abi: fixtureAbi, eventName: kind,
      args: { agentId, clientAddress: reviewer, feedbackIndex } }) as Hex[]; data = '0x';
  } else {
    topics = encodeEventTopics({ abi: fixtureAbi, eventName: kind,
      args: { agentId, clientAddress: reviewer, responder: `0x${'6'.repeat(40)}` } }) as Hex[];
    data = encodeAbiParameters([{ type: 'uint64' }, { type: 'string' }, { type: 'bytes32' }],
      [feedbackIndex, options.uri ?? 'http://127.0.0.1:9876/response', options.digest ?? hash('7')]);
  }
  return { block: options.block ?? block(), transactionHash: hash('8'), transactionIndex: '0',
    logIndex: options.index ?? '0', address: source.reputationRegistry, topics, data };
}
export const batch = (overrides: Partial<FeedbackBatch> = {}): FeedbackBatch => ({ source,
  expectedVersion: '0', expectedCheckpoint: null, through: block(), observedHead: block(),
  finalizedBlock: null, logs: [log()], ...overrides });

describe('qualified raw feedback validation', () => {
  it('retains arbitrary Solidity string bytes and hashes original tag bytes without poisoning later logs', () => {
    const raw = log();
    raw.data = encodeAbiParameters([{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' },
      { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes32' }],
    [1n, -35n, 1, '0xff', '0xefbbbf71', '0x00', '0xff', hash('7')]);
    raw.topics[3] = keccak256('0xff');
    const result = v.validateFeedbackBatch(batch({ logs: [raw, log({ index: '1', kind: 'FeedbackRevoked' })] }));
    expect(result.events[0]!.decoded).toMatchObject({ tag1: null, tag2: '\ufeffq', endpoint: null,
      feedbackURI: null, invalidTextFields: ['tag1', 'endpoint', 'feedbackURI'], indexedTag1: keccak256('0xff') });
    expect(result.events[1]!.decoded.kind).toBe('FeedbackRevoked');
    expect(result.events[0]!.raw).toEqual(raw);
  });
  it('retains a response with unrepresentable URI bytes as attributed evidence', () => {
    const raw = log({ kind: 'ResponseAppended' });
    raw.data = encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes' }, { type: 'bytes32' }], [1n, '0xff', hash('7')]);
    expect(v.validateFeedbackBatch(batch({ logs: [raw] })).events[0]!.decoded)
      .toMatchObject({ kind: 'ResponseAppended', responseURI: null, invalidTextFields: ['responseURI'] });
  });
  it('rejects a transaction hash assigned two different indices in one block', () => {
    expect(() => v.validateFeedbackBatch(batch({ logs: [log(), { ...log({ index: '1' }), transactionIndex: '1' }] }))).toThrow();
  });
  it('decodes reference negative decimal values and full uint256/uint64 widths without rounding', () => {
    const decoded = v.validateFeedbackBatch(batch({ logs: [log({
      agentId: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      feedbackIndex: '18446744073709551615', value: -100000000000000000000000000000000000000n, decimals: 18 })] })).events[0]!.decoded;
    expect(decoded).toMatchObject({ kind: 'NewFeedback', value: '-100000000000000000000000000000000000000',
      valueDecimals: 18, agentId: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      feedbackIndex: '18446744073709551615', indexedTag1: keccak256(stringToHex('quality')) });
  });
  it('decodes the nonindexed response feedbackIndex and indexed responder correctly', () => {
    expect(v.validateFeedbackBatch(batch({ logs: [log({ kind: 'ResponseAppended', feedbackIndex: '18446744073709551615' })] }))
      .events[0]!.decoded).toMatchObject({ kind: 'ResponseAppended', feedbackIndex: '18446744073709551615',
        responder: `0x${'6'.repeat(40)}`, responseURI: 'http://127.0.0.1:9876/response' });
    expect(v.validateFeedbackBatch(batch({ logs: [log({ kind: 'FeedbackRevoked' })] })).events[0]!.decoded)
      .toMatchObject({ kind: 'FeedbackRevoked', feedbackIndex: '1' });
  });
  it('separates source domain, config fingerprint and qualified raw-event identities', () => {
    const first = v.feedbackSourceId(source);
    for (const changed of [{ chainId: 1 }, { genesisHash: hash('9') },
      { identityRegistry: reviewer }, { reputationRegistry: reviewer }]) {
      expect(v.feedbackSourceId({ ...source, ...changed })).not.toBe(first);
    }
    expect(v.feedbackSourceId({ ...source, startBlock: '11', confirmations: 2 })).toBe(first);
    expect(v.feedbackSourceFingerprint({ ...source, startBlock: '11' })).not.toBe(v.feedbackSourceFingerprint(source));
    expect(v.feedbackEventId(source, log({ block: { ...block(), hash: hash('9') } })))
      .not.toBe(v.feedbackEventId(source, log()));
    expect(v.feedbackEventId(source, log({ index: '1' }))).not.toBe(v.feedbackEventId(source, log()));
  });
  it.each(['01', '-1', '1.2', '1e2', '115792089237316195423570985008687907853269984665640564039457584007913129639936'])(
    'rejects noncanonical or overflowing decimal %s', (number) => {
      expect(() => v.validateFeedbackBatch(batch({ through: block(number) }))).toThrow();
    });
  it('rejects wrong source, malformed ABI, tag mismatch and reference-impossible values', () => {
    for (const raw of [ { ...log(), address: reviewer }, { ...log(), data: '0x12' as Hex },
      { ...log(), topics: [...log().topics.slice(0, 3), hash('9')] },
      { ...log(), data: `${log().data}00` as Hex }, log({ decimals: 19 }),
      log({ value: 100000000000000000000000000000000000001n }), log({ feedbackIndex: '0' }) ]) {
      expect(() => v.validateFeedbackBatch(batch({ logs: [raw] }))).toThrow();
    }
  });
  it('rejects incompatible block identities, positions and unconfirmed/out-of-range logs', () => {
    for (const input of [batch({ observedHead: block('9') }),
      batch({ source: { ...source, confirmations: 1 } }), batch({ finalizedBlock: block('11') }),
      batch({ expectedCheckpoint: block() }), batch({ logs: [log({ block: block('9') })] }),
      batch({ logs: [log(), log({ index: '1', block: { ...block(), hash: hash('9') } })] }),
      batch({ logs: [{ ...log(), transactionIndex: '18446744073709551616' }, log({ index: '1' })] }),
      batch({ logs: [log(), { ...log(), transactionHash: hash('9') }] })]) {
      expect(() => v.validateFeedbackBatch(input)).toThrow();
    }
  });
  it('rejects whole batches over log, individual-byte or aggregate-byte bounds', () => {
    expect(() => v.validateFeedbackBatch(batch({ logs: Array.from({ length: 1001 }, (_, i) => log({ index: String(i) })) }))).toThrow(/budget/);
    expect(() => v.validateFeedbackBatch(batch({ logs: [log({ uri: 'x'.repeat(65536) })] }))).toThrow(/budget/);
    expect(() => v.validateFeedbackBatch(batch({ logs: Array.from({ length: 40 }, (_, i) => log({ index: String(i), uri: 'x'.repeat(60000) })) }))).toThrow(/budget/);
  });
  it('classifies intrinsic acquisition failures without interpreting opaque bytes', () => {
    expect(v.feedbackAcquisitionBlock('http://127.0.0.1:9876/review', hash('7'))).toBeNull();
    expect(v.feedbackAcquisitionBlock('', hash('7'))).toBe('empty-uri');
    expect(v.feedbackAcquisitionBlock('x'.repeat(2049), hash('7'))).toBe('uri-too-large');
    expect(v.feedbackAcquisitionBlock('http://127.0.0.1:9876/review', hash('0'))).toBe('zero-hash');
    for (const uri of ['https://example.com', 'http://localhost:9', 'http://127.1/a',
      'http://user@127.0.0.1:9/a', 'http://127.0.0.1:9/a#part']) {
      expect(v.feedbackAcquisitionBlock(uri, hash('7'))).not.toBeNull();
    }
  });
});
