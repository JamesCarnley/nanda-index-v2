# Origin archive store

The origin archive is an optional, digest-pinned byte store for Nanda City's
explicit chain-free comparison. It retains one caller-declared finite snapshot
and the public feedback/retraction envelopes named by that snapshot. It does not
verify signatures, establish reviewer or service authority, calculate reputation,
choose a latest head, or replace the ERC-8004 followers.

## Configuration

The worker is disabled when `ORIGIN_ARCHIVE_CONFIG` is absent or blank. The only
accepted enabled form is:

```json
{"sourceBaseUrl":"http://127.0.0.1:9400/public-origin/","snapshotDigests":["0x1111111111111111111111111111111111111111111111111111111111111111"],"pollMs":1000}
```

The base URL must be canonical literal-loopback HTTP with an explicit nonzero
port and trailing slash. One or two unique lowercase nonzero Keccak-256 snapshot
digests may be selected. The worker derives, and only derives, these URLs:

```text
<sourceBaseUrl>snapshots/<snapshotDigest>
<sourceBaseUrl>documents/<documentDigest selected by a valid snapshot>
```

No API accepts a URL or creates an acquisition job. Requests use identity
encoding, omit credentials, reject redirects, time out after five seconds through
EOF, and stream at most 32,768 snapshot bytes or 6,144 document bytes. Claims are
committed before HTTP, four jobs are processed at a time, and failed jobs retry
with bounded exponential backoff. Expired leases are recoverable after a worker
restart. A previously retained exact blob is reused without network access.

## Retention and interpretation

Hash-matching bytes are immutable and remain addressable after configuration or
source availability changes. A snapshot whose bytes match but whose bounded
shape is invalid remains retained and seeds no document jobs. Valid shape means
only that the envelope and claimed `city-origin@0.1` snapshot projection decode;
`authenticity` is always `not-evaluated` here.

For a claimed service/reviewer pair, status returns at most 32 valid retained
variants in digest order and marks truncation explicitly. Pairwise entry-list
relationships are neutral `equal`, `prefix-extension`, or `non-prefix` findings.
They are not signer truth, conflict adjudication, completeness, endorsement, or
evidence that an origin served the snapshot at its claimed time. Consumers must
verify signatures, interaction links, current origin authority, selected policy,
and private supporting evidence independently.

The store is PostgreSQL-backed. Process restart retention assumes the same
running database. The owned test runner uses database tmpfs, so stopping its
PostgreSQL container intentionally destroys that test database.

## Read API

All reads are unauthenticated, database-only, and return
`Cache-Control: no-store`:

- `GET /api/ard/origin-archive/snapshots/:digest/status`
- `GET /api/ard/origin-archive/snapshots/:digest`
- `GET /api/ard/origin-archive/documents/:digest`

Binary reads use `application/octet-stream`, `nosniff`, and exact content length.
Malformed digests return 400, missing bytes return 404, and stored hash/length
integrity failures return 500 without bytes. GET never seeds or fetches.

## Publication and privacy boundary

The configured source must contain only public snapshot, feedback, and retraction
envelopes. Do not publish requests, answers, preferences, credentials, supporting
bundles, or private planning material. Documents are intentionally opaque, so the
Index cannot certify that callers followed this boundary. There is no upload API.
