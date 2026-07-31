/**
 * EizouDendenshiSetup + EizouDendenshiPairingDialog — ED-3 component tests.
 * ---------------------------------------------------------------------------
 * Covers: setup section semantics (mobile/desktop structure, connected
 * state), OTP validation + accessibility, pair request success/failure,
 * memory-only token (no storage), and close/unmount cleanup.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EizouDendenshiSetup } from '@/components/player/EizouDendenshiSetup';

const baseDict = {
  eizouSetupLabel: 'Set up',
  eizouSetupTitle: 'EizouDendenshi',
  eizouSetupDesc: 'Assists with videos shared over YouTube and P2P.',
  eizouSetupImageAlt: 'EizouDendenshi illustration',
  eizouConnected: 'Connected',
  eizouPairingTitle: 'Pair EizouDendenshi',
  eizouPairingDesc: 'Enter the 6-digit code shown in the companion app.',
  eizouPairingOtpLabel: '6-digit pairing code',
  eizouPairingOtpInvalid: 'Enter the 6-digit code.',
  eizouPairingSubmit: 'Pair',
  eizouPairingConnecting: 'Pairing…',
  eizouPairingErrorNetwork: 'Could not reach EizouDendenshi.',
  eizouPairingErrorInvalidCode: 'Invalid code.',
  eizouPairingErrorGeneric: 'Pairing failed.',
  dialogClose: 'Close',
};

const PAIR_URL = 'http://127.0.0.1:4322/v1/pair';

/** input-otp measures slots with ResizeObserver, which jsdom lacks. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  // input-otp runs a delayed hit-test on focus; jsdom has no hit-testing.
  document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
});

function setupSection(overrides: Partial<Parameters<typeof EizouDendenshiSetup>[0]> = {}) {
  const props = {
    isConnected: false,
    onPairSuccess: vi.fn(),
    dict: baseDict,
    ...overrides,
  };
  return render(<EizouDendenshiSetup {...props} />);
}

function fillOtp(value: string) {
  const input = screen.getByLabelText(baseDict.eizouPairingOtpLabel);
  fireEvent.change(input, { target: { value } });
  return input;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EizouDendenshiSetup — section semantics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders title, description and setup button; no connected status when unpaired', () => {
    setupSection();
    expect(
      screen.getByRole('heading', { name: baseDict.eizouSetupTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(baseDict.eizouSetupDesc)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: baseDict.eizouSetupLabel }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('is a labelled region (desktop/mobile semantics share the same structure)', () => {
    setupSection();
    expect(
      screen.getByRole('region', { name: baseDict.eizouSetupTitle }),
    ).toBeInTheDocument();
  });

  it('shows the connected status when paired', () => {
    setupSection({ isConnected: true });
    expect(screen.getByRole('status')).toHaveTextContent(
      baseDict.eizouConnected,
    );
  });

  it('opens the pairing dialog from the Setup button', () => {
    setupSection();
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    expect(
      screen.getByRole('dialog', { name: baseDict.eizouPairingTitle }),
    ).toBeInTheDocument();
  });
});

describe('EizouDendenshiPairingDialog — OTP validation + accessibility', () => {
  beforeEach(() => vi.clearAllMocks());

  function openDialog() {
    setupSection();
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
  }

  it('provides a labelled 6-slot OTP input', () => {
    openDialog();
    expect(screen.getByLabelText(baseDict.eizouPairingOtpLabel)).toBeInTheDocument();
  });

  it('shows localized error + aria-invalid when pairing with an incomplete code', () => {
    openDialog();
    fillOtp('12');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      baseDict.eizouPairingOtpInvalid,
    );
    expect(screen.getByLabelText(baseDict.eizouPairingOtpLabel)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('clears the error once the user edits the code', () => {
    openDialog();
    fillOtp('12');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fillOtp('123456');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pair button is disabled and shows the connecting label while in flight', () => {
    openDialog();
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    fillOtp('123456');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));
    const pairingBtn = screen.getByRole('button', { name: baseDict.eizouPairingConnecting });
    expect(pairingBtn).toBeDisabled();
    resolveFetch(
      new Response(JSON.stringify({ token: 'tok123' }), { status: 200 }),
    );
  });
});

describe('EizouDendenshiPairingDialog — pair request', () => {
  beforeEach(() => vi.clearAllMocks());

  function openDialog() {
    setupSection();
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
  }

  it('POSTs the 6-digit code to the companion and accepts the token only on 200', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'tok-abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onPairSuccess = vi.fn();
    render(
      <EizouDendenshiSetup
        isConnected={false}
        onPairSuccess={onPairSuccess}
        dict={baseDict}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    fillOtp('123456');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        PAIR_URL,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ code: '123456' }),
        }),
      ),
    );
    await waitFor(() => expect(onPairSuccess).toHaveBeenCalledWith('tok-abc'));
    // Dialog closes on success and the token never renders in the DOM.
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: baseDict.eizouPairingTitle }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/tok-abc/)).not.toBeInTheDocument();
  });

  it('rejects invalid code (403) with localized feedback and no token', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid pairing code' }), { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onPairSuccess = vi.fn();
    render(
      <EizouDendenshiSetup
        isConnected={false}
        onPairSuccess={onPairSuccess}
        dict={baseDict}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    fillOtp('111111');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        baseDict.eizouPairingErrorInvalidCode,
      ),
    );
    expect(onPairSuccess).not.toHaveBeenCalled();
    // The raw error body is never exposed to the user.
    expect(screen.queryByText(/invalid pairing code/)).not.toBeInTheDocument();
  });

  it('shows the generic network error without request detail on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const onPairSuccess = vi.fn();
    render(
      <EizouDendenshiSetup
        isConnected={false}
        onPairSuccess={onPairSuccess}
        dict={baseDict}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    fillOtp('123456');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        baseDict.eizouPairingErrorNetwork,
      ),
    );
    expect(onPairSuccess).not.toHaveBeenCalled();
  });

  it('maps other server errors to the generic message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const onPairSuccess = vi.fn();
    render(
      <EizouDendenshiSetup
        isConnected={false}
        onPairSuccess={onPairSuccess}
        dict={baseDict}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    fillOtp('123456');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        baseDict.eizouPairingErrorGeneric,
      ),
    );
    expect(onPairSuccess).not.toHaveBeenCalled();
  });

  it('fails closed when a 200 body carries no token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    const onPairSuccess = vi.fn();
    render(
      <EizouDendenshiSetup
        isConnected={false}
        onPairSuccess={onPairSuccess}
        dict={baseDict}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    fillOtp('123456');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        baseDict.eizouPairingErrorGeneric,
      ),
    );
    expect(onPairSuccess).not.toHaveBeenCalled();
  });

  it('never persists the code or token to any storage API', async () => {
    const storageSetSpy = vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ token: 'tok-secret' }), { status: 200 }),
      ),
    );
    const onPairSuccess = vi.fn();
    render(
      <EizouDendenshiSetup
        isConnected={false}
        onPairSuccess={onPairSuccess}
        dict={baseDict}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    fillOtp('123456');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));

    await waitFor(() => expect(onPairSuccess).toHaveBeenCalled());
    expect(storageSetSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/tok-secret/)).not.toBeInTheDocument();
  });
});

describe('EizouDendenshiPairingDialog — close/unmount cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the OTP and error when the dialog closes, and forgets nothing on reopen', () => {
    const { rerender } = setupSection();
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    fillOtp('12');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: baseDict.dialogClose }));
    expect(
      screen.queryByRole('dialog', { name: baseDict.eizouPairingTitle }),
    ).not.toBeInTheDocument();

    // Reopen — OTP and error must be clean (no persistence).
    rerender(<EizouDendenshiSetup isConnected={false} onPairSuccess={vi.fn()} dict={baseDict} />);
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    expect(screen.getByLabelText(baseDict.eizouPairingOtpLabel)).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a late pair response after the dialog was closed (unmount/close guard)', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const onPairSuccess = vi.fn();
    const { unmount } = render(
      <EizouDendenshiSetup
        isConnected={false}
        onPairSuccess={onPairSuccess}
        dict={baseDict}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouSetupLabel }));
    fillOtp('123456');
    fireEvent.click(screen.getByRole('button', { name: baseDict.eizouPairingSubmit }));

    unmount(); // dialog unmounts with the section — in-flight attempt aborted
    resolveFetch(
      new Response(JSON.stringify({ token: 'stale-token' }), { status: 200 }),
    );
    await waitFor(() => expect(onPairSuccess).not.toHaveBeenCalled());
    expect(screen.queryByText(/stale-token/)).not.toBeInTheDocument();
  });
});
