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
 *     "source": "yomitan-scan-inputs", "copy": "scanningInputs",
 *     "label": "Configure advanced scanning inputs...", … }
 *
 * Every card presents the unified set of standard field rows and choice buttongroups:
 * - Required inputs: (token field + keyboard record button)
 * - Excluded inputs: (token field + keyboard record button)
 * - Input types: ([ Mouse | Touch | Pen ])
 * - Search for: ([ Term | Kanji ])
 * - Scan on: ([ Tap | press | release | move ])
 * - Prevent Scan on scrolling: (Switch toggle)
 * - Minimum Touch Time (in ms): (number input)
 *
 * The first input definition (index === 0) is permanent and cannot be deleted;
 * additional input definitions (index > 0) carry a full-width Remove button at
 * the bottom of the card.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useId, useState } from 'react';
import {
  Keyboard,
  Pen,
  Pointer,
  SquareDashedMousePointer,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { Options, ScanningInput } from '@gorakudo/yomitan-headless/settings';
import { Input } from '@/components/player/ui/input';
import { Switch } from '@/components/player/ui/switch';
import { SettingsButton } from '@/components/settings/SettingsButton';
import { SettingsChoiceGroup } from '@/components/settings/SettingsChoiceGroup';
import {
  readOptionPath,
  writeOptionPath,
} from '@/modules/yomitan/yomitan-preferences';

/** Dot-path of the array this editor owns. */
const SCAN_INPUTS_PATH = 'scanning.inputs';

/** The pointer type one card is set to. */
export type ScanInputKind = 'mouse' | 'touch' | 'pen';

/** What `Search for` is set to on a card. */
export type ScanInputSearchTarget = 'term' | 'kanji';

/** What `Scan on` is set to on a card. */
export type ScanInputTrigger = 'tap' | 'press' | 'release' | 'move';

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
  /** Persisted tap/hover trigger flag. */
  tapFlag: ScanFlagName;
  /** Persisted press trigger flag. */
  pressFlag: ScanFlagName;
  /** Persisted release trigger flag. */
  releaseFlag: ScanFlagName;
  /** Persisted move trigger flag. */
  moveFlag: ScanFlagName;
}

/** Pointer types in draw order. */
const KIND_DESCRIPTORS: readonly ScanKindDescriptor[] = [
  {
    kind: 'mouse',
    icon: SquareDashedMousePointer,
    tapFlag: 'scanOnTouchTap',
    pressFlag: 'scanOnTouchPress',
    releaseFlag: 'scanOnTouchRelease',
    moveFlag: 'scanOnTouchMove',
  },
  {
    kind: 'touch',
    icon: Pointer,
    tapFlag: 'scanOnTouchTap',
    pressFlag: 'scanOnTouchPress',
    releaseFlag: 'scanOnTouchRelease',
    moveFlag: 'scanOnTouchMove',
  },
  {
    kind: 'pen',
    icon: Pen,
    tapFlag: 'scanOnPenHover',
    pressFlag: 'scanOnPenPress',
    releaseFlag: 'scanOnPenRelease',
    moveFlag: 'scanOnPenMove',
  },
];

/** English copy of the `inputs` layout (`components/settings/module-copy`). */
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
  /** Search-for row label. */
  searchFor: string;
  /** Search-for choices. */
  term: string;
  kanji: string;
  /** Scan-on row label. */
  scanOn: string;
  /** Scan-on choices (Tap | press | release | move). */
  tap: string;
  press: string;
  release: string;
  move: string;
  /** Prevent-scrolling switch label. */
  preventScrolling: string;
  /** Minimum-touch-time row label. */
  minimumTouchTime: string;
  /** Accessible name of a field's record button. */
  capture: string;
  /** Record button label while it waits for input. */
  listening: string;
  /** Full-width remove button label on the card footer. */
  remove: string;
  /** Sentence shown while no card exists. */
  empty: string;
}

