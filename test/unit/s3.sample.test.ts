import { describe, expect, it } from 'vitest';
import { MAX_SAMPLE_OBJECT_BYTES, planObjectSample } from '../../src/services/s3/sample.js';

const KB = 1024;

describe('planObjectSample', () => {
  const listing = [
    { key: 'photos/chai-1.jpg', size: 300 * KB },
    { key: 'orders/2026-10.json', size: 4 * KB },
    { key: 'photos/logo.PNG', size: 20 * KB },
    { key: 'exports/customers.csv', size: MAX_SAMPLE_OBJECT_BYTES + 1 },
    { key: 'archive.tar.gz', size: 50 * KB },
    { key: 'README', size: 1 * KB },
    { key: 'photos/', size: 0 },
    { key: 'notes/menu.txt', size: 2 * KB },
  ];

  it('copies only maskable text objects under the size cap', () => {
    const plan = planObjectSample('chaicart-photos', listing, 10);
    expect(plan.copy.map((o) => o.key)).toEqual(['orders/2026-10.json', 'notes/menu.txt']);
  });

  it('skips binary objects with a reason instead of dropping them silently', () => {
    const plan = planObjectSample('chaicart-photos', listing, 10);
    const byName = Object.fromEntries(plan.skipped.map((s) => [s.name, s]));

    expect(byName['chaicart-photos/photos/chai-1.jpg']).toEqual({
      service: 's3',
      type: 'object',
      name: 'chaicart-photos/photos/chai-1.jpg',
      status: 'skipped',
      reasons: [".jpg files are treated as binary and can't be PII-masked"],
    });
    expect(byName['chaicart-photos/photos/logo.PNG']?.reasons[0]).toMatch(
      /\.png files are treated as binary/,
    );
    expect(byName['chaicart-photos/archive.tar.gz']?.reasons[0]).toMatch(/\.gz files are treated as binary/);
    expect(byName['chaicart-photos/README']?.reasons[0]).toMatch(/without an extension/);
  });

  it('skips oversized text objects with a size reason', () => {
    const plan = planObjectSample('chaicart-photos', listing, 10);
    const big = plan.skipped.find((s) => s.name === 'chaicart-photos/exports/customers.csv');
    expect(big?.reasons).toEqual(['5.0 MB is over the 5.0 MB sample limit']);
  });

  it('accounts for every visited object: each is either copied or skipped with a reason', () => {
    const plan = planObjectSample('chaicart-photos', listing, 10);
    expect(plan.copy.length + plan.skipped.length).toBe(listing.length);
    for (const s of plan.skipped) expect(s.reasons.length).toBeGreaterThan(0);
  });

  it('stops once the sample limit is reached', () => {
    const plan = planObjectSample('chaicart-photos', listing, 1);
    expect(plan.copy.map((o) => o.key)).toEqual(['orders/2026-10.json']);
    // Only the binary seen before the limit was reached is reported.
    expect(plan.skipped.map((s) => s.name)).toEqual(['chaicart-photos/photos/chai-1.jpg']);
  });
});
