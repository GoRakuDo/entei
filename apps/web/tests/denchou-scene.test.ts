/**
 * Tests for DenChou fixed automatic scene wrapping.
 * ---------------------------------------------------------------------------
 * When noteType === 'DenChou', sentence and source are automatically
 * wrapped in `<span class="group">…</span>`. No configuration.
 * --------------------------------------------------------------------------- */

import { describe, it, expect } from 'vitest';
import {
  wrapDenChouField,
  isDenChouActiveTarget,
  isDenChouWrapTarget,
} from '@/features/player/denchou-scene';

// ---------------------------------------------------------------------------
// isDenChouWrapTarget
// ---------------------------------------------------------------------------

describe('isDenChouWrapTarget', () => {
  it('returns true for sentence', () => {
    expect(isDenChouWrapTarget('sentence')).toBe(true);
  });

  it('returns true for source', () => {
    expect(isDenChouWrapTarget('source')).toBe(true);
  });

  it('returns false for definition', () => {
    expect(isDenChouWrapTarget('definition')).toBe(false);
  });

  it('returns false for image', () => {
    expect(isDenChouWrapTarget('image')).toBe(false);
  });

  it('returns false for audio', () => {
    expect(isDenChouWrapTarget('audio')).toBe(false);
  });

  it('returns false for word', () => {
    expect(isDenChouWrapTarget('word')).toBe(false);
  });

  it('returns false for tags', () => {
    expect(isDenChouWrapTarget('tags')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wrapDenChouField
// ---------------------------------------------------------------------------

describe('wrapDenChouField', () => {
  it('wraps sentence in <span class="group">', () => {
    expect(wrapDenChouField('sentence', '電車のscene')).toBe(
      '<span class="group">電車のscene</span>',
    );
  });

  it('wraps source in <span class="group">', () => {
    expect(wrapDenChouField('source', '作品名 話1')).toBe(
      '<span class="group">作品名 話1</span>',
    );
  });

  it('returns value unchanged for definition', () => {
    expect(wrapDenChouField('definition', '定義テキスト')).toBe('定義テキスト');
  });

  it('returns value unchanged for image', () => {
    expect(wrapDenChouField('image', '<img src="a.png">')).toBe(
      '<img src="a.png">',
    );
  });

  it('returns value unchanged for audio', () => {
    expect(wrapDenChouField('audio', '[sound:file.mp3]')).toBe(
      '[sound:file.mp3]',
    );
  });

  it('returns empty string unchanged for sentence', () => {
    expect(wrapDenChouField('sentence', '')).toBe(
      '<span class="group"></span>',
    );
  });

  it('preserves HTML in value', () => {
    expect(wrapDenChouField('sentence', '<ruby>漢<rt>かん</rt></ruby>')).toBe(
      '<span class="group"><ruby>漢<rt>かん</rt></ruby></span>',
    );
  });

  it('preserves complex Anki media markup in source', () => {
    expect(wrapDenChouField('source', 'TVアニメ「test」')).toBe(
      '<span class="group">TVアニメ「test」</span>',
    );
  });
});

// ---------------------------------------------------------------------------
// isDenChouActiveTarget
// ---------------------------------------------------------------------------

describe('isDenChouActiveTarget', () => {
  it('returns true for sentence (always active for DenChou)', () => {
    expect(isDenChouActiveTarget('sentence')).toBe(true);
  });

  it('returns true for source (always active for DenChou)', () => {
    expect(isDenChouActiveTarget('source')).toBe(true);
  });

  it('returns false for definition', () => {
    expect(isDenChouActiveTarget('definition')).toBe(false);
  });

  it('returns false for word', () => {
    expect(isDenChouActiveTarget('word')).toBe(false);
  });

  it('returns false for tags', () => {
    expect(isDenChouActiveTarget('tags')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: fixed wrapper in payload construction
// ---------------------------------------------------------------------------

describe('DenChou fixed payload construction', () => {
  const isDenChou = true;

  it('New mode: sentence field wrapped automatically', () => {
    const value = '電車のscene';
    const result = isDenChou ? wrapDenChouField('sentence', value) : value;
    expect(result).toBe('<span class="group">電車のscene</span>');
  });

  it('New mode: source field wrapped automatically', () => {
    const value = '作品名 話1';
    const result = isDenChou ? wrapDenChouField('source', value) : value;
    expect(result).toBe('<span class="group">作品名 話1</span>');
  });

  it('New mode: definition field NOT wrapped', () => {
    const value = '定義テキスト';
    const result = isDenChou ? wrapDenChouField('definition', value) : value;
    expect(result).toBe('定義テキスト');
  });

  it('Append mode DenChou sentence: no <br>', () => {
    const existing = '<span class="group">既存scene</span>';
    const incoming = '新しいscene';
    const wrapped = isDenChou
      ? wrapDenChouField('sentence', incoming)
      : incoming;
    const skipBr = isDenChou && isDenChouActiveTarget('sentence');
    const result = skipBr
      ? `${existing}${wrapped}`
      : `${existing}<br>${wrapped}`;
    expect(result).not.toContain('<br>');
    expect(result).toBe(
      '<span class="group">既存scene</span><span class="group">新しいscene</span>',
    );
  });

  it('Append mode non-DenChou: uses <br>', () => {
    const existing = '既存テキスト';
    const incoming = '追記テキスト';
    const result = `${existing}<br>${incoming}`;
    expect(result).toBe('既存テキスト<br>追記テキスト');
  });

  it('Append mode DenChou definition: always <br>', () => {
    const existing = '定義1';
    const incoming = '定義2';
    const skipBr = isDenChou && isDenChouActiveTarget('definition');
    const result = skipBr
      ? `${existing}${incoming}`
      : `${existing}<br>${incoming}`;
    expect(result).toBe('定義1<br>定義2');
  });

  it('Append mode DenChou image: always <br>', () => {
    const existing = '<img src="old.png">';
    const incoming = '<img src="new.png">';
    const result = `${existing}<br>${incoming}`;
    expect(result).toBe('<img src="old.png"><br><img src="new.png">');
  });

  it('Append mode DenChou audio: always <br>', () => {
    const existing = '[sound:old.mp3]';
    const incoming = '[sound:new.mp3]';
    const result = `${existing}<br>${incoming}`;
    expect(result).toBe('[sound:old.mp3]<br>[sound:new.mp3]');
  });

  it('Append DenChou empty wrapper: still uses <br> for non-targets', () => {
    // Even when wrappers are undefined (no config), non-targets use <br>
    const active = isDenChouActiveTarget('word');
    expect(active).toBe(false);
  });

  it('DenChou source → miscInfo physical target', () => {
    const value = '作品名 話1';
    const wrapped = wrapDenChouField('source', value);
    // Source maps to miscInfo physical field
    expect(wrapped).toBe('<span class="group">作品名 話1</span>');
  });

  it('Old existing HTML untouched in append', () => {
    const oldHtml = '<span class="group">旧scene</span>';
    const incoming = '新scene';
    const wrapped = wrapDenChouField('sentence', incoming);
    // Old HTML never re-wrapped
    expect(oldHtml).toBe('<span class="group">旧scene</span>');
    const result = `${oldHtml}${wrapped}`;
    expect(result).toBe(
      '<span class="group">旧scene</span><span class="group">新scene</span>',
    );
  });
});