export interface ScanningInputManagerProps {
  /** The module's whole options tree (this editor writes through it). */
  options: Options;
  /** Persist the next options tree. */
  onChange: (next: Options) => void;
  /** Block title: the row's own literal `label`. */
  title?: string;
  /** Block description: the row's own literal `description`. */
  description?: string;
  /** English copy of the inputs layout (`module-copy`). */
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
 * Extract active modifiers from a KeyboardEvent matching Yomitan's getActiveModifiers.
 */
export function activeKeyboardModifiers(event: KeyboardEvent): string[] {
  const modifiers: string[] = [];
  if (event.ctrlKey || event.key === 'Control') modifiers.push('ctrl');
  if (event.altKey || event.key === 'Alt') modifiers.push('alt');
  if (event.shiftKey || event.key === 'Shift') modifiers.push('shift');
  if (event.metaKey || event.key === 'Meta' || event.key === 'OS') modifiers.push('meta');
  return Array.from(new Set(modifiers));
}

/**
 * The token or tokens a recorded keyboard event stands for.
 * Returns null if no recognized modifier or action key was pressed.
 */
export function keyboardInputToken(event: KeyboardEvent): string | null {
  if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Delete') {
    return '';
  }
  const mods = activeKeyboardModifiers(event);
  if (mods.length > 0) {
    return mods.join(' ');
  }
  return null;
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
      searchTerms: options.searchTerms !== false,
      searchKanji: options.searchKanji === true,
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
  if (descriptor === undefined) throw new Error(`unknown scan input kind: ${kind}`);
  return descriptor;
}

/**
 * The one pointer type a card shows.
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

/** Which targets `Search for` is set to (supports multiple selection: term, kanji). */
export function scanInputSearchTargets(
  input: ScanningInput,
): string[] {
  const targets: string[] = [];
  if (input.options.searchTerms) targets.push('term');
  if (input.options.searchKanji) targets.push('kanji');
  return targets;
}

/** Write the `Search for` multiple choices (`term` and/or `kanji`). */
export function withScanInputSearchTargets(
  input: ScanningInput,
  targets: readonly string[],
): ScanningInput {
  return {
    ...input,
    options: {
      ...input.options,
      searchTerms: targets.includes('term'),
      searchKanji: targets.includes('kanji'),
    },
  };
}

/** Legacy single-target reader kept for backward compatibility. */
export function scanInputSearchTarget(
  input: ScanningInput,
): ScanInputSearchTarget {
  return input.options.searchKanji && !input.options.searchTerms
    ? 'kanji'
    : 'term';
}

/** Legacy single-target writer kept for backward compatibility. */
export function withScanInputSearchTarget(
  input: ScanningInput,
  target: ScanInputSearchTarget,
): ScanningInput {
  return withScanInputSearchTargets(input, [target]);
}

/** Which triggers the card's pointer type is set to (supports multiple selection). */
export function scanInputTriggers(input: ScanningInput): string[] {
  const kind = scanInputKind(input);
  const triggers: string[] = [];
  if (kind === 'mouse') {
    if (input.options.scanOnTouchTap) triggers.push('tap');
    if (input.options.scanOnTouchPress) triggers.push('press');
    if (input.options.scanOnTouchRelease) triggers.push('release');
    if (input.options.scanOnTouchMove) triggers.push('move');
    // If none are set for mouse, default to move
    if (triggers.length === 0) triggers.push('move');
    return triggers;
  }
  const descriptor = scanKindDescriptor(kind);
  if (input.options[descriptor.tapFlag]) triggers.push('tap');
  if (input.options[descriptor.pressFlag]) triggers.push('press');
  if (input.options[descriptor.releaseFlag]) triggers.push('release');
  if (input.options[descriptor.moveFlag]) triggers.push('move');
  return triggers;
}

/** Write multiple triggers for the card's pointer type. */
export function withScanInputTriggers(
  input: ScanningInput,
  triggers: readonly string[],
): ScanningInput {
  const kind = scanInputKind(input);
  if (kind === 'mouse') {
    return {
      ...input,
      options: {
        ...input.options,
        scanOnTouchTap: triggers.includes('tap'),
        scanOnTouchPress: triggers.includes('press'),
        scanOnTouchRelease: triggers.includes('release'),
        scanOnTouchMove: triggers.includes('move'),
        scanOnPenPress: false,
        scanOnPenRelease: false,
        scanOnPenHover: false,
        scanOnPenMove: false,
        scanOnPenReleaseHover: false,
      },
    };
  }
  const descriptor = scanKindDescriptor(kind);
  const options = { ...input.options };
  options[descriptor.tapFlag] = triggers.includes('tap');
  options[descriptor.pressFlag] = triggers.includes('press');
  options[descriptor.releaseFlag] = triggers.includes('release');
  options[descriptor.moveFlag] = triggers.includes('move');
  options.scanOnPenReleaseHover = false;
  return { ...input, options };
}

