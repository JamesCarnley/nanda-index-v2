export type OriginDigest = `0x${string}`;

export type OriginArchiveService = {
  method: 'https-origin';
  identityUrl: string;
};

export type OriginArchiveSnapshotPayload = {
  profile: 'city-origin@0.1';
  kind: 'archive-snapshot';
  service: OriginArchiveService;
  reviewer: `0x${string}`;
  snapshotId: string;
  createdAt: string;
  historyScope: 'reviewer-declared-from-inception';
  entries: OriginDigest[];
};

export type OriginArchiveSnapshotShape =
  | { status: 'valid'; claimed: OriginArchiveSnapshotPayload }
  | { status: 'invalid'; reason: string };

export type OriginArchiveJobKind = 'snapshot' | 'document';

export type OriginArchiveJob = {
  sourceId: string;
  kind: OriginArchiveJobKind;
  digest: OriginDigest;
  jobVersion: string;
  attempts: string;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  lastAttemptAt: string | null;
  state: 'pending' | 'retained';
  reason: string | null;
  actualHash: OriginDigest | null;
  actualSize: string | null;
};

export type OriginArchiveJobOutcome =
  | { kind: 'retained'; bytes: Uint8Array }
  | { kind: 'retry'; reason: string; nextAttemptAt: string; actualHash?: OriginDigest; actualSize?: string };

export type OriginArchiveRelationship = 'equal' | 'prefix-extension' | 'non-prefix';
