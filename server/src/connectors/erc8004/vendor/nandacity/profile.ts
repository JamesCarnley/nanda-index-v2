import { isAddress, keccak256 } from 'viem';
import { z } from 'zod';

export const MAX_REGISTRATION_BYTES = 32 * 1024;
export const MAX_CARD_BYTES = 64 * 1024;
export const REGISTRATION_TYPE =
  'https://eips.ethereum.org/EIPS/eip-8004#registration-v1' as const;

const REGISTRATION_DATA_URI_PREFIX = 'data:application/json;base64,';
const MAX_REGISTRATION_BASE64_LENGTH = Math.ceil(MAX_REGISTRATION_BYTES / 3) * 4;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_SAFE_REGISTRATION_ID = BigInt(Number.MAX_SAFE_INTEGER);
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const canonicalRegistrationIdSchema = z.string().superRefine((value, context) => {
  if (value.length > 16) {
    context.addIssue({
      code: 'custom',
      message: 'agentId must contain at most 16 digits',
    });
    return;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    context.addIssue({
      code: 'custom',
      message: 'must be a canonical unsigned decimal string',
    });
    return;
  }

  if (BigInt(value) > MAX_SAFE_REGISTRATION_ID) {
    context.addIssue({ code: 'custom', message: 'must be a safe integer' });
  }
});

const numericWireRegistrationIdSchema = z
  .number()
  .safe()
  .int()
  .nonnegative()
  .transform((value) => String(value))
  .pipe(canonicalRegistrationIdSchema);

const normalizedRegistrationIdSchema = z
  .union([
    numericWireRegistrationIdSchema,
    canonicalRegistrationIdSchema,
  ])
  .pipe(canonicalRegistrationIdSchema);

const nonZeroAddressSchema = z.string().superRefine((value, context) => {
  if (!isAddress(value, { strict: true }) || value.toLowerCase() === ZERO_ADDRESS) {
    context.addIssue({
      code: 'custom',
      message: 'must be a non-zero Ethereum address',
    });
  }
});

const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hexadecimal value');

function isAllowedBoundUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    value.includes('#')
  ) {
    return false;
  }

  if (url.protocol === 'https:') {
    return true;
  }

  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]')
  );
}

const boundUrlSchema = z.string().superRefine((value, context) => {
  if (!isAllowedBoundUrl(value)) {
    context.addIssue({
      code: 'custom',
      message:
        'endpoint must use HTTPS (or explicit localhost/127.0.0.1/[::1] HTTP) without credentials or fragments',
    });
  }
});

function makeRegistrationLocatorSchema(agentIdSchema: z.ZodType<string>) {
  return z
    .object({
      agentId: agentIdSchema,
      agentRegistry: z.string(),
    })
    .passthrough()
    .superRefine((value, context) => {
      const match = /^eip155:(0|[1-9][0-9]*):(0x[0-9a-fA-F]{40})$/.exec(
        value.agentRegistry,
      );
      if (!match) {
        context.addIssue({
          code: 'custom',
          path: ['agentRegistry'],
          message: 'must be eip155:<canonical-chain-id>:<registry-address>',
        });
        return;
      }

      const chainId = Number(match[1]);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) {
        context.addIssue({
          code: 'custom',
          path: ['agentRegistry'],
          message: 'chain ID must be a positive safe integer',
        });
      }

      if (
        !isAddress(match[2]!, { strict: true }) ||
        match[2]!.toLowerCase() === ZERO_ADDRESS
      ) {
        context.addIssue({
          code: 'custom',
          path: ['agentRegistry'],
          message: 'registry must be a non-zero Ethereum address',
        });
      }
    });
}

const serviceSchema = z
  .object({
    name: z.string().min(1),
    endpoint: boundUrlSchema,
    version: z.string().min(1).optional(),
  })
  .passthrough();

const cityAreaSchema = z.union([
  z.strictObject({
    '@type': z.literal('City'),
    '@id': z.literal('https://www.wikidata.org/entity/Q1297'),
    name: z.literal('Chicago'),
  }),
  z.strictObject({
    '@type': z.literal('City'),
    '@id': z.literal('https://www.wikidata.org/entity/Q100'),
    name: z.literal('Boston'),
  }),
]);

const cityExtensionSchema = z.strictObject({
  version: z.literal('0.1'),
  ownerAtPublication: nonZeroAddressSchema,
  revision: z.number().safe().int().positive(),
  cardDigest: bytes32Schema,
  endpoint: boundUrlSchema,
  receiptSigner: nonZeroAddressSchema,
  capability: z.literal('evening-plan'),
  areaServed: z.array(cityAreaSchema).min(1),
});

