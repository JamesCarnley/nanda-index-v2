import { describe, expect, it } from 'vitest';
import {
  ServiceDiscoveryError,
  decodeServiceCursor,
  encodeServiceCursor,
  parseServiceReplacement,
  parseServiceSearch,
} from '../../src/services/serviceDiscoveryInput.js';

const validService = {
  identifier: 'service:weather',
  display_name: 'Weather service',
  type: 'application/vnd.a2a+json',
  url: 'https://weather.example/card.json',
  capability_ids: ['capability:forecast'],
  area_served: ['https://www.wikidata.org/entity/Q1297'],
  interfaces: ['application/vnd.a2a+json'],
};

const MAX_PAGE_TOKEN_LENGTH = 16_384;

function expectInvalid(run: () => unknown): void {
  try {
    run();
    throw new Error('expected ServiceDiscoveryError');
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceDiscoveryError);
    expect((error as ServiceDiscoveryError).code).toBe('INVALID_INPUT');
  }
}

describe('parseServiceSearch', () => {
  it('applies the default page size and preserves an optional token', () => {
    expect(parseServiceSearch({
      filter: { interfaces: ['application/vnd.a2a+json'] },
      pageToken: 'next-page',
    })).toEqual({
      filter: { interfaces: ['application/vnd.a2a+json'] },
      pageSize: 20,
      pageToken: 'next-page',
    });
  });

  it('rejects non-plain requests, missing or empty filters, and unknown keys', () => {
    for (const raw of [
      null,
      [],
      {},
      { filter: {} },
      { filter: { areaServed: [] } },
      { filter: { city: ['Chicago'] } },
      { filter: { interfaces: ['a2a'] }, extra: true },
    ]) {
      expectInvalid(() => parseServiceSearch(raw));
    }
  });

  it('requires an exact integer page size from 1 through 100', () => {
    for (const pageSize of ['20', 0, 101, 1.5, Number.NaN]) {
      expectInvalid(() => parseServiceSearch({
        filter: { interfaces: ['a2a'] },
        pageSize,
      }));
    }

    expect(parseServiceSearch({
      filter: { interfaces: ['a2a'] },
      pageSize: 100,
    }).pageSize).toBe(100);
  });

  it('sorts and deduplicates filter values without changing their case', () => {
    const filter = { areaServed: ['place:b', 'place:a', 'place:a', 'Place:a'] };

    expect(parseServiceSearch({ filter }).filter).toEqual({
      areaServed: ['Place:a', 'place:a', 'place:b'],
    });
    expect(filter.areaServed).toEqual(['place:b', 'place:a', 'place:a', 'Place:a']);
  });

  it('bounds raw filter arrays before deduplication', () => {
    const twenty = Array.from({ length: 20 }, () => 'capability:one');
    const twentyOne = Array.from({ length: 21 }, () => 'capability:one');

    expect(parseServiceSearch({ filter: { capabilityIds: twenty } }).filter)
      .toEqual({ capabilityIds: ['capability:one'] });
    expectInvalid(() => parseServiceSearch({ filter: { capabilityIds: twentyOne } }));
  });

  it('rejects invalid filter identifiers and invalid page tokens', () => {
    for (const value of ['', ' padded', 'padded ', 'x'.repeat(513), 42]) {
      expectInvalid(() => parseServiceSearch({ filter: { interfaces: [value] } }));
    }
    for (const pageToken of ['', 'x'.repeat(MAX_PAGE_TOKEN_LENGTH + 1), 42]) {
      expectInvalid(() => parseServiceSearch({
        filter: { interfaces: ['a2a'] },
        pageToken,
      }));
    }
  });

  it('accepts filter identifiers and raw page tokens at their exact limits', () => {
    const filterIdentifier = 'x'.repeat(512);
    const pageToken = 'x'.repeat(MAX_PAGE_TOKEN_LENGTH);

    expect(parseServiceSearch({
      filter: { capabilityIds: [filterIdentifier] },
      pageToken,
    })).toEqual({
      filter: { capabilityIds: [filterIdentifier] },
      pageSize: 20,
      pageToken,
    });
  });

  it('rejects NUL and ill-formed Unicode filter identifiers without repairing them', () => {
    for (const value of ['capability:\u0000weather', 'capability:\uD800', 'capability:\uDC00']) {
      expectInvalid(() => parseServiceSearch({ filter: { capabilityIds: [value] } }));
    }
  });

  it('preserves valid non-ASCII and astral Unicode filter identifiers exactly', () => {
    const value = 'capability:東京:🌦️';

    expect(parseServiceSearch({ filter: { capabilityIds: [value] } }).filter)
      .toEqual({ capabilityIds: [value] });
  });
});

