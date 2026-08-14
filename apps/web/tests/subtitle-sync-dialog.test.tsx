import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubtitleSyncDialog } from '@/components/player/SubtitleSyncDialog';
import { en } from '@i18n/locales/en';

const fetchMagnetPcm = vi.fn();
vi.mock('@/features/player/companion-media', () => ({
  fetchMagnetPcm: (...args: unknown[]) => fetchMagnetPcm(...args),
}));

const dict = en.playerUI;
const onOpenChange = vi.fn();
const onComplete = vi.fn();

function renderDialog(open = true) {
  return render(
    <SubtitleSyncDialog
      open={open}
      onOpenChange={onOpenChange}
      dict={dict}
      token="tok"
      onComplete={onComplete}
    />,
  );
}

describe('SubtitleSyncDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('renders title, description, cancel and confirm buttons', () => {
    renderDialog();
    expect(screen.getByText(dict.subtitleSyncWaitTitle)).toBeTruthy();
    expect(screen.getByText(dict.subtitleSyncWaitDesc)).toBeTruthy();
    expect(screen.getByText(dict.subtitleSyncWaitCancel)).toBeTruthy();
    expect(screen.getByText(dict.subtitleSyncWaitConfirm)).toBeTruthy();
  });

  it('closes when cancel is clicked', () => {
    renderDialog();
    fireEvent.click(screen.getByText(dict.subtitleSyncWaitCancel));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('polls DL% until complete, then calls onComplete with audio', async () => {
    vi.useFakeTimers();
    fetchMagnetPcm
      .mockRejectedValueOnce(
        Object.assign(new Error('buffering'), {
          name: 'CompanionBufferingError',
          available: 128,
          total: 256,
        }),
      )
      .mockResolvedValueOnce({ samples: new Float32Array([0.1]), sampleRate: 16000 });

    renderDialog();
    fireEvent.click(screen.getByText(dict.subtitleSyncWaitConfirm));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });
    // First poll: buffering → 50%
    expect(screen.getByText('Downloading… 50%')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });
    // Second poll: ready → onComplete + close
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]![0].sampleRate).toBe(16000);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
