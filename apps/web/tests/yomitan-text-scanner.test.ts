/**
 * Text scanner tests — input group matching, pointer/touch/pen triggers, and scan window.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  getActiveButtons,
  getActiveModifiers,
  getActiveModifiersAndButtons,
  getMatchingInputGroup,
  getMatchingInputGroupFromEvent,
  isScannableCharacter,
  normalizeScanInputConfig,
  readScanSettings,
  scanWindowAt,
  shouldScanInput,
  type ScanInputConfig,
  type ScanSettings,
} from '@/modules/yomitan/text-scanner';
import {
  readOptionPath,
  writeOptionPath,
} from '@/modules/yomitan/yomitan-preferences';
import {
  readScanInputs,
  scanInputTrigger,
  withScanInputKind,
  withScanInputTrigger,
  type ScanInputTrigger,
} from '@/components/settings/ScanningInputManager';
import { createDefaultOptions } from '@gorakudo/yomitan-headless/settings';

/** A text node stand-in: the window only ever reads `.data`. */
function textNode(data: string): Text {
  return { data } as unknown as Text;
}

const DEFAULT_INPUTS: ScanInputConfig[] = [
  normalizeScanInputConfig({
    include: 'shift',
    exclude: 'mouse0',
    types: { mouse: true, touch: false, pen: false },
    options: {
      searchTerms: true,
      searchKanji: true,
      scanOnTouchTap: false,
      scanOnTouchMove: true,
      scanOnTouchPress: false,
      scanOnTouchRelease: false,
      preventTouchScrolling: false,
      minimumTouchTime: 0,
    },
  }),
  normalizeScanInputConfig({
    include: '',
    exclude: '',
    types: { mouse: false, touch: true, pen: true },
    options: {
      searchTerms: true,
      searchKanji: false,
      scanOnTouchTap: true,
      scanOnTouchMove: false,
      scanOnTouchPress: false,
      scanOnTouchRelease: false,
      scanOnPenMove: true,
      scanOnPenPress: true,
      preventTouchScrolling: true,
      preventPenScrolling: true,
      minimumTouchTime: 150,
    },
  }),
];

