/**
 * EizouDenSettingsTab — YouTube download mode tab tests.
 * ---------------------------------------------------------------------------
 * Covers: renders both modes with labels, default quality selected, switching
 * to Speed persists to localStorage, switching back to Quality.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EizouDenSettingsTab } from '../src/components/player/EizouDenSettingsTab';
import { YT_MODE_KEY } from '../src/features/player/yt-download-mode';

const dict = {
  settingsTabEizouDen: 'EizouDen',
  ytModeQuality: 'Quality (quality first)',
  ytModeSpeed: 'Speed (instant playback)',
  ytModeQualityDesc: 'Download DASH 1080p',
  ytModeSpeedDesc: 'Play while downloading',
} as const;

function findRadio(container: HTMLElement, value: string) {
  return container.querySelector<HTMLButtonElement>(
    `[data-slot="radio-group-item"][value="${value}"]`,
  );
}

describe('EizouDenSettingsTab', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it('renders both mode options with labels', () => {
    render(<EizouDenSettingsTab dict={dict} />);
    expect(screen.getByText(dict.ytModeQuality)).toBeInTheDocument();
    expect(screen.getByText(dict.ytModeSpeed)).toBeInTheDocument();
    expect(screen.getByText(dict.ytModeQualityDesc)).toBeInTheDocument();
    expect(screen.getByText(dict.ytModeSpeedDesc)).toBeInTheDocument();
  });

  it('defaults to quality (no localStorage value)', () => {
    const { container } = render(<EizouDenSettingsTab dict={dict} />);
    const quality = findRadio(container, 'quality');
    const speed = findRadio(container, 'speed');
    expect(quality).not.toBeNull();
    expect(speed).not.toBeNull();
    expect(quality!.getAttribute('data-state')).toBe('checked');
    expect(speed!.getAttribute('data-state')).not.toBe('checked');
  });

  it('switching to Speed persists the mode to localStorage', () => {
    const { container } = render(<EizouDenSettingsTab dict={dict} />);
    fireEvent.click(findRadio(container, 'speed')!);
    expect(JSON.parse(localStorage.getItem(YT_MODE_KEY) ?? 'null')).toBe(
      'speed',
    );
  });

  it('switching back to Quality persists quality', () => {
    const { container } = render(<EizouDenSettingsTab dict={dict} />);
    fireEvent.click(findRadio(container, 'speed')!);
    fireEvent.click(findRadio(container, 'quality')!);
    expect(JSON.parse(localStorage.getItem(YT_MODE_KEY) ?? 'null')).toBe(
      'quality',
    );
  });
});