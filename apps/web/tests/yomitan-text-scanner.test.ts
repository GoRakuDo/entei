/**
 * Text scanner tests — the pointer-scan rule and the scan window.
 * ---------------------------------------------------------------------------
 * The scanner's DOM half (`caretRangeFromPoint`, listeners) is a WebView2 API and
 * is verified by hand on the running app; everything that DECIDES what to scan is
 * pure and is pinned here:
 *
 * - `shouldScanInput`: which modifier/button combinations are a scan at all
 *   (the rule that keeps a page of Japanese from being looked up on every move),
 * - `scanWindowAt` / `isScannableCharacter`: how many characters are taken and
 *   where the window stops (a Latin label under the pointer must yield nothing),
 * - `readScanSettings`: the persisted values, with the virtual modifier knob read
 *   back out of Yomitan's scan-input list.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  isScannableCharacter,
  readScanSettings,
  scanWindowAt,
  shouldScanInput,
  type ScanSettings,
} from '@/features/yomitan/text-scanner';
import {
  readOptionPath,
  writeOptionPath,
} from '@/features/yomitan/yomitan-preferences';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';

/** A text node stand-in: the window only ever reads `.data`. */
function textNode(data: string): Text {
  return { data } as unknown as Text;
}

const SHIFT_HOVER: ScanSettings = {
  modifierKey: 'shift',
  middleMouse: false,
  delay: 0,
  length: 16,
  matchTypePrefix: false,
  scanResolution: 'character',
  scanWithoutMousemove: false,
  selectText: false,
  layoutAwareScan: false,
  deepContentScan: false,
};

const RESTING = {
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  buttons: 0,
};

beforeEach(() => {
  localStorage.clear();
});

describe('shouldScanInput — the modifier gate', () => {
  it('scans only while the chosen modifier is held', () => {
    expect(shouldScanInput({ ...RESTING, shiftKey: true }, SHIFT_HOVER)).toBe(true);
    expect(shouldScanInput(RESTING, SHIFT_HOVER)).toBe(false);
    // Another modifier held is not a scan: the user asked for Shift.
    expect(shouldScanInput({ ...RESTING, ctrlKey: true }, SHIFT_HOVER)).toBe(false);
  });

  it('scans on plain hover when the modifier is none', () => {
    const none: ScanSettings = { ...SHIFT_HOVER, modifierKey: 'none' };
    expect(shouldScanInput(RESTING, none)).toBe(true);
  });

  it('accepts every offered modifier', () => {
    const state = (key: 'ctrlKey' | 'altKey' | 'metaKey') => ({
      ...RESTING,
      [key]: true,
    });
    expect(
      shouldScanInput(state('ctrlKey'), { ...SHIFT_HOVER, modifierKey: 'ctrl' }),
    ).toBe(true);
    expect(
      shouldScanInput(state('altKey'), { ...SHIFT_HOVER, modifierKey: 'alt' }),
    ).toBe(true);
    expect(
      shouldScanInput(state('metaKey'), { ...SHIFT_HOVER, modifierKey: 'meta' }),
    ).toBe(true);
  });
});

describe('shouldScanInput — the button rules', () => {
  it('never scans during a primary-button drag (that is a selection)', () => {
    expect(
      shouldScanInput({ ...RESTING, shiftKey: true, buttons: 1 }, SHIFT_HOVER),
    ).toBe(false);
  });

  it('skips a held middle button until the option allows it', () => {
    const held = { ...RESTING, shiftKey: true, buttons: 4 };
    expect(shouldScanInput(held, SHIFT_HOVER)).toBe(false);
    expect(
      shouldScanInput(held, { ...SHIFT_HOVER, middleMouse: true }),
    ).toBe(true);
  });
});

