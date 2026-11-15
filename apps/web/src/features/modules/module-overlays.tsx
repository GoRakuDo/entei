'use client';

/**
 * module-overlays — what a module draws OUTSIDE its own page.
 * ---------------------------------------------------------------------------
 * Most of a module lives behind its own surface (a settings section, a source
 * modal, a player panel). A few things belong to the whole app: a card that
 * floats over whatever the user is pointing at, a badge, a global listener with
 * something to show. Those are OVERLAYS, and this is the host that draws them.
 *
 * THE CONVENTION IS THE REGISTRATION. A module that has one ships
 * `src/modules/<id>/overlay.tsx` with a default-exported React component, and it
 * appears here — no manifest field to keep in sync, no host-side list of module
 * ids, and nothing in `BaseLayout` / `PlayerLayout` that names a module. The
 * layouts mount `<EnteiModuleOverlays />` once; which overlays that turns into is
 * answered by the registry and the user's enabled state at runtime.
 *
 * LAZY BY CONSTRUCTION. The glob below is a map of LOADERS, so a disabled
 * module's overlay is never fetched and a module the user installs later needs no
 * rebuild of this file. Each entry is resolved by the id its manifest already
 * carries, which is what keeps the app from holding a name of its own.
 *
 * SUSPENDED PER OVERLAY, not as one boundary: an overlay still being fetched must
 * not hold back (or blank out) the one next to it.
 * ---------------------------------------------------------------------------
 */

import { lazy, Suspense, useMemo } from 'react';
import type { ComponentType } from 'react';
import { useModuleRegistry } from '@/features/modules/use-module-registry';

/**
 * Every module's own overlay entry, keyed by module DIRECTORY.
 *
 * Deliberately NOT feature-detected (see `module-registry`): `import.meta.glob`
 * is a compile-time rewrite of the CALL SITE, so `typeof import.meta.glob` is
 * `undefined` at runtime and a guard would silently empty the map.
 *
 * Exported so a test can assert the convention actually resolves for a shipped
 * module, instead of trusting that the glob was rewritten.
 */
export const MODULE_OVERLAYS = import.meta.glob<{
  default: ComponentType;
}>('/src/modules/*/overlay.tsx');

/** Directory overlays are looked for in (the modules' own root). */
export const OVERLAY_ROOT = '/src/modules/';

/** File name a module's overlay entry has, by convention. */
export const OVERLAY_ENTRY_FILE = 'overlay.tsx';

/**
 * Where one module's overlay entry sits.
 *
 * Exported so the address the host looks up is a fact the tests can read rather
 * than a string buried in a template literal.
 */
export function overlayEntryPath(moduleId: string): string {
  return `${OVERLAY_ROOT}${moduleId}/${OVERLAY_ENTRY_FILE}`;
}

/** Loads one module's overlay entry (the shape React's `lazy` takes). */
export type OverlayLoader = () => Promise<{ default: ComponentType }>;

/**
 * One module's overlay loader out of an already-loaded glob map.
 *
 * PURE and map-injected: the resolution — "this id owns exactly this entry, and
 * a module without one simply has none" — is the part worth testing without a
 * bundler, and it is the part that must never fall back to a guess.
 */
export function overlayLoaderFor(
  overlays: Record<string, unknown>,
  moduleId: string,
): OverlayLoader | undefined {
  const load = overlays[overlayEntryPath(moduleId)];
  return typeof load === 'function' ? (load as OverlayLoader) : undefined;
}

/** One overlay to draw, with the component it draws. */
interface MountedOverlay {
  /** Module id — the React key, and the label of anything reported about it. */
  id: string;
  /** The module's own default export, loaded on demand. */
  Component: ComponentType;
}

/**
 * Which registered modules mount an overlay, in registry order.
 *
 * PURE, with the map injected: the gate is "registered, not switched off, and
 * actually ships an entry", and it is the one decision a layout must never make
 * again. An unknown id in the enabled map counts as enabled (the same rule
 * `modules-store` and the player gates use), so a module whose state the user has
 * never touched draws what its manifest's `defaultEnabled` says.
 */
export function enabledOverlayIds(
  modules: readonly { id: string }[],
  enabled: Readonly<Record<string, boolean>>,
  overlays: Record<string, unknown> = MODULE_OVERLAYS,
): string[] {
  return modules.flatMap((module) => {
    if (enabled[module.id] === false) return [];
    return overlayLoaderFor(overlays, module.id) === undefined ? [] : [module.id];
  });
}

/** The overlays the registry and the user's enabled state ask for. */
export function useModuleOverlays(
  modules: readonly { id: string }[],
  enabled: Readonly<Record<string, boolean>>,
): MountedOverlay[] {
  return useMemo(
    () =>
      enabledOverlayIds(modules, enabled).flatMap((id) => {
        const load = overlayLoaderFor(MODULE_OVERLAYS, id);
        if (load === undefined) return [];
        return [{ id, Component: lazy(load) }];
      }),
    [modules, enabled],
  );
}

/**
 * Draw every enabled module's overlay. Renders nothing when none has one — the
 * usual case, since most modules are a page of their own.
 */
export function EnteiModuleOverlays() {
  const { modules, enabled } = useModuleRegistry();
  const overlays = useModuleOverlays(modules, enabled);

  if (overlays.length === 0) return null;

  return (
    <>
      {overlays.map(({ id, Component }) => (
        <Suspense key={id} fallback={null}>
          <Component />
        </Suspense>
      ))}
    </>
  );
}