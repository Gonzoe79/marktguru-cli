// Offline tests for the REST API (`marktguru serve`). Each test spawns the
// built CLI with an isolated HOME (never touching the real ~/.marktguru) and
// tears it down in a finally block — no hook APIs, which are unreliable on
// older Node 22 minors. Per-test servers keep tests independent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;

// Graceful kill first, SIGKILL fallback: SIGTERM alone does not reliably
// terminate the child on Windows (Git Bash), which would wedge the runner.
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!exited) child.kill('SIGKILL');
}

async function startServer(home) {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let baseUrl;
  try {
    baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('serve did not report its port in time')),
        15000,
      );
      const onData = (chunk) => {
        const match = chunk.toString().match(/Listening on (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(match[1]);
        }
      };
      child.stdout.on('data', onData);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`serve exited before startup (code ${code})`));
      });
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return { child, baseUrl };
}

async function withServer(run) {
  const home = await mkdtemp(join(tmpdir(), 'marktguru-serve-'));
  const { child, baseUrl } = await startServer(home);
  try {
    await run(baseUrl, home);
  } finally {
    await stopChild(child);
    await rm(home, { recursive: true, force: true });
  }
}

async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: await res.json(),
    contentType: res.headers.get('content-type'),
    allow: res.headers.get('allow'),
  };
}

test('responds 404 with JSON for unknown paths', async () => {
  await withServer(async (baseUrl) => {
    const res = await api(baseUrl, 'GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.success, false);
    assert.match(res.json.error, /Not found/);
  });
});

test('responds 405 for wrong methods', async () => {
  await withServer(async (baseUrl) => {
    for (const [method, path, allow] of [
      ['GET', '/login', 'POST'],
      ['PUT', '/set-zip', 'POST'],
      ['POST', '/search', 'GET'],
    ]) {
      const res = await api(baseUrl, method, path);
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.allow, allow, `${method} ${path}`);
    }
  });
});

test('POST /set-zip saves the ZIP code and returns JSON', async () => {
  await withServer(async (baseUrl, home) => {
    const res = await api(baseUrl, 'POST', '/set-zip', { zipCode: '8020' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { success: true, zipCode: '8020' });
    assert.match(res.contentType, /application\/json/);

    const config = JSON.parse(
      await readFile(join(home, '.marktguru', 'config.json'), 'utf-8'),
    );
    assert.equal(config.zipCode, '8020');
  });
});

test('POST /set-zip rejects missing or malformed bodies', async () => {
  await withServer(async (baseUrl) => {
    for (const [label, body] of [
      ['no body', undefined],
      ['empty zipCode', { zipCode: '' }],
      ['non-string zipCode', { zipCode: 123 }],
      ['malformed JSON', '{invalid'],
      ['non-object JSON', '["x"]'],
    ]) {
      const res = await api(baseUrl, 'POST', '/set-zip', body);
      assert.equal(res.status, 400, label);
      assert.equal(res.json.success, false);
      assert.match(res.json.error, /zipCode|JSON/);
    }
  });
});

test('GET /search validates required parameters', async () => {
  await withServer(async (baseUrl) => {
    for (const [label, path] of [
      ['missing q', '/search'],
      ['empty q', '/search?q='],
      ['bad limit (zero)', '/search?q=milch&limit=0'],
      ['bad limit (text)', '/search?q=milch&limit=abc'],
      ['bad country', '/search?q=milch&country=fr'],
    ]) {
      const res = await api(baseUrl, 'GET', path);
      assert.equal(res.status, 400, label);
      assert.equal(res.json.success, false);
      assert.match(res.json.error, /q|limit|country/);
    }
  });
});

test('POST /login rejects invalid country before scraping', async () => {
  await withServer(async (baseUrl) => {
    const res = await api(baseUrl, 'POST', '/login', { country: 'fr' });
    assert.equal(res.status, 400);
    assert.equal(res.json.success, false);
    assert.match(res.json.error, /Invalid country/);
  });
});
