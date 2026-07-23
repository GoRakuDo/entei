/**
 * Dialog click propagation tests.
 * ---------------------------------------------------------------------------
 * Radix Dialog portals content outside the DOM parent, but React synthetic
 * events bubble through the React component tree. Clicks inside a Dialog
 * must NOT reach a parent that has an onClick handler (e.g. PlayerApp's
 * surface click handler that toggles playback).
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';

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

function TestDialogParent() {
  const [parentClicks, setParentClicks] = useState(0);
  const [open, setOpen] = useState(true);

  return (
    <div
      data-testid="parent"
      onClick={() => setParentClicks((c) => c + 1)}
    >
      <p data-testid="click-count">{parentClicks}</p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel="Close">
          <DialogHeader>
            <DialogTitle data-testid="dialog-title">Dialog Title</DialogTitle>
            <DialogDescription data-testid="dialog-desc">
              Dialog description
            </DialogDescription>
          </DialogHeader>
          <button type="button" data-testid="dialog-btn">
            Action
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

describe('DialogContent click propagation', () => {
  it('does NOT propagate clicks on dialog title to parent', () => {
    const { getByTestId } = render(<TestDialogParent />);
    const title = getByTestId('dialog-title');

    fireEvent.click(title);

    expect(getByTestId('click-count').textContent).toBe('0');
  });

  it('does NOT propagate clicks on dialog body to parent', () => {
    const { getByTestId } = render(<TestDialogParent />);
    const desc = getByTestId('dialog-desc');

    fireEvent.click(desc);

    expect(getByTestId('click-count').textContent).toBe('0');
  });

  it('does NOT propagate clicks on dialog button to parent', () => {
    const { getByTestId } = render(<TestDialogParent />);
    const btn = getByTestId('dialog-btn');

    fireEvent.click(btn);

    expect(getByTestId('click-count').textContent).toBe('0');
  });

  it('does NOT propagate clicks on close button to parent', () => {
    const { getByTestId } = render(<TestDialogParent />);
    // The close button is inside the Radix Dialog portal (rendered in document.body)
    const closeBtn = document.body.querySelector('.entei-dialog-close');
    expect(closeBtn).not.toBeNull();

    fireEvent.click(closeBtn!);

    expect(getByTestId('click-count').textContent).toBe('0');
  });

  it('still forwards consumer onClick when provided', () => {
    const consumerOnClick = vi.fn();

    function TestConsumerOnClick() {
      const [parentClicks, setParentClicks] = useState(0);
      return (
        <div onClick={() => setParentClicks((c) => c + 1)}>
          <p data-testid="parent-count">{parentClicks}</p>
          <Dialog open>
            <DialogContent onClick={consumerOnClick} closeLabel="Close">
              <div data-testid="dialog-body">Body</div>
            </DialogContent>
          </Dialog>
        </div>
      );
    }

    const { getByTestId } = render(<TestConsumerOnClick />);
    const body = getByTestId('dialog-body');

    fireEvent.click(body);

    // Parent should NOT have been clicked
    expect(getByTestId('parent-count').textContent).toBe('0');
    // Consumer onClick SHOULD have been called
    expect(consumerOnClick).toHaveBeenCalledTimes(1);
  });
});
