/**
 * ModuleSettingsRenderer — the ONE settings surface of a module detail page.
 * ---------------------------------------------------------------------------
 * Given a module manifest, this draws its settings. The settings page calls it
 * once and never names a module: there is no per-module branch anywhere in the
 * page, so an imported `*.module.json` gets a settings page with no host code.
 *
 * THE MANIFEST IS THE ONLY INPUT: every section, group and field comes from its
 * descriptor tree (`@gorakudo/yomitan-headless/settings` for Yomitan's 18
 * sections, the module's own JSON for Jimaku.cc and Nadeshiko) and the components
 * below walk it generically. A module without a tree has no settings page at all
 * (`moduleHasSettings`, which is what the nav routes by).
 *
 * Layout (declarative): one collapsible card per SECTION (accordion, multiple
 * open at once — a settings page is a reference surface, not a wizard). Inside a
 * section each GROUP is a labelled stack of field rows: label + description on
 * the left, the control on the right (stacks on mobile).
 *
 * Persistence: this component OWNS the options tree (localStorage immediately,
 * desktop SQLite `kv_store` seeded on mount and debounced on write — see
 * `modules/yomitan/yomitan-preferences`). Every edit writes through it, so
 * there is no Save button and the page holds no settings state of its own.
 *
 * MANIFEST-DECLARED SECTIONS: a section whose real editor is not a plain field
 * list (Yomitan's Dictionaries: an installed-item list plus host-only rows) is
 * declared by the manifest as a `sectionLayouts` entry — an ordered list of ROWS,
 * each naming one of the app's standard layouts (`list`, `field`, `usage`,
 * `inputs`), the field it edits, the host-owned DATA SOURCE behind it, and its
 * own literal text (English, like the upstream UI it reproduces). This renderer
 * resolves those rows against the descriptor tree and the host source registry
 * (`components/settings/module-data-sources`); it never names a module or a
 * field itself. A field laid out this way is claimed: it is not drawn a second
 * time in its tree group.
 *
 * A `field` row may also name a source that owns its EDITOR: some values are not
 * in the module's options tree at all (a credential lives in the module's own
 * store), so the host binds the editor and the row keeps only its text. Without
 * such a binding the row stays the standard one, so a module degrades instead of
 * losing the row.
 *
 * `array` / `section-header` fields are not editable as a plain row: they are
 * structural placeholders in the tree (Anki card formats, profile management)
 * whose editors need their own CRUD surface, so they render as a read-only note
 * — unless a manifest declares a `list` or `inputs` layout for them, which is
 * exactly how the dictionary list and the scan-input cards get their editors.
 *
 * Fields the HOST owns (`LOCKED_OPTION_PATHS` — master switch, lookup language,
 * the Chrome onboarding guide, the advanced/debug toggles) are skipped entirely,
 * and a group left empty by that skip disappears with them.
 *
 * A row may also name a path the tree has NO descriptor for — a host-declared
 * virtual field (Yomitan's scan modifier is derived from `scanning.inputs[]`, so
 * it is not a tree field of its own). Such a row declares its own control type, and
 * only `boolean` and `select` are allowed: they are the two that need no descriptor
 * beyond their key. Everything else still fails closed.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useEffect, useId, useMemo, useState } from 'react';
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
  SelectOption,
  SettingFieldDescriptor,
  SettingGroupDescriptor,
  SettingSectionDescriptor,
} from '@gorakudo/yomitan-headless/settings';
import {
  hasSettingsSchema,
  type EnteiModuleRowBinding,
  type EnteiModuleManifest,
  type EnteiModuleSectionLayout,
} from '@/features/modules/module-registry';
import { ModuleFieldRow } from '@/components/settings/ModuleFieldRow';
import type { ModuleListManagerCopy } from '@/components/settings/ModuleListManager';
import { ModuleUsageMeter } from '@/components/settings/ModuleUsageMeter';
import type { ScanningInputManagerCopy } from '@/components/settings/ScanningInputManager';
import { resolveModuleCopyTable } from '@/components/settings/module-copy';
import { resolveModuleDataSource } from '@/components/settings/module-data-sources';
import {
  hydrateYomitanOptions,
  isLockedOptionPath,
  readOptionPath,
  readYomitanOptions,
  writeOptionPath,
} from '@/modules/yomitan/yomitan-preferences';
import type { Dictionary } from '@i18n/types';

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

export interface ModuleSettingsRendererProps {
  /** The module whose settings page is open (manifest-driven, never by id). */
  module: EnteiModuleManifest;
  /** The app dictionary — the renderer's own chrome is localised from it. */
  dict: Dictionary;
}

