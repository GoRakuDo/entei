/**
 * ModulesDashboard tests — `/modules/` module management screen.
 * ---------------------------------------------------------------------------
 * - renders the three official core modules with localized copy
 * - every module switch starts enabled (defaults) and toggles off
 * - toggling persists the enabled map to `entei.modules.v1`
 * - a stored disabled module renders as disabled on mount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ModulesDashboard } from '@/components/modules/ModulesDashboard';
import { en } from '@/i18n/locales/en';
import {
  MODULES_KEY,
  MODULES_SCHEMA_VERSION,
} from '@/features/modules/modules-store';

beforeEach(() => {
  localStorage.clear();
  global.ResizeObserver = vi.fn(function () {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderDashboard() {
  return render(<ModulesDashboard dict={en.modulesPage} />);
}

describe('ModulesDashboard', () => {
  it('renders the page heading and description', () => {
    renderDashboard();
    expect(
      screen.getByRole('heading', { level: 1, name: en.modulesPage.title }),
    ).toBeTruthy();
    expect(screen.getByText(en.modulesPage.description)).toBeTruthy();
  });

  it('lists the five official core modules', () => {
    renderDashboard();
    expect(screen.getByText(en.modulesPage.ytdlpName)).toBeTruthy();
    expect(screen.getByText(en.modulesPage.torrentName)).toBeTruthy();
    expect(screen.getByText(en.modulesPage.yomitanName)).toBeTruthy();
    expect(screen.getByText(en.modulesPage.jimakuName)).toBeTruthy();
    expect(screen.getByText(en.modulesPage.nadeshikoName)).toBeTruthy();
    expect(screen.getAllByRole('switch')).toHaveLength(5);
  });

  it('starts with every module enabled', () => {
    renderDashboard();
    for (const toggle of screen.getAllByRole('switch')) {
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    }
  });

  it('toggling a module persists the new state', () => {
    renderDashboard();
    const toggle = screen.getByRole('switch', {
      name: en.modulesPage.torrentName,
    });
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const raw = localStorage.getItem(MODULES_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      version: MODULES_SCHEMA_VERSION,
      enabled: {
        ytdlp: true,
        torrent: false,
        yomitan: true,
        jimaku: true,
        nadeshiko: true,
      },
    });
  });

  it('honours a stored disabled module on mount', () => {
    localStorage.setItem(
      MODULES_KEY,
      JSON.stringify({
        version: MODULES_SCHEMA_VERSION,
        enabled: { ytdlp: false, torrent: true, yomitan: true },
      }),
    );
    renderDashboard();
    expect(
      screen
        .getByRole('switch', { name: en.modulesPage.ytdlpName })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('exposes a disabled import entry for future community modules', () => {
    renderDashboard();
    const button = screen.getByRole('button', {
      name: en.modulesPage.importLabel,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(en.modulesPage.importHint)).toBeTruthy();
  });
});
