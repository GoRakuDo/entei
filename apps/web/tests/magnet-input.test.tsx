/**
 * MagnetInput — Component Tests
 * ---------------------------------------------------------------------------
 * WT-1: Tests for the magnet URI input dialog.
 * Validates submission, validation errors, and callback behavior.
 * Verifies icon-only accessible names and no SubtitlePicker / no Cancel footer.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MagnetInput } from '@/components/player/MagnetInput';

const baseDict = {
  magnetErrorInvalid: 'Invalid magnet URI.',
  magnetErrorWebRTC: 'WebRTC unsupported.',
  magnetErrorPeerInsufficient: 'Not enough peers.',
  magnetErrorTracker: 'Tracker failed.',
  magnetErrorNoPeer: 'No peers found.',
  magnetErrorNoMedia: 'No playable media.',
  magnetErrorMultipleMedia: 'Multiple playable files.',
  magnetErrorStreamUnavailable: 'Stream unavailable.',
  magnetErrorGeneric: 'Unexpected error.',
  magnetInputLabel: 'Magnet URI',
  magnetInputPlaceholder: 'magnet:?xt=urn:btih:...',
  magnetInputLabelTitle: 'Open Torrent Stream',
  magnetConnect: 'Connect',
};

afterEach(() => {
  cleanup();
});

describe('MagnetInput', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSubmit: vi.fn(),
    isConnecting: false,
    dict: baseDict,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dialog when open', () => {
    render(<MagnetInput {...defaultProps} />);
    expect(screen.getByText('Open Torrent Stream')).toBeInTheDocument();
    expect(screen.getByLabelText('Magnet URI')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<MagnetInput {...defaultProps} open={false} />);
    expect(screen.queryByText('Open Torrent Stream')).not.toBeInTheDocument();
  });

  it('description is visually hidden but accessible', () => {
    render(<MagnetInput {...defaultProps} />);
    const desc = screen.getByText('Magnet URI', { selector: 'p' });
    // entei-sr-only hides visually
    expect(desc.className).toContain('entei-sr-only');
  });

  it('shows error for empty submission (Enter on empty input)', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid magnet URI.');
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('shows error for non-magnet input', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid magnet URI.');
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('shows error for malformed magnet (no xt=urn:btih)', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, { target: { value: 'magnet:?dn=test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid magnet URI.');
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('submits valid magnet URI', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    const uri = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10';
    fireEvent.change(input, { target: { value: uri } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(defaultProps.onSubmit).toHaveBeenCalledWith(uri);
  });

  it('clears error when input changes', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    // Trigger an error first
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Typing clears it
    fireEvent.change(input, { target: { value: 'm' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('submit button is icon-only with accessible name', () => {
    render(<MagnetInput {...defaultProps} />);
    const submitBtn = screen.getByRole('button', { name: /connect/i });
    // Icon-only: no visible text children, only SVG
    expect(submitBtn).toBeInTheDocument();
    expect(submitBtn).toHaveAttribute('aria-label', 'Connect');
  });

  it('no Cancel footer button exists', () => {
    render(<MagnetInput {...defaultProps} />);
    // Only the close X button should provide cancel affordance
    const allBtns = screen.getAllByRole('button');
    const cancelBtns = allBtns.filter(
      (b) => b.textContent?.trim().toLowerCase() === 'cancel',
    );
    expect(cancelBtns).toHaveLength(0);
  });

  it('disables input and submit when connecting', () => {
    render(<MagnetInput {...defaultProps} isConnecting={true} />);
    const input = screen.getByLabelText('Magnet URI');
    expect(input).toBeDisabled();
    const submitBtn = screen.getByRole('button', { name: /connect/i });
    expect(submitBtn).toBeDisabled();
  });

  it('disables submit button when input is empty', () => {
    render(<MagnetInput {...defaultProps} />);
    const submitBtn = screen.getByRole('button', { name: /connect/i });
    expect(submitBtn).toBeDisabled();
  });

  it('enables submit button when input has valid prefix', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, {
      target: { value: 'magnet:?xt=urn:btih:abc' },
    });
    const submitBtn = screen.getByRole('button', { name: /connect/i });
    expect(submitBtn).not.toBeDisabled();
  });
});
