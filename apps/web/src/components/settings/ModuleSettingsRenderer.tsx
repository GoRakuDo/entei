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
 * `inputs`, `selects`, `numbers`), the field it edits, the host-owned DATA SOURCE
 * behind it, and its own literal text (English, like the upstream UI it
 * reproduces) — a grouped row (`selects`, `checkboxes`, `numbers`) instead carries
 * several mini-labelled controls, each bound to its own field (with its own choices
 * for a select). This renderer
 * resolves those rows against the descriptor tree and the host source registry
 * (`components/settings/module-data-sources`); it never names a module or a
 * field itself. A field laid out this way is claimed: it is not drawn a second
 * time in its tree group.
 *
 * The layout entry may also RE-TEXT the section it takes over (`label` /
 * `description`): upstream's headings describe the extension's own window, so a
 * host that fills a section with rows about its own page would otherwise head them
 * with a sentence about chrome it does not have. Both are optional and the tree's
 * wording is the fallback, so a layout cannot blank a heading by omission.
 *
 * A `field` row may also name a source that owns its EDITOR: some values are not
 * in the module's options tree at all (a credential lives in the module's own
 * store), or one control edits several paths at once (Yomitan's merge dictionary
 * selection), so the host binds the editor and the row keeps only its text — or, for
 * a block that is not a value at all (Yomitan's popup preview), no text: the editor
 * is then the whole row. Such an editor is handed the whole-tree setter too, so it
 * can write without the row knowing which paths it owns. Without such a binding the
 * row stays the standard one, so a module degrades instead of losing the row.
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

import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { ModuleSelectPairRow } from '@/components/settings/ModuleSelectPairRow';
import { ModuleCheckboxGroupRow } from '@/components/settings/ModuleCheckboxGroupRow';
import { ModuleNumberGroupRow } from '@/components/settings/ModuleNumberGroupRow';
import type { ModuleListManagerCopy } from '@/components/settings/ModuleListManager';
import { ModuleUsageMeter } from '@/components/settings/ModuleUsageMeter';
import type { ScanningInputManagerCopy } from '@/components/settings/ScanningInputManager';
import { resolveModuleCopyTable } from '@/components/settings/module-copy';
import { resolveModuleDataSource } from '@/components/settings/module-data-sources';
import { PlayingCardsFan } from '@/components/settings/PlayingCardsFan';
import { SettingsButton } from '@/components/settings/SettingsButton';
import {
  hydrateYomitanOptions,
  isLockedOptionPath,
  readOptionPath,
  readYomitanOptions,
  writeOptionPath,
} from '@/modules/yomitan/yomitan-preferences';
import {
  buildSettingsExportPayload,
  importSettingsFromJson,
  resetSettings,
  traceSettingsExported,
} from '@/modules/yomitan/settings-backup';
import {
  readAnkiConnectionPreferences,
} from '@/features/player/anki-connection-preferences';
import {
  importDictionaryFromPath,
  invalidateInstalledDictionaries,
  createDictionaryOptionEntry,
  type DictionaryOptionEntry,
} from '@/modules/yomitan/dictionary-store';
import {
  isTauri,
  writeTextFileDirect,
  importDictionaryDexieDirect,
  exportDictionaryDexieDirect,
  onYomitanImportProgress,
  onYomitanExportProgress,
} from '@/features/player/tauri-bridge';
import { toast } from 'sonner';
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
  /**
   * Open a section's new home — the destination of a `link` row's button (Yomitan's
   * Anki section, whose editor lives on the dedicated Anki page). The row hands
   * over its own `target` (a top-level settings group id) and the page resolves it
   * against its own group list, so this contract stays a plain string and the
   * renderer never needs to know the app's group union. Absent (a module settings
   * page shown outside the settings app) a `link` row still draws its card, with
   * the button inert rather than broken.
   */
  onNavigate?: (target: string) => void;
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
  onNavigate,
}: ModuleSettingsRendererProps) {
  if (!hasSettingsSchema(module)) return null;
  return <SchemaSettings module={module} dict={dict} onNavigate={onNavigate} />;
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
  /** Destination of a `link` row's button (see `ModuleSettingsRendererProps`). */
  onNavigate?: (target: string) => void;
}

