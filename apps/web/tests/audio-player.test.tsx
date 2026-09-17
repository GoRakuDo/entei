import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AudioPlayer, {
  clampAudioSeekTarget,
  findActiveAudioCue,
} from '@/components/player/AudioPlayer';

const cues = [
  { id: 1, start: 0, end: 2, text: 'First line' },
  { id: 2, start: 2, end: 5, text: 'Second line' },
] as const;

describe('AudioPlayer', () => {
  it('renders cover/subtitle ButtonGroup tabs and subtitle cues from props', () => {
    render(<AudioPlayer title="Book title" cues={cues} />);

    const subtitleTab = screen.getByRole('button', { name: 'Subtitle' });
    const coverTab = screen.getByRole('button', { name: 'Cover' });
    expect(subtitleTab.getAttribute('aria-pressed')).toBe('false');
    expect(coverTab.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(subtitleTab);
    expect(subtitleTab.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /First line/ })).not.toBeNull();
    expect(screen.getByRole('button', { name: /Second line/ })).not.toBeNull();

    fireEvent.click(coverTab);
    expect(coverTab.getAttribute('aria-pressed')).toBe('true');
  });

  it('exposes keyboard and touch-sized playback controls with existing speed values', () => {
    render(<AudioPlayer />);

    expect((screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Skip back 10 seconds' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Skip back 30 seconds' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Skip forward 10 seconds' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Skip forward 30 seconds' }) as HTMLButtonElement).disabled).toBe(true);

    const speed = screen.getByRole('combobox', { name: 'Playback speed' }) as HTMLSelectElement;
    expect(speed.value).toBe('1');

    expect(screen.getAllByRole('option')).toHaveLength(8);
    expect((screen.getByRole('slider', { name: 'Seek through audio' }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('audio player pure controls', () => {
  it('clamps skip and cue targets without exceeding media duration', () => {
    expect(clampAudioSeekTarget(-10, 20)).toBe(0);
    expect(clampAudioSeekTarget(25, 20)).toBe(20);
    expect(clampAudioSeekTarget(7, Number.NaN)).toBe(7);
  });

  it('finds only the cue active at the current playback time', () => {
    expect(findActiveAudioCue(cues, 1)?.text).toBe('First line');
    expect(findActiveAudioCue(cues, 2)?.text).toBe('Second line');
    expect(findActiveAudioCue(cues, 5)).toBeNull();
  });
});
