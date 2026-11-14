'use client';

/**
 * ScanningInputManager — the `inputs` layout's Yomitan editor.
 * ---------------------------------------------------------------------------
 * Yomitan models a scan trigger as a LIST of input definitions
 * (`scanning.inputs[]`): each entry pairs a set of required and excluded input
 * tokens with the pointer types it serves and how that pointer has to behave.
 * The settings TREE can only describe that array as a whole (`type: 'array'`),
 * so the array needs an editor of its own — this one, declared by the manifest
 * as a row of the Scanning section:
 *
 *   { "layout": "inputs", "field": "scanning.inputs",
 *     "source": "yomitan-scan-inputs", "labelKey": "advancedInputs", … }
 *
 * One CARD per entry, each card a stack of the platform's STANDARD field rows
 * (`.entei-module-field`), so a card reads exactly like the settings around it.
 *
 * WHERE THIS EDITOR IS STRICTER THAN YOMITAN, on purpose:
 * - ONE pointer type per card. Yomitan ships checkboxes because a mouse
 *   definition and a touch/pen one differ in every other field; with the touch
 *   and pen options unified below, a card is one trigger and one type. Picking a
 *   type writes exactly that flag and clears the other two.
 * - `Scan on: press | release` is the only trigger choice, and it is
 *   AUTHORITATIVE: the flags this card does not show (touch tap/move, pen
 *   move/hover) are written off with it, so what the card says is what the
 *   engine does. It appears for touch and pen only — Yomitan's mouse trigger is
 *   "hold the required inputs and move", which has no press or release to pick.
 * - `Search for: term | kanji` is gone: both are always on, and every write
 *   re-imposes them, so a hand-edited payload cannot half-search a word.
 *
 * Touch and pen share one set of rows (Yomitan keeps two near-identical blocks):
 * prevent-scrolling and minimum touch time exist once, bound to the persisted
 * flag of whichever type the card selected.
 *
 * The persisted shape is untouched — every control reads and writes the real
 * `ScanningInput` fields, so the scanner reads exactly this tree.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useId, useState } from 'react';
import {
  Hand,
  Keyboard,
  Mouse,
  Pen,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { Options, ScanningInput } from '@gorakudo/yomitan-headless/settings';
import { Input } from '@/components/player/ui/input';
import { Switch } from '@/components/player/ui/switch';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/player/ui/toggle-group';
import { SettingsButton } from '@/components/settings/SettingsButton';
import {
  readOptionPath,
  writeOptionPath,
} from '@/features/yomitan/yomitan-preferences';

/** Dot-path of the array this editor owns. */
const SCAN_INPUTS_PATH = 'scanning.inputs';

/** The pointer type one card is set to. */
export type ScanInputKind = 'mouse' | 'touch' | 'pen';

/** What `Scan on` is set to on a touch or pen card. */
export type ScanInputTrigger = 'press' | 'release';

/** Every option flag a card writes (all of them are booleans). */
type ScanFlagName =
  | 'scanOnTouchTap'
  | 'scanOnTouchMove'
  | 'scanOnTouchPress'
  | 'scanOnTouchRelease'
  | 'scanOnPenMove'
  | 'scanOnPenHover'
  | 'scanOnPenReleaseHover'
  | 'scanOnPenPress'
  | 'scanOnPenRelease'
  | 'preventTouchScrolling'
  | 'preventPenScrolling';

/** One pointer type: its icon and the persisted flags it owns. */
interface ScanKindDescriptor {
  kind: ScanInputKind;
  icon: LucideIcon;
  /**
   * Persisted press trigger of this pointer, or `undefined` for a pointer that
   * has none. A mouse scans by moving with the required inputs held, so it owns
   * no trigger flag at all — pointing the mouse entry at the touch flags would
   * read as if a mouse card could write them.
   */
  pressFlag?: ScanFlagName;
  /** Persisted release trigger of this pointer (touch and pen only). */
  releaseFlag?: ScanFlagName;
}

