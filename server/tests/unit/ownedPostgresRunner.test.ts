import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { runOwnedCommand, testEnvironment, validateDataIsolation, validateOwnership, validateSocket } from '../../scripts/test-owned-postgres.js';

it('excludes ambient secrets and both follower configurations from test children', () => {
  const env = testEnvironment('postgres://synthetic', { PATH: '/synthetic', OPENAI_API_KEY: 'secret',
    ERC8004_IDENTITY_CONFIG: 'unsafe', ERC8004_FEEDBACK_CONFIG: 'unsafe', DATABASE_URL: 'unsafe' });
  expect(env).toEqual({ PATH: '/synthetic', DATABASE_URL: 'postgres://synthetic', NODE_ENV: 'test',
    SMTP_URL: 'log', FEDERATION_MODE: 'none', DB_MAX_CONNECTIONS: '2', NANDA_TEST_ENV_ONLY: '1' });
});
it.each(['abort', 'timeout'] as const)('terminates owned stubborn children and grandchildren on %s', async (kind) => {
  const controller = new AbortController();
  const grandchild = 'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),2000)';
  const script = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});` +
    `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});` +
    `console.log(process.pid+','+child.pid);setTimeout(()=>process.exit(0),2000)`;
  let output = '';
  const start = Date.now();
  const operation = runOwnedCommand(process.execPath, ['-e', script], { env: { PATH: process.env['PATH'] },
    timeoutMs: kind === 'timeout' ? 150 : 5000, signal: controller.signal,
    onOutput: (text) => { output += text; if (kind === 'abort') controller.abort(); } });
  await expect(operation).rejects.toThrow(/aborted|timed out/);
  expect(Date.now() - start).toBeLessThan(1500);
  const pids = output.trim().split(',').map(Number);
  expect(pids).toHaveLength(2);
  for (const pid of pids) {
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
  }
});
it('refuses remote Docker endpoints and ownership mismatches before mutation', () => {
  expect(validateSocket('unix:///tmp/synthetic.sock')).toBe('unix:///tmp/synthetic.sock');
  for (const endpoint of ['tcp://127.0.0.1:2375', 'ssh://example.com', 'unix://host/tmp/x', 'unix:///x?q=1']) {
    expect(() => validateSocket(endpoint)).toThrow();
  }
  const expected = { id: 'a'.repeat(64), nonce: 'test_nonce', database: 'feedback_test_nonce' };
  expect(() => validateOwnership(expected, expected)).not.toThrow();
  for (const key of ['id', 'nonce', 'database'] as const) {
    expect(() => validateOwnership(expected, { ...expected, [key]: 'wrong' })).toThrow();
  }
});
it('opt-in prevents all environment-file reads while default setup still tries loading', () => {
  const probe = `let calls=0; process.loadEnvFile=()=>{calls++}; await import('./tests/setup.ts'); console.log(calls)`;
  for (const [optIn, expected] of [['1', '0'], ['0', '1']]) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      env: { PATH: process.env['PATH'], NANDA_TEST_ENV_ONLY: optIn }, encoding: 'utf8',
    });
    expect(output.trim()).toBe(expected);
  }
});
it('accepts inspected tmpfs data and rejects persistent volumes or missing isolation', () => {
  expect(() => validateDataIsolation({ '/var/lib/postgresql/data': '' }, [])).not.toThrow();
  expect(() => validateDataIsolation({}, [])).toThrow();
  expect(() => validateDataIsolation({ '/var/lib/postgresql/data': '' },
    [{ Type: 'volume', Destination: '/var/lib/postgresql/data' }])).toThrow();
});
