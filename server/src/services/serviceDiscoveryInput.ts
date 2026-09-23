import { createHash } from 'node:crypto';
import type {
  ServiceDeclaration,
  ServiceFilter,
  ServiceSearchQuery,
} from '../types/api/service-discovery.js';

const FILTER_KEYS = ['capabilityIds', 'areaServed', 'interfaces'] as const;
const SEARCH_KEYS = ['filter', 'pageSize', 'pageToken'] as const;
const REPLACEMENT_KEYS = ['services'] as const;
const SERVICE_KEYS = [
  'identifier',
  'display_name',
  'type',
  'url',
  'description',
  'capability_ids',
  'area_served',
  'interfaces',
] as const;
const CURSOR_KEYS = ['v', 'filterHash', 'after'] as const;
const CURSOR_AFTER_KEYS = ['identifier', 'sourceId'] as const;

const MAX_FILTER_VALUES = 20;
const MAX_IDENTIFIER_LENGTH = 512;
// Two 512-character keys at six ASCII bytes per escaped code unit plus 127
// JSON bytes encode to 8,362 base64url characters; 16 KiB preserves that domain.
const MAX_PAGE_TOKEN_LENGTH = 16_384;

type PlainObject = Record<string, unknown>;

export class ServiceDiscoveryError extends Error {
  constructor(
    public readonly code: 'INVALID_INPUT' | 'FORBIDDEN' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceDiscoveryError';
  }
}

function invalid(message: string): never {
  throw new ServiceDiscoveryError('INVALID_INPUT', message);
}

function parsePlainObject(value: unknown, path: string): PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${path} must be a plain object`);
  }

  return value as PlainObject;
}

function requireAllowedKeys(
  value: PlainObject,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return invalid(`${path} contains unknown field ${String(key)}`);
    }
  }
}

function requireOwnKey(value: PlainObject, key: string, path: string): void {
  if (!Object.hasOwn(value, key)) {
    return invalid(`${path}.${key} is required`);
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      if (index + 1 >= value.length) {
        return false;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function parseBoundedString(
  value: unknown,
  path: string,
  options: { minLength?: number; maxLength: number; unpadded?: boolean },
): string {
  const minimum = options.minLength ?? 0;
  if (typeof value !== 'string') {
    return invalid(`${path} must be a string`);
  }
  if (value.length < minimum || value.length > options.maxLength) {
    return invalid(`${path} must contain ${minimum}-${options.maxLength} characters`);
  }
  if (value.includes('\u0000')) {
    return invalid(`${path} must not contain NUL`);
  }
  if (!isWellFormedUnicode(value)) {
    return invalid(`${path} must contain well-formed Unicode`);
  }
  if (options.unpadded && value.trim() !== value) {
    return invalid(`${path} must not have surrounding whitespace`);
  }
  return value;
}

function parseStringArray(
  value: unknown,
  path: string,
  minimum: number,
): string[] {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be an array`);
  }
  if (value.length < minimum || value.length > MAX_FILTER_VALUES) {
    return invalid(`${path} must contain ${minimum}-${MAX_FILTER_VALUES} values`);
  }

  const values = value.map((item, index) => parseBoundedString(
    item,
    `${path}[${index}]`,
    { minLength: 1, maxLength: MAX_IDENTIFIER_LENGTH, unpadded: true },
  ));
  return [...new Set(values)].sort();
}

function parseFilter(raw: unknown): ServiceFilter {
  const value = parsePlainObject(raw, 'filter');
  requireAllowedKeys(value, FILTER_KEYS, 'filter');

  const filter: ServiceFilter = {};
  if (Object.hasOwn(value, 'capabilityIds')) {
    filter.capabilityIds = parseStringArray(value.capabilityIds, 'filter.capabilityIds', 1);
  }
  if (Object.hasOwn(value, 'areaServed')) {
    filter.areaServed = parseStringArray(value.areaServed, 'filter.areaServed', 1);
  }
  if (Object.hasOwn(value, 'interfaces')) {
    filter.interfaces = parseStringArray(value.interfaces, 'filter.interfaces', 1);
  }

  if (Object.keys(filter).length === 0) {
    return invalid('filter must contain at least one supported field');
  }
  return filter;
}

