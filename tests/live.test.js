// Live end-to-end tests: these hit marktguru.at/.de and api.marktguru.* for
// real, so they catch the scraper breaking when Marktguru ships a new frontend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;

const COUNTRIES = [
  { country: 'at', zip: '1010' },
  { country: 'de', zip: '10115' },
];

for (const { country, zip } of COUNTRIES) {
  test(
    `live: login and search in ${country}`,
    { timeout: 120000 },
    async () => {
      // Isolated HOME so the test never reads or writes a real ~/.marktguru.
      const home = await mkdtemp(join(tmpdir(), 'marktguru-live-'));
      const cli = (...args) =>
        run(process.execPath, [CLI, ...args], {
          env: { ...process.env, HOME: home, USERPROFILE: home },
        });
      try {
        await cli('set-country', country);

        // No key is stored yet, so search has to auto-login by scraping.
        const { stdout } = await cli(
          'search',
          'raw',
          'milch',
          '--zip',
          zip,
          '--limit',
          '5',
          '--json',
        );
        const data = JSON.parse(stdout);

        assert.ok(data.total > 0, `no results for "milch" in ${country}`);
        assert.ok(data.offers.length > 0);
        assert.ok(data.offers.length <= 5);
        for (const offer of data.offers) {
          assert.equal(typeof offer.title, 'string');
          assert.equal(typeof offer.price, 'number');
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}

test(
  'live: serve endpoints (set-zip, login, search)',
  { timeout: 120000 },
  async () => {
    // Isolated HOME so the test never reads or writes a real ~/.marktguru.
    const home = await mkdtemp(join(tmpdir(), 'marktguru-serve-'));
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      const baseUrl = await new Promise((resolve, reject) => {
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
        child.once('error', reject);
        child.once('exit', (code) => {
          reject(new Error(`serve exited before startup (code ${code})`));
        });
      });

      const setZip = await fetch(`${baseUrl}/set-zip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ zipCode: '1010' }),
      });
      assert.equal(setZip.status, 200);
      assert.deepEqual(await setZip.json(), { success: true, zipCode: '1010' });

      const login = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ country: 'at' }),
      });
      assert.equal(login.status, 200);
      const loginData = await login.json();
      assert.equal(loginData.success, true);
      assert.ok(loginData.apiKey.length > 10);

      const search = await fetch(`${baseUrl}/search?q=milch&limit=2`);
      assert.equal(search.status, 200);
      const data = await search.json();

      assert.equal(data.query, 'milch');
      assert.ok(data.totalResults > 0, 'no results for "milch"');
      assert.ok(data.results.length > 0 && data.results.length <= 2);
      assert.ok(Array.isArray(data.filters.retailers));
      for (const offer of data.results) {
        assert.equal(typeof offer.price, 'number');
        assert.ok('oldPrice' in offer);
        assert.ok(Array.isArray(offer.validityDates));
        assert.ok(Array.isArray(offer.descriptionLines));
        assert.ok(offer.descriptionLines.length > 0);
        assert.ok(
          offer.descriptionLines.every(
            (line) => typeof line === 'string' && line.length > 0,
          ),
        );
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const exited = await Promise.race([
          new Promise((resolve) => child.once('exit', () => resolve(true))),
          new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
        ]);
        if (!exited) child.kill('SIGKILL');
      }
      await rm(home, { recursive: true, force: true });
    }
  },
);
