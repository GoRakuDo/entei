/**
 * ScanningInputManager — the rules behind the scan-input cards.
 * ---------------------------------------------------------------------------
 * Pure logic only (no rendering): everything the cards read and write is decided
 * here, so the pointer-type single select, the authoritative press/release
 * trigger, the unified touch/pen options and the always-on term+kanji search are
 * tested without a DOM.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';
import {
  keyboardInputToken,
  mouseInputToken,
  newScanInput,
  normalizeScanInput,
  readScanInputs,
  scanInputKind,
  scanInputPreventScrolling,
  scanInputSearchTarget,
  scanInputSearchTargets,
  scanInputTokens,
  scanInputTrigger,
  scanInputTriggers,
  withScanInputKind,
  withScanInputPreventScrolling,
  withScanInputSearchTarget,
  withScanInputSearchTargets,
  withScanInputToken,
  withScanInputTrigger,
  withScanInputTriggers,
  writeScanInputs,
} from '@/components/settings/ScanningInputManager';
import { readOptionPath } from '@/modules/yomitan/yomitan-preferences';

beforeEach(() => {
  localStorage.clear();
});

describe('scan input tokens', () => {
  it('splits and rejoins the persisted token string', () => {
    expect(scanInputTokens('shift mouse0')).toEqual(['shift', 'mouse0']);
    expect(scanInputTokens('  shift   mouse0  ')).toEqual(['shift', 'mouse0']);
    expect(scanInputTokens('')).toEqual([]);
    expect(scanInputTokens(undefined)).toEqual([]);
    expect(scanInputTokens(7)).toEqual([]);
  });

  it('adds a token once', () => {
    expect(withScanInputToken('', 'shift')).toBe('shift');
    expect(withScanInputToken('shift', 'mouse0')).toBe('shift mouse0');
    expect(withScanInputToken('shift mouse0', 'shift')).toBe('shift mouse0');
    expect(withScanInputToken(undefined, 'ctrl')).toBe('ctrl');
  });
});

describe('recording a key or button', () => {
  const key = (value: string) => ({ key: value }) as KeyboardEvent;

  it('records only the modifiers the matcher knows', () => {
    expect(keyboardInputToken(key('Shift'))).toBe('shift');
    expect(keyboardInputToken(key('Control'))).toBe('ctrl');
    expect(keyboardInputToken(key('Alt'))).toBe('alt');
    expect(keyboardInputToken(key('Meta'))).toBe('meta');
  });

  it('ignores a key that has no token (and keeps listening)', () => {
    expect(keyboardInputToken(key('a'))).toBeNull();
    expect(keyboardInputToken(key('Enter'))).toBeNull();
    expect(keyboardInputToken(key('F5'))).toBeNull();
  });

  it('records mouse buttons 0–5 only', () => {
    const button = (value: number) => ({ button: value }) as MouseEvent;
    expect(mouseInputToken(button(0))).toBe('mouse0');
    expect(mouseInputToken(button(1))).toBe('mouse1');
    expect(mouseInputToken(button(5))).toBe('mouse5');
    expect(mouseInputToken(button(6))).toBeNull();
    expect(mouseInputToken(button(-1))).toBeNull();
    expect(mouseInputToken(button(1.5))).toBeNull();
  });
});

describe('normalizeScanInput', () => {
  it('fills every field of a partial entry', () => {
    const input = normalizeScanInput({ include: 'shift' });
    expect(input.include).toBe('shift');
    expect(input.exclude).toBe('');
    expect(input.types).toEqual({ mouse: false, touch: false, pen: false });
    expect(input.options.minimumTouchTime).toBe(0);
    expect(input.options.scanOnTouchPress).toBe(false);
  });

  it('survives an entry that is not an object at all', () => {
    expect(normalizeScanInput(null).include).toBe('');
    expect(normalizeScanInput('shift').types.mouse).toBe(false);
  });

  it('reads and updates the search target (term | kanji)', () => {
    const termInput = normalizeScanInput({
      options: { searchTerms: true, searchKanji: false },
    });
    expect(scanInputSearchTarget(termInput)).toBe('term');
    const kanjiInput = withScanInputSearchTarget(termInput, 'kanji');
    expect(kanjiInput.options.searchTerms).toBe(false);
    expect(kanjiInput.options.searchKanji).toBe(true);
    expect(scanInputSearchTarget(kanjiInput)).toBe('kanji');
    const backToTerm = withScanInputSearchTarget(kanjiInput, 'term');
    expect(backToTerm.options.searchTerms).toBe(true);
    expect(backToTerm.options.searchKanji).toBe(false);
    expect(scanInputSearchTarget(backToTerm)).toBe('term');
  });

  it('reads and updates multiple search targets (term and/or kanji)', () => {
    const both = normalizeScanInput({
      options: { searchTerms: true, searchKanji: true },
    });
    expect(scanInputSearchTargets(both)).toEqual(['term', 'kanji']);

    const kanjiOnly = withScanInputSearchTargets(both, ['kanji']);
    expect(kanjiOnly.options.searchTerms).toBe(false);
    expect(kanjiOnly.options.searchKanji).toBe(true);
    expect(scanInputSearchTargets(kanjiOnly)).toEqual(['kanji']);

    const neither = withScanInputSearchTargets(kanjiOnly, []);
    expect(neither.options.searchTerms).toBe(false);
    expect(neither.options.searchKanji).toBe(false);
    expect(scanInputSearchTargets(neither)).toEqual([]);

    const termOnly = withScanInputSearchTargets(neither, ['term']);
    expect(termOnly.options.searchTerms).toBe(true);
    expect(termOnly.options.searchKanji).toBe(false);
    expect(scanInputSearchTargets(termOnly)).toEqual(['term']);
  });

  it('clamps a nonsense minimum touch time to zero', () => {
    expect(
      normalizeScanInput({ options: { minimumTouchTime: -30 } }).options
        .minimumTouchTime,
    ).toBe(0);
    expect(
      normalizeScanInput({ options: { minimumTouchTime: 12.6 } }).options
        .minimumTouchTime,
    ).toBe(13);
    expect(
      normalizeScanInput({ options: { minimumTouchTime: 'soon' } }).options
        .minimumTouchTime,
    ).toBe(0);
  });
});

describe('the persisted input list', () => {
  it('reads Yomitan’s shipped definitions and writes them back', () => {
    const defaults = readScanInputs(createDefaultOptions());
    expect(defaults).toHaveLength(2);
    expect(scanInputKind(defaults[0]!)).toBe('mouse');

    const next = writeScanInputs(createDefaultOptions(), [
      ...defaults.slice(0, 1),
      newScanInput(),
    ]);
    const written = readOptionPath(next, 'scanning.inputs');
    expect(written).toHaveLength(2);
  });
});

describe('one pointer type per card', () => {
  it('picks the first type in draw order when several are set', () => {
    // Yomitan's own second default serves touch AND pen: the card shows touch.
    const both = normalizeScanInput({
      types: { mouse: false, touch: true, pen: true },
    });
    expect(scanInputKind(both)).toBe('touch');
    const none = normalizeScanInput({ types: {} });
    expect(scanInputKind(none)).toBe('pen');
  });

  it('writes exactly the picked type', () => {
    const mouse = newScanInput();
    expect(
      withScanInputKind(mouse, 'pen').types,
    ).toEqual({ mouse: false, touch: false, pen: true });
    expect(
      withScanInputKind(withScanInputKind(mouse, 'pen'), 'touch').types,
    ).toEqual({ mouse: false, touch: true, pen: false });
  });
});

describe('the scan trigger', () => {
  it('reads the press flag of the card’s pointer type', () => {
    const pen = withScanInputKind(newScanInput(), 'pen');
    expect(scanInputTrigger(pen)).toBe('press');
    expect(
      scanInputTrigger({
        ...pen,
        options: { ...pen.options, scanOnPenRelease: true },
      }),
    ).toBe('release');
  });

  it('ignores the other pointer’s flags when it reads', () => {
    // A touch card must not report the pen's release.
    const touch = withScanInputKind(newScanInput(), 'touch');
    expect(
      scanInputTrigger({
        ...touch,
        options: { ...touch.options, scanOnPenRelease: true },
      }),
    ).toBe('tap');
  });

  it('writes the touch trigger off against tap and move', () => {
    const touch = withScanInputKind(
      {
        ...newScanInput(),
        options: {
          ...newScanInput().options,
          scanOnTouchTap: true,
          scanOnTouchMove: true,
        },
      },
      'touch',
    );
    const released = withScanInputTrigger(touch, 'release');
    expect(released.options.scanOnTouchRelease).toBe(true);
    expect(released.options.scanOnTouchPress).toBe(false);
    expect(released.options.scanOnTouchTap).toBe(false);
    expect(released.options.scanOnTouchMove).toBe(false);
  });

  it('writes the pen trigger off against move and hover', () => {
    const pen = withScanInputKind(
      {
        ...newScanInput(),
        options: {
          ...newScanInput().options,
          scanOnPenMove: true,
          scanOnPenHover: true,
          scanOnPenReleaseHover: true,
        },
      },
      'pen',
    );
    const pressed = withScanInputTrigger(pen, 'press');
    expect(pressed.options.scanOnPenPress).toBe(true);
    expect(pressed.options.scanOnPenRelease).toBe(false);
    expect(pressed.options.scanOnPenMove).toBe(false);
    expect(pressed.options.scanOnPenHover).toBe(false);
    expect(pressed.options.scanOnPenReleaseHover).toBe(false);
  });

  it('writes multiple triggers for pointer types', () => {
    const mouse = newScanInput();
    const multi = withScanInputTriggers(mouse, ['tap', 'press']);
    expect(multi.options.scanOnTouchTap).toBe(true);
    expect(multi.options.scanOnTouchPress).toBe(true);
    expect(multi.options.scanOnTouchRelease).toBe(false);
    expect(multi.options.scanOnTouchMove).toBe(false);
    expect(scanInputTriggers(multi)).toEqual(['tap', 'press']);
  });

  it('writes the tap trigger flag on a mouse card', () => {
    const mouse = newScanInput();
    const released = withScanInputTrigger(mouse, 'release');
    expect(released.options.scanOnTouchRelease).toBe(true);
    expect(released.options.scanOnTouchTap).toBe(false);
    expect(released.options.scanOnTouchPress).toBe(false);
    expect(released.options.scanOnTouchMove).toBe(false);
  });
});

describe('the unified pointer options', () => {
  it('reads and writes prevent-scrolling across pointer types', () => {
    const touch = withScanInputKind(newScanInput(), 'touch');
    const blocked = withScanInputPreventScrolling(touch, true);
    expect(scanInputPreventScrolling(blocked)).toBe(true);
    expect(blocked.options.preventTouchScrolling).toBe(true);
    expect(blocked.options.preventPenScrolling).toBe(true);

    const unblocked = withScanInputPreventScrolling(blocked, false);
    expect(scanInputPreventScrolling(unblocked)).toBe(false);
  });

  it('reads and writes prevent-scrolling on a mouse card as well', () => {
    const mouse = newScanInput();
    const blocked = withScanInputPreventScrolling(mouse, true);
    expect(scanInputPreventScrolling(blocked)).toBe(true);
    expect(blocked.options.preventTouchScrolling).toBe(true);
    expect(blocked.options.preventPenScrolling).toBe(true);
  });
});

describe('a card added by “Add New Key”', () => {
  it('starts as an empty mouse card with tap trigger and term search', () => {
    const input = newScanInput();
    expect(input.include).toBe('');
    expect(input.exclude).toBe('');
    expect(scanInputKind(input)).toBe('mouse');
    expect(scanInputSearchTarget(input)).toBe('term');
    expect(input.options.searchTerms).toBe(true);
    expect(input.options.searchKanji).toBe(false);
    expect(scanInputTrigger(input)).toBe('tap');
    expect(scanInputTrigger(withScanInputKind(input, 'touch'))).toBe('tap');
    expect(scanInputTrigger(withScanInputKind(input, 'pen'))).toBe('press');
    expect(input.options.minimumTouchTime).toBe(0);
  });
});