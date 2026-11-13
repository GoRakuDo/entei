'use client';

/**
 * ModuleFieldRow — the platform's STANDARD settings row.
 * ---------------------------------------------------------------------------
 * One label + optional description on the left, one control on the right
 * (stacked on mobile). The control is chosen from the field's descriptor type,
 * so a section rendered from a `settingsSchema` and a section rendered from a
 * manifest's explicit row list look and behave identically — there is exactly
 * one field row in the app.
 *
 * The caller resolves everything module-specific: the label/description copy
 * (descriptor text, or a manifest `labelKey` override), the options of a select
 * row (descriptor options, or a host-owned `optionsSource`), and what a write
 * means. This component owns no strings and knows no field by name.
 * ---------------------------------------------------------------------------
 */

import { useId } from 'react';
import type {
  SelectOption,
  SettingFieldDescriptor,
} from '@gorakudo/yomitan-headless/settings';
import { Input } from '@/components/player/ui/input';
import { Switch } from '@/components/player/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/player/ui/select';

/** Sentinel `SelectItem` value standing for "no dictionary selected". */
const NONE_VALUE = '__entei-module-none__';

/** Renderable (editable) descriptor types. */
export function isEditableField(field: SettingFieldDescriptor): boolean {
  return (
    field.type === 'boolean' ||
    field.type === 'number' ||
    field.type === 'integer' ||
    field.type === 'select' ||
    field.type === 'string' ||
    field.type === 'text' ||
    field.type === 'password'
  );
}

export interface ModuleFieldRowProps {
  /** Descriptor deciding the control (type, min/max/step, placeholder). */
  field: SettingFieldDescriptor;
  /** Row label — descriptor text or a manifest override. */
  label: string;
  /** Optional sentence under the label. */
  description?: string;
  /** Current value of `field.key` (may be `undefined` when unset). */
  value: unknown;
  /**
   * Host-resolved options for a `select` row. When absent the descriptor's own
   * `options` are drawn.
   */
  options?: readonly SelectOption[];
  /**
   * Draw a leading "none" item on a select row and clear the value when it is
   * picked (the tree's own empty value: `null` for a nullable field, else `''`).
   */
  noneLabel?: string;
  /** Write the next value of `field.key`. */
  onChange: (value: unknown) => void;
  /** Copy for a type this layout cannot edit (`array`, `section-header`). */
  notEditable: string;
}

export function ModuleFieldRow({
  field,
  label,
  description,
  value,
  options,
  noneLabel,
  onChange,
  notEditable,
}: ModuleFieldRowProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const describedBy = description !== undefined ? hintId : undefined;

  /* Structural / not generically editable (array, section-header). */
  if (!isEditableField(field)) {
    return (
      <div className="entei-module-field entei-module-field--readonly">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{label}</span>
          {description !== undefined && (
            <p className="entei-module-field-description">{description}</p>
          )}
        </div>
        <span className="entei-module-field-note">{notEditable}</span>
      </div>
    );
  }

  const hint =
    description !== undefined ? (
      <p className="entei-module-field-description" id={hintId}>
        {description}
      </p>
    ) : null;

  const choices = options ?? field.options ?? [];
  const current = value ?? '';
  const selectValue =
    noneLabel !== undefined && current === '' ? NONE_VALUE : String(current);
  /* A host-supplied option list makes the row a select even when the descriptor
     calls the field a plain string (Yomitan's dictionary-name settings are
     stored as strings but only ever chosen from what is installed).
     A boolean row is never a select: the switch is its only control, so a host
     that hands every row of a section the same option list cannot conjure a
     stray empty combobox beside the toggle. */
  const asSelect =
    field.type !== 'boolean' &&
    (field.type === 'select' || options !== undefined);

  return (
    <div
      className={
        field.type === 'boolean'
          ? 'entei-module-field entei-module-field--switch'
          : 'entei-module-field'
      }
    >
      <div className="entei-module-field-text">
        <label className="entei-module-field-label" htmlFor={inputId}>
          {label}
        </label>
        {hint}
      </div>

      <div className="entei-module-field-control">
        {field.type === 'boolean' && (
          <Switch
            id={inputId}
            checked={value === true}
            onCheckedChange={(checked) => onChange(checked)}
            aria-describedby={describedBy}
          />
        )}

        {!asSelect &&
          (field.type === 'string' ||
            field.type === 'text' ||
            field.type === 'password') &&
          (field.type === 'text' ? (
            <textarea
              id={inputId}
              className="entei-module-textarea"
              value={typeof value === 'string' ? value : ''}
              placeholder={field.placeholder}
              rows={4}
              spellCheck={false}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <Input
              id={inputId}
              type={field.type === 'password' ? 'password' : 'text'}
              className="entei-module-input"
              value={typeof value === 'string' ? value : ''}
              placeholder={field.placeholder}
              autoComplete="off"
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.value)}
            />
          ))}

        {(field.type === 'number' || field.type === 'integer') && (
          <Input
            id={inputId}
            type="number"
            className="entei-module-input entei-module-input--number"
            value={typeof value === 'number' ? value : ''}
            min={field.min}
            max={field.max}
            step={field.step ?? (field.type === 'integer' ? 1 : undefined)}
            aria-describedby={describedBy}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') return; // keep the last valid number mid-edit
              const parsed = Number(raw);
              if (!Number.isFinite(parsed)) return;
              onChange(field.type === 'integer' ? Math.round(parsed) : parsed);
            }}
          />
        )}

        {asSelect && (
          <Select
            value={selectValue}
            onValueChange={(next) => {
              if (noneLabel !== undefined && next === NONE_VALUE) {
                // Clearing writes the tree's own empty value for this field.
                onChange(field.default === null ? null : '');
                return;
              }
              onChange(next);
            }}
          >
            <SelectTrigger
              id={inputId}
              size="sm"
              className="entei-module-select"
              aria-describedby={describedBy}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {noneLabel !== undefined && (
                <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem>
              )}
              {choices.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}