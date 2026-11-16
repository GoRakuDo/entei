'use client';

/**
 * ModuleRelatedDictionariesSelect — Yomitan's merge grouping dictionary picker.
 * ---------------------------------------------------------------------------
 * ONE control for the two settings Yomitan splits apart: which dictionary leads a
 * merged result (`general.mainDictionary`) and which other dictionaries are asked
 * for the same term (`dictionaries[].allowSecondarySearches`). The ordered
 * selection lives in `modules/yomitan/related-dictionaries`; this file is only the
 * surface — a Combobox in the row's trailing control column, with the selection as
 * a chip box under the row.
 *
 * Chips, because the ORDER is the meaning: the first chip is the primary
 * dictionary (crowned, gold) and every later one is a secondary search. Each chip
 * removes itself, which is how a selection is edited; the dropdown adds. Both go
 * through the same write, so the row, the popup preview and every lookup read the
 * same tree.
 *
 * IT ONLY EXISTS IN MERGE MODE. Any other result grouping ignores both settings,
 * so the row draws nothing unless `general.resultOutputMode` is `merge` — a host
 * editor decides that from the options tree it is handed, which keeps the manifest
 * free of conditional-row syntax.
 *
 * Styling travels with the settings surface (`styles/settings.css`): the picker is
 * the standard trailing control so the column keeps one left edge, and the chips
 * get the card's full width under it, where a wrapped list has room to breathe.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useId, useMemo, useState } from 'react';
import type { Options } from '@gorakudo/yomitan-headless/settings';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/player/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from '@/components/player/ui/command';
import { listInstalledDictionariesCached } from '@/modules/yomitan/dictionary-store';
import {
  isMergeResultOutput,
  readRelatedDictionaries,
  relatedDictionaryChoices,
  writeRelatedDictionaries,
} from '@/modules/yomitan/related-dictionaries';

/**
 * English chrome this editor owns itself.
 *
 * Same reasoning as `module-copy` and `ModuleSecretField`: the strings a
 * host-owned control draws are not manifest data, and Entei's locales do not
 * translate them — they sit inside the upstream tool's own English UI.
 */
const RELATED_COPY = {
  /** Trigger text while nothing is selected (the row reads like an empty select). */
  empty: 'Select dictionaries',
  /** Chip suffix of the leading dictionary. */
  primary: 'Primary',
  /** Chip suffix of every other selected dictionary. */
  secondary: 'Secondary',
  /** Accessible name of one chip's remove button. */
  remove: (name: string) => `Remove ${name}`,
  /** Dropdown state with no dictionary installed at all. */
  none: 'No dictionaries installed',
} as const;

export interface ModuleRelatedDictionariesSelectProps {
  /** Row label (the manifest's literal English). */
  label?: string;
  /** Sentence under the label. */
  description?: string;
  /** The module's whole options tree (read for the selection, written on edit). */
  options: Options;
  /** Persist the next options tree. */
  onChange: (next: Options) => void;
}

