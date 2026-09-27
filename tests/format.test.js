import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  formatResultsText,
  simplifyOffer,
  toFullSearchResult,
} from '../dist/commands/search.js';

async function loadFixture() {
  const raw = await readFile(
    new URL('./fixtures/search-result.json', import.meta.url),
  );
  return JSON.parse(raw.toString());
}

test('formatResultsText includes externalUrl when available', async () => {
  const fixture = await loadFixture();
  const output = formatResultsText(fixture, 'chips');
  assert.match(output, /https:\/\/shop\.billa\.at/);
});

test('simplifyOffer exposes externalUrl only when present', async () => {
  const fixture = await loadFixture();
  const offer = fixture.results[0];
  const simplified = simplifyOffer(offer);

  assert.equal(simplified.externalUrl, offer.externalUrl);
});

test('toFullSearchResult returns full structure with query and filters', async () => {
  const fixture = await loadFixture();
  const full = toFullSearchResult(
    fixture,
    fixture.results,
    fixture.totalResults,
    'chips',
  );

  assert.equal(full.query, 'chips');
  assert.equal(full.totalResults, fixture.totalResults);
  assert.equal(full.results.length, fixture.results.length);
  assert.ok(Array.isArray(full.filters.retailers));
  assert.ok(Array.isArray(full.filters.brands));
  assert.ok(Array.isArray(full.filters.categories));
});

test('toFullSearchResult keeps complete offer fields', async () => {
  const fixture = await loadFixture();
  const full = toFullSearchResult(fixture, fixture.results, 1, 'chips');
  const offer = full.results[0];

  assert.equal(offer.id, 123);
  assert.equal(offer.oldPrice, 1.99);
  assert.equal(offer.product.id, 999);
  assert.equal(offer.referencePrice, 5.96);
  assert.equal(offer.unit.shortName, 'kg');
  assert.equal(offer.volume, 0.25);
  assert.equal(offer.quantity, 1);
  assert.deepEqual(offer.advertisers, [{ name: 'BILLA PLUS' }]);
  assert.deepEqual(offer.validityDates, [
    { from: '2026-02-01', to: '2026-02-10' },
  ]);
});

test('toFullSearchResult adds descriptionLines to every offer', async () => {
  const fixture = await loadFixture();
  const full = toFullSearchResult(fixture, fixture.results, 1, 'chips');
  const lines = full.results[0].descriptionLines;

  assert.ok(Array.isArray(lines));
  // Title line matches the text formatter output
  assert.equal(lines[0], 'Test Chips [SnackCo]');
  // Computed price data (was-price, discount, per-unit price), emoji-free
  assert.ok(lines.some((line) => line.includes('€1.49 (was €1.99) -25%')));
  assert.ok(lines.some((line) => line.includes('€5.96/kg')));
  // Description, retailer/validity, and URL lines
  assert.ok(lines.some((line) => line === '250 g'));
  assert.ok(lines.some((line) => line.includes('BILLA PLUS')));
  assert.ok(lines.some((line) => line.includes('https://shop.billa.at')));
});

test('toFullSearchResult reflects filtered results and adjusted total', async () => {
  const fixture = await loadFixture();
  const full = toFullSearchResult(fixture, [], 0, 'chips');

  assert.equal(full.totalResults, 0);
  assert.deepEqual(full.results, []);
});

test('toFullSearchResult serialized output contains no emojis', async () => {
  const fixture = await loadFixture();
  const serialized = JSON.stringify(
    toFullSearchResult(fixture, fixture.results, fixture.totalResults, 'chips'),
  );

  assert.doesNotMatch(
    serialized,
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u,
  );
});