describe('parseServiceReplacement', () => {
  it('accepts an empty replacement', () => {
    expect(parseServiceReplacement({ services: [] })).toEqual([]);
  });

  it('maps native fields, normalizes arrays, and defaults description to null', () => {
    const raw = {
      ...validService,
      capability_ids: ['capability:z', 'capability:a', 'capability:a'],
      area_served: [],
      interfaces: ['z', 'a'],
    };

    expect(parseServiceReplacement({ services: [raw] })).toEqual([{
      identifier: 'service:weather',
      displayName: 'Weather service',
      type: 'application/vnd.a2a+json',
      url: 'https://weather.example/card.json',
      description: null,
      capabilityIds: ['capability:a', 'capability:z'],
      areaServed: [],
      interfaces: ['a', 'z'],
    }]);
    expect(raw.capability_ids).toEqual(['capability:z', 'capability:a', 'capability:a']);
  });

  it('preserves a supplied optional description', () => {
    expect(parseServiceReplacement({
      services: [{ ...validService, description: 'Forecasts for Chicago.' }],
    })[0]?.description).toBe('Forecasts for Chicago.');
  });

  it('rejects malformed bodies, too many services, and missing service fields', () => {
    for (const raw of [
      null,
      [],
      {},
      { services: 'not-an-array' },
      { services: [], extra: true },
      { services: [{}] },
      { services: Array.from({ length: 101 }, () => validService) },
    ]) {
      expectInvalid(() => parseServiceReplacement(raw));
    }
  });

  it('rejects caller-supplied provenance and all other service keys', () => {
    for (const forbidden of [
      { provenance: { sourceId: 'org:other' } },
      { source_id: 'org:other' },
      { source_kind: 'organization-declaration' },
      { organization_id: 'other' },
      { revision: 'caller-controlled' },
    ]) {
      expectInvalid(() => parseServiceReplacement({
        services: [{ ...validService, ...forbidden }],
      }));
    }
  });

  it('rejects duplicate service identifiers without case folding', () => {
    expectInvalid(() => parseServiceReplacement({
      services: [validService, { ...validService, display_name: 'Duplicate' }],
    }));

    expect(parseServiceReplacement({
      services: [validService, { ...validService, identifier: 'SERVICE:WEATHER' }],
    })).toHaveLength(2);
  });

  it('requires HTTP(S) URLs without credentials', () => {
    for (const url of [
      'ftp://weather.example/card.json',
      'https://user:password@weather.example/card.json',
      'https://user@weather.example/card.json',
      'not a URL',
      'x'.repeat(2049),
    ]) {
      expectInvalid(() => parseServiceReplacement({
        services: [{ ...validService, url }],
      }));
    }

    expect(parseServiceReplacement({
      services: [{ ...validService, url: 'http://localhost:3000/card.json' }],
    })[0]?.url).toBe('http://localhost:3000/card.json');
  });

  it('enforces scalar field types and bounds without trimming', () => {
    for (const override of [
      { identifier: '' },
      { identifier: ' service:weather' },
      { identifier: 'x'.repeat(513) },
      { display_name: '' },
      { display_name: 'x'.repeat(256) },
      { type: 42 },
      { type: 'x'.repeat(513) },
      { description: null },
      { description: 'x'.repeat(1001) },
    ]) {
      expectInvalid(() => parseServiceReplacement({
        services: [{ ...validService, ...override }],
      }));
    }
  });

  it('accepts every scalar field at its exact maximum length', () => {
    const urlPrefix = 'https://example.test/';
    const service = {
      ...validService,
      identifier: 'i'.repeat(512),
      display_name: 'd'.repeat(255),
      type: 't'.repeat(512),
      url: `${urlPrefix}${'u'.repeat(2048 - urlPrefix.length)}`,
      description: 'n'.repeat(1000),
    };

    expect(parseServiceReplacement({ services: [service] })[0]).toMatchObject({
      identifier: service.identifier,
      displayName: service.display_name,
      type: service.type,
      url: service.url,
      description: service.description,
    });
  });

  it('accepts 100 distinct service declarations', () => {
    const services = Array.from({ length: 100 }, (_, index) => ({
      ...validService,
      identifier: `service:${index}`,
    }));

    expect(parseServiceReplacement({ services })).toHaveLength(100);
  });

  it('rejects NUL and ill-formed Unicode replacement fields', () => {
    for (const override of [
      { display_name: 'Weather\u0000service' },
      { description: 'Broken high surrogate: \uD800' },
      { description: 'Broken low surrogate: \uDC00' },
    ]) {
      expectInvalid(() => parseServiceReplacement({
        services: [{ ...validService, ...override }],
      }));
    }
  });

  it('preserves valid non-ASCII and astral Unicode replacement fields exactly', () => {
    const service = {
      ...validService,
      identifier: 'service:東京:🌦️',
      display_name: '東京の天気 🌦️',
      description: 'Prévisions météo pour 東京 🌦️',
    };

    expect(parseServiceReplacement({ services: [service] })[0]).toMatchObject({
      identifier: service.identifier,
      displayName: service.display_name,
      description: service.description,
    });
  });

  it('allows empty declaration arrays but validates and bounds their raw values', () => {
    expect(parseServiceReplacement({
      services: [{
        ...validService,
        capability_ids: [],
        area_served: [],
        interfaces: [],
      }],
    })[0]).toMatchObject({ capabilityIds: [], areaServed: [], interfaces: [] });

    for (const capability_ids of [
      [''],
      [' capability:forecast'],
      [42],
      ['x'.repeat(513)],
      Array.from({ length: 21 }, () => 'capability:forecast'),
    ]) {
      expectInvalid(() => parseServiceReplacement({
        services: [{ ...validService, capability_ids }],
      }));
    }
  });
});

