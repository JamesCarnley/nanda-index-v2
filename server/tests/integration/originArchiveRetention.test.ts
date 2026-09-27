import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { closeSql } from '../../src/db/client.js';
import { originArchiveSourceId } from '../../src/connectors/originArchive/config.js';
import { cleanupOriginArchive, digestBytes, originConfig, originPayload, originSnapshotBytes } from '../fixtures/originArchive.js';

async function freePort(): Promise<number> {
  const server = createNetServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}

async function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
    const done = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', done);
  });
}

type StartIndexOptions = { args?: string[]; readinessAttempts?: number; onSpawn?: (child: ChildProcess) => void };

async function startIndex(config: ReturnType<typeof originConfig>, options: StartIndexOptions = {}):
Promise<{ port: number; child: ChildProcess; stop: () => Promise<void> }> {
  const port = await freePort();
  const child = spawn(process.execPath, options.args ?? ['--import', 'tsx',
    fileURLToPath(new URL('../fixtures/runIndex.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), API_BASE_URL: `http://127.0.0.1:${port}`,
      ERC8004_IDENTITY_CONFIG: '', ERC8004_FEEDBACK_CONFIG: '', ORIGIN_ARCHIVE_CONFIG: JSON.stringify(config) },
  });
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (!await waitForExit(child, 3000)) {
        child.kill('SIGKILL');
        if (!await waitForExit(child, 2000)) throw new Error('owned Index did not exit');
      }
    })();
    return stopPromise;
  };
  try {
    options.onSpawn?.(child);
    let live = false;
    for (let attempt = 0; attempt < (options.readinessAttempts ?? 60); attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
        if (response.ok) { live = true; break; }
      } catch { /* process is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!live) throw new Error('owned Index did not become ready');
    return { port, child, stop };
  } catch (error) {
    await stop(); throw error;
  }
}

afterAll(closeSql);

it('stops and awaits an owned child that stays alive without becoming ready', async () => {
  const config = originConfig(); let child: ChildProcess | undefined;
  try {
    await expect(startIndex(config, { args: ['-e', 'setInterval(() => {}, 1000)'], readinessAttempts: 2,
      onSpawn: (spawned) => { child = spawned; } })).rejects.toThrow(/did not become ready/);
    expect(child).toBeDefined();
    expect(await waitForExit(child!, 200)).toBe(true);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await waitForExit(child, 2000);
    }
  }
});

it('retains over HTTP and serves exact bytes from a new Index process after the source and first Index stop', async () => {
  const first = Buffer.from([0, 11, 255]); const second = Buffer.from('retained negative review');
  const snapshot = originSnapshotBytes({ payload: originPayload({ entries: [digestBytes(first), digestBytes(second)] }) });
  const source = createHttpServer((req, res) => {
    const digest = req.url!.split('/').at(-1);
    if (req.url === `/public-origin/snapshots/${digestBytes(snapshot)}`) return void res.end(snapshot);
    if (digest === digestBytes(first)) return void res.end(first);
    if (digest === digestBytes(second)) return void res.end(second);
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as { port: number }).port;
  const config = originConfig({ sourceBaseUrl: `http://127.0.0.1:${sourcePort}/public-origin/`,
    snapshotDigests: [digestBytes(snapshot)], pollMs: 100 });
  let firstIndex: Awaited<ReturnType<typeof startIndex>> | undefined;
  let secondIndex: Awaited<ReturnType<typeof startIndex>> | undefined;
  try {
    firstIndex = await startIndex(config);
    let complete = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const response = await fetch(`http://127.0.0.1:${firstIndex.port}/api/ard/origin-archive/snapshots/${digestBytes(snapshot)}/status`);
      if (response.ok) {
        const status = await response.json() as { entries: { availability: string }[] };
        if (status.entries.length === 2 && status.entries.every((entry) => entry.availability === 'retained')) { complete = true; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(complete).toBe(true);
    await new Promise<void>((resolve) => { source.closeAllConnections(); source.close(() => resolve()); });
    await firstIndex.stop(); firstIndex = undefined;

    secondIndex = await startIndex(config);
    const base = `http://127.0.0.1:${secondIndex.port}/api/ard/origin-archive`;
    const status = await fetch(`${base}/snapshots/${digestBytes(snapshot)}/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ acquisition: { state: 'retained' },
      entries: [{ availability: 'retained' }, { availability: 'retained' }], authenticity: 'not-evaluated' });
    const snapshotRead = await fetch(`${base}/snapshots/${digestBytes(snapshot)}`);
    expect(Buffer.from(await snapshotRead.arrayBuffer())).toEqual(snapshot);
    for (const bytes of [first, second]) {
      const response = await fetch(`${base}/documents/${digestBytes(bytes)}`);
      expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
  } finally {
    await firstIndex?.stop(); await secondIndex?.stop();
    if (source.listening) await new Promise<void>((resolve) => { source.closeAllConnections(); source.close(() => resolve()); });
    await cleanupOriginArchive([originArchiveSourceId(config)]);
  }
}, 30_000);
