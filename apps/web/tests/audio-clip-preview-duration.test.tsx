/**
 * AudioClipPreviewDialog duration behavior tests.
 * ---------------------------------------------------------------------------
 * Verifies that expectedDuration is used when audio.duration is NaN,
 * Infinity, or 0, and that actual finite duration overrides it later.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { AudioClipPreviewDialog } from '@/components/player/AudioClipPreviewDialog';

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

const mockDict = {
  audioClipPreviewTitle: 'Preview',
  audioClipRecording: 'Recording…',
  audioClipRetry: 'Retry',
  audioClipClose: 'Close',
  audioClipError: 'Error',
  audioClipNoPreview: 'No preview.',
  audioClipPlay: 'Play',
  audioClipPause: 'Pause',
  dialogClose: 'Close',
};

function getTimeText(): string | null {
  const timeEl = document.body.querySelector('.entei-audio-clip-time');
  return timeEl?.textContent ?? null;
}

function setAudioDuration(value: number) {
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(value);
}

describe('AudioClipPreviewDialog duration fallback', () => {
  it('shows expectedDuration when audio.duration is NaN', () => {
    render(
      <AudioClipPreviewDialog
        open
        onOpenChange={vi.fn()}
        audioUrl="blob:test"
        expectedDuration={5.5}
        error={false}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        isRecording={false}
        dict={mockDict}
      />,
    );

    const audio = document.body.querySelector('[data-testid="audio-clip-audio"]') as HTMLAudioElement;
    expect(audio).not.toBeNull();

    // Simulate NaN duration (before metadata)
    setAudioDuration(NaN);
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(getTimeText()).toBe('00:00 / 00:05');
  });

  it('shows expectedDuration when audio.duration is Infinity', () => {
    render(
      <AudioClipPreviewDialog
        open
        onOpenChange={vi.fn()}
        audioUrl="blob:test"
        expectedDuration={3.2}
        error={false}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        isRecording={false}
        dict={mockDict}
      />,
    );

    const audio = document.body.querySelector('[data-testid="audio-clip-audio"]') as HTMLAudioElement;
    setAudioDuration(Infinity);
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(getTimeText()).toBe('00:00 / 00:03');
  });

  it('shows expectedDuration when audio.duration is 0', () => {
    render(
      <AudioClipPreviewDialog
        open
        onOpenChange={vi.fn()}
        audioUrl="blob:test"
        expectedDuration={8.1}
        error={false}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        isRecording={false}
        dict={mockDict}
      />,
    );

    const audio = document.body.querySelector('[data-testid="audio-clip-audio"]') as HTMLAudioElement;
    setAudioDuration(0);
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(getTimeText()).toBe('00:00 / 00:08');
  });

  it('uses actual finite duration when loadedmetadata reports it', () => {
    render(
      <AudioClipPreviewDialog
        open
        onOpenChange={vi.fn()}
        audioUrl="blob:test"
        expectedDuration={2.0}
        error={false}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        isRecording={false}
        dict={mockDict}
      />,
    );

    const audio = document.body.querySelector('[data-testid="audio-clip-audio"]') as HTMLAudioElement;
    setAudioDuration(4.5);
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(getTimeText()).toBe('00:00 / 00:04');
  });

  it('overrides expectedDuration on later durationchange event', () => {
    render(
      <AudioClipPreviewDialog
        open
        onOpenChange={vi.fn()}
        audioUrl="blob:test"
        expectedDuration={2.0}
        error={false}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        isRecording={false}
        dict={mockDict}
      />,
    );

    const audio = document.body.querySelector('[data-testid="audio-clip-audio"]') as HTMLAudioElement;

    // First: bad duration
    setAudioDuration(NaN);
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });
    expect(getTimeText()).toBe('00:00 / 00:02');

    // Later: browser reports real duration
    setAudioDuration(6.75);
    act(() => {
      audio.dispatchEvent(new Event('durationchange'));
    });
    expect(getTimeText()).toBe('00:00 / 00:06');
  });

  it('ignores later durationchange if the value is still invalid', () => {
    render(
      <AudioClipPreviewDialog
        open
        onOpenChange={vi.fn()}
        audioUrl="blob:test"
        expectedDuration={2.0}
        error={false}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        isRecording={false}
        dict={mockDict}
      />,
    );

    const audio = document.body.querySelector('[data-testid="audio-clip-audio"]') as HTMLAudioElement;

    // Start with NaN → fallback
    setAudioDuration(NaN);
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });
    expect(getTimeText()).toBe('00:00 / 00:02');

    // Another invalid durationchange → keep fallback
    setAudioDuration(Infinity);
    act(() => {
      audio.dispatchEvent(new Event('durationchange'));
    });
    expect(getTimeText()).toBe('00:00 / 00:02');
  });

  it('shows 00:00 when both expectedDuration and actual duration are invalid', () => {
    render(
      <AudioClipPreviewDialog
        open
        onOpenChange={vi.fn()}
        audioUrl="blob:test"
        expectedDuration={0}
        error={false}
        onRetry={vi.fn()}
        onClose={vi.fn()}
        isRecording={false}
        dict={mockDict}
      />,
    );

    const audio = document.body.querySelector('[data-testid="audio-clip-audio"]') as HTMLAudioElement;
    setAudioDuration(NaN);
    act(() => {
      audio.dispatchEvent(new Event('loadedmetadata'));
    });

    expect(getTimeText()).toBe('00:00 / 00:00');
  });
});
