import type { ServiceDeclaration } from '../../types/api/service-discovery.js';

export type Hex = `0x${string}`;
export type AgentRef = { chainId: number; registry: Hex; agentId: string };
export type BlockRef = { number: string; hash: Hex; timestamp: number };
export type IdentitySource = {
  chainId: number; registry: Hex; genesisHash: Hex; startBlock: string;
  adapter: 'nandacity-0.1'; confirmations: number;
};
export type Qualification = 'eligible' | 'inactive' | 'owner-mismatch' |
  'unsupported' | 'invalid' | 'missing';
export type IdentityObservation = {
  agent: AgentRef; block: BlockRef;
  owner: Hex | null; agentURI: string | null;
  agentUriDigest: Hex | null; agentUriByteLength: number | null;
  qualification: Qualification; reason: string | null;
  declaration: ServiceDeclaration | null;
};
export type IdentityCoverage = {
  sourceId: string; stateVersion: string;
  availability: 'available' | 'unavailable';
  progress: 'initializing' | 'lagging' | 'synchronized' | 'rebuilding';
  checkpoint: BlockRef | null; observedHead: BlockRef | null;
  finalizedBlock: BlockRef | null; confirmations: number;
  lastSuccessAt: string | null; lastAttemptAt: string | null;
};
export type IdentityBatch = {
  source: IdentitySource; expectedVersion: string;
  expectedCheckpoint: BlockRef | null; through: BlockRef;
  observedHead: BlockRef; finalizedBlock: BlockRef | null;
  observations: IdentityObservation[];
};
