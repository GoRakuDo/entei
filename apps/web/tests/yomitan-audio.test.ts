/**
 * Yomitan audio playback unit tests.
 *
 * Covers the PURE half of the audio work — the parts that need no browser and no
 * network:
 *   - `audio-sources`: shaping the stored `audio.sources[]` into labelled entries
 *     (upstream's friendly names, duplicate-type disambiguation, client-playable).
 *   - `audio-resolver`: jpod101 + custom URL resolution (the two client-complete
 *     sources), including upstream's entirely-kana rule, and volume clamping.
 *   - `popup-document`: the frame embeds an inert `#popup-audio-config` JSON the
 *     bridge reads, and the audio menu templates ride along.
 *
 * Playback itself (`new Audio(url)`) is browser-only and is exercised on the real
 * surfaces, not here.
 * ---------------------------------------------------------------------------
 */
import { describe, expect, it } from 'bun:test';
import {
  audioSourceTypeName,
  toAudioSourceInfos,
} from '@/modules/yomitan/audio/audio-sources';
import {
  buildCustomUrl,
  buildJpod101Url,
  clampVolume,
} from '@/modules/yomitan/audio/audio-resolver';
import { buildPopupDocument } from '@/modules/yomitan/popup-preview/popup-document';
import { extractAudioMenuTemplates } from '@/modules/yomitan/popup-preview/popup-entries';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('audio-sources — toAudioSourceInfos', () => {
  it('labels each source with upstream’s friendly name', () => {
    const infos = toAudioSourceInfos([
      { type: 'jpod101', url: '', voice: '' },
      { type: 'jisho', url: '', voice: '' },
      { type: 'custom', url: 'https://x/{term}', voice: '' },
    ]);
    expect(infos.map((s) => s.name)).toEqual([
      'JapanesePod101',
      'Jisho.org',
      'Custom URL',
    ]);
  });

  it('disambiguates duplicate types with a nameIndex', () => {
    const infos = toAudioSourceInfos([
      { type: 'custom', url: 'a', voice: '' },
      { type: 'custom', url: 'b', voice: '' },
    ]);
    expect(infos).toHaveLength(2);
    expect(infos[0]?.nameIndex).toBe(0);
    expect(infos[1]?.nameIndex).toBe(1);
    // Neither is unique now — the menu label must show "Custom URL 1" / "2".
    expect(infos[0]?.nameUnique).toBe(false);
    expect(infos[1]?.nameUnique).toBe(false);
    expect(infos.map((s) => s.index)).toEqual([0, 1]);
  });

  it('marks only the client-resolvable sources playable', () => {
    const infos = toAudioSourceInfos([
      { type: 'jpod101', url: '', voice: '' },
      { type: 'custom', url: 'x', voice: '' },
      { type: 'jisho', url: '', voice: '' },
      { type: 'language-pod-101', url: '', voice: '' },
      { type: 'wiktionary', url: '', voice: '' },
    ]);
    const byType = new Map(infos.map((s) => [s.type, s.clientPlayable]));
    expect(byType.get('jpod101')).toBe(true);
    expect(byType.get('custom')).toBe(true);
    expect(byType.get('jisho')).toBe(false);
    expect(byType.get('language-pod-101')).toBe(false);
    expect(byType.get('wiktionary')).toBe(false);
  });

  it('coerces an untrusted stored entry with an unknown type to jpod101', () => {
    const infos = toAudioSourceInfos([
      { type: 'not-a-real-type', url: '', voice: '' },
      'garbage',
      null,
    ]);
    expect(infos).toHaveLength(1);
    expect(infos[0]?.type).toBe('jpod101');
  });

  it('returns [] for a non-array (no sources configured)', () => {
    expect(toAudioSourceInfos(undefined)).toEqual([]);
    expect(toAudioSourceInfos('nope')).toEqual([]);
  });

  it('audioSourceTypeName falls back to Unknown', () => {
    expect(audioSourceTypeName('jpod101')).toBe('JapanesePod101');
    expect(audioSourceTypeName('mystery')).toBe('Unknown');
  });
});

