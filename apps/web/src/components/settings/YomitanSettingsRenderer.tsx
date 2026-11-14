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
 * MANIFEST-DECLARED SECTIONS: a section whose real editor is not a plain field
 * list (Yomitan's Dictionaries: an installed-item list plus host-only rows) is
 * declared by the manifest as a `sectionLayouts` entry — an ordered list of ROWS,
 * each naming one of the app's standard layouts (`list`, `field`, `usage`,
 * `inputs`), the field it edits, the host-owned DATA SOURCE behind it, and the
 * copy keys of its labels. This renderer resolves those rows against the
 * descriptor tree and the host source registry
 * (`components/settings/module-data-sources`); it never names a module or a
 * field itself. A field laid out this way is claimed: it is not drawn a second
 * time in its tree group.
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
import type {
  EnteiModuleRowBinding,
  EnteiModuleSectionLayout,
} from '@/features/modules/module-registry';
import { ModuleFieldRow } from '@/components/settings/ModuleFieldRow';
import type { ModuleListManagerCopy } from '@/components/settings/ModuleListManager';
import { ModuleUsageMeter } from '@/components/settings/ModuleUsageMeter';
import type { ScanningInputManagerCopy } from '@/components/settings/ScanningInputManager';
import { resolveModuleDataSource } from '@/components/settings/module-data-sources';
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

/** A module's copy table: the dictionary keys a manifest may reference. */
export type ModuleCopyTable = {
  readonly [key: string]: string | ModuleCopyTable | undefined;
};

export interface YomitanSettingsRendererProps {
  /** Ordered section descriptors (from the manifest's `settingsSchema`). */
  sections: readonly SettingSectionDescriptor[];
  /**
   * Manifest `sectionLayouts`: sections whose rows the manifest lays out
   * itself. Absent leaves every section on the generic group walk.
   */
  sectionLayouts?: readonly EnteiModuleSectionLayout[];
  /** Current persisted options. */
  options: Options;
  /** Called with the next options after every edit (autosave lives upstream). */
  onChange: (next: Options) => void;
  /**
   * Manifest flag (`showSectionIcons`): render the leading section icon. The
   * renderer never decides this on its own — absent/false means no icons.
   */
  showSectionIcons?: boolean;
  /** Localised strings from the settings dictionary. */
  labels: {
    /** Shown in place of a control the host cannot edit generically. */
    notEditable: string;
    /** Accessible name for a section's collapse toggle. */
    toggleSection: string;
  };
  /** The module's copy table — where manifest `labelKey` / `*Key` resolve. */
  copy: ModuleCopyTable;
}

/** Resolve one key of a copy table's group (e.g. `dictionaries` → `import`). */
function resolveCopy(
  table: ModuleCopyTable,
  group: string | undefined,
  key: string | undefined,
): string | undefined {
  if (key === undefined || key === '') return undefined;
  const scope = group === undefined || group === '' ? table : table[group];
  if (typeof scope !== 'object' || scope === null) return undefined;
  const value = (scope as ModuleCopyTable)[key];
  return typeof value === 'string' ? value : undefined;
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
 * control); the label comes from the manifest's copy and the choices from its
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

export function YomitanSettingsRenderer({
  sections,
  sectionLayouts,
  options,
  onChange,
  showSectionIcons = false,
  labels,
  copy,
}: YomitanSettingsRendererProps) {
  /* Section keys open on first render. Opening every one of 18 sections would
     make the page a wall of controls; the user opens what they came for. */
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const section of sections) initial[section.key] = false;
    return initial;
  });

  const fields = useMemo(() => indexFields(sections), [sections]);
  const claimed = useMemo(() => claimedPaths(sectionLayouts), [sectionLayouts]);

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
          sectionLayouts={sectionLayouts}
          fields={fields}
          claimed={claimed}
          options={options}
          expanded={open[section.key] === true}
          labels={labels}
          copy={copy}
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
  sectionLayouts: readonly EnteiModuleSectionLayout[] | undefined;
  fields: Map<string, SettingFieldDescriptor>;
  claimed: ReadonlySet<string>;
  options: Options;
  expanded: boolean;
  labels: YomitanSettingsRendererProps['labels'];
  copy: ModuleCopyTable;
  /** Manifest-driven: draw the leading icon on this section header. */
  showIcon: boolean;
  onToggle: () => void;
  onChange: (path: string, value: unknown) => void;
  /** Whole-tree setter, for fields whose editor owns an array (dictionaries). */
  onOptionsChange: (next: Options) => void;
}

