/**
 * ImmersionToolsDialog tests — MODULE_ARCHITECTURE.md §4.
 * ---------------------------------------------------------------------------
 * - the trigger renders on each nav surface variant and opens the drawer
 * - the drawer lists the three tools (video / audio / modules)
 * - locale changes re-render the drawer copy (React text is outside the
 *   `[data-i18n]` pass)
 * - tool routes mark the trigger active
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from '@testing-library/react';
import { ImmersionToolsDialog } from '@/components/home/ImmersionToolsDialog';
import { en } from '@/i18n/locales/en';
import { ja } from '@/i18n/locales/ja';
import { LOCALE_CHANGE_EVENT } from '@/i18n/locale-events';

beforeEach(() => {
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
});

function renderDialog(
  variant: 'pill' | 'dock' | 'sidebar' = 'pill',
  currentPath = '/',
) {
  return render(
    <ImmersionToolsDialog
      label={en.nav.destinationTools}
      variant={variant}
      dict={en.toolsDrawer}
      currentPath={currentPath}
    />,
  );
}

describe('ImmersionToolsDialog', () => {
  it('renders the localized trigger label', () => {
    renderDialog('sidebar');
    expect(
      screen.getByRole('button', { name: en.nav.destinationTools }),
    ).toBeTruthy();
  });

  it('opens the drawer with the three immersion tools', () => {
    renderDialog();
    fireEvent.click(
      screen.getByRole('button', { name: en.nav.destinationTools }),
    );

    expect(
      screen.getByRole('heading', { name: en.toolsDrawer.title }),
    ).toBeTruthy();
    expect(screen.getByText(en.toolsDrawer.description)).toBeTruthy();

    const hrefs = ['/player/', '/audio-player/', '/modules/'];
    for (const href of hrefs) {
      const card = document.querySelector(`[data-entei-tools-card="${href}"]`);
      expect(card, `missing tools card for ${href}`).not.toBeNull();
    }
    expect(screen.getByText(en.toolsDrawer.videoTitle)).toBeTruthy();
    expect(screen.getByText(en.toolsDrawer.audioTitle)).toBeTruthy();
    expect(screen.getByText(en.toolsDrawer.modulesTitle)).toBeTruthy();
  });

  it('renders both drawer geometry modifiers (media queries pick one)', () => {
    renderDialog();
    fireEvent.click(
      screen.getByRole('button', { name: en.nav.destinationTools }),
    );
    const drawer = document.querySelector('[data-entei-tools-drawer]');
    expect(drawer).not.toBeNull();
    expect(drawer!.classList.contains('entei-tools-drawer--desktop')).toBe(true);
    expect(drawer!.classList.contains('entei-tools-drawer--mobile')).toBe(true);
  });

  it('marks the trigger active on tool routes only', () => {
    renderDialog('pill', '/player/');
    const trigger = document.querySelector('[data-entei-nav-tools]');
    expect(trigger!.getAttribute('data-active')).toBe('true');
    cleanup();

    renderDialog('pill', '/profile/');
    expect(
      document.querySelector('[data-entei-nav-tools]')!.hasAttribute(
        'data-active',
      ),
    ).toBe(false);
  });

  it('re-renders the drawer copy after a locale change', () => {
    renderDialog();
    fireEvent.click(
      screen.getByRole('button', { name: en.nav.destinationTools }),
    );
    expect(screen.getByText(en.toolsDrawer.description)).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(LOCALE_CHANGE_EVENT, {
          detail: { locale: 'ja', dictionary: ja },
        }),
      );
    });

    expect(screen.getByText(ja.toolsDrawer.description)).toBeTruthy();
    expect(screen.getByText(ja.toolsDrawer.videoTitle)).toBeTruthy();
    // The open dialog marks the rest of the document aria-hidden, so the
    // trigger is queried directly rather than by accessible role.
    expect(
      document
        .querySelector('[data-entei-nav-tools]')!
        .getAttribute('aria-label'),
    ).toBe(ja.nav.destinationTools);
  });

  it('closes the drawer when the overlay outside it is clicked', async () => {
    renderDialog();
    fireEvent.click(
      screen.getByRole('button', { name: en.nav.destinationTools }),
    );
    expect(document.querySelector('[data-entei-tools-drawer]')).not.toBeNull();

    // Radix attaches its document pointerdown listener on a 0ms timer, so the
    // click-outside dismissal only works once that macrotask has flushed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const overlay = document.querySelector('.entei-dialog-overlay');
    expect(overlay).not.toBeNull();
    // Radix defers pointer-down dismissal to the following click (so dragging
    // out of the drawer does not close it), so both events are required.
    await act(async () => {
      fireEvent.pointerDown(overlay!);
      fireEvent.click(overlay!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelector('[data-entei-tools-drawer]')).toBeNull();
  });
});
