# Feedback persistence boundary

This is a database/query layer, not a running chain follower, HTTP API, reputation
score, or signature verifier. It retains attributed raw ERC-8004 feedback events
and digest-matching opaque document bytes. Every event/history read says
`semantics: "not-evaluated"`. No read fetches a URL or initializes a source.

The event declarations are pinned in `src/connectors/erc8004/feedbackAbi.ts`.
`ResponseAppended` indexes the responder, not the feedback index. Solidity
strings contain arbitrary bytes: invalid UTF-8 or NUL-containing text gets a
null text projection and an `invalidTextFields` entry; valid BOMs are preserved.
The raw topics/data remain intact, including unsupported text. An unsupported
document URI blocks acquisition, not event ingestion or subsequent revocations.

## Storage and authority

| Table | Purpose |
| --- | --- |
| `feedback_sources` | Full chain/genesis/Identity/Reputation domain, configuration fingerprint, cursor, generation, availability and recovery horizon |
| `feedback_events` | Immutable raw logs and decoded projections, numeric canonical ordering and insertion fence |
| `feedback_membership` | Canonical, withdrawn or explicitly orphaned event associations per replay generation |
| `feedback_documents` | Nonzero digest, exact bytes (0–6144), length and retention time |
| `feedback_fetch_jobs` | Durable per-publication acquisition state, leases, retries and observations |

None depends on current identity eligibility, organizations, service projections
or provider liveness. Withdrawal does not delete evidence or jobs. It increases
the generation and rewinds to the configured start. Replaying the unchanged
prefix readopts the original event; rebuilding remains visible until the maximum
old recovery horizon is reached, including across repeated withdrawals.

`withdrawFeedbackSource` optionally accepts `{previous, replacement}` BlockRefs.
Only a same-height, different-hash conflict marks events from the old hash
orphaned. Other withdrawn associations remain withdrawn, not proven orphaned.

Batches implicitly cover `(expectedCheckpoint, through]`, or `[startBlock,
through]` initially. Fingerprint/version/checkpoint CAS and a source row lock
serialize writers; events, membership, jobs and coverage commit atomically. The
store enforces supplied range/header/log integrity and confirmation bounds. It
does **not** independently prove that an RPC returned every log.

Agent IDs and block numbers use uint256-safe decimal strings; feedback, log and
transaction indices use uint64-safe strings. SQL uses exact numeric columns,
not signed-bigint truncation. Logs are bounded to 64 KiB each, 1000 logs and 2 MiB
per batch, counting decoded wire bytes plus fixed provenance fields. Entire
overflowing batches are rejected. JSON/HTTP transport overhead needs its own
bound in a future follower/API.

## Acquisition

Claims select at most four pending jobs in due-time/event-ID order with row locks
and `SKIP LOCKED`. Claims commit before any future network work. A lease is at
most 30 seconds; the returned `jobVersion` is the finish CAS token.
`leaseExpiresAt` is explicit. Expired/superseded finishes cannot write a blob.
Retry times must be later than `now` and at most 300 seconds away. Reasons are
lowercase alphanumeric/hyphen codes of at most 64 characters. URI/policy failures
must not be logged as raw URLs or errors containing credentials.

The intrinsic acquisition profile supports literal loopback HTTP URLs only, up
to 2048 UTF-8 bytes, without credentials, fragments, controls or backslashes.
The future worker must additionally enforce its administrator's **exact** URL
allowlist, deadlines, streaming size and redirect rules. A valid but unlisted URL
stays pending with positive backoff (`url-not-allowed`), not terminally blocked.
Responses are retained as raw events; their document content is not fetched.

Blob insertion and job completion are one transaction. Keccak is recomputed on
insert and document read; bytes are never decoded/reencoded as JSON. A different
event may already have acquired the same digest: history and source counts use
blob existence, not just one job's state. Synchronized event coverage is not full
document retention. Acquisition never restores canonical membership.

## Read scope and pagination

Source reads include canonical-prefix retained/pending/blocked association
counts. Unknown-source history has null coverage/basis; a known source with an
empty subject still returns coverage. Event IDs stay addressable after withdrawal.

History has `view`, `basis`, current `coverage`, `records` and `nextCursor`.
Page sizes are 1–100. `basis` freezes generation, the full through BlockRef and
the insertion-sequence fence. Canonical-prefix reads freeze their through height;
all-retained reads include withdrawn history even when the cursor is reset.
Ordinary heartbeats/appends do not invalidate a cursor; withdrawal does.

The cursor is a bounded, client-tamperable continuation scope, **not an
authenticated block observation or authority proof**. Filters/view/order/page
size and current range/fence bounds are validated. Contradictory hashes at the
currently known checkpoint are rejected. Older supplied basis hashes are not
upgraded into authenticated observations. Consumers must independently verify
event/chain authority where needed.

`canonicalityBasis: "current-coverage"` makes membership explicitly live.
Event selection/order is frozen, not historical membership: an all-retained page
may show an event readopted by replay after the previous page. Coverage,
membership and event rows are read in one repeatable-read, read-only SQL snapshot.
Document availability may change between pages. There is no cached active or
unrevoked review verdict.

## Safe local verification

From `server`, with Node 24, Docker on a local Unix socket and the repository's
pinned Anvil version available on PATH:

```sh
node scripts/test-owned-postgres.ts
```

This runs build, typecheck, compiled migrations twice and the complete test
suite. To select focused tests, pass explicit `tests/unit/*.test.ts` or
`tests/integration/*.test.ts` filenames (not globs/flags). Package scripts and
default developer `.env` behavior remain unchanged. The runner opts into
`NANDA_TEST_ENV_ONLY=1`, passes only the explicit nonsecret test environment,
and never invokes the `.env`-loading `npm run migrate` command.

Each invocation creates a fresh labeled PostgreSQL 16 container, random database
and password, and a literal loopback port. ID/labels/database and tmpfs data
isolation are checked before tests. Receipts contain only nonsecret identifiers;
the URL/password is never printed. Cancellation/timeouts stop the runner's own
process groups (including descendants), with bounded TERM/KILL escalation.
Finally, only the verified owned container/ephemeral storage is removed. Existing
containers and databases are never test targets. No dependency is downloaded by
the runner; Docker may need the standard PostgreSQL 16 image available locally.
