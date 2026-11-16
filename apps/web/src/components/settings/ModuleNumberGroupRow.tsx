'use client';

/**
 * ModuleNumberGroupRow — one settings row holding SEVERAL mini-labelled number
 * inputs side by side.
 * ---------------------------------------------------------------------------
 * Upstream Yomitan groups two related numbers under a single row: Popup Position
 * & Size's `Size` is a Width and a Height input on one line, and its two text
 * offsets are an `x` and a `y` one. This is that row.
 *
 * Like every platform layout it is generic: it knows no module and no field. The
 * manifest declares the row's text and each input (its mini label and the numeric
 * field it edits); each control takes its min/max/step from that field's own
 * descriptor, so a value written here is the same number the single-field numeric
 * row would write.
 * ---------------------------------------------------------------------------
 */

import { useId } from 'react';
import type { SettingFieldDescriptor } from '@gorakudo/yomitan-headless/settings';
import type { EnteiModuleNumberBinding } from '@/features/modules/module-registry';
import { Input } from '@/components/player/ui/input';

export interface ModuleNumberGroupRowProps {
  /** Row label — the text block on the left. */
  label: string;
  /** Optional sentence under the label. */
  description?: string;
  /** The inputs, in draw order (each with its own numeric field). */
  numbers: readonly EnteiModuleNumberBinding[];
  /** The module's descriptor tree: each input takes its min/max/step from it. */
  fields: ReadonlyMap<string, SettingFieldDescriptor>;
  /** Current options tree, to read each input's value. */
  read: (path: string) => unknown;
  /** Write one input's next value. */
  onChange: (path: string, value: unknown) => void;
}

export function ModuleNumberGroupRow({
  label,
  description,
  numbers,
  fields,
  read,
  onChange,
}: ModuleNumberGroupRowProps) {
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

      <div className="entei-module-field-control entei-module-numbers">
        {numbers.map((item) => {
          const itemId = `${groupId}-${item.field}`;
          const current = read(item.field);
          /* An unknown path still edits its option (the row's own labels and the
             store are enough); it simply has no bounds to declare. */
          const descriptor = fields.get(item.field);
          return (
            <div className="entei-module-number-pair-item" key={item.field}>
              <label
                className="entei-module-number-pair-label"
                htmlFor={itemId}
              >
                {item.label}
              </label>
              <Input
                id={itemId}
                type="number"
                className="entei-module-input entei-module-input--number entei-module-number-pair-input"
                value={typeof current === 'number' ? current : ''}
                min={descriptor?.min}
                max={descriptor?.max}
                step={
                  descriptor?.step ??
                  (descriptor?.type === 'integer' ? 1 : undefined)
                }
                aria-describedby={
                  description !== undefined ? hintId : undefined
                }
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === '') return; // keep the last valid number mid-edit
                  const parsed = Number(raw);
                  if (!Number.isFinite(parsed)) return;
                  onChange(
                    item.field,
                    descriptor?.type === 'integer'
                      ? Math.round(parsed)
                      : parsed,
                  );
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
