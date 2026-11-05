/**
 * ImmersionToolsDialog — the Immersion Tools shelf (MODULE_ARCHITECTURE.md §4).
 * ---------------------------------------------------------------------------
 * Replaces the former direct "Player" navigation entry. Clicking the trigger
 * opens a drawer that lists every immersion tool the platform ships:
 *
 *   - 動画プレイヤー      → /player/
 *   - 音声プレイヤー      → /audio-player/
 *   - モジュール管理      → /modules/
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
  Clapperboard,
  Headphones,
  Layers,
  type LucideIcon,
} from 'lucide-react';
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

/** Routes owned by the tools shelf — the trigger reads as "current" here. */
const TOOL_ROUTES = ['/player', '/audio-player', '/modules'] as const;

function isToolRoute(path: string | undefined): boolean {
  if (!path) return false;
  const normalised = path === '/' ? '/' : path.replace(/\/+$/, '');
  return TOOL_ROUTES.some(
    (route) => normalised === route || normalised.startsWith(`${route}/`),
  );
}

interface ToolsCard {
  href: string;
  Icon: LucideIcon;
  title: string;
  description: string;
}

function buildCards(dict: Dictionary['toolsDrawer']): ToolsCard[] {
  return [
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
      href: '/modules/',
      Icon: Blocks,
      title: dict.modulesTitle,
      description: dict.modulesDescription,
    },
  ];
}

export function ImmersionToolsDialog({
  label,
  variant,
  dict,
  currentPath = '/',
}: ImmersionToolsDialogProps) {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState({ trigger: label, dict });

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
  const cards = buildCards(copy.dict);

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
          {cards.map(({ href, Icon, title, description }) => (
            <li key={href} className="entei-tools-drawer-item">
              <a
                className="entei-tools-card"
                href={href}
                data-entei-tools-card={href}
                onClick={() => setOpen(false)}
              >
                <span className="entei-tools-card-icon" aria-hidden="true">
                  <Icon size={20} />
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