/**
 * Whether a module has a settings page to route to.
 *
 * A manifest with a renderable tree is the whole answer: the nav shows a row for
 * it, the Modules grid links to it, and a URL addressing anything else is sent
 * back to the landing grid rather than to an empty pane.
 */
export function moduleHasSettings(
  module: EnteiModuleManifest | undefined,
): boolean {
  return hasSettingsSchema(module);
}

/** Draw one module's settings from its manifest (nothing when it has none). */
export function ModuleSettingsRenderer({
  module,
  dict,
}: ModuleSettingsRendererProps) {
  if (!hasSettingsSchema(module)) return null;
  return <SchemaSettings module={module} dict={dict} />;
}

/** The renderer's own chrome, localised by the app dictionary. */
interface ModuleSettingsLabels {
  /** Shown in place of a control the host cannot edit generically. */
  notEditable: string;
  /** Accessible name for a section's collapse toggle. */
  toggleSection: string;
}

interface SchemaSettingsProps {
  /** A manifest with a renderable `settingsSchema` (narrowed by the caller). */
  module: EnteiModuleManifest & {
    settingsSchema: readonly SettingSectionDescriptor[];
  };
  dict: Dictionary;
}

/**
 * The declarative settings page: the manifest's own descriptor tree, drawn.
 *
 * Owns the persisted options tree so the page above stays module-agnostic. The
 * desktop DB is the durable source of truth, so it is read once on mount and
 * then answered from state; every write goes straight through the preferences
 * store (localStorage now, DB debounced).
 */
function SchemaSettings({ module, dict }: SchemaSettingsProps) {
  const [options, setOptions] = useState<Options>(readYomitanOptions);

  useEffect(() => {
    let current = true;
    void hydrateYomitanOptions().then((next) => {
      // Gone before the DB answered: the value is still cached, so dropping it
      // avoids a write into an unmounted component.
      if (current) setOptions(next);
    });
    return () => {
      current = false;
    };
  }, []);

  const labels = useMemo<ModuleSettingsLabels>(
    () => ({
      notEditable: dict.yomitanSettings.notEditable,
      toggleSection: dict.yomitanSettings.toggleSection,
    }),
    [dict],
  );

  const { settingsSchema: sections } = module;

  /* Section keys open on first render. Opening every one of 18 sections would
     make the page a wall of controls; the user opens what they came for. */
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const section of sections) initial[section.key] = false;
    return initial;
  });

  const fields = useMemo(() => indexFields(sections), [sections]);
  const claimed = useMemo(
    () => claimedPaths(module.sectionLayouts),
    [module.sectionLayouts],
  );

  function update(path: string, value: unknown) {
    const next = writeOptionPath(options, path, value);
    // Same reference = the path was not addressable; skip a pointless render.
    if (next !== options) setOptions(next);
  }

  return (
    <div className="entei-module-settings">
      {sections.map((section) => (
        <ModuleSection
          key={section.key}
          section={section}
          sectionLayouts={module.sectionLayouts}
          fields={fields}
          claimed={claimed}
          options={options}
          expanded={open[section.key] === true}
          labels={labels}
          showIcon={module.showSectionIcons === true}
          onToggle={() =>
            setOpen((prev) => ({
              ...prev,
              [section.key]: !prev[section.key],
            }))
          }
          onChange={update}
          onOptionsChange={setOptions}
        />
      ))}
    </div>
  );
}

/** Every field of the tree, by dot-path — how a declared row finds its field. */
function indexFields(
  sections: readonly SettingSectionDescriptor[],
): Map<string, SettingFieldDescriptor> {
  const index = new Map<string, SettingFieldDescriptor>();
  for (const section of sections) {
    for (const group of section.groups) {
      for (const field of group.fields) index.set(field.key, field);
    }
  }
  return index;
}

