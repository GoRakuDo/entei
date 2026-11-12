/**
 * YomitanSettingsRenderer — renders a module manifest's `settingsSchema`.
 * ---------------------------------------------------------------------------
 * Chrome-extension parity WITHOUT page-side knowledge of the module: every
 * section, group and field comes from the manifest's descriptor tree
 * (`@gorakudo/yomitan-headless/settings` for Yomitan's 18 sections), and this
 * component walks it generically. An imported community module that ships a
 * `settingsSchema` renders through exactly the same code.
 *
 * Layout: one collapsible card per SECTION (accordion, multiple open at once —
 * a settings page is a reference surface, not a wizard). Inside a section each
 * GROUP is a labelled stack of field rows: label + description on the left,
 * the control on the right (stacks on mobile).
 *
 * Persistence: every edit calls `onChange(nextOptions)`; the owner writes it
 * through `features/yomitan/yomitan-preferences` (localStorage immediately,
 * desktop SQLite `kv_store` debounced). There is no Save button.
 *
 * `array` / `section-header` fields are not editable here: they are structural
 * placeholders in the tree (dictionary lists, Anki card formats, profile
 * management) whose editors need their own CRUD surface. They render as a
 * read-only note instead of a fake control.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type {
  Options,
  SettingFieldDescriptor,
  SettingGroupDescriptor,
  SettingSectionDescriptor,
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
import {
  readOptionPath,
  writeOptionPath,
} from '@/features/yomitan/yomitan-preferences';

export interface YomitanSettingsRendererProps {
  /** Ordered section descriptors (from the manifest's `settingsSchema`). */
  sections: readonly SettingSectionDescriptor[];
  /** Current persisted options. */
  options: Options;
  /** Called with the next options after every edit (autosave lives upstream). */
  onChange: (next: Options) => void;
  /** Unlocalised strings from the settings dictionary. */
  labels: {
    /** Shown in place of a control the host cannot edit generically. */
    notEditable: string;
    /** Accessible name for a section's collapse toggle. */
    toggleSection: string;
  };
}

/** Renderable (editable) descriptor types. */
function isEditable(field: SettingFieldDescriptor): boolean {
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

export function YomitanSettingsRenderer({
  sections,
  options,
  onChange,
  labels,
}: YomitanSettingsRendererProps) {
  /* Section keys open on first render. Opening every one of 18 sections would
     make the page a wall of controls; the user opens what they came for. */
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const section of sections) initial[section.key] = false;
    return initial;
  });

  function update(path: string, value: unknown) {
    const next = writeOptionPath(options, path, value);
    // Same reference = the path was not addressable; skip a pointless render.
    if (next !== options) onChange(next);
  }

  return (
    <div className="entei-yomitan-settings">
      {sections.map((section) => (
        <YomitanSection
          key={section.key}
          section={section}
          options={options}
          expanded={open[section.key] === true}
          labels={labels}
          onToggle={() =>
            setOpen((prev) => ({
              ...prev,
              [section.key]: !prev[section.key],
            }))
          }
          onChange={update}
        />
      ))}
    </div>
  );
}

interface YomitanSectionProps {
  section: SettingSectionDescriptor;
  options: Options;
  expanded: boolean;
  labels: YomitanSettingsRendererProps['labels'];
  onToggle: () => void;
  onChange: (path: string, value: unknown) => void;
}

