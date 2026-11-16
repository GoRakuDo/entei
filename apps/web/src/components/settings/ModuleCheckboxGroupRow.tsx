'use client';

/**
 * ModuleCheckboxGroupRow — one settings row holding SEVERAL mini-labelled
 * checkboxes side by side.
 * ---------------------------------------------------------------------------
 * Upstream Yomitan groups several independent booleans under one row:
 * "Pitch accent display styles" is a `Downstep notation`, a `Downstep position`
 * and a `Graph` checkbox on a single line. This is that row.
 *
 * Like every platform layout it is generic: it knows no module and no field. The
 * manifest declares the row's text and each checkbox (its mini label and the
 * boolean field it toggles); the renderer resolves the write through the module's
 * options store. A checkbox is a real option path, so a value written here is the
 * same value a single-field switch row would write.
 * ---------------------------------------------------------------------------
 */

import { useId } from 'react';
import type { EnteiModuleCheckboxBinding } from '@/features/modules/module-registry';
import { Checkbox } from '@/components/player/ui/checkbox';

export interface ModuleCheckboxGroupRowProps {
  /** Row label — the text block on the left. */
  label: string;
  /** Optional sentence under the label. */
  description?: string;
  /** The checkboxes, in draw order (each with its own boolean field). */
  checkboxes: readonly EnteiModuleCheckboxBinding[];
  /** Current options tree, to read each checkbox's value. */
  read: (path: string) => unknown;
  /** Write one checkbox's next value. */
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

      <div className="entei-module-field-control entei-module-checkboxes">
        {checkboxes.map((item) => {
          const itemId = `${groupId}-${item.field}`;
          const checked = read(item.field) === true;
          return (
            <label
              className="entei-module-checkbox-item"
              htmlFor={itemId}
              key={item.field}
            >
              <Checkbox
                id={itemId}
                checked={checked}
                onCheckedChange={(next) => onChange(item.field, next === true)}
                aria-describedby={
                  description !== undefined ? hintId : undefined
                }
              />
              <span className="entei-module-checkbox-label">{item.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}