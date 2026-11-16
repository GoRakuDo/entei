/**
 * module-registry unit tests — the `*.module.json` spec + the merged registry.
 *
 * Covers:
 * - the built-in manifests (5 core modules, all built-in / default-on)
 * - Yomitan ships its own 18-section Chrome-compatible settings tree
 * - imported manifests: validation is fail-closed (malformed → rejected)
 * - the merge order (built-ins first, then imported)
 * - a rejected / corrupted import store never breaks the registry
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_MODULES,
  MODULE_IMPORTS_KEY,
  MODULE_MANIFEST_VERSION,
  getRegisteredModules,
  hasSettingsSchema,
  normalizeSectionLayouts,
  parseModuleManifest,
  readImportedModules,
} from '@/features/modules/module-registry';

/** A minimal valid imported manifest. */
function validImport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'community-dict',
    name: 'Community Dictionary',
    description: 'An imported community module.',
    version: '1.0.0',
    author: 'Someone',
    category: 'dictionary',
    ...overrides,
  };
}

describe('module-registry — core manifests', () => {
  it('ships the five official core modules in registry order', () => {
    expect(CORE_MODULES.map((module) => module.id)).toEqual([
      'ytdlp',
      'torrent',
      'yomitan',
      'jimaku',
      'nadeshiko',
    ]);
  });

  it('marks every core module built-in and default-enabled', () => {
    expect(CORE_MODULES.every((module) => module.builtIn)).toBe(true);
    expect(CORE_MODULES.every((module) => module.defaultEnabled)).toBe(true);
    expect(
      CORE_MODULES.every(
        (module) => module.manifestVersion === MODULE_MANIFEST_VERSION,
      ),
    ).toBe(true);
  });

  it('categorises source and dictionary modules', () => {
    const byId = Object.fromEntries(
      CORE_MODULES.map((module) => [module.id, module.category]),
    );
    expect(byId.ytdlp).toBe('source');
    expect(byId.torrent).toBe('source');
    expect(byId.jimaku).toBe('source');
    expect(byId.yomitan).toBe('dictionary');
    expect(byId.nadeshiko).toBe('dictionary');
  });

  it('uses dictionary keys for built-in copy (localizable)', () => {
    for (const module of CORE_MODULES) {
      expect(typeof module.nameKey).toBe('string');
      expect(typeof module.descriptionKey).toBe('string');
      expect(module.name).toBeUndefined();
    }
  });

  it('ships the 18-section Chrome-compatible settings tree in yomitan', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    expect(hasSettingsSchema(yomitan)).toBe(true);
    expect(yomitan?.settingsSchema).toHaveLength(18);
    // Chrome-parity section order (general → debug).
    expect(yomitan?.settingsSchema?.[0]?.key).toBe('general');
    expect(
      yomitan?.settingsSchema?.[yomitan.settingsSchema.length - 1]?.key,
    ).toBe('debug');
  });

  it('every settings-tree field carries a dot-path key and a default', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    const fields = (yomitan?.settingsSchema ?? []).flatMap((section) =>
      section.groups.flatMap((group) => group.fields),
    );
    expect(fields.length).toBeGreaterThan(100);
    for (const field of fields) {
      expect(field.key.length).toBeGreaterThan(0);
      expect('default' in field).toBe(true);
    }
  });

  it('declares its Dictionaries and Scanning section layouts in yomitan.module.json, not in code', () => {
    // The manifest decides which sections draw themselves and with which standard
    // layouts; the page resolves each row's layout + host-owned data source.
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    expect(yomitan?.sectionLayouts?.[0]).toEqual({
      section: 'dictionaries',
      rows: [
        {
          layout: 'list',
          field: 'dictionaries',
          source: 'yomitan-dictionaries',
          copy: 'dictionaries',
          label: 'Installed Dictionaries',
          description:
            'Dictionary entries are managed at runtime. The settings tree exposes per-dictionary fields once a dictionary is installed.',
        },
        {
          layout: 'field',
          field: 'global.database.prefixWildcardsSupported',
          label: 'Enable support for prefix wildcard searches',
        },
        {
          layout: 'usage',
          source: 'yomitan-dictionaries',
          label: 'Storage',
          usage: 'Yomitan is using approximately {used} of {total}.',
          action: 'Refresh',
        },
        {
          layout: 'field',
          field: 'general.sortFrequencyDictionary',
          optionsSource: 'yomitan-dictionaries',
          label: 'Frequency sorting dictionary',
          description: 'Sort results using a frequency dictionary.',
          none: 'None',
        },
      ],
    });

    /* The Scanning section is laid out too. Its first row is a HOST-DECLARED
       VIRTUAL FIELD (a scan modifier lives inside Yomitan's `scanning.inputs[]`
       array, so it is not a tree field of its own — the row declares its
       control), and its second is the `inputs` layout that edits that very
       array, one card per definition. */
    const scanning = yomitan?.sectionLayouts?.[1];
    expect(scanning?.section).toBe('scanning');
    expect(scanning?.rows[0]).toEqual({
      layout: 'field',
      field: 'scanning.modifierKey',
      type: 'select',
      optionsSource: 'yomitan-scan-modifier-keys',
      label: 'Scan modifier key',
      description: 'Hold a key while moving the cursor to scan text.',
    });
    expect(scanning?.rows[1]).toEqual({
      layout: 'inputs',
      field: 'scanning.inputs',
      source: 'yomitan-scan-inputs',
      copy: 'scanningInputs',
      label: 'Configure advanced scanning inputs...',
      description:
        'Scanning inputs are used to define when text scanning should occur.',
    });
    /* Every row of a laid-out section carries its own English text (that surface
       is the upstream tool's own UI, which the app does not translate). */
    for (const layout of yomitan?.sectionLayouts ?? []) {
      for (const row of layout.rows) {
        if (row.layout === 'usage') {
          expect(row.action).toBeTruthy();
          continue;
        }
        if (row.source === 'yomitan-popup-preview') {
          continue;
        }
        expect(row.label).toBeTruthy();
      }
    }

    // And the declaration really lives in the JSON document.
    const document = JSON.parse(
      fs.readFileSync(
        fileURLToPath(
          new URL('../src/modules/yomitan/yomitan.module.json', import.meta.url),
        ),
        'utf-8',
      ),
    ) as { sectionLayouts?: unknown };
    expect(document.sectionLayouts).toEqual(yomitan?.sectionLayouts);
  });

  it('leaves sectionLayouts empty for modules that declare none', () => {
    const ytdlp = CORE_MODULES.find((module) => module.id === 'ytdlp');
    expect(ytdlp?.sectionLayouts).toEqual([]);
    const torrent = CORE_MODULES.find((module) => module.id === 'torrent');
    expect(torrent?.sectionLayouts).toEqual([]);
  });

  it('declares Jimaku and Nadeshiko settings in their own manifests', () => {
    // Both used to be hand-written React cards on the settings page. The row
    // text is the manifest's own English and the API-key row names a HOST-owned
    // data source, because the key lives in that module's own store — nothing
    // about either module is written in the page any more.
    const modulesDir = fileURLToPath(
      new URL('../src/modules', import.meta.url),
    );

    const cases = [
      { id: 'jimaku', directory: 'jimaku', file: 'jimaku.module.json', source: 'jimaku-api-key' },
      {
        id: 'nadeshiko',
        directory: 'nadeshiko',
        file: 'nadeshiko.module.json',
        source: 'nadeshiko-api-key',
      },
    ] as const;

    for (const { id, directory, file, source } of cases) {
      const manifest = CORE_MODULES.find((module) => module.id === id);
      expect(manifest?.hasSettings).toBe(true);

      // One section, whose API-key field is drawn by the host-owned editor.
      const schema = manifest?.settingsSchema ?? [];
      expect(schema.length).toBeGreaterThan(0);
      const fields = schema.flatMap((section) =>
        section.groups.flatMap((group) => group.fields),
      );
      const apiKey = fields.find((field) => field.key === 'apiKey');
      expect(apiKey?.type).toBe('password');
      expect(apiKey?.label).toBeTruthy();

      const layout = manifest?.sectionLayouts?.[0];
      expect(layout?.section).toBe(schema[0]?.key);
      const apiRow = layout?.rows?.find((r) => r.field === 'apiKey');
      expect(apiRow).toEqual({ layout: 'field', field: 'apiKey', source });

      // And the declaration really lives in the JSON document.
      const document = JSON.parse(
        fs.readFileSync(
          path.join(modulesDir, directory, file),
          'utf-8',
        ),
      ) as { sectionLayouts?: unknown; hasSettings?: unknown };
      expect(document.hasSettings).toBe(true);
      expect(document.sectionLayouts).toEqual(manifest?.sectionLayouts);
    }
  });

  it('loads iconPath from individual *.module.json files and falls back icon to Blocks', () => {
    const ytdlp = CORE_MODULES.find((m) => m.id === 'ytdlp');
    expect(ytdlp?.iconPath).toBe('/icons/modules/ytdlp.png');
    expect(ytdlp?.icon).toBe('Blocks');

    const torrent = CORE_MODULES.find((m) => m.id === 'torrent');
    expect(torrent?.iconPath).toBe('/icons/modules/torrent.svg');
    expect(torrent?.icon).toBe('Blocks');

    const yomitan = CORE_MODULES.find((m) => m.id === 'yomitan');
    expect(yomitan?.iconPath).toBe('/icons/modules/yomitan.png');
    expect(yomitan?.hasSettings).toBe(true);

    const jimaku = CORE_MODULES.find((m) => m.id === 'jimaku');
    expect(jimaku?.iconPath).toBe('/icons/modules/jimaku.png');

    const nadeshiko = CORE_MODULES.find((m) => m.id === 'nadeshiko');
    expect(nadeshiko?.iconPath).toBe('/icons/modules/nadeshiko.webp');
  });

  it('reflects builtIn / defaultEnabled exactly as written in each *.module.json', () => {
    // The registry must not override the manifest's own flags: a document may
    // legitimately ship a module disabled, and a hard-coded `builtIn: true`
    // would hide that. Every iconPath must also resolve to a real asset, so a
    // manifest can never point at a file that was deleted.
    const modulesDir = fileURLToPath(new URL('../src/modules', import.meta.url));
    const publicDir = fileURLToPath(new URL('../public', import.meta.url));
    const documents: Record<string, unknown>[] = [];

    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(modulesDir, entry.name);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.module.json')) continue;
        const content = fs.readFileSync(path.join(dir, name), 'utf-8');
        documents.push(JSON.parse(content) as Record<string, unknown>);
      }
    }

    expect(documents).toHaveLength(CORE_MODULES.length);

    for (const document of documents) {
      const id = typeof document.id === 'string' ? document.id : '';
      const iconPath =
        typeof document.iconPath === 'string' ? document.iconPath : '';
      const manifest = CORE_MODULES.find((module) => module.id === id);

      expect(manifest?.builtIn).toBe(document.builtIn ?? true);
      expect(manifest?.defaultEnabled).toBe(document.defaultEnabled ?? true);
      expect(manifest?.iconPath).toBe(iconPath);
      expect(fs.existsSync(path.join(publicDir, iconPath))).toBe(true);
    }
  });
});