/** Pointer types in draw order — also the tie-break of a multi-flag card. */
const KIND_DESCRIPTORS: readonly ScanKindDescriptor[] = [
  { kind: 'mouse', icon: Mouse },
  {
    kind: 'touch',
    icon: Hand,
    pressFlag: 'scanOnTouchPress',
    releaseFlag: 'scanOnTouchRelease',
  },
  {
    kind: 'pen',
    icon: Pen,
    pressFlag: 'scanOnPenPress',
    releaseFlag: 'scanOnPenRelease',
  },
];

/** Localized copy of the `inputs` layout (the caller resolves every string). */
export interface ScanningInputManagerCopy {
  /** Add-a-card button label. */
  add: string;
  /** Card count, as `{count} defined`. */
  count: string;
  /** Required-inputs row label. */
  required: string;
  /** Excluded-inputs row label. */
  excluded: string;
  /** Placeholder of an empty required/excluded field. */
  noInputs: string;
  /** Input-types row label. */
  inputTypes: string;
  /** Pointer type choices (keys are the `ScanInputKind` values). */
  mouse: string;
  touch: string;
  pen: string;
  /** Scan-on row label. */
  scanOn: string;
  /** Scan-on choices (touch and pen only). */
  press: string;
  release: string;
  /** Prevent-scrolling switch label (touch and pen only). */
  preventScrolling: string;
  /** Minimum-touch-time row label (touch and pen only). */
  minimumTouchTime: string;
  /** Accessible name of a field's record button. */
  capture: string;
  /** Record button label while it waits for input. */
  listening: string;
  /** Accessible name prefix of a card's delete button. */
  remove: string;
  /** Sentence shown while no card exists. */
  empty: string;
}

export interface ScanningInputManagerProps {
  /** The module's whole options tree (this editor writes through it). */
  options: Options;
  /** Persist the next options tree. */
  onChange: (next: Options) => void;
  /** Block title, resolved by the renderer from the manifest's `labelKey`. */
  title?: string;
  /** Block description, resolved from `descriptionKey`. */
  description?: string;
  /** Already-localized copy for this layout. */
  copy: ScanningInputManagerCopy;
}

/* ---------------------------------------------------------------------------
 * Pure rules (exported: they are what the unit tests exercise)
 * ------------------------------------------------------------------------- */

/** One input's tokens (`"shift mouse0"` → `['shift', 'mouse0']`). */
export function scanInputTokens(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/\s+/).filter((token) => token !== '');
}

/** Add one token to an input list unless it is already there. */
export function withScanInputToken(raw: unknown, token: string): string {
  const tokens = scanInputTokens(raw);
  if (tokens.includes(token)) return tokens.join(' ');
  return [...tokens, token].join(' ');
}

/**
 * The token a recorded keyboard event stands for, or `null` when the key has
 * none.
 *
 * Yomitan's matcher compares an input list against MODIFIERS AND MOUSE BUTTONS
 * only (`normalizeModifier` accepts `shift`/`ctrl`/`alt`/`meta`/`mouse0..5`), so
 * recording a letter would write a token the engine can never match. Such a key
 * is ignored, and the button keeps listening.
 */
export function keyboardInputToken(event: KeyboardEvent): string | null {
  switch (event.key) {
    case 'Shift':
      return 'shift';
    case 'Control':
      return 'ctrl';
    case 'Alt':
      return 'alt';
    case 'Meta':
    case 'OS':
      return 'meta';
    default:
      return null;
  }
}

/** The token a recorded mouse event stands for (buttons 0–5). */
export function mouseInputToken(event: MouseEvent): string | null {
  if (!Number.isInteger(event.button) || event.button < 0 || event.button > 5) {
    return null;
  }
  return `mouse${event.button}`;
}

