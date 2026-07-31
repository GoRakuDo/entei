/**
 * MagnetInput — Component Tests (ED-1 visual shell)
 * ---------------------------------------------------------------------------
 * ED-1: Browser WebTorrent runtime was removed. This dialog is the retained
 * visual shell: local validation + EizouDendenshi not-connected status only.
 * It has no onSubmit / isConnecting props and imports no torrent runtime, so
 * a connection is structurally impossible — valid submit shows the localized
 * notice instead. URI stays in React state; nothing is persisted or sent.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MagnetInput } from '@/components/player/MagnetInput';

const baseDict = {
  magnetInputLabel: 'Magnet URI',
  magnetInputPlaceholder: 'magnet:?xt=urn:btih:...',
  magnetInputLabelTitle: 'Open Torrent Stream',
  magnetConnect: 'Connect',
  magnetErrorInvalid: 'Invalid magnet URI.',
  magnetNotConnectedTitle: 'EizouDendenshi not connected',
  magnetNotConnectedBody: 'Torrent streaming will be enabled in a future update.',
};

const VALID_HEX_URI = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10';

afterEach(() => {
  cleanup();
});

describe('MagnetInput — modal open/close', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
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

  it('close control reports onOpenChange(false)', () => {
    render(<MagnetInput {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('reopening starts with a clean input (state is not persisted)', () => {
    const { rerender } = render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, { target: { value: VALID_HEX_URI } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Close, then reopen
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    rerender(<MagnetInput {...defaultProps} open={false} />);
    rerender(<MagnetInput {...defaultProps} open={true} />);
    expect(screen.getByLabelText('Magnet URI')).toHaveValue('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('MagnetInput — local validation', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    dict: baseDict,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows localized error for empty submission', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid magnet URI.');
  });

  it('shows localized error for non-magnet input', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid magnet URI.');
  });

  it('shows localized error for malformed magnet (no xt=urn:btih)', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, { target: { value: 'magnet:?dn=test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid magnet URI.');
  });

  it('shows localized error for btih with invalid info hash length', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, {
      target: { value: 'magnet:?xt=urn:btih:abc123' },
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid magnet URI.');
  });

  it('clears error when input changes', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'm' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('submit button is disabled while input is empty', () => {
    render(<MagnetInput {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('no Cancel footer button exists — the X close is the only cancel affordance', () => {
    render(<MagnetInput {...defaultProps} />);
    const cancelBtns = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.trim().toLowerCase() === 'cancel');
    expect(cancelBtns).toHaveLength(0);
  });
});

describe('MagnetInput — no torrent runtime on valid submit', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    dict: baseDict,
  };

  it('valid 40-hex btih URI shows the EizouDendenshi not-connected notice', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, { target: { value: VALID_HEX_URI } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Honest unavailable state — no connection, no adapter call
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('EizouDendenshi not connected');
    expect(status).toHaveTextContent(
      'Torrent streaming will be enabled in a future update.',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('valid 32-char base32 btih URI also shows the not-connected notice', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, {
      target: {
        value: 'magnet:?xt=urn:btih:4c7p3fge3fge3fge3fge3fge3fge3fge',
      },
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'EizouDendenshi not connected',
    );
  });

  it('valid submit keeps the dialog open and never closes itself', () => {
    render(<MagnetInput {...defaultProps} />);
    const input = screen.getByLabelText('Magnet URI');
    fireEvent.change(input, { target: { value: VALID_HEX_URI } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(defaultProps.onOpenChange).not.toHaveBeenCalled();
  });
});
