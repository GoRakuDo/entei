/**
 * ImmersionToolsDialog — the Immersion Tools shelf (MODULE_ARCHITECTURE.md §4).
 * ---------------------------------------------------------------------------
 * Replaces the former direct "Player" navigation entry. Clicking the trigger
 * opens a drawer that lists every immersion tool the platform ships:
 *
 *   - 動画プレイヤー      → /player/
 *   - 音声プレイヤー      → /audio-player/
 *   - モジュール管理      → /settings/?group=module
 *
 * THE LIST IS NOT CLOSED. A module that ships a PAGE of its own declares a `tool`
 * in its manifest, and the drawer appends a card for every enabled one — so
 * Yomitan's `Yomitan Search` (`/search/`) is on the shelf without this file naming
 * Yomitan. `listModuleTools` is that call; the three cards above stay the
 * platform's own destinations, which no module can declare.
 *
 * Module cards are read AFTER mount, not during render: this island is SSR'd
 * (`client:load`) and the enabled state lives in localStorage, which the server
 * cannot see — reading it during render would hydrate a different card list than
 * the server printed. The drawer is closed while that settles, so nothing flickers.
 *
 * Geometry (MODULE_ARCHITECTURE.md §4.1):
 *   - Desktop (≥768px): side sheet sliding in from the LEFT.
 *   - Mobile (<768px): bottom sheet sliding up from the BOTTOM.
 *   Both modifier classes are always rendered; the media queries in
 *   ImmersionToolsDialog.css pick the active geometry, so a viewport resize
 *   (or a phone rotation) never needs a React re-render.
 *
 * The trigger keeps the native nav-link metrics of its surface: the
 * `entei-desktop-sidebar-link` / `entei-desktop-pill-link` /
 * `entei-mobile-dock-link` classes are reused, with the pill and dock
 * variants styled from the island CSS because Astro's scoped rules cannot
 * match client-rendered nodes (same constraint as EizouSettingsDialog).
 *
 * Locale: the drawer copy is rendered by React, so the locale switcher's
 * `[data-i18n]` pass cannot reach it — this island listens to
 * `entei:locale-change` and re-renders with the new dictionary (the
 * data-i18n attributes are still emitted for static markup parity).
 * ---------------------------------------------------------------------------
 */

'use client';

import { useEffect, useState } from 'react';
import {
  Blocks,
  BookOpen,
  BrainCircuit,
  Clapperboard,
  Download,
  Headphones,
  Layers,
  Magnet,
  MessageSquareText,
  Search,
  type LucideIcon,
} from 'lucide-react';
import {
  listModuleTools,
  readModuleState,
  type EnteiModuleToolEntry,
} from '@/features/modules/modules-store';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/player/ui/dialog';
import {
  LOCALE_CHANGE_EVENT,
  type LocaleChangeDetail,
} from '@i18n/locale-events';
import type { Dictionary } from '@i18n/types';
import './ImmersionToolsDialog.css';

export interface ImmersionToolsDialogProps {
  /** Trigger label, localized (nav.destinationTools). */
  label: string;
  /** Nav surface the trigger lives on. */
  variant: 'pill' | 'dock' | 'sidebar';
  /** Drawer copy (all strings — serializable across the island boundary). */
  dict: Dictionary['toolsDrawer'];
  /** Current route, used to mark the trigger active for tool pages. */
  currentPath?: string;
}

/** Routes owned by the tools shelf — the trigger reads as "current" here.
 *  The settings page (/settings/) is NOT a tool surface: it owns its own
 *  nav entry (Pengaturan), so the Immersion Tools trigger must stay resting
 *  there. Only the player routes are marked active. */
const TOOL_ROUTES = ['/player', '/audio-player', '/search'] as const;

function isToolRoute(path: string | undefined): boolean {
  if (!path) return false;
  const normalised = path === '/' ? '/' : path.replace(/\/+$/, '');
  return TOOL_ROUTES.some(
    (route) => normalised === route || normalised.startsWith(`${route}/`),
  );
}

interface ToolsCard {
  href: string;
  title: string;
  description: string;
  /** Glyph of a card the PLATFORM owns. */
  Icon?: LucideIcon;
  /** Icon asset of a card a MODULE declared (`tool.iconPath`). */
  iconPath?: string;
}

/** Lucide glyphs a manifest may name, resolved through the bundle. */
const TOOL_ICONS: Readonly<Record<string, LucideIcon>> = {
  Blocks,
  BookOpen,
  BrainCircuit,
  Download,
  Magnet,
  MessageSquareText,
  Search,
};

/**
 * The glyph of a module card: its manifest's Lucide name, or the shared fallback.
 *
 * An unknown name is not an error — a manifest is data, and a typo must degrade to
 * the generic module glyph rather than to a blank 20px box.
 */
