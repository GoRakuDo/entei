/**
 * Module overlays — how the host finds what a module draws over the whole app.
 * ---------------------------------------------------------------------------
 * The layouts mount one host component and name no module, so the whole contract
 * is the lookup tested here:
 *
 *  - an overlay is addressed by the module's own id (`src/modules/<id>/overlay.tsx`),
 *    which is what keeps a component name out of the app;
 *  - a module without an overlay simply has none — no error, no empty mount;
 *  - the convention really resolves in this runtime (the glob is a compile-time
 *    rewrite, so a runner that did not rewrite it would silently host nothing);
 *  - an enabled module's overlay is loaded on demand, never up front.
 * ---------------------------------------------------------------------------
 */

import { describe, expect, it } from 'bun:test';
import {
  enabledOverlayIds,
  MODULE_OVERLAYS,
  overlayEntryPath,
  overlayLoaderFor,
  OVERLAY_ENTRY_FILE,
  OVERLAY_ROOT,
} from '@/features/modules/module-overlays';

describe('overlayEntryPath — where an overlay lives', () => {
  it('addresses it by the module id alone', () => {
    expect(overlayEntryPath('yomitan')).toBe(
      '/src/modules/yomitan/overlay.tsx',
    );
    expect(OVERLAY_ROOT).toBe('/src/modules/');
    expect(OVERLAY_ENTRY_FILE).toBe('overlay.tsx');
  });
});

describe('overlayLoaderFor — what the registry asks for', () => {
  it('resolves the entry of the id it was given, and only that one', () => {
    const yomitan = () => Promise.resolve({ default: () => null });
    const other = () => Promise.resolve({ default: () => null });
    const entries = {
      [overlayEntryPath('yomitan')]: yomitan,
      [overlayEntryPath('jimaku')]: other,
    };
    expect(overlayLoaderFor(entries, 'yomitan')).toBe(yomitan);
    expect(overlayLoaderFor(entries, 'jimaku')).toBe(other);
  });

  it('answers undefined for a module that ships none', () => {
    expect(overlayLoaderFor({}, 'torrent')).toBeUndefined();
    /* A near miss is a miss: the host must not guess a path. */
    expect(
      overlayLoaderFor({ '/src/modules/yomitan/Overlay.tsx': () => null }, 'yomitan'),
    ).toBeUndefined();
  });

  it('ignores anything in the map that is not a loader', () => {
    expect(
      overlayLoaderFor({ [overlayEntryPath('yomitan')]: 'nope' }, 'yomitan'),
    ).toBeUndefined();
  });
});

describe('MODULE_OVERLAYS — the shipped convention, in this runtime', () => {
  it('resolves the overlay the Yomitan module ships', () => {
    expect(Object.keys(MODULE_OVERLAYS)).toContain(overlayEntryPath('yomitan'));
  });

  it('stays lazy: every entry is a loader, not a component', () => {
    for (const [path, entry] of Object.entries(MODULE_OVERLAYS)) {
      expect(typeof entry, path).toBe('function');
    }
  });
});

describe('enabledOverlayIds — which modules get to draw', () => {
  const REGISTRY = [
    { id: 'ytdlp' },
    { id: 'torrent' },
    { id: 'yomitan' },
    { id: 'nadeshiko' },
  ];
  const OVERLAYS = {
    [overlayEntryPath('yomitan')]: () => Promise.resolve({ default: () => null }),
    [overlayEntryPath('nadeshiko')]: () => Promise.resolve({ default: () => null }),
  };

  it('mounts the overlay of every module that ships one', () => {
    expect(enabledOverlayIds(REGISTRY, {}, OVERLAYS)).toEqual([
      'yomitan',
      'nadeshiko',
    ]);
  });

  it('mounts nothing for a module the user switched off', () => {
    /* The switch that matters: the host does not even fetch a disabled module's
       chunk, and the layout still names no module. */
    expect(
      enabledOverlayIds(REGISTRY, { yomitan: false }, OVERLAYS),
    ).toEqual(['nadeshiko']);
  });

  it('treats a module the user never touched as enabled', () => {
    /* Same rule as `modules-store` and the player gates: only an explicit `false`
       switches a module off. */
    expect(
      enabledOverlayIds([{ id: 'yomitan' }], {}, OVERLAYS),
    ).toEqual(['yomitan']);
  });

  it('mounts nothing when no module ships one', () => {
    expect(enabledOverlayIds(REGISTRY, {}, {})).toEqual([]);
    expect(enabledOverlayIds([], {}, OVERLAYS)).toEqual([]);
  });

  it('asks the SHIPPED map about the shipped modules', () => {
    expect(enabledOverlayIds([{ id: 'yomitan' }], {})).toEqual(['yomitan']);
    expect(enabledOverlayIds([{ id: 'torrent' }], {})).toEqual([]);
  });
});