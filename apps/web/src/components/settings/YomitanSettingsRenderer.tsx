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
 * placeholders in the tree (Anki card formats, profile management) whose editors
 * need their own CRUD surface, so they render as a read-only note. A field whose
 * editor IS a list of installed items is declared by the manifest instead
 * (`listFields`: field + `layout` + host `source`) and drawn with the app's
 * standard layout set — see `components/settings/ModuleListManager` and
 * `components/settings/module-list-sources`. Nothing here names a module.
 *
 * Each section header carries the label, and — when the manifest asks for it
 * (`showSectionIcons`) — the icon named by the manifest's `icon` id, the same
 * mark the Chrome extension shows (see the section-icon map below). Whether the
 * icon appears is manifest data, never a page-side decision. Fields
 * the HOST owns (`LOCKED_OPTION_PATHS` — master switch, lookup language, the
 * Chrome onboarding guide, the advanced/debug toggles) are skipped entirely, and
 * a group left empty by that skip disappears with them.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useId, useState } from 'react';
import {
  Accessibility,
  AppWindow,
  BookOpen,
  Bug,
  ChevronDown,
  Clipboard,
  FileText,
  Keyboard,
  Languages,
  Layers,
  LayoutPanelLeft,
  List,
  Maximize2,
  Palette,
  Puzzle,
  Save,
  Scan,
  Settings,
  User,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import type {
  Options,
  SettingFieldDescriptor,
  SettingGroupDescriptor,
  SettingSectionDescriptor,
} from '@gorakudo/yomitan-headless/settings';
import type { EnteiModuleListBinding } from '@/features/modules/module-registry';
import {
  resolveModuleListSource,
  type ModuleListSourceLabels,
} from '@/components/settings/module-list-sources';
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
  isLockedOptionPath,
  readOptionPath,
  writeOptionPath,
} from '@/features/yomitan/yomitan-preferences';

/**
 * Manifest section `icon` id → Lucide icon.
 *
 * Ids come from the descriptor tree (`@gorakudo/yomitan-headless/settings`).
 * An unknown id (imported module) falls back to `Settings` so a header is
 * never bare.
 */
const SECTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  settings: Settings,
  book: BookOpen,
  scan: Scan,
  panel: LayoutPanelLeft,
  palette: Palette,
  list: List,
  resize: Maximize2,
  window: AppWindow,
  volume: Volume2,
  layers: Layers,
  keyboard: Keyboard,
  translate: Languages,
  puzzle: Puzzle,
  text: FileText,
  clipboard: Clipboard,
  accessibility: Accessibility,
  save: Save,
  bug: Bug,
  user: User,
};

export interface YomitanSettingsRendererProps {
  /** Ordered section descriptors (from the manifest's `settingsSchema`). */
  sections: readonly SettingSectionDescriptor[];
  /**
   * Manifest `listFields`: fields drawn through a standard list layout. Absent
   * (or naming an unknown source) leaves the field on the generic path.
   */
  listFields?: readonly EnteiModuleListBinding[];
  /** Current persisted options. */
  options: Options;
  /** Called with the next options after every edit (autosave lives upstream). */
  onChange: (next: Options) => void;
  /**
   * Manifest flag (`showSectionIcons`): render the leading section icon. The
   * renderer never decides this on its own — absent/false means no icons.
   */
  showSectionIcons?: boolean;
  /** Unlocalised strings from the settings dictionary. */
  labels: {
    /** Shown in place of a control the host cannot edit generically. */
    notEditable: string;
    /** Accessible name for a section's collapse toggle. */
    toggleSection: string;
    /** Copy for the list layout set (forwarded to the resolved source). */
    list: ModuleListSourceLabels;
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
  listFields,
  options,
  onChange,
  labels,
  showSectionIcons = false,
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
    <div className="entei-module-settings">
      {sections.map((section) => (
        <YomitanSection
          key={section.key}
          section={section}
          listFields={listFields}
          options={options}
          expanded={open[section.key] === true}
          labels={labels}
          showIcon={showSectionIcons}
          onToggle={() =>
            setOpen((prev) => ({
              ...prev,
              [section.key]: !prev[section.key],
            }))
          }
          onChange={update}
          onOptionsChange={onChange}
        />
      ))}
    </div>
  );
}

interface YomitanSectionProps {
  section: SettingSectionDescriptor;
  listFields: readonly EnteiModuleListBinding[] | undefined;
  options: Options;
  expanded: boolean;
  labels: YomitanSettingsRendererProps['labels'];
  /** Manifest-driven: draw the leading icon on this section header. */
  showIcon: boolean;
  onToggle: () => void;
  onChange: (path: string, value: unknown) => void;
  /** Whole-tree setter, for fields whose editor owns an array (dictionaries). */
  onOptionsChange: (next: Options) => void;
}

