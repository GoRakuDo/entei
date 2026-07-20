import { describe, expect, it } from 'vitest';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '../src/i18n/locale-events';
import { id } from '../src/i18n/locales/id';
import { en } from '../src/i18n/locales/en';
import { ja } from '../src/i18n/locales/ja';

/**
 * Locale Events Constants Tests
 * ---------------------------------------------------------------------------
 * Verifies the side-effect-free locale-events module exports the correct
 * event name and that LocaleChangeDetail shapes are valid Dictionary objects.
 * --------------------------------------------------------------------------- */

describe('LOCALE_CHANGE_EVENT', () => {
  it('is the expected CustomEvent name string', () => {
    expect(LOCALE_CHANGE_EVENT).toBe('entei:locale-change');
  });

  it('is a non-empty string', () => {
    expect(typeof LOCALE_CHANGE_EVENT).toBe('string');
    expect(LOCALE_CHANGE_EVENT.length).toBeGreaterThan(0);
  });
});

describe('LocaleChangeDetail shape', () => {
  it('accepts a valid id dictionary', () => {
    const detail: LocaleChangeDetail = { locale: 'id', dictionary: id };
    expect(detail.locale).toBe('id');
    expect(detail.dictionary.hub.systemLabel).toContain('ENTEI');
    expect(detail.dictionary.playerUI).toBeDefined();
    expect(detail.dictionary.playerUI.shortcutsTitle).toBe('Pintasan Keyboard');
  });

  it('accepts a valid en dictionary', () => {
    const detail: LocaleChangeDetail = { locale: 'en', dictionary: en };
    expect(detail.locale).toBe('en');
    expect(detail.dictionary.playerUI.shortcutsTitle).toBe(
      'Keyboard Shortcuts',
    );
  });

  it('accepts a valid ja dictionary', () => {
    const detail: LocaleChangeDetail = { locale: 'ja', dictionary: ja };
    expect(detail.locale).toBe('ja');
    expect(detail.dictionary.playerUI.shortcutsTitle).toBe(
      'キーボードショートカット',
    );
  });

  it('playerUI contains all required keys', () => {
    const requiredKeys = [
      'selectMediaTitle',
      'selectMediaDesc',
      'chooseMedia',
      'chooseSubtitle',
      'subtitles',
      'noSubtitlesLoaded',
      'shortcuts',
      'shortcutsTitle',
      'shortcutsDesc',
      'showShortcutsAriaLabel',
      'dialogClose',
      'subtitleWarnings',
      'unsupportedFormat',
      'failedToRead',
      'failedToLoadAudio',
      'failedToLoadVideo',
      'cuesCount',
      'seekTo',
      'playLabel',
      'pauseLabel',
      'volumeLabel',
      'linePrefix',
      'shortcutPlayPause',
      'shortcutPrevCue',
      'shortcutNextCue',
      'shortcutSeekHome',
      'shortcutSlowDown',
      'shortcutSpeedUp',
    ] as const;

    for (const locale of [id, en, ja] as const) {
      for (const key of requiredKeys) {
        expect(
          locale.playerUI[key],
          `${key} missing in locale ${locale.hub.systemLabel}`,
        ).toBeDefined();
        expect(typeof locale.playerUI[key], `${key} should be a string`).toBe(
          'string',
        );
      }
    }
  });

  it('can be dispatched and received on window', () => {
    const received: LocaleChangeDetail[] = [];
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<LocaleChangeDetail>).detail;
      received.push(detail);
    };

    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    try {
      const detail: LocaleChangeDetail = { locale: 'en', dictionary: en };
      window.dispatchEvent(
        new CustomEvent<LocaleChangeDetail>(LOCALE_CHANGE_EVENT, { detail }),
      );
      expect(received).toHaveLength(1);
      expect(received[0]!.locale).toBe('en');
    } finally {
      window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
    }
  });
});
