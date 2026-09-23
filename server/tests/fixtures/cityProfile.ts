export const registryAddress = '0x1111111111111111111111111111111111111111' as const;
export const originalOwner = '0x2222222222222222222222222222222222222222' as const;
export const originalSigner = '0x3333333333333333333333333333333333333333' as const;
export const newOwner = '0x4444444444444444444444444444444444444444' as const;
export const newSigner = '0x5555555555555555555555555555555555555555' as const;

export const originalCard = {
  protocolVersion: '0.3.0',
  name: 'NANDA City Chicago Planner',
  description: 'Builds a bounded evening plan for Chicago.',
  url: 'https://planner.example/a2a',
  preferredTransport: 'JSONRPC',
  version: '0.1.0',
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'evening-plan',
      name: 'Evening Plan',
      description: 'Builds a bounded city evening plan.',
      tags: ['city', 'food', 'events'],
    },
  ],
};

export const newCard = {
  protocolVersion: '0.3.0',
  name: 'NANDA City Boston Planner',
  description: 'Builds a bounded evening plan for Boston.',
  url: 'https://boston-planner.example/a2a',
  preferredTransport: 'JSONRPC',
  version: '0.2.0',
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'evening-plan',
      name: 'Evening Plan',
      description: 'Builds a bounded city evening plan.',
      tags: ['city', 'food', 'events'],
    },
  ],
};

export const originalCardDigest =
  '0xceb32de504e328b66dc473d066d85a81b7efd6b772b5798bd8e5a4f155354d5e' as const;
export const newCardDigest =
  '0x0688bab38a506bc1a35a6065722ba49ef5d1d055134af868c3f9fc92ec58dd32' as const;
export const originalAgentUriDigest =
  '0x48b94b6612725ac459cf9727ffd9b6ea64360fc4dc8ae1a7620ff6be31bb1c19' as const;
export const originalRegistrationDigest =
  '0xba03e4c8be43c221b39304d3e551387bd73fe96b7d7a8e42048c9b466b9b8251' as const;
export const newAgentUriDigest =
  '0xdd68a37747525e92d394be5c5ede66f7e046f8ca7ebc46dfb71471d62c762bf5' as const;
export const newRegistrationDigest =
  '0x9d744dbcbec820ecb2f9cc450b67da4d1df8f66964ffaef61512875d69cf1a9c' as const;

export const originalRegistration = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'NANDA City Chicago Planner',
  description: 'A public identity fixture for the City profile.',
  image: 'https://city.example/chicago.png',
  active: true,
  x402Support: false,
  supportedTrust: [],
  registrations: [
    {
      agentId: 7,
      agentRegistry: `eip155:11155111:${registryAddress}`,
    },
  ],
  services: [
    {
      name: 'A2A',
      endpoint: 'https://planner.example/.well-known/agent-card.json',
      version: '0.3.0',
    },
  ],
  'x-nandacity': {
    version: '0.1',
    ownerAtPublication: originalOwner,
    revision: 1,
    cardDigest: originalCardDigest,
    endpoint: 'https://planner.example/a2a',
    receiptSigner: originalSigner,
    capability: 'evening-plan',
    areaServed: [
      {
        '@type': 'City',
        '@id': 'https://www.wikidata.org/entity/Q1297',
        name: 'Chicago',
      },
    ],
  },
  'x-example': {
    source: 'public-test-fixture',
  },
};

export const newRegistration = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'NANDA City Boston Planner',
  description: 'A replacement owner profile for the City verifier fixture.',
  image: 'https://city.example/boston.png',
  active: true,
  x402Support: false,
  registrations: [
    {
      agentId: 7,
      agentRegistry: `eip155:11155111:${registryAddress}`,
    },
  ],
  services: [
    {
      name: 'A2A',
      endpoint: 'https://boston-planner.example/.well-known/agent-card.json',
      version: '0.3.0',
    },
  ],
  'x-nandacity': {
    version: '0.1',
    ownerAtPublication: newOwner,
    revision: 2,
    cardDigest: newCardDigest,
    endpoint: 'https://boston-planner.example/a2a',
    receiptSigner: newSigner,
    capability: 'evening-plan',
    areaServed: [
      {
        '@type': 'City',
        '@id': 'https://www.wikidata.org/entity/Q100',
        name: 'Boston',
      },
    ],
  },
};

const textEncoder = new TextEncoder();

export function bytesFor(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

export function dataUriFor(value: unknown): string {
  return `data:application/json;base64,${Buffer.from(bytesFor(value)).toString('base64')}`;
}

export function cloneOriginalRegistration(): typeof originalRegistration {
  return structuredClone(originalRegistration);
}

export function cloneOriginalCard(): typeof originalCard {
  return structuredClone(originalCard);
}

export const originalAgent = {
  chainId: 11155111,
  registry: registryAddress,
  agentId: '7',
} as const;

export const originalCandidate = {
  agent: originalAgent,
  agentURI: dataUriFor(originalRegistration),
  cardBytes: bytesFor(originalCard),
};

export const originalBasis = {
  agent: originalAgent,
  blockNumber: '9123456',
  blockHash:
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
  blockTimestamp: 1_789_123_456,
  agentOwner: originalOwner,
  agentURI: originalCandidate.agentURI,
};

export const newCandidate = {
  agent: originalAgent,
  agentURI: dataUriFor(newRegistration),
  cardBytes: bytesFor(newCard),
};

export const newBasis = {
  agent: originalAgent,
  blockNumber: '9123999',
  blockHash:
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const,
  blockTimestamp: 1_789_127_999,
  agentOwner: newOwner,
  agentURI: newCandidate.agentURI,
};

export function makeFixtureCandidate(overrides: {
  endpoint?: string;
} = {}): typeof originalCandidate {
  const registration = cloneOriginalRegistration();
  if (overrides.endpoint !== undefined) {
    registration['x-nandacity'].endpoint = overrides.endpoint;
  }
  return {
    agent: originalAgent,
    agentURI: dataUriFor(registration),
    cardBytes: bytesFor(originalCard),
  };
}