function YomitanSection({
  section,
  sectionLayouts,
  fields,
  claimed,
  options,
  expanded,
  labels,
  copy,
  showIcon,
  onToggle,
  onChange,
  onOptionsChange,
}: YomitanSectionProps) {
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
                  copyPath={layout.copy}
                  fields={fields}
                  options={options}
                  labels={labels}
                  copy={copy}
                  onChange={onChange}
                  onOptionsChange={onOptionsChange}
                />
              ))}
            </div>
          ) : (
            section.groups.map((group) => (
              <YomitanGroup
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

interface YomitanGroupProps {
  group: SettingGroupDescriptor;
  claimed: ReadonlySet<string>;
  options: Options;
  labels: YomitanSettingsRendererProps['labels'];
  onChange: (path: string, value: unknown) => void;
}

function YomitanGroup({
  group,
  claimed,
  options,
  labels,
  onChange,
}: YomitanGroupProps) {
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
  /** Section's copy group (manifest `copy`), the rows' key scope. */
  copyPath: string | undefined;
  fields: Map<string, SettingFieldDescriptor>;
  options: Options;
  labels: YomitanSettingsRendererProps['labels'];
  copy: ModuleCopyTable;
  onChange: (path: string, value: unknown) => void;
  onOptionsChange: (next: Options) => void;
}

/** One manifest-declared row: resolve its layout, then draw it. */
function ModuleLayoutRow({
  row,
  copyPath,
  fields,
  options,
  labels,
  copy,
  onChange,
  onOptionsChange,
}: ModuleLayoutRowProps) {
  const source = resolveModuleDataSource(row.source);
  const field = row.field === undefined ? undefined : fields.get(row.field);

  if (row.layout === 'usage') {
    if (source?.usage === undefined) return null;
    const template = resolveCopy(copy, copyPath, row.usageKey) ?? '';
    if (template === '') return null;
    const label = resolveCopy(copy, copyPath, row.labelKey);
    const actionLabel = resolveCopy(copy, copyPath, row.actionKey);
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

  const label = resolveCopy(copy, copyPath, row.labelKey) ?? field?.label;
  const description =
    resolveCopy(copy, copyPath, row.descriptionKey) ?? field?.description;

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
          copy={copy}
          copyPath={copyPath}
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
        copy={resolveListCopy(copy, copyPath)}
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
        copy={resolveInputsCopy(copy, copyPath)}
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
      copy={copy}
      copyPath={copyPath}
      onChange={onChange}
    />
  );
}

/**
 * The `list` layout's fixed copy contract — the keys it always reads, so a
 * manifest declares the layout once and the strings stay in the locales.
 */
function resolveListCopy(
  copy: ModuleCopyTable,
  copyPath: string | undefined,
): ModuleListManagerCopy {
  const pick = (key: string): string =>
    resolveCopy(copy, copyPath, key) ?? '';
  return {
    import: pick('import'),
    importing: pick('importing'),
    importingProgress: pick('importingProgress'),
    empty: pick('empty'),
    enable: pick('enable'),
    remove: pick('remove'),
    importFailed: pick('importFailed'),
    loadFailed: pick('loadFailed'),
    reorder: pick('reorder'),
    reorderHint: pick('reorderHint'),
  };
}

/**
 * The `inputs` layout's fixed copy contract — resolved once, like the `list`
 * layout's, so a manifest declares the layout and the strings stay in the
 * locales.
 */
function resolveInputsCopy(
  copy: ModuleCopyTable,
  copyPath: string | undefined,
): ScanningInputManagerCopy {
  const pick = (key: string): string =>
    resolveCopy(copy, copyPath, key) ?? '';
  return {
    add: pick('addKey'),
    count: pick('advancedInputsCount'),
    required: pick('requiredInputs'),
    excluded: pick('excludedInputs'),
    noInputs: pick('noInputs'),
    inputTypes: pick('inputTypes'),
    mouse: pick('mouse'),
    touch: pick('touch'),
    pen: pick('pen'),
    scanOn: pick('scanOn'),
    press: pick('press'),
    release: pick('release'),
    preventScrolling: pick('preventScrolling'),
    minimumTouchTime: pick('minimumTouchTime'),
    capture: pick('captureInput'),
    listening: pick('captureListening'),
    remove: pick('removeInput'),
    empty: pick('inputsEmpty'),
  };
}

interface BoundFieldRowProps {
  row: EnteiModuleRowBinding;
  field: SettingFieldDescriptor;
  label: string;
  description: string | undefined;
  options: Options;
  labels: YomitanSettingsRendererProps['labels'];
  copy: ModuleCopyTable;
  copyPath: string | undefined;
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
  copy,
  copyPath,
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
    /* Re-read whenever the tree changes (installing or deleting the item this
       list enumerates has to show up without a reload) and whenever the COPY
       changes: a host source labels its choices from the locales, and a locale
       switch replaces the copy table. */
  }, [read, options, copy]);

  return (
    <ModuleFieldRow
      field={field}
      label={label}
      description={description}
      value={readOptionPath(options, field.key)}
      options={choices}
      noneLabel={
        row.noneKey === undefined
          ? undefined
          : resolveCopy(copy, copyPath, row.noneKey)
      }
      onChange={(value) => onChange(field.key, value)}
      notEditable={labels.notEditable}
    />
  );
}