/**
 * Descriptor for a HOST-DECLARED VIRTUAL FIELD: a path the app answers in its
 * options store but that has no entry in the module's settings tree.
 *
 * Only the descriptor's `key` and `type` are load-bearing (they pick the
 * control); the label is the row's own literal text and the choices come from its
 * `optionsSource`, so both are left empty here.
 */
function virtualField(
  path: string,
  type: 'boolean' | 'select',
): SettingFieldDescriptor {
  return {
    key: path,
    type,
    label: '',
    default: type === 'boolean' ? false : '',
  };
}

/** Paths a manifest lays out itself — never drawn again in a tree group. */
function claimedPaths(
  layouts: readonly EnteiModuleSectionLayout[] | undefined,
): ReadonlySet<string> {
  const claimed = new Set<string>();
  for (const layout of layouts ?? []) {
    for (const row of layout.rows) {
      if (row.field !== undefined) claimed.add(row.field);
    }
  }
  return claimed;
}

interface ModuleSectionProps {
  section: SettingSectionDescriptor;
  sectionLayouts: readonly EnteiModuleSectionLayout[] | undefined;
  fields: Map<string, SettingFieldDescriptor>;
  claimed: ReadonlySet<string>;
  options: Options;
  expanded: boolean;
  labels: ModuleSettingsLabels;
  /** Manifest-driven: draw the leading icon on this section header. */
  showIcon: boolean;
  onToggle: () => void;
  onChange: (path: string, value: unknown) => void;
  /** Whole-tree setter, for fields whose editor owns an array (dictionaries). */
  onOptionsChange: (next: Options) => void;
}