/** Is this record a scan-input object at all? */
function isScanInput(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce one persisted entry into a COMPLETE `ScanningInput`.
 *
 * Fail-safe per field, because the tree may have been hand-edited, written by an
 * older schema, or replaced wholesale: a missing `options` block must not crash
 * a card, and the two always-on search flags are re-imposed here (see the file
 * header) rather than merely hidden.
 */
export function normalizeScanInput(raw: unknown): ScanningInput {
  const source = isScanInput(raw) ? raw : {};
  const types = isScanInput(source.types) ? source.types : {};
  const options = isScanInput(source.options) ? source.options : {};
  const flag = (name: ScanFlagName): boolean => options[name] === true;
  const minimum = options.minimumTouchTime;
  return {
    include: typeof source.include === 'string' ? source.include : '',
    exclude: typeof source.exclude === 'string' ? source.exclude : '',
    types: {
      mouse: types.mouse === true,
      touch: types.touch === true,
      pen: types.pen === true,
    },
    options: {
      showAdvanced: options.showAdvanced === true,
      /* Always on, and re-imposed on every write: this UI does not offer the
         choice, so a stored `false` must not half-search the window. */
      searchTerms: true,
      searchKanji: true,
      scanOnTouchTap: flag('scanOnTouchTap'),
      scanOnTouchMove: flag('scanOnTouchMove'),
      scanOnTouchPress: flag('scanOnTouchPress'),
      scanOnTouchRelease: flag('scanOnTouchRelease'),
      scanOnPenMove: flag('scanOnPenMove'),
      scanOnPenHover: flag('scanOnPenHover'),
      scanOnPenReleaseHover: flag('scanOnPenReleaseHover'),
      scanOnPenPress: flag('scanOnPenPress'),
      scanOnPenRelease: flag('scanOnPenRelease'),
      preventTouchScrolling: flag('preventTouchScrolling'),
      preventPenScrolling: flag('preventPenScrolling'),
      minimumTouchTime:
        typeof minimum === 'number' && Number.isFinite(minimum)
          ? Math.max(0, Math.round(minimum))
          : 0,
    },
  };
}

/** The persisted input list, every entry coerced (never null). */
export function readScanInputs(options: Options): ScanningInput[] {
  const raw = readOptionPath(options, SCAN_INPUTS_PATH);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isScanInput).map(normalizeScanInput);
}

/** Persist a whole input list. */
export function writeScanInputs(
  options: Options,
  inputs: readonly ScanningInput[],
): Options {
  return writeOptionPath(options, SCAN_INPUTS_PATH, [...inputs]);
}

/** The descriptor of one pointer type. */
export function scanKindDescriptor(kind: ScanInputKind): ScanKindDescriptor {
  const descriptor = KIND_DESCRIPTORS.find(
    (candidate) => candidate.kind === kind,
  );
  /* Every caller passes a kind this list produced, so the fallback is only here
     to keep the return type honest. */
  if (descriptor === undefined) throw new Error(`unknown scan input kind: ${kind}`);
  return descriptor;
}

/**
 * The one pointer type a card shows.
 *
 * Yomitan's shipped defaults include an entry that serves touch AND pen, which a
 * single-select control cannot express: the first flag in draw order wins, and
 * the first write to that card persists exactly that one type. Nothing is lost
 * in between — the other flags stay in the tree until the user picks a type.
 */
export function scanInputKind(input: ScanningInput): ScanInputKind {
  if (input.types.mouse) return 'mouse';
  if (input.types.touch) return 'touch';
  return 'pen';
}

/** Write exactly one pointer type (the card's single-select rule). */
export function withScanInputKind(
  input: ScanningInput,
  kind: ScanInputKind,
): ScanningInput {
  return {
    ...input,
    types: {
      mouse: kind === 'mouse',
      touch: kind === 'touch',
      pen: kind === 'pen',
    },
  };
}

/** Which trigger the card's pointer type is set to. */
export function scanInputTrigger(input: ScanningInput): ScanInputTrigger {
  const { releaseFlag } = scanKindDescriptor(scanInputKind(input));
  return releaseFlag !== undefined && input.options[releaseFlag]
    ? 'release'
    : 'press';
}