describe('scanWindowAt — how much text is taken', () => {
  it('takes up to the scan length from the caret', () => {
    const windowed = scanWindowAt(textNode('食べる猫'), 0, 2);
    expect(windowed?.text).toBe('食べ');
    expect(windowed?.offset).toBe(0);
  });

  it('starts at the caret, not at the node start', () => {
    const windowed = scanWindowAt(textNode('これは食べる'), 3, 16);
    expect(windowed?.text).toBe('食べる');
    expect(windowed?.offset).toBe(3);
  });

  it('stops at the first character a dictionary cannot be asked about', () => {
    expect(scanWindowAt(textNode('食べる (taberu)'), 0, 16)?.text).toBe('食べる');
    expect(scanWindowAt(textNode('Hello'), 0, 16)).toBeNull();
  });

  it('refuses a caret with no scannable text ahead of it', () => {
    expect(scanWindowAt(textNode('猫'), 1, 16)).toBeNull();
    // A caret past the end has nothing ahead either.
    expect(scanWindowAt(textNode('猫'), 99, 16)).toBeNull();
  });

  it('counts a surrogate pair as one character of the window', () => {
    // 𠮟 is outside the BMP: a per-code-unit loop would take half of it.
    expect(scanWindowAt(textNode('𠮟る'), 0, 1)?.text).toBe('𠮟');
  });

  it('recognises the characters a Japanese lookup needs', () => {
    expect(isScannableCharacter('食')).toBe(true);
    expect(isScannableCharacter('ー')).toBe(true);
    expect(isScannableCharacter('々')).toBe(true);
    expect(isScannableCharacter('ｶ')).toBe(true);
    expect(isScannableCharacter('A')).toBe(false);
    expect(isScannableCharacter(' ')).toBe(false);
    expect(isScannableCharacter('。')).toBe(false);
  });
});

describe('readScanSettings — persisted scanning values', () => {
  it('reads the shipped defaults', () => {
    const settings = readScanSettings(createDefaultOptions());
    expect(settings.modifierKey).toBe('shift');
    expect(settings.middleMouse).toBe(false);
    expect(settings.length).toBe(16);
    expect(typeof settings.delay).toBe('number');
  });

  it('follows the modifier knob the settings row writes', () => {
    const next = writeOptionPath(createDefaultOptions(), 'scanning.modifierKey', 'ctrl');
    expect(readScanSettings(next).modifierKey).toBe('ctrl');
    // The knob writes Yomitan's own field, not a foreign key.
    const inputs = readOptionPath(next, 'scanning.inputs') as {
      include: string;
    }[];
    // The first input is the mouse one; the second (touch/pen) is untouched.
    expect(inputs[0]?.include).toBe('ctrl');
    expect(inputs).toHaveLength(2);
  });

  it('adds and removes the middle-mouse trigger', () => {
    const on = writeOptionPath(
      createDefaultOptions(),
      'scanning.middleMouse',
      true,
    );
    expect(readOptionPath(on, 'scanning.modifierKey')).toBe('shift');
    expect(readScanSettings(on).middleMouse).toBe(true);
    expect(
      (readOptionPath(on, 'scanning.inputs') as { include: string }[])[0]?.include,
    ).toBe('shift mouse1');

    const off = writeOptionPath(on, 'scanning.middleMouse', false);
    expect(readScanSettings(off).middleMouse).toBe(false);
    expect(
      (readOptionPath(off, 'scanning.inputs') as { include: string }[])[0]?.include,
    ).toBe('shift');
  });
});
describe('readScanSettings — the behaviour knobs', () => {
  it('reads the match type, resolution and highlight flags', () => {
    const base = createDefaultOptions();
    expect(readScanSettings(base).matchTypePrefix).toBe(false);
    expect(readScanSettings(base).scanResolution).toBe('character');
    expect(readScanSettings(base).selectText).toBe(true);
    expect(readScanSettings(base).layoutAwareScan).toBe(true);
    expect(readScanSettings(base).scanWithoutMousemove).toBe(true);
    // Yomitan ships the deep scan off; the settings switch is what turns it on.
    expect(readScanSettings(base).deepContentScan).toBe(false);

    const changed = writeOptionPath(
      writeOptionPath(
        writeOptionPath(base, 'scanning.matchTypePrefix', true),
        'scanning.scanResolution',
        'word',
      ),
      'scanning.selectText',
      false,
    );
    const settings = readScanSettings(changed);
    expect(settings.matchTypePrefix).toBe(true);
    expect(settings.scanResolution).toBe('word');
    expect(settings.selectText).toBe(false);
  });

  it('follows the deep content scan the settings page now offers', () => {
    const base = createDefaultOptions();
    const deep = writeOptionPath(base, 'scanning.deepDomScan', true);
    expect(readScanSettings(deep).deepContentScan).toBe(true);
  });
});