export function parseServiceSearch(raw: unknown): ServiceSearchQuery {
  const value = parsePlainObject(raw, 'request');
  requireAllowedKeys(value, SEARCH_KEYS, 'request');
  requireOwnKey(value, 'filter', 'request');

  const filter = parseFilter(value.filter);
  let pageSize = 20;
  if (Object.hasOwn(value, 'pageSize')) {
    if (typeof value.pageSize !== 'number'
      || !Number.isInteger(value.pageSize)
      || value.pageSize < 1
      || value.pageSize > 100) {
      return invalid('request.pageSize must be an integer from 1 through 100');
    }
    pageSize = value.pageSize;
  }

  const result: ServiceSearchQuery = { filter, pageSize };
  if (Object.hasOwn(value, 'pageToken')) {
    result.pageToken = parseBoundedString(value.pageToken, 'request.pageToken', {
      minLength: 1,
      maxLength: MAX_PAGE_TOKEN_LENGTH,
    });
  }
  return result;
}

function parseHttpUrl(value: unknown, path: string): string {
  const raw = parseBoundedString(value, path, {
    minLength: 1,
    maxLength: 2048,
    unpadded: true,
  });

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid(`${path} must be a valid HTTP(S) URL`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== '') {
    return invalid(`${path} must be an HTTP(S) URL without credentials`);
  }
  return raw;
}

function parseService(raw: unknown, index: number): ServiceDeclaration {
  const path = `request.services[${index}]`;
  const value = parsePlainObject(raw, path);
  requireAllowedKeys(value, SERVICE_KEYS, path);
  for (const key of SERVICE_KEYS) {
    if (key !== 'description') {
      requireOwnKey(value, key, path);
    }
  }

  const identifier = parseBoundedString(value.identifier, `${path}.identifier`, {
    minLength: 1,
    maxLength: MAX_IDENTIFIER_LENGTH,
    unpadded: true,
  });
  const displayName = parseBoundedString(value.display_name, `${path}.display_name`, {
    minLength: 1,
    maxLength: 255,
  });
  const type = parseBoundedString(value.type, `${path}.type`, {
    minLength: 1,
    maxLength: MAX_IDENTIFIER_LENGTH,
    unpadded: true,
  });
  const url = parseHttpUrl(value.url, `${path}.url`);
  const description = Object.hasOwn(value, 'description')
    ? parseBoundedString(value.description, `${path}.description`, { maxLength: 1000 })
    : null;

  return {
    identifier,
    displayName,
    type,
    url,
    description,
    capabilityIds: parseStringArray(value.capability_ids, `${path}.capability_ids`, 0),
    areaServed: parseStringArray(value.area_served, `${path}.area_served`, 0),
    interfaces: parseStringArray(value.interfaces, `${path}.interfaces`, 0),
  };
}

export function parseServiceReplacement(raw: unknown): ServiceDeclaration[] {
  const value = parsePlainObject(raw, 'request');
  requireAllowedKeys(value, REPLACEMENT_KEYS, 'request');
  requireOwnKey(value, 'services', 'request');
  if (!Array.isArray(value.services)) {
    return invalid('request.services must be an array');
  }
  if (value.services.length > 100) {
    return invalid('request.services must contain at most 100 declarations');
  }

  const services = value.services.map((service, index) => parseService(service, index));
  const identifiers = new Set<string>();
  for (const service of services) {
    if (identifiers.has(service.identifier)) {
      return invalid(`request.services contains duplicate identifier ${service.identifier}`);
    }
    identifiers.add(service.identifier);
  }
  return services;
}