function ModuleSection({
  section,
  sectionLayouts,
  fields,
  claimed,
  options,
  expanded,
  labels,
  showIcon,
  onToggle,
  onChange,
  onOptionsChange,
}: ModuleSectionProps) {
  const panelId = useId();
  const descriptionId = `${panelId}-description`;
  const SectionIcon = SECTION_ICONS[section.icon ?? ''] ?? Settings;
  const layout = sectionLayouts?.find(
    (candidate) => candidate.section === section.key,
  );

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
          {layout !== undefined ? (
            /* Manifest-laid-out section: the declared rows replace the group
               walk entirely — the manifest owns what this section shows. */
            <div className="entei-module-rows">
              {layout.rows.map((row, index) => (
                <ModuleLayoutRow
                  /* Rows are positional declarations, not data: a manifest may
                     legitimately declare the same field twice. */
                  key={`${layout.section}-${index}`}
                  row={row}
                  fields={fields}
                  options={options}
                  labels={labels}
                  onChange={onChange}
                  onOptionsChange={onOptionsChange}
                />
              ))}
            </div>
          ) : (
            section.groups.map((group) => (
              <ModuleGroup
                key={group.key}
                group={group}
                claimed={claimed}
                options={options}
                labels={labels}
                onChange={onChange}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

interface ModuleGroupProps {
  group: SettingGroupDescriptor;
  claimed: ReadonlySet<string>;
  options: Options;
  labels: ModuleSettingsLabels;
  onChange: (path: string, value: unknown) => void;
}

function ModuleGroup({
  group,
  claimed,
  options,
  labels,
  onChange,
}: ModuleGroupProps) {
  /* Host-locked fields have no editor and manifest-claimed fields are drawn in
     their declared section; a group either emptied is not rendered. */
  const visible = group.fields.filter(
    (field) => !isLockedOptionPath(field.key) && !claimed.has(field.key),
  );
  if (visible.length === 0) return null;

  return (
    <div className="entei-module-group">
      <h4 className="entei-module-group-label">{group.label}</h4>
      {group.description !== undefined && (
        <p className="entei-module-group-description">{group.description}</p>
      )}
      <div className="entei-module-fields">
        {visible.map((field) => (
          <ModuleFieldRow
            key={field.key}
            field={field}
            label={field.label}
            description={field.description}
            value={readOptionPath(options, field.key)}
            onChange={(value) => onChange(field.key, value)}
            notEditable={labels.notEditable}
          />
        ))}
      </div>
    </div>
  );
}

interface ModuleLayoutRowProps {
  row: EnteiModuleRowBinding;
  fields: Map<string, SettingFieldDescriptor>;
  options: Options;
  labels: ModuleSettingsLabels;
  onChange: (path: string, value: unknown) => void;
  onOptionsChange: (next: Options) => void;
}

/** One manifest-declared row: resolve its layout, then draw it. */
function ModuleLayoutRow({
  row,
  fields,
  options,
  labels,
  onChange,
  onOptionsChange,
}: ModuleLayoutRowProps) {
  const source = resolveModuleDataSource(row.source);
  const field = row.field === undefined ? undefined : fields.get(row.field);

  if (row.layout === 'usage') {
    if (source?.usage === undefined) return null;
    const template = row.usage ?? '';
    if (template === '') return null;
    const label = row.label;
    const actionLabel = row.action;
    if (label === undefined || actionLabel === undefined) return null;
    return (
      <ModuleUsageMeter
        label={label}
        template={template}
        read={source.usage}
        actionLabel={actionLabel}
      />
    );
  }

  /* The row's own literal text wins; the descriptor's English is the fallback a
     row that declares none keeps. */
  const label = row.label ?? field?.label;
  const description = row.description ?? field?.description;

  /* HOST-DECLARED VIRTUAL FIELD: a row whose path the app answers in its options
     store but that the module's tree has no descriptor for (a Yomitan scan
     modifier lives inside `scanning.inputs[]`, so "which modifier" is a value the
     app derives, not a tree field). Only the two controls that need no descriptor
     are allowed — a boolean, and a select whose choices come from the host source
     — and both need manifest copy, because there is no descriptor text to fall
     back to. Anything else still fails closed. */
  if (field === undefined) {
    const path = row.field;
    if (path === undefined || label === undefined) return null;
    if (row.type === 'boolean') {
      return (
        <ModuleFieldRow
          field={virtualField(path, 'boolean')}
          label={label}
          description={description}
          value={readOptionPath(options, path)}
          onChange={(value) => onChange(path, value)}
          notEditable={labels.notEditable}
        />
      );
    }
    if (row.type === 'select' && row.optionsSource !== undefined) {
      return (
        <BoundFieldRow
          row={row}
          field={virtualField(path, 'select')}
          label={label}
          description={description}
          options={options}
          labels={labels}
          onChange={onChange}
        />
      );
    }
    return null;
  }

  /* The tree HAS this field, so its own text is a real fallback the optional
     chain above could not prove. */
  const rowLabel = label ?? field.label;
  const rowDescription = description ?? field.description;

  /* HOST-OWNED FIELD EDITOR: a row whose value is not in the options tree at all
     (a module's credential lives in that module's own store), so the source
     behind the row brings the editor and the manifest brings only the text. It is
     resolved before the standard row, which would draw an input bound to a path
     this tree cannot answer. Without such a source the row stays standard, so a
     manifest degrades instead of losing the row. */
  if (row.layout === 'field') {
    const FieldEditor = source?.field;
    if (FieldEditor !== undefined && rowLabel !== undefined) {
      return (
        <FieldEditor
          label={rowLabel}
          description={rowDescription}
          placeholder={field.placeholder}
        />
      );
    }
  }

  if (row.layout === 'list') {
    const ListEditor = source?.list;
    if (ListEditor === undefined) {
      /* Unknown source id: the generic read-only note, same as an undeclared
         array field — a manifest cannot conjure an editor the app lacks. */
      return (
        <ModuleFieldRow
          field={field}
          label={rowLabel}
          description={rowDescription}
          value={undefined}
          onChange={() => {}}
          notEditable={labels.notEditable}
        />
      );
    }
    return (
      <ListEditor
        options={options}
        onChange={onOptionsChange}
        title={rowLabel}
        description={rowDescription}
        copy={resolveListCopy(row.copy)}
      />
    );
  }

  /* `inputs` — the other array layout: CRUD over a list of input DEFINITIONS,
     each drawn as a card of standard rows. Same contract as `list` (the host
     source owns the editor, the manifest names its data and copy), because the
     array's item shape is the module's own. */
  if (row.layout === 'inputs') {
    const InputsEditor = source?.inputs;
    if (InputsEditor === undefined) {
      return (
        <ModuleFieldRow
          field={field}
          label={rowLabel}
          description={rowDescription}
          value={undefined}
          onChange={() => {}}
          notEditable={labels.notEditable}
        />
      );
    }
    return (
      <InputsEditor
        options={options}
        onChange={onOptionsChange}
        title={rowLabel}
        description={rowDescription}
        copy={resolveInputsCopy(row.copy)}
      />
    );
  }

  return (
    <BoundFieldRow
      row={row}
      field={field}
      label={rowLabel}
      description={rowDescription}
      options={options}
      labels={labels}
      onChange={onChange}
    />
  );
}

/**
 * The keys each layout reads out of its copy table.
 *
 * A layout's own strings (the import button, the card rows) are English and live
 * in `components/settings/module-copy`, whatever module the row belongs to; those
 * two lists are the keys it reads. The lookup is fail-closed: a missing key falls
 * back to `''`, and a row's own text stands on its own elsewhere.
 */
const LIST_COPY_KEYS = [
  'import',
  'importing',
  'importingProgress',
  'empty',
  'enable',
  'remove',
  'importFailed',
  'loadFailed',
  'reorder',
  'reorderHint',
] as const satisfies readonly (keyof ModuleListManagerCopy)[];

const INPUTS_COPY_KEYS = [
  'add',
  'count',
  'required',
  'excluded',
  'noInputs',
  'inputTypes',
  'mouse',
  'touch',
  'pen',
  'scanOn',
  'press',
  'release',
  'preventScrolling',
  'minimumTouchTime',
  'capture',
  'listening',
  'remove',
  'empty',
] as const satisfies readonly (keyof ScanningInputManagerCopy)[];

/**
 * One named table as a full copy contract (never a partial one).
 *
 * The strings a LAYOUT owns (`Import`, `Enable dictionary`, `Add New Key`) are
 * English whatever locale the app is in: they are drawn inside the upstream tool's
 * own UI. An unknown name resolves to `undefined`, and every key then falls back
 * to `''` — a typo must never print `undefined` into the page.
 */
function pickCopy<T extends object>(
  name: string | undefined,
  keys: readonly (keyof T)[],
): T {
  const table = resolveModuleCopyTable(name);
  const out: Record<string, string> = {};
  for (const key of keys) {
    out[key as string] = table?.[key as string] ?? '';
  }
  return out as T;
}

/** The `list` layout's copy contract, resolved from the row's named table. */
function resolveListCopy(name: string | undefined): ModuleListManagerCopy {
  return pickCopy<ModuleListManagerCopy>(name, LIST_COPY_KEYS);
}

/** The `inputs` layout's copy contract, resolved from the named table. */
function resolveInputsCopy(name: string | undefined): ScanningInputManagerCopy {
  return pickCopy<ScanningInputManagerCopy>(name, INPUTS_COPY_KEYS);
}

interface BoundFieldRowProps {
  row: EnteiModuleRowBinding;
  field: SettingFieldDescriptor;
  label: string;
  description: string | undefined;
  options: Options;
  labels: ModuleSettingsLabels;
  onChange: (path: string, value: unknown) => void;
}

/**
 * A `field` row: the standard row, with host-supplied options when the manifest
 * names an `optionsSource` (a select whose choices are the module's own data —
 * Yomitan's frequency dictionary list, which only the host can enumerate).
 */
function BoundFieldRow({
  row,
  field,
  label,
  description,
  options,
  labels,
  onChange,
}: BoundFieldRowProps) {
  const read = resolveModuleDataSource(row.optionsSource)?.options;
  /* `[]` before the read resolves, not `undefined`: a row that declares an
     `optionsSource` is a select from its first render, so it never flickers
     through a text input while the source is still being read. */
  const [choices, setChoices] = useState<readonly SelectOption[]>([]);

  useEffect(() => {
    if (read === undefined) return;
    let current = true;
    void read()
      .then((next) => {
        if (current) setChoices(next);
      })
      .catch(() => {
        // Unreadable source: the row still draws, with its `none` option only.
        if (current) setChoices([]);
      });
    return () => {
      current = false;
    };
    /* Re-read whenever the tree changes: installing or deleting the item this
       list enumerates has to show up without a reload. */
  }, [read, options]);

  return (
    <ModuleFieldRow
      field={field}
      label={label}
      description={description}
      value={readOptionPath(options, field.key)}
      options={choices}
      noneLabel={row.none}
      onChange={(value) => onChange(field.key, value)}
      notEditable={labels.notEditable}
    />
  );
}