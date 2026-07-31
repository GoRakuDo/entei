/**
 * YouTubeInput — ED-3 honest-unimplemented dialog tests.
 * ---------------------------------------------------------------------------
 * The YouTube URL entrance is a visual shell: no input field exists, so no
 * URL can be captured, persisted, or sent. X close is the only affordance.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { YouTubeInput } from '@/components/player/YouTubeInput';

const baseDict = {
  youtubeInputLabel: 'YouTube URL',
  youtubeInputTitle: 'YouTube streaming',
  youtubeInputBody: 'YouTube streaming is not available yet.',
  dialogClose: 'Close',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('YouTubeInput — honest unimplemented entrance', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    dict: baseDict,
  };

  it('renders the dialog with honest copy when open', () => {
    render(<YouTubeInput {...defaultProps} />);
    expect(
      screen.getByRole('dialog', { name: baseDict.youtubeInputTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(baseDict.youtubeInputBody)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<YouTubeInput {...defaultProps} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has no input field — a URL cannot be captured, persisted, or sent', () => {
    render(<YouTubeInput {...defaultProps} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/url/i)).not.toBeInTheDocument();
  });

  it('close control reports onOpenChange(false)', () => {
    render(<YouTubeInput {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('has no submit/connect affordance — nothing can be sent', () => {
    render(<YouTubeInput {...defaultProps} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1); // the X close only
  });
});
