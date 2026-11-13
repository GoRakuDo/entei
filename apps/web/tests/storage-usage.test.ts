/**
 * storage-usage tests — the browser storage meter, pure half.
 * ---------------------------------------------------------------------------
 * - the byte format is Yomitan's own (base 1000, one decimal) so a learner
 *   comparing Entei against the extension sees the same figure
 * - an unavailable measurement renders as an em dash, never as a fabricated
 *   `0 bytes`
 * - the copy template's `{used}` / `{total}` placeholders are filled in both
 *   locales' word orders (a Japanese sentence puts `{total}` first)
 */

import { describe, expect, it } from 'bun:test';
import {
  formatStorageBytes,
  formatStorageUsage,
} from '@/features/settings/storage-usage';

describe('formatStorageBytes', () => {
  it('keeps a count below 1000 whole', () => {
    expect(formatStorageBytes(0)).toBe('0 bytes');
    expect(formatStorageBytes(999)).toBe('999 bytes');
  });

  it('steps up the unit at 1000, one decimal', () => {
    expect(formatStorageBytes(1_000)).toBe('1.0KB');
    expect(formatStorageBytes(1_700_000_000)).toBe('1.7GB');
    expect(formatStorageBytes(117_200_000_000)).toBe('117.2GB');
    expect(formatStorageBytes(1_000_000_000_000)).toBe('1.0TB');
  });

  it('never runs past the last unit', () => {
    expect(formatStorageBytes(1_000_000_000_000_000)).toBe('1000.0TB');
  });

  it('treats a non-finite or negative count as zero', () => {
    expect(formatStorageBytes(-5)).toBe('0 bytes');
    expect(formatStorageBytes(Number.NaN)).toBe('0 bytes');
  });
});

describe('formatStorageUsage', () => {
  const template = 'Yomitan is using approximately {used} of {total}.';

  it('fills both placeholders', () => {
    expect(
      formatStorageUsage(template, {
        usage: 1_700_000_000,
        quota: 117_200_000_000,
      }),
    ).toBe('Yomitan is using approximately 1.7GB of 117.2GB.');
  });

  it('follows the template\'s own word order', () => {
    expect(
      formatStorageUsage('Yomitan は {total} のうち約 {used} を使用しています。', {
        usage: 1_000_000,
        quota: 100_000_000,
      }),
    ).toBe('Yomitan は 100.0MB のうち約 1.0MB を使用しています。');
  });

  it('reads as unknown when there is no measurement', () => {
    expect(formatStorageUsage(template, null)).toBe(
      'Yomitan is using approximately — of —.',
    );
  });
});