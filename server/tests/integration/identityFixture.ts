import { keccak256, stringToBytes } from 'viem';
import type { IdentityBatch, IdentityObservation, IdentitySource } from '../../src/connectors/erc8004/types.js';

// Literal public City registration/card fixture (nandacity/test/identity/fixtures.ts).
const registry = '0x1111111111111111111111111111111111111111' as const;
const owner = '0x2222222222222222222222222222222222222222' as const;
export const cityCard = {
  protocolVersion: '0.3.0', name: 'NANDA City Chicago Planner',
  description: 'Builds a bounded evening plan for Chicago.',
  url: 'https://planner.example/a2a', preferredTransport: 'JSONRPC',
  version: '0.1.0',
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
  skills: [{ id: 'evening-plan', name: 'Evening Plan',
    description: 'Builds a bounded city evening plan.', tags: ['city', 'food', 'events'] }],
};
export const cityRegistration = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'NANDA City Chicago Planner',
  description: 'A public identity fixture for the City profile.',
  image: 'https://city.example/chicago.png', active: true, x402Support: false,
  supportedTrust: [],
  registrations: [{ agentId: 7, agentRegistry: `eip155:11155111:${registry}` }],
  services: [{ name: 'A2A', endpoint: 'https://planner.example/.well-known/agent-card.json', version: '0.3.0' }],
  'x-nandacity': {
    version: '0.1', ownerAtPublication: owner, revision: 1,
    cardDigest: '0xceb32de504e328b66dc473d066d85a81b7efd6b772b5798bd8e5a4f155354d5e',
    endpoint: 'https://planner.example/a2a',
    receiptSigner: '0x3333333333333333333333333333333333333333',
    capability: 'evening-plan',
    areaServed: [{ '@type': 'City', '@id': 'https://www.wikidata.org/entity/Q1297', name: 'Chicago' }],
  },
  'x-example': { source: 'public-test-fixture' },
};
export const source: IdentitySource = {
  chainId: 11155111, registry,
  genesisHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  startBlock: '1', adapter: 'nandacity-0.1', confirmations: 2,
};
export const block = {
  number: '42', hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  timestamp: 1790000000,
} as const;
const agentURI = `data:application/json;base64,${Buffer.from(JSON.stringify(cityRegistration)).toString('base64')}`;
export const observation: IdentityObservation = {
  agent: { chainId: source.chainId, registry, agentId: '7' }, block,
  owner, agentURI,
  agentUriDigest: keccak256(stringToBytes(agentURI)),
  agentUriByteLength: Buffer.byteLength(agentURI),
  qualification: 'eligible', reason: null,
  declaration: {
    identifier: `eip155:11155111/erc721:${registry}/7`,
    displayName: cityRegistration.name, type: 'application/agent-card+json',
    url: cityRegistration.services[0]!.endpoint,
    description: cityRegistration.description,
    capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
    areaServed: ['https://www.wikidata.org/entity/Q1297'],
    interfaces: ['application/a2a+json;version=0.3'],
  },
};
export function batch(overrides: Partial<IdentityBatch> = {}): IdentityBatch {
  return { source, expectedVersion: '0', expectedCheckpoint: null, through: block,
    observedHead: block, finalizedBlock: null, observations: [observation], ...overrides };
}