/**
 * Write the trigger, and clear the sibling flags it replaces.
 *
 * Authoritative on purpose: Yomitan also scans on touch tap/move and on pen
 * move/hover, and those rows are not in this UI. Leaving one of them on would
 * make the card claim "press" while the engine also fired on a tap.
 */
export function withScanInputTrigger(
  input: ScanningInput,
  trigger: ScanInputTrigger,
): ScanningInput {
  const descriptor = scanKindDescriptor(scanInputKind(input));
  const options = { ...input.options };
  if (descriptor.kind === 'touch') {
    options.scanOnTouchTap = false;
    options.scanOnTouchMove = false;
    options.scanOnTouchPress = trigger === 'press';
    options.scanOnTouchRelease = trigger === 'release';
  } else if (descriptor.kind === 'pen') {
    options.scanOnPenMove = false;
    options.scanOnPenHover = false;
    options.scanOnPenReleaseHover = false;
    options.scanOnPenPress = trigger === 'press';
    options.scanOnPenRelease = trigger === 'release';
  }
  return { ...input, options };
}

/** `Prevent Scan on scrolling` of the card's pointer type (mouse has none). */
export function scanInputPreventScrolling(input: ScanningInput): boolean {
  const descriptor = scanKindDescriptor(scanInputKind(input));
  if (descriptor.kind === 'touch') return input.options.preventTouchScrolling;
  if (descriptor.kind === 'pen') return input.options.preventPenScrolling;
  return false;
}

/** Write `Prevent Scan on scrolling` on the card's pointer type. */
export function withScanInputPreventScrolling(
  input: ScanningInput,
  value: boolean,
): ScanningInput {
  const descriptor = scanKindDescriptor(scanInputKind(input));
  const options = { ...input.options };
  if (descriptor.kind === 'touch') {
    options.preventTouchScrolling = value;
  } else if (descriptor.kind === 'pen') {
    options.preventPenScrolling = value;
  }
  return { ...input, options };
}

/**
 * A card added by `Add New Key`.
 *
 * A mouse card with no required input: the same starting point as Yomitan's own
 * added input. The touch/pen trigger flags start on PRESS so switching the type
 * later lands on a trigger that fires rather than on none.
 */
export function newScanInput(): ScanningInput {
  return {
    include: '',
    exclude: '',
    types: { mouse: true, touch: false, pen: false },
    options: {
      showAdvanced: false,
      searchTerms: true,
      searchKanji: true,
      scanOnTouchTap: false,
      scanOnTouchMove: false,
      scanOnTouchPress: true,
      scanOnTouchRelease: false,
      scanOnPenMove: false,
      scanOnPenHover: false,
      scanOnPenReleaseHover: false,
      scanOnPenPress: true,
      scanOnPenRelease: false,
      preventTouchScrolling: false,
      preventPenScrolling: false,
      minimumTouchTime: 0,
    },
  };
}

/* ---------------------------------------------------------------------------
 * Editor
 * ------------------------------------------------------------------------- */