describe('service discovery cursors', () => {
  const normalized = { areaServed: ['place:a', 'place:b'] };
  const after = { identifier: 'service:1', sourceId: 'org:one' };
  const expectedToken = 'eyJ2IjoxLCJmaWx0ZXJIYXNoIjoiMDE1YzNiNThiMWEyZWE1MDM1OGFkNzAyOWNhYzBmYjJhNDhiZTI5ZmE1YjU0MmFkOTUwZWYyM2ZkNDI2ZGJhNCIsImFmdGVyIjp7ImlkZW50aWZpZXIiOiJzZXJ2aWNlOjEiLCJzb3VyY2VJZCI6Im9yZzpvbmUifX0';

  it('uses a stable canonical token and decodes it for an equivalent filter', () => {
    const token = encodeServiceCursor(normalized, after);

    expect(token).toBe(expectedToken);
    expect(decodeServiceCursor({ areaServed: ['place:b', 'place:a'] }, token))
      .toEqual(after);
  });

  it.each([
    ['normal values', after],
    ['valid international and astral text', {
      identifier: 'service:東京:🌦️',
      sourceId: 'org:Montréal:🛰️',
    }],
    ['an accepted long control-character identifier', {
      identifier: '\u0001'.repeat(512),
      sourceId: 'org:test',
    }],
    ['both keys at maximum JSON escaping', {
      identifier: '\u0001'.repeat(512),
      sourceId: '\u0001'.repeat(512),
    }],
  ])('round trips %s through search parsing and cursor decoding', (_label, cursorAfter) => {
    const token = encodeServiceCursor(normalized, cursorAfter);

    expect(token.length).toBeLessThanOrEqual(MAX_PAGE_TOKEN_LENGTH);
    expect(parseServiceSearch({
      filter: normalized,
      pageToken: token,
    }).pageToken).toBe(token);
    expect(decodeServiceCursor(normalized, token)).toEqual(cursorAfter);
  });

  it('rejects a cursor bound to a different filter', () => {
    expectInvalid(() => decodeServiceCursor({ areaServed: ['place:c'] }, expectedToken));
  });

  it('rejects malformed, oversized, and non-canonical base64url tokens', () => {
    for (const token of [
      '',
      '***',
      `${expectedToken}=`,
      'x'.repeat(MAX_PAGE_TOKEN_LENGTH + 1),
      Buffer.from('not-json').toString('base64url'),
      Buffer.from(JSON.stringify({
        after,
        filterHash: '015c3b58b1a2ea50358ad7029cac0fb2a48be29fa5b542ad950ef23fd426dba4',
        v: 1,
      })).toString('base64url'),
    ]) {
      expectInvalid(() => decodeServiceCursor(normalized, token));
    }
  });

  it('validates every decoded key, type, version, hash, and cursor bound', () => {
    const validCursor = JSON.parse(
      Buffer.from(expectedToken, 'base64url').toString('utf8'),
    ) as {
      v: number;
      filterHash: string;
      after: typeof after;
    };
    const objects = [
      { ...validCursor, v: 2 },
      { ...validCursor, filterHash: validCursor.filterHash.slice(1) },
      { ...validCursor, extra: true },
      { ...validCursor, after: { ...validCursor.after, extra: true } },
      { ...validCursor, after: { ...validCursor.after, identifier: 42 } },
      { ...validCursor, after: { ...validCursor.after, identifier: 'x'.repeat(513) } },
      { ...validCursor, after: { ...validCursor.after, sourceId: ' org:one' } },
    ];

    for (const object of objects) {
      const token = Buffer.from(JSON.stringify(object), 'utf8').toString('base64url');
      expectInvalid(() => decodeServiceCursor(normalized, token));
    }
  });

  it('validates the filter and last pair when encoding', () => {
    expectInvalid(() => encodeServiceCursor({}, after));
    expectInvalid(() => encodeServiceCursor(normalized, { ...after, identifier: '' }));
    expectInvalid(() => encodeServiceCursor(normalized, { ...after, sourceId: 'x'.repeat(513) }));
  });
});
