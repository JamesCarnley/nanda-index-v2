import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

import { createPublicClient, http } from 'viem';

const execFileAsync = promisify(execFile);
const EXPECTED_ANVIL_VERSION = '1.7.1';
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 2_000;

export type OwnedAnvilResult<T> = {
  value: T;
  rpcUrl: string;
  processId: number;
};

export type AnvilGenesisMarker = {
  blockNumber: bigint;
  timestamp: bigint;
};

export type OwnedAnvilOptions = {
  anvilBinary?: string;
  genesisMarker?: AnvilGenesisMarker;
  port?: number;
};

class OwnedAnvilMarkerMismatchError extends Error {}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not allocate a loopback port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function randomGenesisMarker(): AnvilGenesisMarker {
  return {
    blockNumber: 1_000_000n + BigInt(randomBytes(4).readUInt32BE()),
    timestamp:
      BigInt(Math.floor(Date.now() / 1_000)) + BigInt(randomBytes(3).readUIntBE(0, 3)),
  };
}

function assertGenesisMarker(marker: AnvilGenesisMarker): void {
  if (marker.blockNumber < 0n) {
    throw new Error('owned Anvil genesis block number must be nonnegative');
  }
  if (
    marker.timestamp < 0n ||
    marker.timestamp > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('owned Anvil genesis timestamp must be a nonnegative safe integer');
  }
}

export function assertLocalWriteRpcUrl(rpcUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error('write RPC URL must be a valid loopback HTTP URL');
  }

  const isLoopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (
    parsed.protocol !== 'http:' ||
    !isLoopback ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('identity demo write operations require a loopback HTTP RPC');
  }
}

async function assertAnvilVersion(binary: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ['--version'], {
      timeout: 5_000,
      encoding: 'utf8',
    }));
  } catch (error) {
    throw new Error(
      `Anvil ${EXPECTED_ANVIL_VERSION} is required for the local identity demo; install Foundry, run foundryup --install v${EXPECTED_ANVIL_VERSION}, and ensure anvil is on PATH`,
      { cause: error },
    );
  }

  const match = /^anvil Version: ([^\s]+)/m.exec(stdout);
  if (match?.[1] !== EXPECTED_ANVIL_VERSION) {
    throw new Error(
      `Anvil ${EXPECTED_ANVIL_VERSION} is required for the local identity demo; received ${match?.[1] ?? 'an unknown version'}`,
    );
  }
}

async function waitForReady(
  child: ChildProcess,
  rpcUrl: string,
  marker: AnvilGenesisMarker,
  getSpawnError: () => Error | undefined,
): Promise<void> {
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: 750 }),
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const chainId = await client.getChainId();
      if (chainId !== 31_337) {
        throw new OwnedAnvilMarkerMismatchError(
          `owned Anvil genesis marker mismatch: expected chain ID 31337, received ${chainId}`,
        );
      }
      const head = await client.getBlockNumber();
      if (head !== marker.blockNumber) {
        throw new OwnedAnvilMarkerMismatchError(
          `owned Anvil genesis marker mismatch: expected block ${marker.blockNumber}, received ${head}`,
        );
      }
      const genesis = await client.getBlock({ blockNumber: marker.blockNumber });
      if (genesis.number !== marker.blockNumber || genesis.timestamp !== marker.timestamp) {
        throw new OwnedAnvilMarkerMismatchError(
          'owned Anvil genesis marker mismatch: timestamp or block number differs',
        );
      }
      const spawnError = getSpawnError();
      if (spawnError !== undefined) {
        throw new Error('owned Anvil process failed during startup', { cause: spawnError });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('owned Anvil process exited before its RPC became ready');
      }
      return;
    } catch (error) {
      if (error instanceof OwnedAnvilMarkerMismatchError) throw error;
      lastError = error;
      const spawnError = getSpawnError();
      if (spawnError !== undefined) {
        throw new Error('owned Anvil process failed during startup', { cause: spawnError });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('owned Anvil process exited before its RPC became ready', {
          cause: error,
        });
      }
      await delay(100);
    }
  }

  throw new Error('owned Anvil RPC did not become ready within 10 seconds', {
    cause: lastError,
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return await new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopOwnedProcess(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill('SIGTERM');
  if (await waitForExit(child, timeoutMs)) return;

  child.kill('SIGKILL');
  if (await waitForExit(child, timeoutMs)) return;

  throw new Error('owned Anvil process did not confirm exit after SIGKILL');
}

export function createOwnedProcessStopper(
  child: ChildProcess,
  timeoutMs = STOP_TIMEOUT_MS,
): () => Promise<void> {
  let stopPromise: Promise<void> | undefined;
  return () => {
    stopPromise ??= stopOwnedProcess(child, timeoutMs);
    return stopPromise;
  };
}

export async function withOwnedAnvil<T>(
  run: (rpcUrl: string) => Promise<T>,
  options: OwnedAnvilOptions = {},
): Promise<OwnedAnvilResult<T>> {
  const binary = options.anvilBinary ?? 'anvil';
  await assertAnvilVersion(binary);

  const marker = options.genesisMarker ?? randomGenesisMarker();
  assertGenesisMarker(marker);
  const port = options.port ?? (await availableLoopbackPort());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('owned Anvil port must be an integer from 1 through 65535');
  }
  const rpcUrl = `http://127.0.0.1:${port}`;
  assertLocalWriteRpcUrl(rpcUrl);

  const child = spawn(
    binary,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      '31337',
      '--number',
      marker.blockNumber.toString(),
      '--timestamp',
      marker.timestamp.toString(),
      '--accounts',
      '0',
      '--hardfork',
      'shanghai',
      '--quiet',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  const processId = child.pid;
  if (processId === undefined) {
    child.kill('SIGKILL');
    throw new Error('could not start the owned Anvil process');
  }

  const stop = createOwnedProcessStopper(child);

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      removeSignalHandlers();
      void stop().finally(() => process.kill(process.pid, signal));
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    await waitForReady(child, rpcUrl, marker, () => spawnError);
    const value = await run(rpcUrl);
    return { value, rpcUrl, processId };
  } finally {
    removeSignalHandlers();
    await stop();
  }
}
