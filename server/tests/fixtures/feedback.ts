import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from 'viem';
import type { BlockRef, Hex } from '../../src/connectors/erc8004/types.js';
import type { FeedbackSource, RawFeedbackLog } from '../../src/connectors/erc8004/feedbackTypes.js';
import { getSql } from '../../src/db/client.js';
import { feedbackSourceId } from '../../src/connectors/erc8004/feedbackValidation.js';

export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const address = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;
export const block = (n = '10', h = hash(Number(n))): BlockRef => ({ number: n, hash: h, timestamp: 1234 });
export const payload = new Uint8Array([83, 91, 0, 255]);
export function source(): FeedbackSource {
  return { chainId: 31337, genesisHash: `0x${randomBytes(32).toString('hex')}`, identityRegistry: address(12),
    reputationRegistry: address(13), startBlock: '10', confirmations: 0 };
}
export const config = () => ({ ...source(), rpcUrl: 'http://127.0.0.1:8545/', pollMs: 100, maxBlockSpan: 128,
  documentUrls: [] as string[] });
const abi = parseAbi([
  'event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)',
  'event FeedbackRevoked(uint256 indexed agentId,address indexed clientAddress,uint64 indexed feedbackIndex)',
  'event ResponseAppended(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,address indexed responder,string responseURI,bytes32 responseHash)',
]);
export function log(s: FeedbackSource, options: { index?: string; block?: BlockRef; kind?: 'NewFeedback' | 'FeedbackRevoked' | 'ResponseAppended';
  uri?: string; bytes?: Uint8Array; agentId?: string; digest?: Hex } = {}): RawFeedbackLog {
  const agentId = BigInt(options.agentId ?? '7'); const kind = options.kind ?? 'NewFeedback';
  const clientAddress = address(15); let topics: Hex[]; let data: Hex;
  if (kind === 'NewFeedback') {
    topics = encodeEventTopics({ abi, eventName: kind, args: { agentId, clientAddress, indexedTag1: '' } }) as Hex[];
    data = encodeAbiParameters([{ type: 'uint64' }, { type: 'int128' }, { type: 'uint8' }, { type: 'string' },
      { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
    [1n, -30n, 1, '', '', '', options.uri ?? 'http://127.0.0.1:9987/review', options.digest ?? keccak256(options.bytes ?? payload)]);
  } else if (kind === 'FeedbackRevoked') {
    topics = encodeEventTopics({ abi, eventName: kind, args: { agentId, clientAddress, feedbackIndex: 1n } }) as Hex[]; data = '0x';
  } else {
    topics = encodeEventTopics({ abi, eventName: kind, args: { agentId, clientAddress, responder: address(16) } }) as Hex[];
    data = encodeAbiParameters([{ type: 'uint64' }, { type: 'string' }, { type: 'bytes32' }], [1n, 'response', hash(17)]);
  }
  return { block: options.block ?? block(), transactionHash: hash(18), transactionIndex: '0', logIndex: options.index ?? '0',
    address: s.reputationRegistry, topics, data };
}
/** Delete only this test's explicit sources and then their unshared documents. */
export async function cleanupSources(sources: FeedbackSource[]): Promise<void> {
  if (!sources.length) return;
  const ids = sources.map(feedbackSourceId); const sql = getSql();
  await sql.begin(async (tx) => {
    const hashes = await tx<{ feedbackHash: string }[]>`SELECT DISTINCT feedback_hash FROM feedback_fetch_jobs WHERE source_id IN ${tx(ids)}`;
    await tx`DELETE FROM feedback_fetch_jobs WHERE source_id IN ${tx(ids)}`;
    await tx`DELETE FROM feedback_membership WHERE source_id IN ${tx(ids)}`;
    await tx`DELETE FROM feedback_events WHERE source_id IN ${tx(ids)}`;
    await tx`DELETE FROM feedback_sources WHERE source_id IN ${tx(ids)}`;
    for (const { feedbackHash } of hashes) {
      await tx`DELETE FROM feedback_documents d WHERE document_hash = ${feedbackHash}
        AND NOT EXISTS (SELECT 1 FROM feedback_fetch_jobs j WHERE j.feedback_hash = d.document_hash)`;
    }
  });
}