function resolveToolIcon(name: string | undefined): LucideIcon {
  if (name === undefined) return Blocks;
  return TOOL_ICONS[name] ?? Blocks;
}

/**
 * The drawer's cards: the platform's own three, then every enabled module tool.
 *
 * A module whose `href` collides with a card already on the list is SKIPPED: the
 * card list is keyed by href, and two cards navigating to the same route would be
 * a duplicate React key and a duplicate row.
 */
function buildCards(
  dict: Dictionary['toolsDrawer'],
  tools: readonly EnteiModuleToolEntry[],
): ToolsCard[] {
  const cards: ToolsCard[] = [
    {
      href: '/player/',
      Icon: Clapperboard,
      title: dict.videoTitle,
      description: dict.videoDescription,
    },
    {
      href: '/audio-player/',
      Icon: Headphones,
      title: dict.audioTitle,
      description: dict.audioDescription,
    },
    {
      href: '/settings/?group=module',
      Icon: Blocks,
      title: dict.modulesTitle,
      description: dict.modulesDescription,
    },
  ];
  const seen = new Set(cards.map((card) => card.href));
  for (const tool of tools) {
    if (seen.has(tool.href)) continue;
    seen.add(tool.href);
    cards.push({
      href: tool.href,
      title: tool.title,
      description: tool.description,
      Icon: resolveToolIcon(tool.icon),
      ...(tool.iconPath === undefined ? {} : { iconPath: tool.iconPath }),
    });
  }
  return cards;
}

export function ImmersionToolsDialog({
  label,
  variant,
  dict,
  currentPath = '/',
}: ImmersionToolsDialogProps) {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState({ trigger: label, dict });
  const [tools, setTools] = useState<EnteiModuleToolEntry[]>([]);

  /* Module-declared tool cards. Re-read on a cross-tab toggle (the browser fires
     `storage` when another tab flips a module switch), the same way the player's
     islands keep their module gates fresh. */
  useEffect(() => {
    const sync = (): void => setTools(listModuleTools(readModuleState()));
    sync();
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const dictionary = (event as CustomEvent<LocaleChangeDetail>).detail
        ?.dictionary;
      if (!dictionary) return;
      setCopy({
        trigger: dictionary.nav.destinationTools,
        dict: dictionary.toolsDrawer,
      });
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  const active = isToolRoute(currentPath);
  const cards = buildCards(copy.dict, tools);

  const triggerClass =
    variant === 'pill'
      ? 'entei-desktop-pill-link entei-nav-tools-trigger'
      : variant === 'sidebar'
        ? 'entei-desktop-sidebar-link entei-nav-tools-trigger'
        : 'entei-mobile-dock-link entei-nav-tools-trigger';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* DialogTrigger lets Radix remember the trigger node so focus returns
          to it when the drawer closes (keyboard / screen-reader parity). */}
      <DialogTrigger asChild>
        <button
          type="button"
          className={triggerClass}
          aria-label={copy.trigger}
          data-entei-nav-tools
          data-entei-nav-tools-variant={variant}
          data-active={active ? 'true' : undefined}
          onClick={(event) => event.stopPropagation()}
        >
          <Layers aria-hidden="true" className="entei-nav-tools-icon" />
          {/* The pill shows icon + label like the neighbouring Profile / Player
              links; only the mobile dock hides the label via CSS. */}
          <span data-i18n="nav.destinationTools">{copy.trigger}</span>
        </button>
      </DialogTrigger>
      <DialogContent
        closeLabel={copy.dict.close}
        className="entei-tools-drawer entei-tools-drawer--desktop entei-tools-drawer--mobile"
        data-entei-tools-drawer
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <DialogHeader className="entei-tools-drawer-header">
          <DialogTitle data-i18n="toolsDrawer.title">{copy.dict.title}</DialogTitle>
          <DialogDescription data-i18n="toolsDrawer.description">
            {copy.dict.description}
          </DialogDescription>
        </DialogHeader>
        <ul className="entei-tools-drawer-list">
          {cards.map(({ href, Icon, iconPath, title, description }) => (
            <li key={href} className="entei-tools-drawer-item">
              <a
                className="entei-tools-card"
                href={href}
                data-entei-tools-card={href}
                onClick={() => setOpen(false)}
              >
                <span className="entei-tools-card-icon" aria-hidden="true">
                  {/* A module ships its own asset (Yomitan's logo); everything
                      else draws its manifest's Lucide glyph. */}
                  {iconPath !== undefined ? (
                    <img
                      className="entei-tools-card-icon-img"
                      src={iconPath}
                      alt=""
                      width={20}
                      height={20}
                    />
                  ) : Icon !== undefined ? (
                    <Icon size={20} />
                  ) : null}
                </span>
                <span className="entei-tools-card-text">
                  <span className="entei-tools-card-title">{title}</span>
                  <span className="entei-tools-card-description">
                    {description}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
