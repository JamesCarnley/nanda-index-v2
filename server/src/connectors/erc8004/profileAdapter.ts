import type { AgentRef, BlockRef, Hex, IdentityObservation } from './types.js';

export type ProfileInput = { agent: AgentRef; block: BlockRef; owner: Hex; agentURI: string };
export interface Erc8004ProfileAdapter {
  qualify(input: ProfileInput): IdentityObservation;
}
