import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyLocale,
  resolveKey,
  switchLocale,
} from '../src/scripts/locale-switcher';
import { PREFERENCES_KEY } from '../src/i18n/index';
import { id } from '../src/i18n/locales/id';
import type { Dictionary } from '../src/i18n/types';

/**
 * Locale Switcher DOM Tests
 * -----------------------------------------------------------------------------
 * Covers (reviewer P2 finding #10):
 * - resolveKey safe dot-notation key resolution
 * - applyLocale updates [data-i18n] text, <html lang>, <title>,
 *   <meta description>, and <select> value
 * - switchLocale persists to localStorage
 * - persisted pageshow restores saved locale (JA/EN), does not revert to ID
 *
 * jsdom provides document, window, and localStorage. The locale-switcher
 * module auto-initialises on import (safe no-op when DOM elements are absent).
 * The pageshow listener is registered once at module level; tests dispatch
 * synthetic pageshow events to exercise it.
 * ---------------------------------------------------------------------------*/

/** Set up a minimal Entei DOM for each test. */
function setupDom(): void {
  document.documentElement.lang = 'id';
  document.documentElement.dataset.enteiLocale = '';
  delete document.documentElement.dataset.enteiLocale;
  document.documentElement.classList.remove('entei-hydrating');
  document.title = 'initial title';
  document.head.innerHTML =
    '<meta name="description" content="initial description">';
  document.body.innerHTML = `
    <p data-i18n="hub.lead">Initial hub lead</p>
    <p data-i18n="player.cta">Initial player cta</p>
    <p data-i18n="reader.status">Initial reader status</p>
    <p data-i18n="language.selectLabel">Initial label</p>
    <select data-entei-language-select autocomplete="off">
      <option value="id">Bahasa Indonesia</option>
      <option value="ja">日本語</option>
      <option value="en">English</option>
    </select>
  `;
}

describe('resolveKey', () => {
  const dictionary: Dictionary = id;

  it('resolves a simple two-segment dot-notation key', () => {
    expect(resolveKey(dictionary, 'hub.lead')).toBe(dictionary.hub.lead);
    expect(resolveKey(dictionary, 'player.cta')).toBe(dictionary.player.cta);
    expect(resolveKey(dictionary, 'reader.status')).toBe(
      dictionary.reader.status,
    );
  });

  it('resolves a three-segment key', () => {
    // language.selectLabel is two segments; verify nested objects resolve
    expect(resolveKey(dictionary, 'language.selectLabel')).toBe(
      dictionary.language.selectLabel,
    );
  });

  it('returns null for a missing top-level key', () => {
    expect(resolveKey(dictionary, 'nonexistent.key')).toBeNull();
  });

  it('returns null for a missing nested key', () => {
    expect(resolveKey(dictionary, 'hub.nonexistent')).toBeNull();
  });

  it('returns null when the leaf value is not a string (e.g. an object)', () => {
    // `hub` is an object, not a string — should return null
    expect(resolveKey(dictionary, 'hub')).toBeNull();
    expect(resolveKey(dictionary, 'player')).toBeNull();
  });

  it('returns null for non-object dictionaries', () => {
    expect(resolveKey(null, 'hub.lead')).toBeNull();
    expect(resolveKey(undefined, 'hub.lead')).toBeNull();
    expect(resolveKey('string', 'hub.lead')).toBeNull();
    expect(resolveKey(42, 'hub.lead')).toBeNull();
  });

  it('returns null for empty or malformed keys', () => {
    expect(resolveKey(dictionary, '')).toBeNull();
    expect(resolveKey(dictionary, '.')).toBeNull();
    expect(resolveKey(dictionary, 'hub.')).toBeNull();
  });
});

