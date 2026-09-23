import { keccak256, stringToBytes } from 'viem';
import { validateServiceDeclaration } from '../../../services/serviceDiscoveryInput.js';
import { qualifiedIdentifier } from '../validation.js';
import { decodeRegistration, MAX_REGISTRATION_BYTES } from '../vendor/nandacity/profile.js';
import type { IdentityObservation, Qualification } from '../types.js';
import type { ProfileInput } from '../profileAdapter.js';

export function qualifyCityProfile(input: ProfileInput): IdentityObservation {
  const bytes = stringToBytes(input.agentURI);
  const wellFormedUri = !input.agentURI.includes('\u0000') &&
    Buffer.from(bytes).toString('utf8') === input.agentURI;
  const boundedUri = wellFormedUri && bytes.length <= 48 * 1024;
  const uriPrefix = 'data:application/json;base64,';
  const encoded = input.agentURI.startsWith(uriPrefix) ? input.agentURI.slice(uriPrefix.length) : null;
  const decodedTooLarge = encoded !== null &&
    (encoded.length > Math.ceil(MAX_REGISTRATION_BYTES / 3) * 4 ||
      Buffer.from(encoded, 'base64').byteLength > MAX_REGISTRATION_BYTES);
  const base = {
    agent: input.agent, block: input.block, owner: input.owner,
    agentURI: boundedUri && !decodedTooLarge ? input.agentURI : null,
    agentUriDigest: keccak256(bytes), agentUriByteLength: bytes.length,
  };
  function withheld(qualification: Qualification, reason: string): IdentityObservation {
    return { ...base, qualification, reason, declaration: null };
  }
  if (!wellFormedUri) return withheld('invalid', 'INVALID_URI');
  if (!boundedUri || decodedTooLarge) return withheld('invalid', 'URI_TOO_LARGE');
  if (BigInt(input.agent.agentId) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return withheld('unsupported', 'UNSAFE_AGENT_ID');
  }
  if (!input.agentURI.startsWith('data:application/json;base64,')) {
    return withheld('unsupported', 'UNSUPPORTED_URI');
  }
  let profile;
  try { profile = decodeRegistration(input.agentURI); }
  catch { return withheld('invalid', 'INVALID_PROFILE'); }
  const expectedRegistry = `eip155:${input.agent.chainId}:${input.agent.registry.toLowerCase()}`;
  if (!profile.registrations.some((registration) => registration.agentId === input.agent.agentId &&
    registration.agentRegistry.toLowerCase() === expectedRegistry)) {
    return withheld('invalid', 'FOREIGN_REGISTRATION');
  }
  if (!profile.active) return withheld('inactive', 'INACTIVE_PROFILE');
  if (profile['x-nandacity'].ownerAtPublication.toLowerCase() !== input.owner.toLowerCase()) {
    return withheld('owner-mismatch', 'OWNER_MISMATCH');
  }
  const service = profile.services.find((item) => item.name === 'A2A')!;
  try {
    const declaration = validateServiceDeclaration({
      identifier: qualifiedIdentifier(input.agent), displayName: profile.name,
      type: 'application/agent-card+json', url: service.endpoint,
      description: profile.description,
      capabilityIds: ['urn:nandacity:capability:evening-plan:0.1'],
      areaServed: profile['x-nandacity'].areaServed.map((area) => area['@id']),
      interfaces: ['application/a2a+json;version=0.3'],
    });
    return { ...base, qualification: 'eligible', reason: null, declaration };
  } catch { return withheld('invalid', 'INVALID_DECLARATION'); }
}