/** Reuses the organization declaration bounds for a connector-supplied typed declaration. */
export function validateServiceDeclaration(raw: unknown): ServiceDeclaration {
  const value = parsePlainObject(raw, 'declaration');
  requireAllowedKeys(value, ['identifier', 'displayName', 'type', 'url', 'description',
    'capabilityIds', 'areaServed', 'interfaces'], 'declaration');
  return parseServiceReplacement({ services: [{
    identifier: value.identifier, display_name: value.displayName, type: value.type,
    url: value.url, description: value.description, capability_ids: value.capabilityIds,
    area_served: value.areaServed, interfaces: value.interfaces,
  }] })[0]!;
}

function parseCursorAfter(raw: unknown): { identifier: string; sourceId: string } {
  const value = parsePlainObject(raw, 'cursor.after');
  requireAllowedKeys(value, CURSOR_AFTER_KEYS, 'cursor.after');
  for (const key of CURSOR_AFTER_KEYS) {
    requireOwnKey(value, key, 'cursor.after');
  }
  return {
    identifier: parseBoundedString(value.identifier, 'cursor.after.identifier', {
      minLength: 1,
      maxLength: MAX_IDENTIFIER_LENGTH,
      unpadded: true,
    }),
    sourceId: parseBoundedString(value.sourceId, 'cursor.after.sourceId', {
      minLength: 1,
      maxLength: MAX_IDENTIFIER_LENGTH,
      unpadded: true,
    }),
  };
}

function filterHash(filter: ServiceFilter): string {
  return createHash('sha256').update(JSON.stringify(filter), 'utf8').digest('hex');
}

function serializeCursor(
  hash: string,
  after: { identifier: string; sourceId: string },
): string {
  const json = JSON.stringify({ v: 1, filterHash: hash, after });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function encodeServiceCursor(
  filter: ServiceFilter,
  after: { identifier: string; sourceId: string },
): string {
  const normalizedFilter = parseFilter(filter);
  const normalizedAfter = parseCursorAfter(after);
  const token = serializeCursor(filterHash(normalizedFilter), normalizedAfter);
  if (token.length > MAX_PAGE_TOKEN_LENGTH) {
    return invalid(`encoded pageToken must not exceed ${MAX_PAGE_TOKEN_LENGTH} characters`);
  }
  return token;
}

export function decodeServiceCursor(
  filter: ServiceFilter,
  token: string,
): { identifier: string; sourceId: string } {
  const normalizedFilter = parseFilter(filter);
  const normalizedToken = parseBoundedString(token, 'pageToken', {
    minLength: 1,
    maxLength: MAX_PAGE_TOKEN_LENGTH,
  });
  if (!/^[A-Za-z0-9_-]+$/.test(normalizedToken)) {
    return invalid('pageToken must use unpadded base64url encoding');
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalizedToken, 'base64url');
  } catch {
    return invalid('pageToken must use valid base64url encoding');
  }
  if (bytes.toString('base64url') !== normalizedToken) {
    return invalid('pageToken must use canonical base64url encoding');
  }

  let rawCursor: unknown;
  try {
    rawCursor = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalid('pageToken must contain valid JSON');
  }
  const cursor = parsePlainObject(rawCursor, 'cursor');
  requireAllowedKeys(cursor, CURSOR_KEYS, 'cursor');
  for (const key of CURSOR_KEYS) {
    requireOwnKey(cursor, key, 'cursor');
  }
  if (cursor.v !== 1) {
    return invalid('cursor.v must be 1');
  }
  if (typeof cursor.filterHash !== 'string' || !/^[0-9a-f]{64}$/.test(cursor.filterHash)) {
    return invalid('cursor.filterHash must be a lowercase SHA-256 digest');
  }
  const after = parseCursorAfter(cursor.after);
  const expectedHash = filterHash(normalizedFilter);
  if (cursor.filterHash !== expectedHash) {
    return invalid('pageToken does not match the request filter');
  }
  if (serializeCursor(cursor.filterHash, after) !== normalizedToken) {
    return invalid('pageToken must use canonical cursor JSON');
  }
  return after;
}