describe('audio-resolver — buildJpod101Url', () => {
  it('sends a kanji term and its reading as separate params', () => {
    const url = buildJpod101Url('食べる', 'たべる');
    expect(url).toBe(
      'https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?kanji=%E9%A3%9F%E3%81%B9%E3%82%8B&kana=%E3%81%9F%E3%81%B9%E3%82%8B',
    );
  });

  it('omits kanji when the term is entirely kana (upstream’s rule)', () => {
    // 「ありがとう」 is all kana: it is really the reading, so kanji stays empty.
    const url = buildJpod101Url('ありがとう', 'ありがとう');
    expect(url).toContain('kana=');
    expect(url).not.toContain('kanji=');
  });

  it('keeps kanji when the term has kanji even if reading equals term', () => {
    const url = buildJpod101Url('犬', '犬');
    expect(url).toContain('kanji=');
  });
});

describe('audio-resolver — buildCustomUrl', () => {
  it('substitutes {term}, {reading} and {language} (literal, unencoded — upstream)', () => {
    const url = buildCustomUrl(
      'https://example.com/{language}/{term}/{reading}.mp3',
      '犬',
      'いぬ',
    );
    // Upstream's `_getCustomUrl` does a plain string substitution and does NOT
    // percent-encode; the browser encodes when it fetches. Match that exactly.
    expect(url).toBe('https://example.com/ja/犬/いぬ.mp3');
  });

  it('leaves unknown placeholders untouched (upstream behaviour)', () => {
    const url = buildCustomUrl('https://x/{term}?q={unknown}', '犬', 'いぬ');
    expect(url).toBe('https://x/犬?q={unknown}');
  });

  it('returns null for an empty template', () => {
    expect(buildCustomUrl('', '犬', 'いぬ')).toBeNull();
  });
});

describe('audio-resolver — clampVolume', () => {
  it('maps a 0–100 stored volume into 0–1', () => {
    expect(clampVolume(100)).toBe(1);
    expect(clampVolume(50)).toBe(0.5);
    expect(clampVolume(0)).toBe(0);
  });

  it('clamps out-of-range and non-finite values', () => {
    expect(clampVolume(150)).toBe(1);
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(1);
  });
});

describe('popup-document — audio config + menu templates', () => {
  const templatesPath = resolve(
    process.cwd(),
    'public/yomitan/templates-display.html',
  );
  const templates = readFileSync(templatesPath, 'utf8');

  const baseInput = {
    css: '',
    themeAttributes: {},
    fontStyle: '',
    customCss: '',
    entriesHtml: '<div class="entry"></div>',
  };

  it('embeds an inert #popup-audio-config JSON when audio is configured', () => {
    const html = buildPopupDocument({
      ...baseInput,
      audioConfig: {
        sources: [{ index: 0, type: 'jpod101', url: '', name: 'JapanesePod101', nameIndex: 0, nameUnique: true, clientPlayable: true }],
        volume: 80,
      },
    });
    expect(html).toContain('id="popup-audio-config"');
    expect(html).toContain('application/json');
    expect(html).toContain('JapanesePod101');
    // The config must not be executable JS: it is an inert JSON script.
    expect(html).toContain('<script type="application/json" id="popup-audio-config">');
  });

  it('embeds no audio config when audioConfig is null', () => {
    const html = buildPopupDocument({ ...baseInput });
    // The bridge script always MENTIONS the id (it reads it), so assert on the
    // inert JSON element itself, not the bare substring.
    expect(html).not.toContain('<script type="application/json" id="popup-audio-config">');
  });

  it('neutralises a closing-tag sequence in the embedded JSON', () => {
    const html = buildPopupDocument({
      ...baseInput,
      audioConfig: {
        sources: [{ index: 0, type: 'custom', url: '</script>', name: 'x', nameIndex: 0, nameUnique: true, clientPlayable: true }],
        volume: 100,
      },
    });
    // A literal </script> inside the JSON would close the element early; it must
    // be escaped so the JSON survives intact and cannot inject markup.
    expect(html).toContain('<script type="application/json" id="popup-audio-config">');
    expect(html).not.toMatch(/<\/script><\/script>/);
  });

  it('extractAudioMenuTemplates lifts upstream’s audio menu templates', () => {
    const markup = extractAudioMenuTemplates(templates);
    expect(markup).toContain('audio-button-popup-menu-template');
    expect(markup).toContain('audio-button-popup-menu-item-template');
  });

  it('extractAudioMenuTemplates returns "" when the templates are absent', () => {
    expect(extractAudioMenuTemplates('<html><body></body></html>')).toBe('');
  });
});