function YomitanSection({
  section,
  options,
  expanded,
  labels,
  onToggle,
  onChange,
}: YomitanSectionProps) {
  const panelId = useId();

  return (
    <section className="entei-settings-section-card entei-yomitan-section">
      <h3 className="entei-yomitan-section-heading">
        <button
          type="button"
          className="entei-yomitan-section-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${labels.toggleSection}: ${section.label}`}
          onClick={onToggle}
        >
          <ChevronDown className="entei-yomitan-section-chevron" aria-hidden="true" />
          <span className="entei-yomitan-section-label">{section.label}</span>
        </button>
        {section.description !== undefined && expanded && (
          <p className="entei-yomitan-section-description">
            {section.description}
          </p>
        )}
      </h3>

      {expanded && (
        <div className="entei-yomitan-section-body" id={panelId}>
          {section.groups.map((group) => (
            <YomitanGroup
              key={group.key}
              group={group}
              options={options}
              labels={labels}
              onChange={onChange}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface YomitanGroupProps {
  group: SettingGroupDescriptor;
  options: Options;
  labels: YomitanSettingsRendererProps['labels'];
  onChange: (path: string, value: unknown) => void;
}

function YomitanGroup({ group, options, labels, onChange }: YomitanGroupProps) {
  return (
    <div className="entei-yomitan-group">
      <h4 className="entei-yomitan-group-label">{group.label}</h4>
      {group.description !== undefined && (
        <p className="entei-yomitan-group-description">{group.description}</p>
      )}
      <div className="entei-yomitan-fields">
        {group.fields.map((field) => (
          <YomitanField
            key={field.key}
            field={field}
            options={options}
            labels={labels}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}

interface YomitanFieldProps {
  field: SettingFieldDescriptor;
  options: Options;
  labels: YomitanSettingsRendererProps['labels'];
  onChange: (path: string, value: unknown) => void;
}

function YomitanField({
  field,
  options,
  labels,
  onChange,
}: YomitanFieldProps) {
  const inputId = useId();
  const value = readOptionPath(options, field.key);

  /* Structural / not generically editable (array, section-header). */
  if (!isEditable(field)) {
    return (
      <div className="entei-yomitan-field entei-yomitan-field--readonly">
        <div className="entei-yomitan-field-text">
          <span className="entei-yomitan-field-label">{field.label}</span>
          {field.description !== undefined && (
            <p className="entei-yomitan-field-description">
              {field.description}
            </p>
          )}
        </div>
        <span className="entei-yomitan-field-note">{labels.notEditable}</span>
      </div>
    );
  }

  const hint =
    field.description !== undefined ? (
      <p className="entei-yomitan-field-description" id={`${inputId}-hint`}>
        {field.description}
      </p>
    ) : null;

  return (
    <div
      className={
        field.type === 'boolean'
          ? 'entei-yomitan-field entei-yomitan-field--switch'
          : 'entei-yomitan-field'
      }
    >
      <div className="entei-yomitan-field-text">
        <label className="entei-yomitan-field-label" htmlFor={inputId}>
          {field.label}
        </label>
        {hint}
      </div>

      <div className="entei-yomitan-field-control">
        {field.type === 'boolean' && (
          <Switch
            id={inputId}
            checked={value === true}
            onCheckedChange={(checked) => onChange(field.key, checked)}
            aria-describedby={
              field.description !== undefined ? `${inputId}-hint` : undefined
            }
          />
        )}

        {(field.type === 'string' ||
          field.type === 'text' ||
          field.type === 'password') &&
          (field.type === 'text' ? (
            <textarea
              id={inputId}
              className="entei-yomitan-textarea"
              value={typeof value === 'string' ? value : ''}
              placeholder={field.placeholder}
              rows={4}
              spellCheck={false}
              aria-describedby={
                field.description !== undefined ? `${inputId}-hint` : undefined
              }
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          ) : (
            <Input
              id={inputId}
              type={field.type === 'password' ? 'password' : 'text'}
              className="entei-yomitan-input"
              value={typeof value === 'string' ? value : ''}
              placeholder={field.placeholder}
              autoComplete="off"
              aria-describedby={
                field.description !== undefined ? `${inputId}-hint` : undefined
              }
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          ))}

        {(field.type === 'number' || field.type === 'integer') && (
          <Input
            id={inputId}
            type="number"
            className="entei-yomitan-input entei-yomitan-input--number"
            value={typeof value === 'number' ? value : ''}
            min={field.min}
            max={field.max}
            step={field.step ?? (field.type === 'integer' ? 1 : undefined)}
            aria-describedby={
              field.description !== undefined ? `${inputId}-hint` : undefined
            }
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') return; // keep the last valid number mid-edit
              const parsed = Number(raw);
              if (!Number.isFinite(parsed)) return;
              onChange(
                field.key,
                field.type === 'integer' ? Math.round(parsed) : parsed,
              );
            }}
          />
        )}

        {field.type === 'select' && (
          <Select
            value={typeof value === 'string' ? value : undefined}
            onValueChange={(next) => onChange(field.key, next)}
          >
            <SelectTrigger
              id={inputId}
              size="sm"
              className="entei-yomitan-select"
              aria-describedby={
                field.description !== undefined ? `${inputId}-hint` : undefined
              }
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
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