function YomitanSection({
  section,
  listFields,
  options,
  expanded,
  labels,
  showIcon,
  onToggle,
  onChange,
  onOptionsChange,
}: YomitanSectionProps) {
  const panelId = useId();
  const descriptionId = `${panelId}-description`;
  const SectionIcon = SECTION_ICONS[section.icon ?? ''] ?? Settings;

  return (
    <section className="entei-settings-section-card entei-module-section">
      <h3 className="entei-module-section-heading">
        <button
          type="button"
          className="entei-module-section-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${labels.toggleSection}: ${section.label}`}
          aria-describedby={
            section.description !== undefined ? descriptionId : undefined
          }
          onClick={onToggle}
        >
          <span className="entei-module-section-header-text">
            <span className="entei-module-section-title">
              {showIcon && (
                <SectionIcon
                  className="entei-module-section-icon"
                  aria-hidden="true"
                />
              )}
              <span className="entei-module-section-label">{section.label}</span>
            </span>
            {section.description !== undefined && (
              /* A span, not a <p>: <button> only accepts phrasing content, and
                 the class carries the block layout. */
              <span
                className="entei-module-section-description"
                id={descriptionId}
              >
                {section.description}
              </span>
            )}
          </span>
          <ChevronDown
            className="entei-module-section-chevron"
            aria-hidden="true"
          />
        </button>
      </h3>

      {expanded && (
        <div className="entei-module-section-body" id={panelId}>
          {section.groups.map((group) => (
            <YomitanGroup
              key={group.key}
              group={group}
              listFields={listFields}
              options={options}
              labels={labels}
              onChange={onChange}
              onOptionsChange={onOptionsChange}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface YomitanGroupProps {
  group: SettingGroupDescriptor;
  listFields: readonly EnteiModuleListBinding[] | undefined;
  options: Options;
  labels: YomitanSettingsRendererProps['labels'];
  onChange: (path: string, value: unknown) => void;
  onOptionsChange: (next: Options) => void;
}

function YomitanGroup({
  group,
  listFields,
  options,
  labels,
  onChange,
  onOptionsChange,
}: YomitanGroupProps) {
  /* Host-locked fields have no editor; a group they emptied is not rendered. */
  const fields = group.fields.filter((field) => !isLockedOptionPath(field.key));
  if (fields.length === 0) return null;

  return (
    <div className="entei-module-group">
      <h4 className="entei-module-group-label">{group.label}</h4>
      {group.description !== undefined && (
        <p className="entei-module-group-description">{group.description}</p>
      )}
      <div className="entei-module-fields">
        {fields.map((field) => (
          <YomitanField
            key={field.key}
            field={field}
            listFields={listFields}
            options={options}
            labels={labels}
            onChange={onChange}
            onOptionsChange={onOptionsChange}
          />
        ))}
      </div>
    </div>
  );
}

interface YomitanFieldProps {
  field: SettingFieldDescriptor;
  listFields: readonly EnteiModuleListBinding[] | undefined;
  options: Options;
  labels: YomitanSettingsRendererProps['labels'];
  onChange: (path: string, value: unknown) => void;
  onOptionsChange: (next: Options) => void;
}

function YomitanField({
  field,
  listFields,
  options,
  labels,
  onChange,
  onOptionsChange,
}: YomitanFieldProps) {
  const inputId = useId();
  const value = readOptionPath(options, field.key);

  /* Manifest-bound list field: the layout is generic, the data source is
     host-owned, and an unknown source falls through to the read-only note. */
  const listSource = resolveModuleListSource(
    listFields?.find(
      (binding) => binding.field === field.key && binding.layout === 'list-manager',
    )?.source,
  );

  if (listSource !== undefined) {
    const ListEditor = listSource;
    return (
      <div className="entei-module-field entei-module-field--list">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{field.label}</span>
          {field.description !== undefined && (
            <p className="entei-module-field-description">
              {field.description}
            </p>
          )}
        </div>
        <ListEditor
          options={options}
          onChange={onOptionsChange}
          labels={labels.list}
        />
      </div>
    );
  }

  /* Structural / not generically editable (array, section-header). */
  if (!isEditable(field)) {
    return (
      <div className="entei-module-field entei-module-field--readonly">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">{field.label}</span>
          {field.description !== undefined && (
            <p className="entei-module-field-description">
              {field.description}
            </p>
          )}
        </div>
        <span className="entei-module-field-note">{labels.notEditable}</span>
      </div>
    );
  }

  const hint =
    field.description !== undefined ? (
      <p className="entei-module-field-description" id={`${inputId}-hint`}>
        {field.description}
      </p>
    ) : null;

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
          {field.label}
        </label>
        {hint}
      </div>

      <div className="entei-module-field-control">
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
              className="entei-module-textarea"
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
              className="entei-module-input"
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
            className="entei-module-input entei-module-input--number"
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
              className="entei-module-select"
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