/** Which trigger the card's pointer type is set to. */
export function scanInputTrigger(input: ScanningInput): ScanInputTrigger {
  const triggers = scanInputTriggers(input);
  if (triggers.includes('move')) return 'move';
  if (triggers.includes('release')) return 'release';
  if (triggers.includes('press')) return 'press';
  return 'tap';
}

/**
 * Write the trigger, and clear the sibling flags it replaces.
 */
export function withScanInputTrigger(
  input: ScanningInput,
  trigger: ScanInputTrigger,
): ScanningInput {
  return withScanInputTriggers(input, [trigger]);
}

/** `Prevent Scan on scrolling` of the card. */
export function scanInputPreventScrolling(input: ScanningInput): boolean {
  return (
    input.options.preventTouchScrolling || input.options.preventPenScrolling
  );
}

/** Write `Prevent Scan on scrolling` on the card. */
export function withScanInputPreventScrolling(
  input: ScanningInput,
  value: boolean,
): ScanningInput {
  return {
    ...input,
    options: {
      ...input.options,
      preventTouchScrolling: value,
      preventPenScrolling: value,
    },
  };
}

/**
 * A card added by `Add New Key`.
 */
export function newScanInput(): ScanningInput {
  return {
    include: '',
    exclude: '',
    types: { mouse: true, touch: false, pen: false },
    options: {
      showAdvanced: false,
      searchTerms: true,
      searchKanji: false,
      scanOnTouchTap: true,
      scanOnTouchMove: false,
      scanOnTouchPress: false,
      scanOnTouchRelease: false,
      scanOnPenMove: false,
      scanOnPenHover: false,
      scanOnPenReleaseHover: false,
      scanOnPenPress: true,
      scanOnPenRelease: false,
      preventTouchScrolling: true,
      preventPenScrolling: true,
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

  const count = copy.count.replace('{count}', String(inputs.length));
  const heading =
    title === undefined || title === ''
      ? count
      : count === ''
        ? title
        : `${title} (${count})`;

  return (
    <div className="entei-module-list entei-module-inputs">
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
        <ul className="entei-module-input-cards">
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
  const preventId = useId();
  const minimumId = useId();

  return (
    <li className="entei-module-input-card">
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
          <SettingsChoiceGroup
            value={kind}
            ariaLabel={copy.inputTypes}
            onValueChange={(next) => {
              if (next === '') return;
              onPatch(withScanInputKind(input, next as ScanInputKind));
            }}
            items={KIND_DESCRIPTORS.map(({ kind: value, icon }) => ({
              value,
              icon,
              label: copy[value],
            }))}
          />
        </div>
      </div>

      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{copy.searchFor}</span>
        </div>
        <div className="entei-module-field-control">
          <SettingsChoiceGroup
            type="multiple"
            value={scanInputSearchTargets(input)}
            ariaLabel={copy.searchFor}
            onValueChange={(next) => {
              onPatch(withScanInputSearchTargets(input, next));
            }}
            items={[
              { value: 'term', label: copy.term },
              { value: 'kanji', label: copy.kanji },
            ]}
          />
        </div>
      </div>

      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{copy.scanOn}</span>
        </div>
        <div className="entei-module-field-control">
          <SettingsChoiceGroup
            type="multiple"
            value={scanInputTriggers(input)}
            ariaLabel={copy.scanOn}
            onValueChange={(next) => {
              onPatch(withScanInputTriggers(input, next));
            }}
            items={[
              { value: 'tap', label: copy.tap },
              { value: 'press', label: copy.press },
              { value: 'release', label: copy.release },
              { value: 'move', label: copy.move },
            ]}
          />
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

      {index > 0 && (
        <div className="entei-module-input-card-footer">
          <SettingsButton icon={Trash2} fullWidth onClick={onRemove}>
            {copy.remove}
          </SettingsButton>
        </div>
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
      <div className="entei-module-field-control entei-module-input-card-field">
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
          onRecord={(token) => onCommit(token)}
        />
      </div>
    </div>
  );
}

interface ScanInputRecorderProps {
  name: string;
  listeningLabel: string;
  onRecord: (token: string) => void;
}

function ScanInputRecorder({
  name,
  listeningLabel,
  onRecord,
}: ScanInputRecorderProps) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
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
      className="entei-module-list-remove entei-module-input-card-record"
      aria-label={listening ? listeningLabel : name}
      title={listening ? listeningLabel : name}
      aria-pressed={listening}
      onClick={() => setListening((on) => !on)}
    >
      <Keyboard size={16} aria-hidden="true" />
    </button>
  );
}