export function ModuleRelatedDictionariesSelect({
  label,
  description,
  options,
  onChange,
}: ModuleRelatedDictionariesSelectProps) {
  const rowId = useId();
  const labelId = `${rowId}-label`;
  const descriptionId = `${rowId}-description`;
  const listboxId = `${rowId}-listbox`;
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<readonly string[] | null>(null);

  const merge = isMergeResultOutput(options);

  /* The engine answers what EXISTS; the options tree answers what is selected.
     Read through the store's short cache (the Dictionaries section invalidates it
     on every import / toggle / delete), and re-read when the tree moves so a
     dictionary installed elsewhere on this page shows up without a reload. */
  useEffect(() => {
    if (!merge) return;
    let current = true;
    void listInstalledDictionariesCached()
      .then((list) => {
        if (current) setInstalled(list.map((entry) => entry.name));
      })
      .catch(() => {
        // No engine to answer (a browser pass): the options tree alone decides.
        if (current) setInstalled([]);
      });
    return () => {
      current = false;
    };
  }, [merge, options]);

  const selected = useMemo(() => readRelatedDictionaries(options), [options]);
  const choices = useMemo(
    () => relatedDictionaryChoices(installed ?? [], options),
    [installed, options],
  );

  function select(next: readonly string[]) {
    const written = writeRelatedDictionaries(options, next);
    // Same reference = the tree is not addressable; nothing to persist.
    if (written !== options) onChange(written);
  }

  function toggle(name: string) {
    select(
      selected.includes(name)
        ? selected.filter((entry) => entry !== name)
        : [...selected, name],
    );
  }

  /* Any other grouping mode ignores both settings, so the row would be a control
     that changes nothing. */
  if (!merge) return null;

  return (
    <div className="entei-module-field entei-module-tag-select">
      <div className="entei-module-field-text">
        <span className="entei-module-field-label" id={labelId}>
          {label}
        </span>
        {description !== undefined && (
          <p
            className="entei-module-field-description"
            id={descriptionId}
          >
            {description}
          </p>
        )}
      </div>

      {/* The picker: the same trailing combobox as every select above and below it,
          so the control column keeps one left edge down the page. */}
      <div className="entei-module-field-control">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              id={rowId}
              className="entei-module-select entei-module-tag-select-trigger"
              /* The styling hook the shadcn Select triggers carry: it is what gives
                 this row the same secondary text level and the same gold hover
                 (chevron included) as its neighbours. */
              data-slot="select-trigger"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={open}
              /* Only while it is open: the list does not exist otherwise, and a
                 dangling reference is worse than none. */
              aria-controls={open ? listboxId : undefined}
              /* The row label names the control, so a screen reader ties the picker
                 to the setting it edits rather than to its own placeholder. */
              aria-labelledby={label === undefined ? undefined : labelId}
              aria-describedby={
                description !== undefined ? descriptionId : undefined
              }
            >
              <span className="entei-module-tag-select-trigger-label">
                {RELATED_COPY.empty}
              </span>
              <ChevronsUpDown
                className="entei-module-tag-select-chevron"
                size={16}
                aria-hidden="true"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={4}
            className="entei-combobox-content entei-module-tag-select-content"
          >
            <Command>
              <CommandList
                id={listboxId}
                role="listbox"
                aria-multiselectable="true"
                aria-labelledby={labelId}
              >
                {choices.length === 0 ? (
                  <CommandEmpty>{RELATED_COPY.none}</CommandEmpty>
                ) : (
                  choices.map((name) => (
                    <CommandItem
                      key={name}
                      value={name}
                      role="option"
                      aria-selected={selected.includes(name)}
                      onSelect={() => toggle(name)}
                    >
                      {/* The check is the state; `aria-selected` carries it for a
                          screen reader and styles the row (global.css). */}
                      {selected.includes(name) ? (
                        <Check size={14} aria-hidden="true" />
                      ) : (
                        <span
                          className="entei-module-tag-select-item-icon"
                          aria-hidden="true"
                        />
                      )}
                      <span>{name}</span>
                    </CommandItem>
                  ))
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {/* The selection, card-wide under the row: a wrapped chip list needs the whole
          width, which the trailing control column cannot give it. A list, because
          the order IS the setting — first chip primary (index 1, gold), every later
          one a secondary search — and nothing at all is drawn while it is empty. */}
      {selected.length > 0 && (
        <div className="entei-module-tag-box">
          <ul className="entei-module-tags">
            {selected.map((name, index) => (
              <li
                key={name}
                className="entei-module-tag"
                data-role={index === 0 ? 'primary' : 'secondary'}
              >
                <span className="entei-module-tag-index">{index + 1}.</span>
                <span className="entei-module-tag-name">{name}</span>
                <button
                  type="button"
                  className="entei-module-tag-remove"
                  aria-label={RELATED_COPY.remove(name)}
                  onClick={() => toggle(name)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}