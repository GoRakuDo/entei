'use client';

/**
 * ModuleCheckboxGroupRow — one settings row holding SEVERAL labelled choices
 * side by side.
 * ---------------------------------------------------------------------------
 * Upstream Yomitan groups several independent booleans under one row:
 * "Pitch accent display styles" is a `Downstep notation`, a `Downstep position`
 * and a `Graph` toggle on a single line. This is that row, drawn as the shared
 * multi-select buttongroup (`SettingsChoiceGroup` `type="multiple"`) so it looks
 * and behaves like every other choice control in settings.
 *
 * Like every platform layout it is generic: it knows no module and no field. The
 * manifest declares the row's text and each choice (its label and the boolean
 * field it toggles); the renderer resolves the write through the module's options
 * store. Each choice maps to a real boolean option path, so a value written here
 * is the same value a single-field switch row would write.
 * ---------------------------------------------------------------------------
 */

import { useId } from 'react';
import type { EnteiModuleCheckboxBinding } from '@/features/modules/module-registry';
import {
  SettingsChoiceGroup,
  type SettingsChoiceItem,
} from '@/components/settings/SettingsChoiceGroup';

export interface ModuleCheckboxGroupRowProps {
  /** Row label — the text block on the left. */
  label: string;
  /** Optional sentence under the label. */
  description?: string;
  /** The choices, in draw order (each with its own boolean field). */
  checkboxes: readonly EnteiModuleCheckboxBinding[];
  /** Current options tree, to read each choice's value. */
  read: (path: string) => unknown;
  /** Write one choice's next value. */
  onChange: (path: string, value: unknown) => void;
}

export function ModuleCheckboxGroupRow({
  label,
  description,
  checkboxes,
  read,
  onChange,
}: ModuleCheckboxGroupRowProps) {
  const groupId = useId();
  const hintId = `${groupId}-hint`;

  const items: SettingsChoiceItem[] = checkboxes.map((item) => ({
    value: item.field,
    label: item.label,
  }));

  /* A choice is "on" exactly when its boolean field reads true. The group's value
     is the set of on fields; toggling one writes every field back so the options
     store and the buttongroup can never disagree. */
  const value = checkboxes
    .filter((item) => read(item.field) === true)
    .map((item) => item.field);

  return (
    <div className="entei-module-field">
      <div className="entei-module-field-text">
        <span className="entei-module-field-label">{label}</span>
        {description !== undefined && (
          <p className="entei-module-field-description" id={hintId}>
            {description}
          </p>
        )}
      </div>

      <div className="entei-module-field-control">
        <SettingsChoiceGroup
          type="multiple"
          items={items}
          value={value}
          ariaLabel={label}
          onValueChange={(next) => {
            const selected = new Set(next);
            for (const item of checkboxes) {
              onChange(item.field, selected.has(item.field));
            }
          }}
        />
      </div>
    </div>
  );
}