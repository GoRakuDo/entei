/**
 * EizouDenSettingsTab — YouTube download mode + pairing reset tests.
 * ---------------------------------------------------------------------------
 * Covers: renders both modes with labels, default quality selected, switching
 * to Speed persists to localStorage, switching back to Quality. Plus the
 * ED-3 explicit pairing reset (destructive): control only present when
 * onResetPairing is wired, cancel/confirm dialog flow, graceful divergence
 * when the callback rejects.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EizouDenSettingsTab } from '../src/components/player/EizouDenSettingsTab';
import { YT_MODE_KEY } from '../src/features/player/yt-download-mode';

const dict = {
  settingsTabEizouDen: 'EizouDen',
  settingsEizouDenContentHeading: 'YouTube Playback Mode',
  ytModeQuality: 'Quality (quality first)',
  ytModeSpeed: 'Speed (instant playback)',
  ytModeQualityDesc: 'Download DASH 1080p',
  ytModeSpeedDesc: 'Play while downloading',
  eizouResetButton: 'Reset pairing',
  eizouResetTitle: 'Reset pairing?',
  eizouResetDesc: 'This removes the pairing with the companion app.',
  eizouResetConfirm: 'Reset pairing',
  eizouResetCancel: 'Cancel',
  dialogClose: 'Close',
  eizouPairingOpenButton: 'EizouDendenshi Pairing',
  eizouPairingTitle: 'EizouDendenshi OTP',
  eizouPairingOtpLabel: '6-digit pairing code',
  eizouPairingOtpInvalid: 'Enter the 6-digit code.',
  eizouPairingSubmit: 'Pair',
  eizouPairingConnecting: 'Connecting…',
  eizouPairingErrorNetwork: 'Cannot reach EizouDendenshi.',
  eizouPairingErrorInvalidCode: 'The code is wrong.',
  eizouPairingErrorGeneric: 'Pairing failed.',
  pairingStagePost: '(POST /v1/pair)',
  eizouPairingTutorialPrefix: 'See ',
  eizouPairingTutorialLink: 'here',
  eizouPairingTutorialSuffix: ' for setup.',
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


  it('renders a semantic h3 heading with the content heading text', () => {
    render(<EizouDenSettingsTab dict={dict} />);
    const h3 = screen.getByRole('heading', { level: 3, name: dict.settingsEizouDenContentHeading });
    expect(h3).toBeInTheDocument();
    expect(h3.tagName).toBe('H3');
    expect(h3).toHaveClass('entei-settings-label');
    const radioGroup = screen.getByRole('radiogroup', { name: dict.settingsEizouDenContentHeading });
    expect(radioGroup).toBeInTheDocument();
  });
  it('defaults to speed (no localStorage value)', () => {
    const { container } = render(<EizouDenSettingsTab dict={dict} />);
    const quality = findRadio(container, 'quality');
    const speed = findRadio(container, 'speed');
    expect(quality).not.toBeNull();
    expect(speed).not.toBeNull();
    expect(speed!.getAttribute('data-state')).toBe('checked');
    expect(quality!.getAttribute('data-state')).not.toBe('checked');
  });

  it('switching to Quality persists the mode to localStorage', () => {
    const { container } = render(<EizouDenSettingsTab dict={dict} />);
    fireEvent.click(findRadio(container, 'quality')!);
    expect(JSON.parse(localStorage.getItem(YT_MODE_KEY) ?? 'null')).toBe(
      'quality',
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

describe('EizouDenSettingsTab — explicit pairing reset (ED-3)', () => {
  const onResetPairing = vi.fn(async () => {});

  beforeEach(() => {
    localStorage.clear();
    onResetPairing.mockClear();
  });

  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it('shows the destructive reset control only when onResetPairing is provided', () => {
    const { rerender } = render(<EizouDenSettingsTab dict={dict} />);
    expect(
      screen.queryByRole('button', { name: dict.eizouResetButton }),
    ).not.toBeInTheDocument();

    rerender(
      <EizouDenSettingsTab dict={dict} onResetPairing={onResetPairing} />,
    );
    const resetBtn = screen.getByRole('button', {
      name: dict.eizouResetButton,
    });
    expect(resetBtn).toBeInTheDocument();
    expect(resetBtn.className).toContain('entei-eizouden-reset-btn');
  });

  it('reset requires confirmation: cancel closes the dialog without calling onResetPairing', () => {
    render(<EizouDenSettingsTab dict={dict} onResetPairing={onResetPairing} />);
    fireEvent.click(screen.getByRole('button', { name: dict.eizouResetButton }));
    expect(
      screen.getByRole('dialog', { name: dict.eizouResetTitle }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: dict.eizouResetCancel }));
    expect(
      screen.queryByRole('dialog', { name: dict.eizouResetTitle }),
    ).not.toBeInTheDocument();
    expect(onResetPairing).not.toHaveBeenCalled();
  });

  it('confirm calls onResetPairing once and closes the dialog', async () => {
    render(<EizouDenSettingsTab dict={dict} onResetPairing={onResetPairing} />);
    fireEvent.click(screen.getByRole('button', { name: dict.eizouResetButton }));
    fireEvent.click(screen.getByRole('button', { name: dict.eizouResetConfirm }));
    await waitFor(() => expect(onResetPairing).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: dict.eizouResetTitle }),
      ).not.toBeInTheDocument(),
    );
  });

  it('confirm closes even when the callback rejects (companion unreachable — graceful divergence)', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    render(<EizouDenSettingsTab dict={dict} onResetPairing={failing} />);
    fireEvent.click(screen.getByRole('button', { name: dict.eizouResetButton }));
    fireEvent.click(screen.getByRole('button', { name: dict.eizouResetConfirm }));
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    // The dialog must still close: the browser-side unpaired state is
    // authoritative even when the companion was unreachable.
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: dict.eizouResetTitle }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('EizouDenSettingsTab — pairing entry point (Phase 2 transition)', () => {
  const onPairSuccess = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    onPairSuccess.mockClear();
    // input-otp measures the OTP slots on mount (jsdom has no ResizeObserver).
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    cleanup();
  });

  it('shows the pairing button only when unpaired AND onPairSuccess is wired', () => {
    const { rerender } = render(<EizouDenSettingsTab dict={dict} />);
    expect(
      screen.queryByRole('button', { name: dict.eizouPairingOpenButton }),
    ).not.toBeInTheDocument();

    rerender(<EizouDenSettingsTab dict={dict} onPairSuccess={onPairSuccess} />);
    expect(
      screen.getByRole('button', { name: dict.eizouPairingOpenButton }),
    ).toBeInTheDocument();

    // Already paired: no entry point (reset is the relevant control).
    rerender(
      <EizouDenSettingsTab
        dict={dict}
        onPairSuccess={onPairSuccess}
        isPaired={true}
      />,
    );
    expect(
      screen.queryByRole('button', { name: dict.eizouPairingOpenButton }),
    ).not.toBeInTheDocument();
  });

  it('opens the OTP pairing dialog from the button', () => {
    render(<EizouDenSettingsTab dict={dict} onPairSuccess={onPairSuccess} />);
    fireEvent.click(
      screen.getByRole('button', { name: dict.eizouPairingOpenButton }),
    );
    expect(
      screen.getByRole('dialog', { name: dict.eizouPairingTitle }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(dict.eizouPairingOtpLabel)).toBeInTheDocument();
  });
});