function makeRegistrationSchema(agentIdSchema: z.ZodType<string>) {
  return z
    .object({
      type: z.literal(REGISTRATION_TYPE),
      name: z.string().min(1),
      description: z.string().min(1),
      image: boundUrlSchema,
      active: z.boolean(),
      x402Support: z.boolean(),
      supportedTrust: z.array(z.never()).max(0).optional(),
      registrations: z.array(makeRegistrationLocatorSchema(agentIdSchema)).min(1),
      services: z.array(serviceSchema).min(1),
      'x-nandacity': cityExtensionSchema,
    })
    .passthrough()
    .superRefine((value, context) => {
      const a2aServices = value.services.filter((service) => service.name === 'A2A');
      if (a2aServices.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['services'],
          message: 'registration must contain exactly one A2A service',
        });
        return;
      }

      if (a2aServices[0]!.version !== '0.3.0') {
        context.addIssue({
          code: 'custom',
          path: ['services'],
          message: 'A2A service version must be 0.3.0',
        });
      }
    });
}

const normalizedRegistrationSchema = makeRegistrationSchema(
  normalizedRegistrationIdSchema,
);
const wireRegistrationSchema = makeRegistrationSchema(numericWireRegistrationIdSchema);

const cardSkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
  })
  .passthrough();

const agentCardSchema = z
  .object({
    protocolVersion: z.literal('0.3.0'),
    name: z.string().min(1),
    description: z.string().min(1),
    url: boundUrlSchema,
    preferredTransport: z.literal('JSONRPC'),
    version: z.string().min(1),
    capabilities: z.record(z.string(), z.boolean()),
    defaultInputModes: z.array(z.string().min(1)).min(1),
    defaultOutputModes: z.array(z.string().min(1)).min(1),
    skills: z.array(cardSkillSchema).min(1),
  })
  .passthrough();

export type Registration = z.infer<typeof normalizedRegistrationSchema>;
export type AgentCard = z.infer<typeof agentCardSchema>;

function decodeJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = fatalTextDecoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseRegistrationInput(input: unknown): Registration {
  return normalizedRegistrationSchema.parse(input);
}

function parseWireRegistration(input: unknown): Registration {
  return wireRegistrationSchema.parse(input);
}

function decodeRegistrationBytes(uri: string): Uint8Array {
  if (!uri.startsWith(REGISTRATION_DATA_URI_PREFIX)) {
    throw new Error('registration must be an application/json base64 data URI');
  }

  const encoded = uri.slice(REGISTRATION_DATA_URI_PREFIX.length);
  if (encoded.length > MAX_REGISTRATION_BASE64_LENGTH) {
    throw new Error('registration exceeds the 32 KiB decoded-byte limit');
  }
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error('registration data URI contains invalid base64');
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new Error('registration data URI contains noncanonical base64');
  }
  if (bytes.byteLength > MAX_REGISTRATION_BYTES) {
    throw new Error('registration exceeds the 32 KiB decoded-byte limit');
  }
  return bytes;
}

export function encodeRegistration(input: unknown): string {
  const registration = parseRegistrationInput(input);
  const serializable = {
    ...registration,
    registrations: registration.registrations.map((entry) => ({
      ...entry,
      agentId: Number(entry.agentId),
    })),
  };
  const bytes = textEncoder.encode(JSON.stringify(serializable));
  if (bytes.byteLength > MAX_REGISTRATION_BYTES) {
    throw new Error('registration exceeds the 32 KiB decoded-byte limit');
  }

  return `${REGISTRATION_DATA_URI_PREFIX}${Buffer.from(bytes).toString('base64')}`;
}

export function decodeRegistration(uri: string): Registration {
  const bytes = decodeRegistrationBytes(uri);
  return parseWireRegistration(decodeJson(bytes, 'registration'));
}

export function decodeCard(bytes: Uint8Array): AgentCard {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('cardBytes must be a Uint8Array');
  }
  if (bytes.byteLength > MAX_CARD_BYTES) {
    throw new Error('card exceeds the 64 KiB byte limit');
  }

  return agentCardSchema.parse(decodeJson(bytes, 'card'));
}

/** Returns the keccak256 digest of the exact supplied bytes. */
export function digestBytes(bytes: Uint8Array): `0x${string}` {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytes must be a Uint8Array');
  }
  return keccak256(bytes);
}

export function registrationBytes(uri: string): Uint8Array {
  return decodeRegistrationBytes(uri);
}