export function ScanningInputManager({
  options,
  onChange,
  title,
  description,
  copy,
}: ScanningInputManagerProps) {
  const inputs = readScanInputs(options);

  const commit = useCallback(
    (next: readonly ScanningInput[]) => {
      onChange(writeScanInputs(options, next));
    },
    [onChange, options],
  );

  /* The count is part of the heading ("… inputs... (2 defined)"), so it is
     composed here rather than in the copy table. */
  const count = copy.count.replace('{count}', String(inputs.length));
  const heading =
    title === undefined || title === ''
      ? count
      : count === ''
        ? title
        : `${title} (${count})`;

  return (
    <div className="entei-module-list entei-scan-inputs">
      <div className="entei-module-list-header">
        <div className="entei-module-list-header-text">
          {heading !== '' && (
            <span className="entei-module-list-title">{heading}</span>
          )}
          {description !== undefined && description !== '' && (
            <p className="entei-module-list-description">{description}</p>
          )}
        </div>
        <div className="entei-module-list-toolbar">
          <SettingsButton
            icon={Keyboard}
            onClick={() => commit([...inputs, newScanInput()])}
          >
            {copy.add}
          </SettingsButton>
        </div>
      </div>

      {inputs.length === 0 ? (
        <p className="entei-module-list-empty">{copy.empty}</p>
      ) : (
        <ul className="entei-scan-input-cards">
          {inputs.map((input, index) => (
            <ScanInputCard
              key={index}
              index={index}
              input={input}
              copy={copy}
              onPatch={(next) =>
                commit(inputs.map((entry, at) => (at === index ? next : entry)))
              }
              onRemove={() =>
                commit(inputs.filter((_, at) => at !== index))
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ScanInputCardProps {
  index: number;
  input: ScanningInput;
  copy: ScanningInputManagerCopy;
  onPatch: (next: ScanningInput) => void;
  onRemove: () => void;
}

function ScanInputCard({
  index,
  input,
  copy,
  onPatch,
  onRemove,
}: ScanInputCardProps) {
  const kind = scanInputKind(input);
  /* Touch and pen are the two kinds with a trigger, a scroll guard and a
     minimum press time; a mouse card shows the input lists alone. */
  const hasPointerOptions = kind !== 'mouse';
  const preventId = useId();
  const minimumId = useId();

  return (
    <li className="entei-scan-input-card">
      <div className="entei-scan-input-card-head">
        <span className="entei-scan-input-card-index">{index + 1}</span>
        <button
          type="button"
          className="entei-module-list-remove"
          aria-label={`${copy.remove} ${index + 1}`}
          title={copy.remove}
          onClick={onRemove}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>

      <ScanInputTokenRow
        label={copy.required}
        placeholder={copy.noInputs}
        capture={copy.capture}
        listening={copy.listening}
        value={input.include}
        onCommit={(include) => onPatch({ ...input, include })}
      />
      <ScanInputTokenRow
        label={copy.excluded}
        placeholder={copy.noInputs}
        capture={copy.capture}
        listening={copy.listening}
        value={input.exclude}
        onCommit={(exclude) => onPatch({ ...input, exclude })}
      />

      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{copy.inputTypes}</span>
        </div>
        <div className="entei-module-field-control">
          <ToggleGroup
            type="single"
            value={kind}
            aria-label={copy.inputTypes}
            onValueChange={(next) => {
              /* Clicking the pressed choice must not leave the card serving no
                 pointer at all — a card always has exactly one type. */
              if (next === '') return;
              onPatch(withScanInputKind(input, next as ScanInputKind));
            }}
          >
            {KIND_DESCRIPTORS.map(({ kind: value, icon: Icon }) => (
              <ToggleGroupItem
                key={value}
                value={value}
                aria-label={copy[value]}
              >
                <Icon size={14} aria-hidden="true" />
                {copy[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {hasPointerOptions && (
        <>
          <div className="entei-module-field">
            <div className="entei-module-field-text">
              <span className="entei-module-field-label">{copy.scanOn}</span>
            </div>
            <div className="entei-module-field-control">
              <ToggleGroup
                type="single"
                value={scanInputTrigger(input)}
                aria-label={copy.scanOn}
                onValueChange={(next) => {
                  if (next === '') return;
                  onPatch(withScanInputTrigger(input, next as ScanInputTrigger));
                }}
              >
                <ToggleGroupItem value="press">{copy.press}</ToggleGroupItem>
                <ToggleGroupItem value="release">{copy.release}</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          <div className="entei-module-field entei-module-field--switch">
            <div className="entei-module-field-text">
              <label className="entei-module-field-label" htmlFor={preventId}>
                {copy.preventScrolling}
              </label>
            </div>
            <div className="entei-module-field-control">
              <Switch
                id={preventId}
                checked={scanInputPreventScrolling(input)}
                onCheckedChange={(checked) =>
                  onPatch(withScanInputPreventScrolling(input, checked))
                }
              />
            </div>
          </div>

          <div className="entei-module-field">
            <div className="entei-module-field-text">
              <label className="entei-module-field-label" htmlFor={minimumId}>
                {copy.minimumTouchTime}
              </label>
            </div>
            <div className="entei-module-field-control">
              <Input
                id={minimumId}
                type="number"
                min={0}
                step={1}
                className="entei-module-input entei-module-input--number"
                value={input.options.minimumTouchTime}
                onChange={(event) => {
                  /* Empty mid-edit is not a value: keep the last number, like
                     every other number field on the settings page. */
                  const raw = event.target.value;
                  if (raw === '') return;
                  const parsed = Number(raw);
                  if (!Number.isFinite(parsed)) return;
                  onPatch({
                    ...input,
                    options: {
                      ...input.options,
                      minimumTouchTime: Math.max(0, Math.round(parsed)),
                    },
                  });
                }}
              />
            </div>
          </div>
        </>
      )}
    </li>
  );
}

interface ScanInputTokenRowProps {
  label: string;
  placeholder: string;
  capture: string;
  listening: string;
  value: string;
  onCommit: (next: string) => void;
}

/**
 * One required/excluded row: the token list, and the button that records the
 * next key or mouse button into it.
 *
 * The field holds the PERSISTED token string (`shift mouse0`), like Yomitan's
 * own scan-input field: it is the value the engine matches, and typing it by
 * hand stays possible.
 */
function ScanInputTokenRow({
  label,
  placeholder,
  capture,
  listening,
  value,
  onCommit,
}: ScanInputTokenRowProps) {
  const inputId = useId();
  return (
    <div className="entei-module-field">
      <div className="entei-module-field-text">
        <label className="entei-module-field-label" htmlFor={inputId}>
          {label}
        </label>
      </div>
      <div className="entei-module-field-control entei-scan-input-field">
        <Input
          id={inputId}
          className="entei-module-input"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onCommit(event.target.value)}
        />
        <ScanInputRecorder
          name={`${label} ${capture}`}
          listeningLabel={listening}
          onRecord={(token) => onCommit(withScanInputToken(value, token))}
        />
      </div>
    </div>
  );
}

interface ScanInputRecorderProps {
  /** Accessible name of the button (`<row>: record a key or button`). */
  name: string;
  /** Accessible name while it waits for input. */
  listeningLabel: string;
  /** Called with the token of the key or button that was pressed. */
  onRecord: (token: string) => void;
}

/**
 * The record button: it listens for the next modifier key or mouse button and
 * hands its token to the row.
 *
 * Listening is modal for the keyboard (the handler runs in the capture phase and
 * swallows what it records) and cancels on Escape or a second click, so the user
 * is never trapped. Anything the matcher cannot represent is ignored and keeps
 * listening — a stray letter must not write a dead token.
 */
function ScanInputRecorder({
  name,
  listeningLabel,
  onRecord,
}: ScanInputRecorderProps) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    /** Consume the event when it produced a token. */
    const finish = (token: string | null): boolean => {
      if (token === null) return false;
      setListening(false);
      onRecord(token);
      return true;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setListening(false);
        return;
      }
      if (finish(keyboardInputToken(event))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (finish(mouseInputToken(event))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [listening, onRecord]);

  return (
    <button
      type="button"
      className="entei-module-list-remove entei-scan-input-record"
      aria-label={listening ? listeningLabel : name}
      /* A hover equivalent of the accessible name: the mark alone does not say
         that it records, and a settings page is where users go to find out. */
      title={listening ? listeningLabel : name}
      aria-pressed={listening}
      onClick={() => setListening((on) => !on)}
    >
      <Keyboard size={16} aria-hidden="true" />
    </button>
  );
}