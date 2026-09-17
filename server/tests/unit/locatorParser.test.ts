import { describe, expect, it } from 'vitest';
import { parseLocator, type ParsedLocator } from '../../src/lib/locatorParser.js';

describe('parseLocator (URN format)', () => {
  it.each<{ locator: string; expected: ParsedLocator }>([
    {
      locator: 'urn:ai:domain:acme.com',
      expected: {
        urn: 'urn:ai:domain:acme.com',
        nid: 'ai',
        type: 'domain',
        domain: 'acme.com',
        agentSlug: null,
        email: null,
        identifier: 'acme.com',
      },
    },
    {
      locator: 'urn:ai:domain:acme.com:agent:support',
      expected: {
        urn: 'urn:ai:domain:acme.com:agent:support',
        nid: 'ai',
        type: 'domain',
        domain: 'acme.com',
        agentSlug: 'support',
        email: null,
        identifier: 'support',
      },
    },
    {
      locator: 'urn:ai:email:demo@example.com',
      expected: {
        urn: 'urn:ai:email:demo@example.com',
        nid: 'ai',
        type: 'email',
        domain: null,
        agentSlug: null,
        email: 'demo@example.com',
        identifier: 'urn:ai:email:demo@example.com',
      },
    },
    {
      locator: 'urn:ai:email:john@hotmail.com',
      expected: {
        urn: 'urn:ai:email:john@hotmail.com',
        nid: 'ai',
        type: 'email',
        domain: null,
        agentSlug: null,
        email: 'john@hotmail.com',
        identifier: 'urn:ai:email:john@hotmail.com',
      },
    },
    {
      locator: 'urn:ai:acme.com:helper',
      expected: {
        urn: 'urn:ai:acme.com:helper',
        nid: 'ai',
        type: 'domain',
        domain: 'acme.com',
        agentSlug: 'helper',
        email: null,
        identifier: 'helper',
      },
    },
    {
      locator: 'urn:ai:org.agntcy',
      expected: {
        urn: 'urn:ai:org.agntcy',
        nid: 'ai',
        type: 'domain',
        domain: 'org.agntcy',
        agentSlug: null,
        email: null,
        identifier: 'org.agntcy',
      },
    },
  ])('parses $locator', ({ locator, expected }) => {
    expect(parseLocator(locator)).toEqual(expected);
  });

  it('preserves the post-trim URN and normalises the NID to lowercase', () => {
    expect(parseLocator('  urn:AI:domain:Acme.com  ')).toEqual({
      urn: 'urn:AI:domain:Acme.com',
      nid: 'ai',
      type: 'domain',
      domain: 'Acme.com',
      agentSlug: null,
      email: null,
      identifier: 'Acme.com',
    });
  });

  it('accepts a valid non-ai NID', () => {
    expect(parseLocator('urn:nanda:google.com:search')).toEqual({
      urn: 'urn:nanda:google.com:search',
      nid: 'nanda',
      type: 'domain',
      domain: 'google.com',
      agentSlug: 'search',
      email: null,
      identifier: 'search',
    });
  });

  it('handles subdomains in the legacy domain component', () => {
    expect(parseLocator('urn:ai:agents.nasiko.com:refunds')).toEqual({
      urn: 'urn:ai:agents.nasiko.com:refunds',
      nid: 'ai',
      type: 'domain',
      domain: 'agents.nasiko.com',
      agentSlug: 'refunds',
      email: null,
      identifier: 'refunds',
    });
  });

  it.each([
    'urn:urn:acme.com:helper',
    'urn:ai:acme.com:',
    'urn:ai:acme.com:helper:extra',
    'urn:ai:domain:acme.com:other',
    'urn:ai:domain:acme.com:agent:helper:extra',
  ])('rejects malformed NANDA locator %s', (value) => {
    expect(() => parseLocator(value)).toThrow();
  });

  it.each([
    'ankit@nasiko.com:global',
    'urn:',
    'urn:a_b:nasiko.com:ankit',
    'urn:-ai:nasiko.com:ankit',
    'urn:ai::ankit',
    'urn:ai:domain:',
    'urn:ai:domain:acme.com:agent:',
    '',
    '   ',
  ])('rejects invalid locator %j', (value) => {
    expect(() => parseLocator(value)).toThrow();
  });
});