/**
 * The declarative settings page: the manifest's own descriptor tree, drawn.
 *
 * Owns the persisted options tree so the page above stays module-agnostic. The
 * desktop DB is the durable source of truth, so it is read once on mount and
 * then answered from state; every write goes straight through the preferences
 * store (localStorage now, DB debounced).
 */
function SchemaSettings({ module, dict, onNavigate }: SchemaSettingsProps) {
  const [options, setOptions] = useState<Options>(readYomitanOptions);
  const latest = useRef(options);

  useEffect(() => {
    latest.current = options;
  }, [options]);

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
    /* SEVERAL WRITES IN ONE GESTURE: a grouped row (Yomitan's Auto-scale and
       pitch-accent checkboxes) writes every path it owns inside a SINGLE handler,
       so each write has to see the one before it. Deriving them all from the tree
       captured by the current render would keep only the last; the ref mirrors the
       newest tree between renders while state stays the render source. */
    const current = latest.current;
    const next = writeOptionPath(current, path, value);
    // Same reference = the path was not addressable; skip a pointless render.
    if (next === current) return;
    latest.current = next;
    setOptions(next);
  }

  return (
    <div className="entei-module-settings">
      {sections.filter((section) => {
        /* Sections explicitly hidden in sectionLayouts (e.g. residual descriptor-tree
           sections migrated elsewhere) are suppressed entirely from the page. */
        const layout = module.sectionLayouts?.find((c) => c.section === section.key);
        return layout?.hidden !== true;
      }).map((section) => (
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
          onNavigate={onNavigate}
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
  type: 'boolean' | 'select' | 'number',
  bounds?: { min?: number; max?: number; step?: number; default?: number },
): SettingFieldDescriptor {
  return {
    key: path,
    type,
    label: '',
    default:
      type === 'boolean' ? false : type === 'number' ? (bounds?.default ?? 0) : '',
    ...(type === 'number' && bounds
      ? { min: bounds.min, max: bounds.max, step: bounds.step }
      : {}),
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
      /* A grouped row edits one path per control, so every one of them is
         claimed: leaving one out would draw it a second time in its tree group. */
      for (const item of row.selects ?? []) claimed.add(item.field);
      for (const item of row.checkboxes ?? []) claimed.add(item.field);
      for (const item of row.numbers ?? []) claimed.add(item.field);
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
  /** Destination of a `link` row's button (see `ModuleSettingsRendererProps`). */
  onNavigate?: (target: string) => void;
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
  onNavigate,
}: ModuleSectionProps) {
  const panelId = useId();
  const descriptionId = `${panelId}-description`;
  const SectionIcon = SECTION_ICONS[section.icon ?? ''] ?? Settings;
  const layout = sectionLayouts?.find(
    (candidate) => candidate.section === section.key,
  );
  /* A section the manifest lays out may also RE-TEXT it: upstream's heading
     describes the extension's own surface, which is not what host-declared rows are
     about (see `EnteiModuleSectionLayout`). An override, never a second source of
     copy: a layout that declares neither keeps the tree's own wording. */
  const heading = layout?.label ?? section.label;
  const headingDescription = layout?.description ?? section.description;

  return (
    <section className="entei-settings-section-card entei-module-section">
      <h3 className="entei-module-section-heading">
        <button
          type="button"
          className="entei-module-section-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${labels.toggleSection}: ${heading}`}
          aria-describedby={
            headingDescription !== undefined ? descriptionId : undefined
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
              <span className="entei-module-section-label">{heading}</span>
            </span>
            {headingDescription !== undefined && (
              /* A span, not a <p>: <button> only accepts phrasing content, and
                 the class carries the block layout. */
              <span
                className="entei-module-section-description"
                id={descriptionId}
              >
                {headingDescription}
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
                  onNavigate={onNavigate}
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
  /** Destination of a `link` row's button (see `ModuleSettingsRendererProps`). */
  onNavigate?: (target: string) => void;
}

/** One manifest-declared row: resolve its layout, then draw it. */
function ModuleLayoutRow({
  row,
  fields,
  options,
  labels,
  onChange,
  onOptionsChange,
  onNavigate,
}: ModuleLayoutRowProps) {
  const source = resolveModuleDataSource(row.source);
  const field = row.field === undefined ? undefined : fields.get(row.field);

  /* SEVERAL SELECTS, ONE ROW: upstream Yomitan's paired controls (Theme is a Body
     and a Shadow select on one line). Every path is a real field of the tree, but
     the row ships its OWN choices — upstream's order and wording, which the
     descriptor's list does not reproduce — so this is resolved before the
     single-field row, which can only draw one control. */
  if (row.layout === 'selects') {
    const items = row.selects;
    if (items === undefined || items.length === 0 || row.label === undefined) {
      return null;
    }
    return (
      <ModuleSelectPairRow
        label={row.label}
        description={row.description}
        selects={items}
        read={(path) => readOptionPath(options, path)}
        onChange={onChange}
      />
    );
  }

  /* SECTION EMPTY STATE: this section's editor lives elsewhere in the app now, so
     instead of rows the manifest draws one centered card naming the move and a
     button that navigates to it. It edits no field and reads no source — it just
     replaces the residual descriptor-tree form (Yomitan's Anki section, whose
     connection and card-profile settings moved to the dedicated Anki page).
     Resolved before the field lookup, which a row with neither a field nor a
     source would otherwise fall through. */
  if (row.layout === 'link') {
    /* Fail-closed on copy, exactly like the grouped rows: a move notice with no
       heading, or a button with no label, is a half-applied card rather than a
       trustworthy one. `target` is already validated at parse time. */
    if (row.label === undefined || row.action === undefined) return null;
    return (
      <div className="entei-module-empty-card">
        <PlayingCardsFan
          size={24}
          className="entei-module-empty-card-icon"
          aria-hidden="true"
        />
        <span className="entei-module-empty-card-title">{row.label}</span>
        {row.description !== undefined && (
          <p className="entei-module-empty-card-desc">{row.description}</p>
        )}
        <SettingsButton
          icon={PlayingCardsFan}
          className="entei-module-empty-card-btn"
          onClick={() => onNavigate?.(row.target ?? 'anki')}
        >
          {row.action}
        </SettingsButton>
      </div>
    );
  }
  /* SETTINGS BACKUP ROW: Export / Import / Reset action group. This row owns no
   field and reads no source — it is a self-contained action card driven by the
   `settings-backup` module. The three buttons cover the full backup lifecycle:
   Export writes a portable .json, Import reads one (upstream extension format
   or this app's own), Reset restores host defaults. Each dispatches
   `entei:yomitan-options-updated` on success so the renderer re-hydrates. */
  if (row.layout === 'backup') {
    return (
      <BackupRow
        options={options}
        onOptionsChange={onOptionsChange}
      />
    );
  }


  /* SEVERAL CHECKBOXES, ONE ROW: upstream Yomitan's grouped booleans ("Pitch accent
     display styles" is a Downstep notation, a Downstep position and a Graph checkbox
     on one line). Each item is a real boolean field path; the row ships its own text
     and mini labels, and the write resolves through the options store exactly like
     a single-field switch row. Resolved before the single-field row, which can only
     draw one control. */
  if (row.layout === 'checkboxes') {
    const items = row.checkboxes;
    if (items === undefined || items.length === 0 || row.label === undefined) {
      return null;
    }
    return (
      <ModuleCheckboxGroupRow
        label={row.label}
        description={row.description}
        checkboxes={items}
        read={(path) => readOptionPath(options, path)}
        onChange={onChange}
      />
    );
  }

  /* SEVERAL NUMBERS, ONE ROW: upstream Yomitan's paired numeric knobs (Popup
     Position & Size's `Size` is a Width and a Height input on one line). Each item
     is a real numeric field path, and its control takes min/max/step from that
     field's descriptor. Resolved before the single-field row, which can only draw
     one control. */
  if (row.layout === 'numbers') {
    const items = row.numbers;
    if (items === undefined || items.length === 0 || row.label === undefined) {
      return null;
    }
    return (
      <ModuleNumberGroupRow
        label={row.label}
        description={row.description}
        numbers={items}
        fields={fields}
        read={(path) => readOptionPath(options, path)}
        onChange={onChange}
      />
    );
  }

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

  /* HOST-OWNED EDITOR: a row the host draws itself, either for a value that is
     not in the options tree at all (a module's credential lives in that module's
     own store) or for a row that names NO tree field because it is not a value —
     Yomitan's popup preview is a block the app composes out of the module's whole
     options. Both are resolved before the standard row, which would draw a
     control bound to a path this tree cannot answer, or nothing at all. Without
     such a source the row falls through, so a manifest degrades instead of losing
     the row. */
  if (row.layout === 'field') {
    const FieldEditor = source?.field;
    /* No label requirement: a host-owned BLOCK (Yomitan's popup preview) declares no
       text of its own and its editor draws the whole row. */
    if (FieldEditor !== undefined) {
      return (
        <FieldEditor
          label={label}
          description={description}
          placeholder={field?.placeholder}
          options={options}
          /* A host editor may WRITE as well as draw: a credential writes to its own
             store and ignores this, while a control that edits several option paths
             at once (Yomitan's merge dictionary selection) has nothing else to write
             through. */
          onChange={onOptionsChange}
        />
      );
    }
  }

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
    /* A host-declared number (Yomitan's audio fetch timeout lives only in the
       options store, not the tree): a numeric input the app answers itself. */
    if (row.type === 'number') {
      return (
        <ModuleFieldRow
          field={virtualField(path, 'number', row)}
          label={label}
          description={description}
          value={readOptionPath(options, path)}
          onChange={(value) => onChange(path, value)}
          notEditable={labels.notEditable}
        />
      );
    }
    if (
      row.type === 'select' &&
      (row.optionsSource !== undefined || row.options !== undefined)
    ) {
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

/* --- Settings backup action card --- */

function BackupRow({
  options,
  onOptionsChange,
}: {
  options: Options;
  onOptionsChange: (next: Options) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Progress (percent) of the four backup operations, or `null` when idle. A
  // non-null value both swaps the button's label to `Importing NN%` and disables
  // its row against a second click.
  const [dictImportPercent, setDictImportPercent] = useState<number | null>(null);
  const [dictExportPercent, setDictExportPercent] = useState<number | null>(null);
  const [settingsImportPercent, setSettingsImportPercent] = useState<number | null>(null);
  const [settingsExportPercent, setSettingsExportPercent] = useState<number | null>(null);

  // Whether THIS card is the one driving the current dictionary import/export.
  // The engine's progress events are global broadcasts — a dictionary imported
  // from the Dictionaries list fires the same event — so without this gate the
  // row's buttons would flip to `Importing NN%` / disabled while some OTHER
  // surface runs its own import. The ref (not state) keeps the subscription
  // handler stable across renders.
  const dictImportingRef = useRef(false);
  const dictExportingRef = useRef(false);

  // The settings import/export percent pulses (0 -> 100) inside a single gesture
  // and settles back to idle after a short delay. Track the pending timer so an
  // unmount before it fires doesn't call a state setter on a dead component.
  const settingsTimersRef = useRef<number[]>([]);
  useEffect(() => {
    const timers = settingsTimersRef.current;
    return () => {
      for (const id of timers) window.clearTimeout(id);
      timers.length = 0;
    };
  }, []);

  /** Schedule the settings percent's return to idle, cancellable on unmount. */
  function scheduleSettingsIdleReset(
    reset: (next: number | null) => void,
  ): void {
    const id = window.setTimeout(() => reset(null), 800);
    settingsTimersRef.current.push(id);
  }

  // The engine streams a dictionary backup row by row and publishes a percent on
  // `yomitan:export-progress` (a bare number); imports publish a
  // `{percent, current, total}` report. Both are memory-only — the number lives
  // in this component and is reset the moment its operation settles. Events that
  // arrive while this card isn't the one driving the operation are ignored, so
  // another surface's import never moves this row's label.
  useEffect(() => {
    const stopImport = onYomitanImportProgress((progress) => {
      if (!dictImportingRef.current) return;
      setDictImportPercent(progress.percent);
    });
    const stopExport = onYomitanExportProgress((percent) => {
      if (!dictExportingRef.current) return;
      setDictExportPercent(percent);
    });
    return () => {
      stopImport();
      stopExport();
    };
  }, []);

  /** Current date as `YYYY-MM-DD`, for the dictionary export filename. */
  function todayStamp(): string {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${mm}-${dd}`;
  }

  /** The web's own sink: a blob the browser hands to its downloads folder. */
  function browserDownload(text: string, filename: string): void {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Write `text` to the file the user chooses.
   *
   * Desktop app: the OS save dialog picks the path, and the native plugin writes
   * it — an `<a download>` inside the webview drops the file into the browser's
   * own downloads folder without ever asking where it should go. Web: the browser
   * download is the only sink there is.
   *
   * @returns `true` when the file was written, `false` when the user cancelled —
   * a cancel is a decision, not a failure, and must stay silent.
   */
  async function downloadText(text: string, defaultFilename: string): Promise<boolean> {
    if (!isTauri()) {
      browserDownload(text, defaultFilename);
      return true;
    }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const chosenPath = await save({
      defaultPath: defaultFilename,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (chosenPath === null || chosenPath.length === 0) return false;
    // Note: Android answers with a SAF `content://` URI, which has no filesystem
    // path behind it — `std::fs::write` cannot open one. There the webview's own
    // download stays the sink (what the platform had before this dialog), rather
    // than failing an export the user already aimed somewhere.
    if (chosenPath.includes('://')) {
      browserDownload(text, defaultFilename);
      return true;
    }
    await writeTextFileDirect(chosenPath, text);
    return true;
  }

  async function handleImportSettingsFile(file: File): Promise<void> {
    // Settings import is a fast local JSON parse, so the percent is a short
    // 0 -> 100 pulse: the button label reads `Importing 0%` the moment the file
    // is chosen and `Importing 100%` once it lands, then returns to `Import`.
    setSettingsImportPercent(0);
    try {
      const text = await file.text();
      const profileCount = await importSettingsFromJson(text);
      setSettingsImportPercent(100);
      toast.success(`Imported ${profileCount} profile${profileCount === 1 ? '' : 's'}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed.';
      toast.error(message);
    } finally {
      scheduleSettingsIdleReset(setSettingsImportPercent);
    }
  }

  async function handleExportSettings(): Promise<void> {
    setSettingsExportPercent(0);
    try {
      const payload = buildSettingsExportPayload();
      setSettingsExportPercent(50);
      const exported = await downloadText(payload.contents, payload.filename);
      if (!exported) return; // User cancelled: silence, not a failure.
      setSettingsExportPercent(100);
      traceSettingsExported(payload.profileCount);
      toast.success('Settings exported.');
    } catch (error) {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Export failed.';
      toast.error(message);
    } finally {
      scheduleSettingsIdleReset(setSettingsExportPercent);
    }
  }

  /** Import one dictionary archive (.zip) or Dexie backup (.json): a native path picker, then the engine. */
  async function handleImportDictionary(): Promise<void> {
    if (!isTauri()) {
      toast.error('Dictionary import requires the desktop app.');
      return;
    }
    setDictImportPercent(0);
    // Claim the import for THIS card before any await so the global progress
    // events this operation is about to emit are the ones this row listens to.
    dictImportingRef.current = true;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: 'Dictionary', extensions: ['zip', 'json'] },
        ],
      });
      if (typeof picked !== 'string' || picked.length === 0) return;
      if (picked.toLowerCase().endsWith('.json')) {
        // A Yomitan "Export Database" backup carries every dictionary at once.
        const restored = await importDictionaryDexieDirect(picked);
        invalidateInstalledDictionaries();
        // Mirror every restored dictionary into the options tree (priority
        // order), the SAME contract the single-dictionary ZIP branch below
        // follows. Without this the backup's dictionaries exist in the engine
        // but never in `options.dictionaries`, so a later reorder / toggle
        // writes a list that silently drops them and they read as disabled.
        const restoredNames = new Set(
          restored.map((summary) => summary.title).filter((name) => name.length > 0),
        );
        const optionEntries = readOptionPath(options, 'dictionaries') as
          DictionaryOptionEntry[] | undefined;
        const next = writeOptionPath(options, 'dictionaries', [
          ...(optionEntries ?? []).filter((entry) => !restoredNames.has(entry.name)),
          ...[...restoredNames].map((name) => createDictionaryOptionEntry(name)),
        ]);
        onOptionsChange(next);
        const count = restored.length;
        toast.success(`Imported ${count} dictionar${count === 1 ? 'y' : 'ies'}.`);
        return;
      }
      const record = await importDictionaryFromPath(picked);
      // Mirror the installed dictionary into the options tree (priority order),
      // the same contract the Dictionaries list import follows.
      const optionEntries = readOptionPath(options, 'dictionaries') as
        DictionaryOptionEntry[] | undefined;
      const next = writeOptionPath(options, 'dictionaries', [
        ...(optionEntries ?? []).filter((entry) => entry.name !== record.name),
        createDictionaryOptionEntry(record.name),
      ]);
      onOptionsChange(next);
      toast.success(`Imported dictionary: ${record.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Dictionary import failed.';
      toast.error(message);
    } finally {
      // Release the claim BEFORE dropping the label, so a late event from this
      // operation can't sneak past the guard and re-light the row.
      dictImportingRef.current = false;
      // The engine's progress events stop once the import settles; drop the
      // label back to idle so the row isn't stuck at `Importing 100%`.
      setDictImportPercent(null);
    }
  }

  /** Export every installed dictionary as a full Yomitan Dexie `.json` backup. */
  async function handleExportDictionary(): Promise<void> {
    if (!isTauri()) {
      toast.error('Dictionary export requires the desktop app.');
      return;
    }
    setDictExportPercent(0);
    // Same claim as the import path: this card owns the export stream it is
    // about to start, whatever else the app is doing.
    dictExportingRef.current = true;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const chosenPath = await save({
        defaultPath: `yomitan-dictionaries-${todayStamp()}.json`,
        filters: [{ name: 'Yomitan Dictionary Backup', extensions: ['json'] }],
      });
      // A cancel is a decision, not a failure — stay silent.
      if (chosenPath === null || chosenPath.length === 0) return;
      // Note: Android answers with a SAF `content://` URI, which has no
      // filesystem path behind it for the native engine to stream into.
      if (chosenPath.includes('://')) {
        toast.error('Dictionary export needs a real file path (not available on this platform).');
        return;
      }
      const count = await exportDictionaryDexieDirect(chosenPath);
      toast.success(`Exported ${count} dictionar${count === 1 ? 'y' : 'ies'}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Dictionary export failed.';
      toast.error(message);
    } finally {
      // Release the claim before the label so a trailing event can't re-light
      // the row either.
      dictExportingRef.current = false;
      // The export stream emitted its final 100 and stopped; return to idle so
      // the row isn't stuck at `Exporting 100%`.
      setDictExportPercent(null);
    }
  }

  // Per-row busy: while either operation in a row runs, BOTH its buttons disable
  // (no second click mid-stream). `NN%` swaps the label so the button itself is
  // the progress indicator. Only the button actually running an operation carries
  // `data-busy`, so the gold progress styling lands on the one moving and the
  // other (idle, disabled) half stays dim rather than looking tappable.
  const dictBusy = dictImportPercent !== null || dictExportPercent !== null;
  const settingsBusy =
    settingsImportPercent !== null || settingsExportPercent !== null;

  // Reset runs instantly (no percent stream), but a `Resetting…` label keeps
  // the button from looking dead during the await, so it carries its own busy
  // flag rather than reusing `settingsBusy` (which only tracks import/export).
  const [resetting, setResetting] = useState(false);

  /**
   * Reset Yomitan settings (and, when the Yomitan→Anki bridge is on, this
   * app's Anki Connection card) back to host defaults.
   *
   * Confirm first: like upstream, a reset discards every Yomitan setting at
   * once, and dictionaries are unaffected either way.
   */
  async function handleResetSettings(): Promise<void> {
    const ankiControlled = readAnkiConnectionPreferences().yomitanModuleControl === true;
    const message = ankiControlled
      ? 'Reset Yomitan settings to defaults? Anki settings will also be reset (Yomitan Module Control is on).'
      : 'Reset Yomitan settings to defaults?';
    if (typeof window !== 'undefined' && !window.confirm(message)) return;
    setResetting(true);
    try {
      // resetSettings itself restores this app's Anki defaults when the bridge is
      // on (keeping the switch ON), so the Anki card needs no separate write here
      // — one reset path, not two.
      await resetSettings();
      // Re-seed the renderer's in-memory tree from what was just persisted so
      // every field on the page drops back to its default without a reload.
      onOptionsChange(readYomitanOptions());
      toast.success('Yomitan settings reset.');
    } catch (error) {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Reset failed.';
      toast.error(message);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="entei-module-field" data-layout="backup">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="entei-module-backup-file-input"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) void handleImportSettingsFile(file);
          // Reset so re-selecting the same file fires change again.
          e.target.value = '';
        }}
      />
      <div className="entei-module-backup-rows">
        <div className="entei-module-backup-row">
          <span className="entei-module-backup-row-label">Yomitan Dictionaries</span>
          <div
            className="entei-module-backup-group"
            role="group"
            aria-label="Yomitan dictionary backup"
          >
            <SettingsButton
              className="entei-module-backup-btn entei-module-backup-btn--left"
              disabled={dictBusy}
              data-busy={dictImportPercent !== null ? 'true' : undefined}
              aria-label={
                dictImportPercent === null
                  ? 'Import Yomitan dictionaries'
                  : `Importing Yomitan dictionaries, ${dictImportPercent}%`
              }
              onClick={() => void handleImportDictionary()}
            >
              {dictImportPercent === null ? 'Import' : `Importing ${dictImportPercent}%`}
            </SettingsButton>
            <SettingsButton
              className="entei-module-backup-btn entei-module-backup-btn--right"
              disabled={dictBusy}
              data-busy={dictExportPercent !== null ? 'true' : undefined}
              aria-label={
                dictExportPercent === null
                  ? 'Export Yomitan dictionaries'
                  : `Exporting Yomitan dictionaries, ${dictExportPercent}%`
              }
              onClick={() => void handleExportDictionary()}
            >
              {dictExportPercent === null ? 'Export' : `Exporting ${dictExportPercent}%`}
            </SettingsButton>
          </div>
        </div>
        <div className="entei-module-backup-row">
          <span className="entei-module-backup-row-label">Yomitan Settings</span>
          <div
            className="entei-module-backup-group"
            role="group"
            aria-label="Yomitan settings backup"
          >
            <SettingsButton
              className="entei-module-backup-btn entei-module-backup-btn--left"
              disabled={settingsBusy}
              data-busy={settingsImportPercent !== null ? 'true' : undefined}
              aria-label={
                settingsImportPercent === null
                  ? 'Import Yomitan settings'
                  : `Importing Yomitan settings, ${settingsImportPercent}%`
              }
              onClick={() => fileInputRef.current?.click()}
            >
              {settingsImportPercent === null
                ? 'Import'
                : `Importing ${settingsImportPercent}%`}
            </SettingsButton>
            <SettingsButton
              className="entei-module-backup-btn entei-module-backup-btn--right"
              disabled={settingsBusy}
              data-busy={settingsExportPercent !== null ? 'true' : undefined}
              aria-label={
                settingsExportPercent === null
                  ? 'Export Yomitan settings'
                  : `Exporting Yomitan settings, ${settingsExportPercent}%`
              }
              onClick={() => void handleExportSettings()}
            >
              {settingsExportPercent === null
                ? 'Export'
                : `Exporting ${settingsExportPercent}%`}
            </SettingsButton>
          </div>
        </div>
        <div className="entei-module-backup-row entei-module-backup-row--reset">
          <span className="entei-module-backup-row-label">Reset Settings</span>
          <SettingsButton
            className="entei-module-backup-reset-btn"
            disabled={resetting}
            onClick={() => void handleResetSettings()}
          >
            {resetting ? 'Resetting…' : 'Reset'}
          </SettingsButton>
        </div>
      </div>
    </div>
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
  'definitionsCollapsible',
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
  'searchFor',
  'term',
  'kanji',
  'scanOn',
  'tap',
  'press',
  'release',
  'move',
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
  const hasOptionsSource = row.optionsSource !== undefined;
  const read = hasOptionsSource
    ? resolveModuleDataSource(row.optionsSource)?.options
    : undefined;
  /* A `field` row may ship its OWN select choices (upstream's exact wording). Those
     are static — no source read — and take precedence over the descriptor's list.
     They also make the row a select from its first render, so the row must not
     start as `undefined` and flicker through a text input. */
  const inlineOptions = row.options;
  /* `[]` before the read resolves, not `undefined`, ONLY when an optionsSource is declared:
     a row that declares an `optionsSource` is a select from its first render, so it never
     flickers through a text input while the source is still being read.
     A row WITHOUT optionsSource or inline options must pass undefined so number/string fields are not turned into selects. */
  const [choices, setChoices] = useState<readonly SelectOption[] | undefined>(
    inlineOptions !== undefined
      ? inlineOptions
      : hasOptionsSource
        ? []
        : undefined,
  );

  useEffect(() => {
    /* Inline options are static: the effect has nothing to read. */
    if (inlineOptions !== undefined) {
      setChoices(inlineOptions);
      return;
    }
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
  }, [read, options, inlineOptions]);

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
