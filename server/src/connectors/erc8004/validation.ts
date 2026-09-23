import { createHash } from 'node:crypto';
import { keccak256, stringToBytes } from 'viem';
import { validateServiceDeclaration } from '../../services/serviceDiscoveryInput.js';
import type {
  AgentRef, BlockRef, Hex, IdentityBatch, IdentityObservation, IdentitySource,
} from './types.js';

function fail(field: string): never { throw new Error(`invalid identity ${field}`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(field);
  return value as Record<string, unknown>;
}
function shape(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  const row = object(value, field);
  if (Reflect.ownKeys(row).some((key) => typeof key !== 'string' || !keys.includes(key))) fail(field);
  if (keys.some((key) => !Object.hasOwn(row, key))) fail(field);
  return row;
}
export function decimal(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) ||
      BigInt(value) > 9223372036854775807n) fail(field);
  return value;
}
function agentDecimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 78 ||
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      BigInt(value) > (1n << 256n) - 1n) fail('agent.agentId');
  return value;
}
function safeInt(value: unknown, field: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail(field);
  return value;
}
function hex(value: unknown, field: string, bytes: number): Hex {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) fail(field);
  return value.toLowerCase() as Hex;
}
export function validateAgent(value: unknown): AgentRef {
  const row = shape(value, 'agent', ['chainId', 'registry', 'agentId']);
  return { chainId: safeInt(row.chainId, 'agent.chainId', 1),
    registry: hex(row.registry, 'agent.registry', 20), agentId: agentDecimal(row.agentId) };
}
export function validateBlock(value: unknown): BlockRef {
  const row = shape(value, 'block', ['number', 'hash', 'timestamp']);
  return { number: decimal(row.number, 'block.number'), hash: hex(row.hash, 'block.hash', 32),
    timestamp: safeInt(row.timestamp, 'block.timestamp') };
}
export function validateSource(value: unknown): IdentitySource {
  const row = shape(value, 'source', ['chainId', 'registry', 'genesisHash', 'startBlock', 'adapter', 'confirmations']);
  if (row.adapter !== 'nandacity-0.1') fail('source.adapter');
  return { chainId: safeInt(row.chainId, 'source.chainId', 1),
    registry: hex(row.registry, 'source.registry', 20), genesisHash: hex(row.genesisHash, 'source.genesisHash', 32),
    startBlock: decimal(row.startBlock, 'source.startBlock'), adapter: 'nandacity-0.1',
    confirmations: safeInt(row.confirmations, 'source.confirmations') };
}
export function identitySourceId(source: IdentitySource): string {
  const valid = validateSource(source);
  return `erc8004-identity:${valid.chainId}:${valid.registry}`;
}
export function sourceFingerprint(source: IdentitySource): string {
  const s = validateSource(source);
  return JSON.stringify({ chainId: s.chainId, registry: s.registry, genesisHash: s.genesisHash,
    startBlock: s.startBlock, adapter: s.adapter, confirmations: s.confirmations });
}
export function qualifiedIdentifier(agent: AgentRef): string {
  const a = validateAgent(agent);
  return `eip155:${a.chainId}/erc721:${a.registry}/${a.agentId}`;
}
function validateObservation(value: unknown, source: IdentitySource, through: BlockRef): IdentityObservation {
  const row = shape(value, 'observation', ['agent', 'block', 'owner', 'agentURI', 'agentUriDigest',
    'agentUriByteLength', 'qualification', 'reason', 'declaration']);
  const agent = validateAgent(row.agent);
  const block = validateBlock(row.block);
  if (agent.chainId !== source.chainId || agent.registry !== source.registry ||
      block.hash !== through.hash || block.number !== through.number || block.timestamp !== through.timestamp) fail('observation source/block');
  const owner = row.owner === null ? null : hex(row.owner, 'observation.owner', 20);
  const agentURI = row.agentURI;
  if (agentURI !== null && (typeof agentURI !== 'string' || agentURI.includes('\u0000') ||
      Buffer.from(agentURI, 'utf8').toString('utf8') !== agentURI)) fail('observation.agentURI');
  const uri = agentURI as string | null;
  const agentUriDigest = row.agentUriDigest === null ? null : hex(row.agentUriDigest, 'observation.agentUriDigest', 32);
  const agentUriByteLength = row.agentUriByteLength === null ? null : safeInt(row.agentUriByteLength, 'observation.agentUriByteLength');
  if (uri !== null && (agentUriDigest !== keccak256(stringToBytes(uri)) ||
      agentUriByteLength !== Buffer.byteLength(uri, 'utf8'))) fail('observation URI commitment');
  if (uri === null && (agentUriDigest === null) !== (agentUriByteLength === null)) fail('observation URI commitment');
  if (uri !== null && Buffer.byteLength(uri, 'utf8') > 48 * 1024) fail('observation URI budget');
  if (uri?.startsWith('data:application/json;base64,') &&
    Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').byteLength > 32 * 1024) {
    fail('observation URI decoded-byte budget');
  }
  const qualifications = ['eligible', 'inactive', 'owner-mismatch', 'unsupported', 'invalid', 'missing'];
  if (!qualifications.includes(row.qualification as string)) fail('observation.qualification');
  const reason = row.reason;
  if (reason !== null && (typeof reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason))) fail('observation.reason');
  if (row.qualification === 'eligible' ? (row.declaration === null || reason !== null) :
      (row.declaration !== null || reason === null)) fail('observation qualification/declaration');
  if (row.qualification === 'eligible' && (owner === null || uri === null)) {
    fail('eligible observation owner/URI');
  }
  if (row.qualification === 'eligible' && BigInt(agent.agentId) > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('eligible observation agentId unsupported by adapter');
  }
  let declaration = null;
  if (row.declaration !== null) {
    shape(row.declaration, 'observation.declaration', [
      'identifier', 'displayName', 'type', 'url', 'description',
      'capabilityIds', 'areaServed', 'interfaces',
    ]);
    declaration = validateServiceDeclaration(row.declaration);
    if (declaration.identifier !== qualifiedIdentifier(agent)) fail('observation.declaration.identifier');
  }
  const result = { agent, block, owner, agentURI: uri, agentUriDigest,
    agentUriByteLength, qualification: row.qualification as IdentityObservation['qualification'],
    reason: reason as string | null, declaration };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 64 * 1024) fail('observation byte budget');
  return result;
}
export function validateBatch(value: unknown): IdentityBatch {
  const row = shape(value, 'batch', ['source', 'expectedVersion', 'expectedCheckpoint', 'through',
    'observedHead', 'finalizedBlock', 'observations']);
  const source = validateSource(row.source);
  const through = validateBlock(row.through);
  const observedHead = validateBlock(row.observedHead);
  const expectedCheckpoint = row.expectedCheckpoint === null ? null : validateBlock(row.expectedCheckpoint);
  const finalizedBlock = row.finalizedBlock === null ? null : validateBlock(row.finalizedBlock);
  if (BigInt(through.number) > BigInt(observedHead.number) ||
      (finalizedBlock && BigInt(finalizedBlock.number) > BigInt(observedHead.number)) ||
      !Array.isArray(row.observations) || row.observations.length > 1000) fail('batch bounds');
  if ((through.number === observedHead.number &&
      (through.hash !== observedHead.hash || through.timestamp !== observedHead.timestamp)) ||
      (finalizedBlock && finalizedBlock.number === observedHead.number &&
      (finalizedBlock.hash !== observedHead.hash || finalizedBlock.timestamp !== observedHead.timestamp))) {
    fail('batch bounds');
  }
  const observations = row.observations.map((item) => validateObservation(item, source, through));
  if (new Set(observations.map((item) => item.agent.agentId)).size !== observations.length) fail('duplicate subject');
  return { source, expectedVersion: decimal(row.expectedVersion, 'batch.expectedVersion'),
    expectedCheckpoint, through, observedHead, finalizedBlock, observations };
}
export function identityObservationId(source: IdentitySource, observation: IdentityObservation): string {
  const s = validateSource(source);
  const o = validateObservation(observation, s, observation.block);
  const canonical = JSON.stringify({ source: JSON.parse(sourceFingerprint(s)), observation: o });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
export function parseObservationId(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail('observationId');
  return value;
}
