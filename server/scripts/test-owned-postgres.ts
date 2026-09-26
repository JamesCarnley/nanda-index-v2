import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export async function runOwnedCommand(binary: string, args: string[], options: {
  env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; onOutput?: (text: string) => void;
}): Promise<string> {
  if (options.signal?.aborted) throw new Error('owned command aborted');
  return new Promise((resolve, reject) => {
    // A new group contains only this command and the descendants it creates.
    const child = spawn(binary, args, { env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let size = 0; let closed = false; let done = false; let failure: string | null = null;
    let escalation: NodeJS.Timeout | undefined; let poll: NodeJS.Timeout | undefined;
    const alive = (): boolean => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = 'owned command group cleanup failed'; }
    };
    const finish = (): void => {
      if (done) return; done = true;
      clearTimeout(timeout); clearTimeout(escalation); clearInterval(poll);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(new Error(failure)); else resolve(output);
    };
    const stop = (reason: string): void => {
      if (failure || done) return; failure = reason;
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'), 100);
      const deadline = Date.now() + 1000;
      poll = setInterval(() => {
        if (closed && !alive()) finish();
        else if (Date.now() >= deadline) {
          failure = 'owned command group did not stop within deadline'; finish();
        }
      }, 10);
    };
    const abort = (): void => stop('owned command aborted');
    const timeout = setTimeout(() => stop('owned command timed out'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk: Buffer, stdout: boolean): void => {
      size += chunk.byteLength;
      if (size > 16 * 1024 * 1024) { stop('owned command output budget exceeded'); return; }
      const text = chunk.toString('utf8'); if (stdout) output += text;
      options.onOutput?.(text);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
    child.once('error', () => { failure = 'owned command could not start'; closed = true; finish(); });
    child.once('close', (code) => {
      closed = true;
      if (failure) { if (!alive()) finish(); return; }
      if (alive()) { stop('owned command left running descendants'); return; }
      if (code !== 0) failure = 'owned command exited unsuccessfully';
      finish();
    });
  });
}
const LABEL = 'org.nanda-index.owned-test';
const DB_LABEL = 'org.nanda-index.owned-test-database';
type Ownership = { id: string; nonce: string; database: string };
export function validateDataIsolation(tmpfs: Record<string, string>, mounts: { Type: string; Destination: string }[]): void {
  if (!tmpfs || Object.keys(tmpfs).length !== 1 || !Object.hasOwn(tmpfs, '/var/lib/postgresql/data') ||
    mounts.some((mount) => mount.Type !== 'tmpfs' || mount.Destination !== '/var/lib/postgresql/data')) {
    throw new Error('owned PostgreSQL must use only ephemeral tmpfs data');
  }
}

export function testEnvironment(url: string, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: ambient['PATH'] ?? '', DATABASE_URL: url, NODE_ENV: 'test', SMTP_URL: 'log',
    FEDERATION_MODE: 'none', DB_MAX_CONNECTIONS: '2', NANDA_TEST_ENV_ONLY: '1' };
}
export function validateSocket(endpoint: string): string {
  if (!/^unix:\/\/\/[^\s?#\u0000]+$/.test(endpoint)) throw new Error('local Docker Unix socket required');
  return endpoint;
}
export function validateOwnership(expected: Ownership, actual: Ownership): void {
  if (!/^[0-9a-f]{64}$/.test(expected.id) || expected.id !== actual.id ||
    expected.nonce !== actual.nonce || expected.database !== actual.database) {
    throw new Error('owned PostgreSQL identity, label or database mismatch');
  }
}

/** Fixed build/migration/test commands only; never inherits database or provider credentials.
 * Usage (from server): node scripts/test-owned-postgres.ts [Vitest test file ...]
 * With no files, runs the entire suite. Every invocation owns a fresh database. */
async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.some((file) => !/^tests\/(unit|integration)\/[A-Za-z0-9_-]+\.test\.ts$/.test(file))) {
    throw new Error('arguments must be explicit unit/integration test filenames');
  }
  const baseEnv = { PATH: process.env['PATH'] ?? '' };
  const nonce = randomBytes(12).toString('hex');
  const database = `feedback_test_${nonce}`;
  const password = randomBytes(24).toString('hex');
  const name = `nanda-index-test-${nonce}`;
  let id = '';
  let acquisitionStarted = false;
  let cancelled = false; let cleaningUp = false;
  const controller = new AbortController();
  const cancel = (): void => { cancelled = true; controller.abort(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const check = (): void => { if (cancelled) throw new Error('owned test run cancelled'); };
  const redact = (value: string): string => value.replaceAll(password, '[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database URL redacted]');
  async function run(binary: string, args: string[], env: NodeJS.ProcessEnv = baseEnv, print = false): Promise<string> {
    let output = '';
    try {
      const result = await runOwnedCommand(binary, args, { env, timeoutMs: 300_000,
        signal: cleaningUp ? undefined : controller.signal, onOutput: (text) => { output += text; } });
      return result.trim();
    } catch {
      throw new Error(`${binary} failed; owned test operation aborted`);
    } finally { if (print) process.stdout.write(redact(output)); }
  }
  // Ignore remote overrides; resolve the saved context read-only, then pin its local socket.
  const context = await run('docker', ['context', 'show']);
  const socket = validateSocket(await run('docker', ['context', 'inspect', context,
    '--format', '{{.Endpoints.docker.Host}}']));
  const docker = (args: string[]): Promise<string> => run('docker', ['--host', socket, ...args]);
  async function assertOwned(): Promise<void> {
    if (!id) throw new Error('owned PostgreSQL ID missing');
    const result = await docker(['inspect', '--format',
      `{{.Id}}|{{index .Config.Labels "${LABEL}"}}|{{index .Config.Labels "${DB_LABEL}"}}`, id]);
    const [actualId = '', actualNonce = '', actualDatabase = ''] = result.split('|');
    validateOwnership({ id, nonce, database }, { id: actualId, nonce: actualNonce, database: actualDatabase });
  }
  try {
    check(); acquisitionStarted = true;
    id = await docker(['run', '-d', '--name', name, '--label', `${LABEL}=${nonce}`,
      '--label', `${DB_LABEL}=${database}`, '-e', `POSTGRES_DB=${database}`,
      '-e', `POSTGRES_PASSWORD=${password}`, '--tmpfs', '/var/lib/postgresql/data',
      '-p', '127.0.0.1::5432', 'postgres:16']);
    await assertOwned(); check();
    console.log('Owned PostgreSQL receipt:', JSON.stringify({ id, nonce, database }));
    const mounts = JSON.parse(await docker(['inspect', '--format', '{{json .Mounts}}', id])) as { Type: string; Destination: string }[];
    const tmpfs = JSON.parse(await docker(['inspect', '--format', '{{json .HostConfig.Tmpfs}}', id])) as Record<string, string>;
    console.log('Owned data isolation:', JSON.stringify({ mounts, tmpfs }));
    validateDataIsolation(tmpfs, mounts);
    const binding = await docker(['port', id, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('loopback port required');
    const deadline = Date.now() + 30_000;
    for (;;) {
      check();
      const logs = await docker(['logs', id]);
      if (logs.includes('PostgreSQL init process complete; ready for start up.')) {
        try {
          const actual = await docker(['exec', id, 'psql', '-U', 'postgres', '-d', database,
            '-Atc', 'SELECT current_database()']);
          if (actual !== database) throw new Error('database mismatch');
          break;
        } catch { /* Wait for final server, not temporary init server. */ }
      }
      if (Date.now() > deadline) throw new Error('owned PostgreSQL readiness deadline');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const env = testEnvironment(`postgres://postgres:${password}@127.0.0.1:${match[1]}/${database}`);
    for (const args of [['run', 'build'], ['run', 'typecheck']]) {
      check(); await assertOwned(); await run('npm', args, env, true);
    }
    for (let pass = 0; pass < 2; pass++) {
      check(); await assertOwned();
      await run(process.execPath, ['dist/db/migrate.js'], env, true);
    }
    check(); await assertOwned();
    await run('npm', ['test', '--', ...files], env, true);
    console.log('Owned test verification passed.');
  } finally {
    cleaningUp = true;
    try {
      if (!id && acquisitionStarted) {
        id = await docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${name}$`, '--filter', `label=${LABEL}=${nonce}`]);
      }
      if (id) { await assertOwned(); await docker(['rm', '-fv', id]); console.log('Owned test container and ephemeral data removed.'); }
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'owned test failed'); process.exitCode = 1; });
}
