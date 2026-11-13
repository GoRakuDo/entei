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
  normalizeListFields,
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

  it('only yomitan ships a settings tree, and it has all 18 sections', () => {
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

  it('declares its installed-item list in yomitan.module.json, not in code', () => {
    // The manifest decides which field draws through the standard list layout;
    // the page resolves the layout + the host-owned data source from this.
    const yomitan = CORE_MODULES.find((module) => module.id === 'yomitan');
    expect(yomitan?.listFields).toEqual([
      {
        field: 'dictionaries',
        layout: 'list-manager',
        source: 'yomitan-dictionaries',
      },
    ]);

    // And the declaration really lives in the JSON document.
    const document = JSON.parse(
      fs.readFileSync(
        fileURLToPath(
          new URL('../src/modules/yomitan/yomitan.module.json', import.meta.url),
        ),
        'utf-8',
      ),
    ) as { listFields?: unknown };
    expect(document.listFields).toEqual(yomitan?.listFields);
  });

  it('leaves listFields empty for modules that declare none', () => {
    const jimaku = CORE_MODULES.find((module) => module.id === 'jimaku');
    expect(jimaku?.listFields).toEqual([]);
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

  it('keeps a well-formed imported list binding', () => {
    const result = parseModuleManifest(
      validImport({
        listFields: [
          { field: 'items', layout: 'list-manager', source: 'host-items' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.listFields).toEqual([
      { field: 'items', layout: 'list-manager', source: 'host-items' },
    ]);
  });
});

describe('module-registry — listFields normalisation', () => {
  it('drops malformed bindings instead of half-applying them', () => {
    expect(normalizeListFields(undefined)).toEqual([]);
    expect(normalizeListFields('nope')).toEqual([]);
    expect(
      normalizeListFields([
        null,
        42,
        {},
        { field: '  ', layout: 'list-manager', source: 'host' },
        { field: 'items', layout: '', source: 'host' },
        { field: 'items', layout: 'carousel', source: 'host' },
        { field: 'items', layout: 'list-manager', source: '   ' },
        { field: 'items', layout: 'list-manager' },
      ]),
    ).toEqual([]);
  });

  it('trims field and source ids', () => {
    expect(
      normalizeListFields([
        { field: '  items  ', layout: 'list-manager', source: ' host-items ' },
      ]),
    ).toEqual([{ field: 'items', layout: 'list-manager', source: 'host-items' }]);
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