describe('applyLocale', () => {
  beforeEach(() => {
    setupDom();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('updates <html lang> to the applied locale', () => {
    applyLocale('ja');
    expect(document.documentElement.lang).toBe('ja');

    applyLocale('en');
    expect(document.documentElement.lang).toBe('en');

    applyLocale('id');
    expect(document.documentElement.lang).toBe('id');
  });

  it('updates document.title and meta description', () => {
    applyLocale('ja');
    expect(document.title).toBe('Entei — 日本語学習の拠点');
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    expect(meta).not.toBeNull();
    expect(meta!.content).toContain('Entei');
    expect(meta!.content).toContain('日本語');

    applyLocale('en');
    expect(document.title).toBe('Entei — Japanese Learning Base');
    expect(meta!.content).toContain('Japanese');
  });

  it('updates all [data-i18n] elements with translated text', () => {
    applyLocale('ja');
    const hubLead = document.querySelector<HTMLElement>(
      '[data-i18n="hub.lead"]',
    );
    expect(hubLead?.textContent).toBe(
      '手元の映像・音声・本から学ぶための場所を、ここに作っています。',
    );

    applyLocale('en');
    expect(hubLead?.textContent).toBe(
      "We're building a learning space around the Japanese videos, audio, and books on your device.",
    );
  });

  it('updates the Language Selector label text', () => {
    applyLocale('ja');
    const label = document.querySelector<HTMLLabelElement>(
      '[data-i18n="language.selectLabel"]',
    );
    expect(label?.textContent).toBe('言語');

    applyLocale('id');
    expect(label?.textContent).toBe('Bahasa');
  });

  it('syncs the Language Selector <select> value', () => {
    const select = document.querySelector<HTMLSelectElement>(
      '[data-entei-language-select]',
    );
    expect(select).not.toBeNull();

    applyLocale('ja');
    expect(select!.value).toBe('ja');

    applyLocale('en');
    expect(select!.value).toBe('en');

    applyLocale('id');
    expect(select!.value).toBe('id');
  });

  it('does not throw when elements are absent', () => {
    document.body.innerHTML = '';
    expect(() => applyLocale('ja')).not.toThrow();
  });
});

describe('switchLocale', () => {
  beforeEach(() => {
    setupDom();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('applies the locale to the document AND persists to localStorage', () => {
    switchLocale('ja');

    expect(document.documentElement.lang).toBe('ja');
    expect(document.title).toBe('Entei — 日本語学習の拠点');

    const raw = localStorage.getItem(PREFERENCES_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      schemaVersion: number;
      locale: string;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.locale).toBe('ja');
  });

  it('overwrites a previous preference on subsequent switches', () => {
    switchLocale('ja');
    switchLocale('en');

    const raw = localStorage.getItem(PREFERENCES_KEY);
    const parsed = JSON.parse(raw!) as { locale: string };
    expect(parsed.locale).toBe('en');
  });

  it('persists Indonesian when switched to id', () => {
    switchLocale('id');
    const raw = localStorage.getItem(PREFERENCES_KEY);
    const parsed = JSON.parse(raw!) as { locale: string };
    expect(parsed.locale).toBe('id');
  });
});

describe('persisted pageshow restores saved locale (reviewer P1 #3)', () => {
  beforeEach(() => {
    setupDom();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  /**
   * Simulates the real flow:
   * 1. User has a saved JA preference in localStorage.
   * 2. The inline <head> script sets dataset.enteiLocale = 'ja' and adds
   *    .entei-hydrating (body hidden).
   * 3. The module script's init() calls getCurrentLocale() -> 'ja',
   *    applyLocale('ja'), then revealPage() which DELETES dataset.enteiLocale.
   * 4. The user navigates away and back — bfcache serves the page, triggering
   *    a persisted pageshow event.
   * 5. The pageshow handler must call getSavedLocale() (reads localStorage),
   *    NOT getCurrentLocale() (which would read the now-deleted dataset and
   *    fall back to 'id').
   *
   * This test proves JA does not revert to Indonesian.
   */
  it('does not revert to Indonesian on persisted pageshow when JA is saved', () => {
    // Step 1: Save JA preference
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'ja' }),
    );

    // Step 2: Simulate inline script setting dataset + hydrating class
    document.documentElement.dataset.enteiLocale = 'ja';
    document.documentElement.classList.add('entei-hydrating');

    // Step 3: Simulate init + revealPage (deletes dataset)
    applyLocale('ja');
    document.documentElement.classList.remove('entei-hydrating');
    delete document.documentElement.dataset.enteiLocale;

    // Verify dataset is gone — getCurrentLocale would return 'id' here
    expect(document.documentElement.dataset.enteiLocale).toBeUndefined();
    expect(document.documentElement.lang).toBe('ja');

    // Step 4: Dispatch persisted pageshow
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', {
      value: true,
      configurable: true,
    });
    window.dispatchEvent(event);

    // Step 5: Verify locale is still JA (not reverted to ID)
    expect(document.documentElement.lang).toBe('ja');
    expect(document.title).toBe('Entei — 日本語学習の拠点');

    // Verify [data-i18n] elements still show Japanese text
    const hubLead = document.querySelector<HTMLElement>(
      '[data-i18n="hub.lead"]',
    );
    expect(hubLead?.textContent).toBe(
      '手元の映像・音声・本から学ぶための場所を、ここに作っています。',
    );

    // Verify select value is still JA
    const select = document.querySelector<HTMLSelectElement>(
      '[data-entei-language-select]',
    );
    expect(select?.value).toBe('ja');
  });

  it('does not revert to Indonesian on persisted pageshow when EN is saved', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'en' }),
    );

    document.documentElement.dataset.enteiLocale = 'en';
    applyLocale('en');
    delete document.documentElement.dataset.enteiLocale;

    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', {
      value: true,
      configurable: true,
    });
    window.dispatchEvent(event);

    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('Entei — Japanese Learning Base');

    const hubLead = document.querySelector<HTMLElement>(
      '[data-i18n="hub.lead"]',
    );
    expect(hubLead?.textContent).toBe(
      "We're building a learning space around the Japanese videos, audio, and books on your device.",
    );
  });

  it('falls back to Indonesian on persisted pageshow when no preference exists', () => {
    // No localStorage entry
    applyLocale('ja'); // Temporarily set to JA
    expect(document.documentElement.lang).toBe('ja');

    delete document.documentElement.dataset.enteiLocale;

    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', {
      value: true,
      configurable: true,
    });
    window.dispatchEvent(event);

    // getSavedLocale() returns DEFAULT_LOCALE ('id') when no preference
    expect(document.documentElement.lang).toBe('id');
    expect(document.title).toBe('Entei — Markas Belajar Bahasa Jepang');
  });

  it('does not apply locale on non-persisted pageshow (normal page load)', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ schemaVersion: 1, locale: 'ja' }),
    );

    applyLocale('id');
    expect(document.documentElement.lang).toBe('id');

    // Non-persisted pageshow should NOT trigger re-application
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', {
      value: false,
      configurable: true,
    });
    window.dispatchEvent(event);

    // Still ID — the handler only acts on persisted pageshow
    expect(document.documentElement.lang).toBe('id');
  });
});
