import { expect, it } from 'vitest';
import { inspectOriginArchiveSnapshot } from '../../src/connectors/originArchive/validation.js';
import { originAddress, originDigest, originPayload, originSnapshotBytes } from '../fixtures/originArchive.js';

it('decodes the exact archive snapshot shape as an unverified claimed projection', () => {
  const payload = originPayload();
  expect(inspectOriginArchiveSnapshot(originSnapshotBytes({ payload }))).toEqual({
    status: 'valid',
    claimed: payload,
  });
});

it('rejects extra or wrong outer fields and noncanonical bounded Base64 without evaluating a signature', () => {
  const cases = [
    originSnapshotBytes({ envelope: { extra: true } }),
    originSnapshotBytes({ envelope: { profile: 'city-origin@0.2' } }),
    originSnapshotBytes({ envelope: { scheme: 'eip712-eoa' } }),
    originSnapshotBytes({ envelope: { signer: { method: 'secp256k1-key', address: originAddress(8), extra: true } } }),
    originSnapshotBytes({ envelope: { signer: { method: 'eip155-eoa', address: originAddress(8) } } }),
    originSnapshotBytes({ envelope: { signer: { method: 'secp256k1-key', address: originAddress(0) } } }),
    originSnapshotBytes({ envelope: { payloadBase64: 'e30' } }),
    originSnapshotBytes({ envelope: { payloadBase64: '====' } }),
    originSnapshotBytes({ envelope: { signature: `0x${'11'.repeat(66)}` } }),
  ];
  for (const bytes of cases) expect(inspectOriginArchiveSnapshot(bytes)).toMatchObject({ status: 'invalid' });
});

it('requires strict UTF-8 JSON and the exact bounded payload scalars', () => {
  const invalidPayloads: unknown[] = [
    { ...originPayload(), extra: true },
    { ...originPayload(), profile: 'city-origin@0.2' },
    { ...originPayload(), kind: 'feedback' },
    { ...originPayload(), service: { method: 'https-origin', identityUrl: 'http://origin.example/identity.json' } },
    { ...originPayload(), service: { method: 'https-origin', identityUrl: 'https://u:p@origin.example/identity.json' } },
    { ...originPayload(), service: { method: 'https-origin', identityUrl: 'https://origin.example/identity.json?q=1' } },
    { ...originPayload(), service: { method: 'https-origin', identityUrl: 'https://origin.example/identity.json#x' } },
    { ...originPayload(), service: { method: 'https-origin', identityUrl: `https://origin.example/${'x'.repeat(2048)}` } },
    { ...originPayload(), reviewer: `0x${'A'.repeat(40)}` },
    { ...originPayload(), snapshotId: '' },
    { ...originPayload(), snapshotId: 'x'.repeat(65) },
    { ...originPayload(), snapshotId: 'has space' },
    { ...originPayload(), createdAt: '2026-09-26T12:34:56.000Z' },
    { ...originPayload(), createdAt: '2026-02-30T12:34:56Z' },
    { ...originPayload(), historyScope: 'complete' },
    { ...originPayload(), entries: [originDigest(11), originDigest(11)] },
    { ...originPayload(), entries: [`0x${'0'.repeat(64)}`] },
    { ...originPayload(), entries: [`0x${'A'.repeat(64)}`] },
    { ...originPayload(), entries: Array.from({ length: 257 }, (_, i) => originDigest(i + 1)) },
  ];
  for (const payload of invalidPayloads) {
    expect(inspectOriginArchiveSnapshot(originSnapshotBytes({ payload }))).toMatchObject({ status: 'invalid' });
  }
  expect(inspectOriginArchiveSnapshot(originSnapshotBytes({ payloadBytes: new Uint8Array([0xff]) })))
    .toMatchObject({ status: 'invalid' });
  const payload = Buffer.from(JSON.stringify(originPayload()), 'utf8');
  expect(inspectOriginArchiveSnapshot(originSnapshotBytes({ payloadBytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload]) })))
    .toMatchObject({ status: 'invalid' });
});
