import { describe, expect, it } from 'vitest';
import { originalAgent, originalCandidate, originalOwner, newOwner,
  originalRegistration, dataUriFor } from '../fixtures/cityProfile.js';
import { qualifyCityProfile } from '../../src/connectors/erc8004/adapters/nandaCityV01.js';

const block = { number: '42', hash: `0x${'bb'.repeat(32)}` as `0x${string}`, timestamp: 1790000000 };
const input = { agent: originalAgent, block, owner: originalOwner, agentURI: originalCandidate.agentURI };

describe('pinned City 0.1 qualification', () => {
  it('projects only the exact declared service, without fetching a card', () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('network fetch forbidden'); }) as typeof fetch;
    try {
      expect(qualifyCityProfile(input)).toMatchObject({
        agent: originalAgent, owner: originalOwner, agentUriDigest:
          '0x48b94b6612725ac459cf9727ffd9b6ea64360fc4dc8ae1a7620ff6be31bb1c19',
        qualification: 'eligible', reason: null,
        declaration: {
          identifier: `eip155:11155111/erc721:${originalAgent.registry}/7`,
          displayName: 'NANDA City Chicago Planner',
          url: 'https://planner.example/.well-known/agent-card.json',
          capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
          areaServed: ['https://www.wikidata.org/entity/Q1297'],
          interfaces: ['application/a2a+json;version=0.3'],
        },
      });
    } finally { globalThis.fetch = oldFetch; }
  });

  it('withholds a former owner after transfer', () => {
    expect(qualifyCityProfile({ ...input, owner: newOwner })).toMatchObject({
      qualification: 'owner-mismatch', declaration: null,
    });
  });

  it('withholds inactive and foreign-bound profiles', () => {
    expect(qualifyCityProfile({ ...input, agentURI: dataUriFor({
      ...originalRegistration, active: false,
    }) }).qualification).toBe('inactive');
    expect(qualifyCityProfile({ ...input, agentURI: dataUriFor({
      ...originalRegistration, registrations: [{ agentId: 7,
        agentRegistry: `eip155:1:${originalAgent.registry}` }],
    }) }).qualification).toBe('invalid');
  });

  it('preserves unsupported, invalid, oversized and unsafe-ID observations without eligibility', () => {
    expect(qualifyCityProfile({ ...input, agentURI: 'https://example.test/profile' }))
      .toMatchObject({ qualification: 'unsupported', declaration: null });
    expect(qualifyCityProfile({ ...input, agentURI: 'data:application/json;base64,%%%' }))
      .toMatchObject({ qualification: 'invalid', declaration: null });
    expect(qualifyCityProfile({ ...input, agentURI: `data:application/json;base64,${Buffer.alloc(33 * 1024).toString('base64')}` }))
      .toMatchObject({ qualification: 'invalid', agentURI: null, reason: 'URI_TOO_LARGE', declaration: null });
    expect(qualifyCityProfile({ ...input, agentURI: `data:application/json;base64,${Buffer.alloc(32 * 1024 + 1).toString('base64')}` }))
      .toMatchObject({ qualification: 'invalid', agentURI: null, reason: 'URI_TOO_LARGE', declaration: null });
    expect(qualifyCityProfile({ ...input, agentURI: 'bad\u0000uri' }))
      .toMatchObject({ qualification: 'invalid', agentURI: null, reason: 'INVALID_URI', declaration: null });
    expect(qualifyCityProfile({ ...input, agent: { ...originalAgent, agentId: '9007199254740992' } }))
      .toMatchObject({ agent: { agentId: '9007199254740992' }, qualification: 'unsupported',
        reason: 'UNSAFE_AGENT_ID', declaration: null });
  });
});
