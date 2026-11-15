'use client';

/**
 * ModuleSelectPairRow — one settings row holding SEVERAL mini-labelled selects
 * side by side.
 * ---------------------------------------------------------------------------
 * Upstream Yomitan groups two related knobs under a single row: "Theme" is a
 * `Body` select and a `Shadow` select in one line, "Action bar appearance" a
 * `Visibility` and a `Location` one. This is that row.
 *
 * Like every platform layout it is generic: it knows no module and no field. The
 * manifest declares the row's text and each control (its mini label, the field it
 * edits, its own choices); the renderer resolves the write through the module's
 * options store. A control is a real option path, so a value written here is the
 * same value the tree's own single-field row would write.
 * ---------------------------------------------------------------------------
 */

import { useId } from 'react';
import type { EnteiModuleSelectBinding } from '@/features/modules/module-registry';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/player/ui/select';

export interface ModuleSelectPairRowProps {
  /** Row label — the text block on the left. */
  label: string;
  /** Optional sentence under the label. */
  description?: string;
  /** The controls, in draw order (each with its own choices). */
  selects: readonly EnteiModuleSelectBinding[];
  /** Current options tree, to read each control's value. */
  read: (path: string) => unknown;
  /** Write one control's next value. */
  onChange: (path: string, value: unknown) => void;
}

export function ModuleSelectPairRow({
  label,
  description,
  selects,
  read,
  onChange,
}: ModuleSelectPairRowProps) {
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

      <div className="entei-module-field-control entei-module-selects">
        {selects.map((item) => {
          const itemId = `${groupId}-${item.field}`;
          const current = read(item.field);
          return (
            <div className="entei-module-select-pair-item" key={item.field}>
              <label
                className="entei-module-select-pair-label"
                htmlFor={itemId}
              >
                {item.label}
              </label>
              <Select
                value={
                  current === undefined || current === null
                    ? ''
                    : String(current)
                }
                onValueChange={(next) => onChange(item.field, next)}
              >
                <SelectTrigger
                  id={itemId}
                  size="sm"
                  className="entei-module-select entei-module-select-pair-trigger"
                  aria-describedby={
                    description !== undefined ? hintId : undefined
                  }
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {item.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
