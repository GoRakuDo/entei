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
  scanInputTokens,
  scanInputTrigger,
  withScanInputKind,
  withScanInputPreventScrolling,
  withScanInputToken,
  withScanInputTrigger,
  writeScanInputs,
} from '@/components/settings/ScanningInputManager';
import { readOptionPath } from '@/features/yomitan/yomitan-preferences';

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

  it('re-imposes the always-on term and kanji search', () => {
    const input = normalizeScanInput({
      options: { searchTerms: false, searchKanji: false },
    });
    expect(input.options.searchTerms).toBe(true);
    expect(input.options.searchKanji).toBe(true);
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
    ).toBe('press');
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

  it('leaves a mouse card alone (it has no trigger to write)', () => {
    const mouse = newScanInput();
    expect(withScanInputTrigger(mouse, 'release')).toEqual(mouse);
  });
});

describe('the unified touch/pen options', () => {
  it('reads and writes prevent-scrolling on the card’s own pointer type', () => {
    const touch = withScanInputKind(newScanInput(), 'touch');
    const blocked = withScanInputPreventScrolling(touch, true);
    expect(blocked.options.preventTouchScrolling).toBe(true);
    // The pen's own flag is untouched, so switching type keeps each side's value.
    expect(blocked.options.preventPenScrolling).toBe(false);

    const pen = withScanInputPreventScrolling(
      withScanInputKind(newScanInput(), 'pen'),
      true,
    );
    expect(scanInputPreventScrolling(pen)).toBe(true);
    expect(pen.options.preventTouchScrolling).toBe(false);
  });

  it('reports a mouse card as never blocking a scroll', () => {
    const mouse = {
      ...newScanInput(),
      options: { ...newScanInput().options, preventTouchScrolling: true },
    };
    expect(scanInputPreventScrolling(mouse)).toBe(false);
    expect(withScanInputPreventScrolling(mouse, true)).toEqual(mouse);
  });
});

describe('a card added by “Add New Key”', () => {
  it('starts as an empty mouse card with a press trigger', () => {
    const input = newScanInput();
    expect(input.include).toBe('');
    expect(input.exclude).toBe('');
    expect(scanInputKind(input)).toBe('mouse');
    expect(input.options.searchTerms).toBe(true);
    expect(input.options.searchKanji).toBe(true);
    // Switching to touch or pen later lands on a trigger that actually fires.
    expect(scanInputTrigger(withScanInputKind(input, 'pen'))).toBe('press');
    expect(scanInputTrigger(withScanInputKind(input, 'touch'))).toBe('press');
    expect(input.options.minimumTouchTime).toBe(0);
  });
});