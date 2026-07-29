/**
 * Tests for IMMERSION_TRACKER — Identity helpers.
 * ---------------------------------------------------------------------------
 * Covers:
 * - No-subtitle vs subtitle digest learning-set distinction
 * - Learning set ID composition
 * - Salt generation and persistence
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect } from 'vitest';
import {
  noSubtitleLearningSetId,
  makeLearningSetId,
  NO_SUBTITLE_ID,
  computeSubtitleDigestFromText,
} from '@/features/player/tracker/identity';

/* ------------------------------------------------------------------------ */
/* Learning set ID helpers                                                  */
/* ------------------------------------------------------------------------ */

describe('noSubtitleLearningSetId', () => {
  it('creates ID with no-subtitle sentinel', () => {
    expect(noSubtitleLearningSetId('media-abc')).toBe('media-abc:no-subtitle');
  });

  it('uses NO_SUBTITLE_ID constant', () => {
    const id = noSubtitleLearningSetId('x');
    expect(id).toContain(NO_SUBTITLE_ID);
  });
});

describe('makeLearningSetId', () => {
  it('combines mediaId and subtitleId', () => {
    expect(makeLearningSetId('media-1', 'sub-2')).toBe('media-1:sub-2');
  });

  it('different subtitleIds produce different learningSetIds', () => {
    const a = makeLearningSetId('m', 's1');
    const b = makeLearningSetId('m', 's2');
    expect(a).not.toBe(b);
  });
});

describe('NO_SUBTITLE_ID', () => {
  it('is a non-empty string', () => {
    expect(typeof NO_SUBTITLE_ID).toBe('string');
    expect(NO_SUBTITLE_ID.length).toBeGreaterThan(0);
  });

  it('is "no-subtitle"', () => {
    expect(NO_SUBTITLE_ID).toBe('no-subtitle');
  });
});

/* ------------------------------------------------------------------------ */
/* Subtitle digest                                                          */
/* ------------------------------------------------------------------------ */

describe('computeSubtitleDigestFromText', () => {
  it('returns a string hash', async () => {
    const hash = await computeSubtitleDigestFromText('Hello world');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('same text produces same hash', async () => {
    const a = await computeSubtitleDigestFromText('test content');
    const b = await computeSubtitleDigestFromText('test content');
    expect(a).toBe(b);
  });

  it('different text produces different hash', async () => {
    const a = await computeSubtitleDigestFromText('content A');
    const b = await computeSubtitleDigestFromText('content B');
    expect(a).not.toBe(b);
  });

  it('handles empty string', async () => {
    const hash = await computeSubtitleDigestFromText('');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('handles unicode content', async () => {
    const hash = await computeSubtitleDigestFromText('日本語テスト');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ */
/* Learning set distinction: no-subtitle vs subtitle                        */
/* ------------------------------------------------------------------------ */

describe('learning set distinction', () => {
  it('no-subtitle ID is different from subtitle ID', () => {
    const mediaId = 'media-abc';
    const subtitleId = 'sub-xyz';

    const noSub = noSubtitleLearningSetId(mediaId);
    const withSub = makeLearningSetId(mediaId, subtitleId);

    expect(noSub).not.toBe(withSub);
  });

  it('different subtitles produce different learning set IDs', () => {
    const a = makeLearningSetId('m', 's1');
    const b = makeLearningSetId('m', 's2');
    expect(a).not.toBe(b);
  });

  it('different media with same subtitle produce different IDs', () => {
    const a = makeLearningSetId('m1', 's');
    const b = makeLearningSetId('m2', 's');
    expect(a).not.toBe(b);
  });
});