const SHIFT_HOVER: ScanSettings = {
  inputs: DEFAULT_INPUTS,
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

describe('Modifier and Button extraction (Yomitan document-util parity)', () => {
  it('extracts active modifier keys in Yomitan order', () => {
    expect(
      getActiveModifiers({
        altKey: true,
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      }),
    ).toEqual(['alt', 'ctrl', 'meta', 'shift']);
    expect(getActiveModifiers({ shiftKey: true, key: 'Shift', code: 'ShiftLeft' })).toEqual([
      'shift',
    ]);
  });

  it('extracts mouse button tokens mouse0..mouse5 from bitmask', () => {
    expect(getActiveButtons(0)).toEqual([]);
    expect(getActiveButtons(1)).toEqual(['mouse0']);
    expect(getActiveButtons(2)).toEqual(['mouse1']);
    expect(getActiveButtons(4)).toEqual(['mouse2']);
    expect(getActiveButtons(5)).toEqual(['mouse0', 'mouse2']);
    expect(getActiveButtons(63)).toEqual(['mouse0', 'mouse1', 'mouse2', 'mouse3', 'mouse4', 'mouse5']);
  });

  it('combines modifiers and buttons in getActiveModifiersAndButtons', () => {
    expect(
      getActiveModifiersAndButtons({
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        buttons: 5,
      }),
    ).toEqual(['shift', 'mouse0', 'mouse2']);
  });
});

describe('getMatchingInputGroup — Yomitan input card matching', () => {
  it('matches required include tokens and rejects excluded tokens', () => {
    // Mouse card requires shift and excludes mouse0
    const m1 = getMatchingInputGroup(DEFAULT_INPUTS, 'mouse', 'mouseMove', ['shift'], ['shift']);
    expect(m1?.input.types.mouse).toBe(true);
    expect(m1?.passive).toBe(false);

    // Missing shift -> no explicit mouse match, and fallback is touch/pen only
    const m2 = getMatchingInputGroup(DEFAULT_INPUTS, 'mouse', 'mouseMove', [], []);
    expect(m2).toBeNull();

    // Shift + mouse0 -> excluded by exclude: ['mouse0']
    const m3 = getMatchingInputGroup(
      DEFAULT_INPUTS,
      'mouse',
      'mouseMove',
      ['shift', 'mouse0'],
      ['shift'],
    );
    expect(m3).toBeNull();
  });

  it('uses empty-include cards as passive fallback when no explicit card matches', () => {
    const t1 = getMatchingInputGroup(DEFAULT_INPUTS, 'touch', 'touchStart', [], []);
    expect(t1).not.toBeNull();
    expect(t1?.passive).toBe(true);
    expect(t1?.input.types.touch).toBe(true);
    expect(t1?.input.minimumTouchTime).toBe(150);
  });

  it('prefers explicit match over empty-include fallback card', () => {
    const inputs: ScanInputConfig[] = [
      normalizeScanInputConfig({
        include: '',
        exclude: '',
        types: { mouse: true, touch: true, pen: true },
        options: { searchKanji: false },
      }),
      normalizeScanInputConfig({
        include: 'ctrl',
        exclude: '',
        types: { mouse: true, touch: false, pen: false },
        options: { searchKanji: true },
      }),
    ];
    const passive = getMatchingInputGroup(inputs, 'mouse', 'mouseMove', [], []);
    expect(passive?.passive).toBe(true);
    expect(passive?.input.searchKanji).toBe(false);

    const explicit = getMatchingInputGroup(inputs, 'mouse', 'mouseMove', ['ctrl'], ['ctrl']);
    expect(explicit?.passive).toBe(false);
    expect(explicit?.input.searchKanji).toBe(true);
  });

  it('resolves pointer type from event in getMatchingInputGroupFromEvent', () => {
    const match = getMatchingInputGroupFromEvent(
      DEFAULT_INPUTS,
      'pen',
      'pointerDown',
      { buttons: 0, shiftKey: false },
    );
    expect(match?.pointerType).toBe('pen');
    expect(match?.eventType).toBe('pointerDown');
    expect(match?.input.scanOnPenPress).toBe(true);
    expect(match?.input.preventPenScrolling).toBe(true);
  });
});

describe('shouldScanInput — legacy modifier gate compatibility', () => {
  it('scans only while the chosen modifier is held', () => {
    expect(shouldScanInput({ ...RESTING, shiftKey: true }, SHIFT_HOVER)).toBe(true);
    expect(shouldScanInput(RESTING, SHIFT_HOVER)).toBe(false);
    expect(shouldScanInput({ ...RESTING, ctrlKey: true }, SHIFT_HOVER)).toBe(false);
  });

  it('scans on plain hover when the modifier is none', () => {
    const none: ScanSettings = { ...SHIFT_HOVER, modifierKey: 'none' };
    expect(shouldScanInput(RESTING, none)).toBe(true);
  });

  it('never scans during a primary-button drag unless explicitly allowed', () => {
    expect(
      shouldScanInput({ ...RESTING, shiftKey: true, buttons: 1 }, SHIFT_HOVER),
    ).toBe(false);
  });

  it('skips a held middle button until the option allows it', () => {
    const held = { ...RESTING, shiftKey: true, buttons: 4 };
    expect(shouldScanInput(held, SHIFT_HOVER)).toBe(false);
    expect(shouldScanInput(held, { ...SHIFT_HOVER, middleMouse: true })).toBe(true);
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
    expect(scanWindowAt(textNode('猫'), 99, 16)).toBeNull();
  });

  it('counts a surrogate pair as one character of the window', () => {
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

describe('readScanSettings — persisted scanning values and inputs', () => {
  it('reads the shipped defaults and input cards', () => {
    const settings = readScanSettings(createDefaultOptions());
    expect(settings.modifierKey).toBe('shift');
    expect(settings.middleMouse).toBe(false);
    expect(settings.length).toBe(16);
    expect(settings.inputs.length).toBe(2);
    expect(settings.inputs[0]?.types.mouse).toBe(true);
    expect(settings.inputs[0]?.searchTerms).toBe(true);
    expect(settings.inputs[0]?.searchKanji).toBe(true);
  });

  it('follows the modifier knob without destroying other input cards', () => {
    const base = createDefaultOptions();
    const customInputs = [
      ...readScanInputs(base),
      {
        include: 'alt mouse2',
        exclude: 'mouse0',
        types: { mouse: true, touch: false, pen: false },
        options: {
          showAdvanced: false,
          searchTerms: true,
          searchKanji: false,
          scanOnTouchTap: false,
          scanOnTouchMove: false,
          scanOnTouchPress: true,
          scanOnTouchRelease: false,
          scanOnPenMove: false,
          scanOnPenHover: false,
          scanOnPenReleaseHover: false,
          scanOnPenPress: false,
          scanOnPenRelease: false,
          preventTouchScrolling: false,
          preventPenScrolling: false,
          minimumTouchTime: 0,
        },
      },
    ];
    const withCustom = writeOptionPath(base, 'scanning.inputs', customInputs);
    const next = writeOptionPath(withCustom, 'scanning.modifierKey', 'ctrl');
    expect(readScanSettings(next).modifierKey).toBe('ctrl');

    const rawInputs = readOptionPath(next, 'scanning.inputs') as {
      include: string;
      exclude: string;
    }[];
    expect(rawInputs).toHaveLength(3);
    expect(rawInputs[0]?.include).toBe('ctrl');
    // Custom third card remains intact!
    expect(rawInputs[2]?.include).toBe('alt mouse2');
    expect(rawInputs[2]?.exclude).toBe('mouse0');
  });

  it('adds and removes the middle-mouse trigger non-destructively', () => {
    const on = writeOptionPath(
      createDefaultOptions(),
      'scanning.middleMouse',
      true,
    );
    expect(readOptionPath(on, 'scanning.modifierKey')).toBe('shift');
    expect(readScanSettings(on).middleMouse).toBe(true);
    const inputsOn = readOptionPath(on, 'scanning.inputs') as {
      include: string;
      exclude: string;
    }[];
    expect(inputsOn[0]?.include).toBe('shift mouse1');
    expect(inputsOn[0]?.exclude).toBe('mouse0');
    expect(inputsOn).toHaveLength(2);

    const off = writeOptionPath(on, 'scanning.middleMouse', false);
    expect(readScanSettings(off).middleMouse).toBe(false);
    const inputsOff = readOptionPath(off, 'scanning.inputs') as {
      include: string;
      exclude: string;
    }[];
    expect(inputsOff[0]?.include).toBe('shift');
    expect(inputsOff[0]?.exclude).toBe('mouse0');
  });
});

describe('Settings UI trigger round-trip across Mouse / Touch / Pen', () => {
  const ALL_TRIGGERS: ScanInputTrigger[] = ['tap', 'press', 'release', 'move'];

  it('round-trips all 4 Scan on choices for Mouse without corrupting other cards', () => {
    const base = createDefaultOptions();
    const initialInputs = readScanInputs(base);
    for (const trig of ALL_TRIGGERS) {
      const mouseCard = withScanInputTrigger(initialInputs[0]!, trig);
      const next = writeOptionPath(base, 'scanning.inputs', [mouseCard, initialInputs[1]!]);
      const readBack = readScanInputs(next);
      expect(scanInputTrigger(readBack[0]!)).toBe(trig);
      expect(readBack).toHaveLength(2);
    }
  });

  it('round-trips all 4 Scan on choices for Touch and Pen', () => {
    const base = createDefaultOptions();
    for (const kind of ['touch', 'pen'] as const) {
      let card = withScanInputKind(readScanInputs(base)[0]!, kind);
      for (const trig of ALL_TRIGGERS) {
        card = withScanInputTrigger(card, trig);
        expect(scanInputTrigger(card)).toBe(trig);
      }
    }
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