describe('module-registry — manifest validation', () => {
  it('accepts a well-formed imported manifest', () => {
    const result = parseModuleManifest(validImport());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Imported modules default OFF and are never marked built-in.
    expect(result.manifest.builtIn).toBe(false);
    expect(result.manifest.defaultEnabled).toBe(false);
    expect(result.manifest.id).toBe('community-dict');
  });

  it('rejects a non-object', () => {
    expect(parseModuleManifest(null).ok).toBe(false);
    expect(parseModuleManifest('manifest').ok).toBe(false);
    expect(parseModuleManifest(42).ok).toBe(false);
  });

  it('rejects a missing or malformed id', () => {
    expect(parseModuleManifest(validImport({ id: '' })).ok).toBe(false);
    expect(parseModuleManifest(validImport({ id: '   ' })).ok).toBe(false);
    expect(parseModuleManifest(validImport({ id: 'Bad Id' })).ok).toBe(false);
    expect(parseModuleManifest(validImport({ id: 'UPPER' })).ok).toBe(false);
    expect(parseModuleManifest(validImport({ id: '-leading' })).ok).toBe(false);
  });

  it('rejects an id that collides with a built-in module', () => {
    const result = parseModuleManifest(validImport({ id: 'yomitan' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('collides');
  });

  it('rejects missing version / author / name', () => {
    expect(parseModuleManifest(validImport({ version: '' })).ok).toBe(false);
    expect(parseModuleManifest(validImport({ author: '' })).ok).toBe(false);
    expect(parseModuleManifest(validImport({ name: '' })).ok).toBe(false);
  });

  it('rejects an unknown category', () => {
    expect(parseModuleManifest(validImport({ category: 'plugin' })).ok).toBe(
      false,
    );
  });

  it('keeps a well-formed imported section layout', () => {
    const result = parseModuleManifest(
      validImport({
        sectionLayouts: [
          {
            section: 'items',
            rows: [
              {
                layout: 'list',
                field: 'items',
                source: 'host-items',
                copy: 'items',
                label: 'Installed items',
              },
            ],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.sectionLayouts).toEqual([
      {
        section: 'items',
        rows: [
          {
            layout: 'list',
            field: 'items',
            source: 'host-items',
            copy: 'items',
            label: 'Installed items',
          },
        ],
      },
    ]);
  });
});

describe('module-registry — sectionLayouts normalisation', () => {
  it('drops malformed rows instead of half-applying them', () => {
    expect(normalizeSectionLayouts(undefined)).toEqual([]);
    expect(normalizeSectionLayouts('nope')).toEqual([]);
    expect(
      normalizeSectionLayouts([
        null,
        42,
        {},
        { section: '  ', rows: [{ layout: 'field', field: 'general.api' }] },
        { section: 'items', rows: 'nope' },
        { section: 'items', rows: [] },
      ]),
    ).toEqual([]);
  });

  it('drops a section whose rows are all unusable', () => {
    expect(
      normalizeSectionLayouts([
        {
          section: 'items',
          rows: [
            null,
            42,
            {},
            { layout: 'carousel', field: 'items' },
            { layout: 'field' },
            { layout: 'list', field: 'items' },
            { layout: 'usage' },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it('trims ids and keeps only the copy/text fields a row carries', () => {
    expect(
      normalizeSectionLayouts([
        {
          section: '  items  ',
          rows: [
            {
              layout: ' list ',
              field: '  items  ',
              source: ' host-items ',
              copy: '  items  ',
              label: '  title  ',
              description: '   ',
            },
          ],
        },
      ]),
    ).toEqual([
      {
        section: 'items',
        rows: [
          {
            layout: 'list',
            field: 'items',
            source: 'host-items',
            copy: 'items',
            label: 'title',
          },
        ],
      },
    ]);
  });
});

describe('module-registry — `selects` rows (paired mini-labelled selects)', () => {
  it('keeps every control of a well-formed row, with its own choices', () => {
    expect(
      normalizeSectionLayouts([
        {
          section: 'popup-appearance',
          rows: [
            {
              layout: 'selects',
              label: 'Theme',
              description: 'Adjust the style of Yomitan.',
              selects: [
                {
                  label: 'Body',
                  field: 'general.popupTheme',
                  options: [
                    { value: 'site', label: 'Auto' },
                    { value: 'light', label: 'Light' },
                  ],
                },
                {
                  label: 'Shadow',
                  field: 'general.popupOuterTheme',
                  options: [{ value: 'none', label: 'None' }],
                },
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        section: 'popup-appearance',
        rows: [
          {
            layout: 'selects',
            label: 'Theme',
            description: 'Adjust the style of Yomitan.',
            selects: [
              {
                label: 'Body',
                field: 'general.popupTheme',
                options: [
                  { value: 'site', label: 'Auto' },
                  { value: 'light', label: 'Light' },
                ],
              },
              {
                label: 'Shadow',
                field: 'general.popupOuterTheme',
                options: [{ value: 'none', label: 'None' }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('drops a control with no field, no label or no usable choice, and a row left with none', () => {
    expect(
      normalizeSectionLayouts([
        {
          section: 'items',
          rows: [
            /* No controls at all — the row would draw an empty box. */
            { layout: 'selects', label: 'Theme' },
            {
              layout: 'selects',
              label: 'Action bar appearance',
              selects: [
                {
                  label: 'Visibility',
                  options: [{ value: 'auto', label: 'Auto' }],
                },
                {
                  label: 'Location',
                  field: 'general.popupActionBarLocation',
                  options: [],
                },
                { field: 'general.x', options: [{ value: 'a', label: 'A' }] },
                {
                  label: 'Y',
                  field: 'general.y',
                  options: [{ value: '', label: '' }],
                },
                /* Kept: the one usable control of the row. */
                {
                  label: 'Mode',
                  field: 'general.mode',
                  options: [{ value: 'a', label: 'A' }],
                },
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        section: 'items',
        rows: [
          {
            layout: 'selects',
            label: 'Action bar appearance',
            selects: [
              {
                label: 'Mode',
                field: 'general.mode',
                options: [{ value: 'a', label: 'A' }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('replaces Yomitan’s two separate theme rows with the upstream paired ones', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    const appearance = yomitan?.sectionLayouts?.find(
      (layout) => layout.section === 'popup-appearance',
    );
    const theme = appearance?.rows.find((row) => row.label === 'Theme');
    expect(theme?.layout).toBe('selects');
    expect(theme?.selects?.map((item) => item.field)).toEqual([
      'general.popupTheme',
      'general.popupOuterTheme',
    ]);
    // Upstream's own wording: `site` reads as `Auto`, and it comes first.
    expect(theme?.selects?.[0]?.options?.map((option) => option.value)).toEqual(
      ['site', 'light', 'dark', 'browser'],
    );

    const actionBar = appearance?.rows.find(
      (row) => row.label === 'Action bar appearance',
    );
    expect(actionBar?.selects?.map((item) => item.field)).toEqual([
      'general.popupActionBarVisibility',
      'general.popupActionBarLocation',
    ]);

    // The old standalone rows are gone: the paired row owns both paths.
    const paths = (appearance?.rows ?? []).flatMap((row) =>
      row.field === undefined ? [] : [row.field],
    );
    expect(paths).not.toContain('general.popupTheme');
    expect(paths).not.toContain('general.popupOuterTheme');
  });
});

describe('module-registry — `checkboxes` rows (grouped mini-labelled booleans)', () => {
  it('keeps every checkbox of a well-formed row', () => {
    expect(
      normalizeSectionLayouts([
        {
          section: 'popup-appearance',
          rows: [
            {
              layout: 'checkboxes',
              label: 'Pitch accent display styles',
              description: 'Japanese only.',
              checkboxes: [
                {
                  label: 'Downstep notation',
                  field: 'general.showPitchAccentDownstepNotation',
                },
                {
                  label: 'Downstep position',
                  field: 'general.showPitchAccentPositionNotation',
                },
                { label: 'Graph', field: 'general.showPitchAccentGraph' },
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        section: 'popup-appearance',
        rows: [
          {
            layout: 'checkboxes',
            label: 'Pitch accent display styles',
            description: 'Japanese only.',
            checkboxes: [
              {
                label: 'Downstep notation',
                field: 'general.showPitchAccentDownstepNotation',
              },
              {
                label: 'Downstep position',
                field: 'general.showPitchAccentPositionNotation',
              },
              { label: 'Graph', field: 'general.showPitchAccentGraph' },
            ],
          },
        ],
      },
    ]);
  });

  it('drops a checkbox with no field or no label, and a row left with none', () => {
    expect(
      normalizeSectionLayouts([
        {
          section: 'items',
          rows: [
            /* No checkboxes at all — the row would draw an empty box. */
            { layout: 'checkboxes', label: 'Empty' },
            {
              layout: 'checkboxes',
              label: 'Pitch accent display styles',
              checkboxes: [
                { label: 'No field' },
                { field: 'general.showPitchAccentGraph' },
                { label: 'Graph', field: 'general.showPitchAccentGraph' },
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        section: 'items',
        rows: [
          {
            layout: 'checkboxes',
            label: 'Pitch accent display styles',
            checkboxes: [
              { label: 'Graph', field: 'general.showPitchAccentGraph' },
            ],
          },
        ],
      },
    ]);
  });

  /* The Appearance section ships the pitch-accent group upstream draws. */
  it('exposes the pitch-accent checkbox group on the Yomitan manifest', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    const appearance = yomitan?.sectionLayouts?.find(
      (layout) => layout.section === 'popup-appearance',
    );
    const pitch = appearance?.rows.find(
      (row) => row.label === 'Pitch accent display styles',
    );
    expect(pitch?.layout).toBe('checkboxes');
    expect(pitch?.checkboxes?.map((item) => item.field)).toEqual([
      'general.showPitchAccentDownstepNotation',
      'general.showPitchAccentPositionNotation',
      'general.showPitchAccentGraph',
    ]);
    expect(pitch?.checkboxes?.map((item) => item.label)).toEqual([
      'Downstep notation',
      'Downstep position',
      'Graph',
    ]);
  });
});

describe('module-registry — `field` rows with literal options', () => {
  it('keeps a field row’s own choices, dropping a malformed one', () => {
    expect(
      normalizeSectionLayouts([
        {
          section: 'popup-appearance',
          rows: [
            {
              layout: 'field',
              field: 'general.glossaryLayoutMode',
              label: 'Compact glossaries',
              options: [
                { value: 'default', label: 'Default' },
                { value: 'compact', label: 'Compact Popup' },
                { value: 'compact-popup-anki', label: 'Compact Popup and Anki' },
                { value: '', label: '' },
                { label: 'no value' },
              ],
            },
            /* No usable choice — the row keeps no `options` (descriptor fallback). */
            {
              layout: 'field',
              field: 'general.termDisplayMode',
              options: [{ value: '', label: '' }],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        section: 'popup-appearance',
        rows: [
          {
            layout: 'field',
            field: 'general.glossaryLayoutMode',
            label: 'Compact glossaries',
            options: [
              { value: 'default', label: 'Default' },
              { value: 'compact', label: 'Compact Popup' },
              { value: 'compact-popup-anki', label: 'Compact Popup and Anki' },
            ],
          },
          { layout: 'field', field: 'general.termDisplayMode' },
        ],
      },
    ]);
  });

  /* The Appearance section ships the upstream-exact select wording. */
  it('carries upstream’s exact option labels on the Yomitan manifest', () => {
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    const appearance = yomitan?.sectionLayouts?.find(
      (layout) => layout.section === 'popup-appearance',
    );
    const indicator = appearance?.rows.find(
      (row) => row.field === 'general.popupCurrentIndicatorMode',
    );
    expect(indicator?.options?.map((option) => option.label)).toEqual([
      'None',
      'Asterisk',
      'Triangle',
      'Vertical bar (left)',
      'Vertical bar (right)',
      'Small dot (left)',
      'Small dot (right)',
    ]);
  });
});

describe('module-registry — merged registry', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('equals the built-ins when nothing is imported', () => {
    expect(getRegisteredModules().map((module) => module.id)).toEqual(
      CORE_MODULES.map((module) => module.id),
    );
  });

  it('appends imported manifests after the built-ins', () => {
    localStorage.setItem(
      MODULE_IMPORTS_KEY,
      JSON.stringify({ version: MODULE_MANIFEST_VERSION, modules: [validImport()] }),
    );
    const ids = getRegisteredModules().map((module) => module.id);
    expect(ids).toEqual([
      'ytdlp',
      'torrent',
      'yomitan',
      'jimaku',
      'nadeshiko',
      'community-dict',
    ]);
  });

  it('drops invalid entries but keeps the valid ones', () => {
    localStorage.setItem(
      MODULE_IMPORTS_KEY,
      JSON.stringify({
        version: MODULE_MANIFEST_VERSION,
        modules: [validImport(), validImport({ id: 'torrent' })],
      }),
    );
    const imported = readImportedModules();
    expect(imported).toHaveLength(1);
    expect(imported[0]?.id).toBe('community-dict');
  });

  it('survives a corrupted import store', () => {
    localStorage.setItem(MODULE_IMPORTS_KEY, '{not json');
    expect(readImportedModules()).toEqual([]);
    expect(getRegisteredModules()).toHaveLength(CORE_MODULES.length);
  });

  it('survives a structurally wrong import store', () => {
    localStorage.setItem(MODULE_IMPORTS_KEY, JSON.stringify({ modules: 'no' }));
    expect(readImportedModules()).toEqual([]);
  });
});