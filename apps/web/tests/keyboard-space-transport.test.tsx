/**
 * Space shortcut — transport delegation (`useKeyboardShortcuts`)
 * ---------------------------------------------------------------------------
 * Desktop native mode (libmpv) cannot rely on the media element: WebView2 does
 * not decode every source mpv can (HEVC 4:4:4 10-bit, FLAC in MKV), so the
 * element never fires `play`/`pause` and `media.paused` stays `true` forever.
 * The shortcut therefore hands the intent to the caller, which drives the
 * engine directly.
 *
 * These tests pin both halves of that contract:
 * - with `onTogglePlayback`, Space delegates and never touches the element;
 * - without it (browser build), Space keeps toggling the element itself.
 */
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from '@/features/player/use-keyboard-shortcuts';

/** Minimal media element stand-in: jsdom has no media pipeline. */
function makeMedia(paused: boolean): HTMLMediaElement {
  const element = document.createElement('video');
  Object.defineProperty(element, 'paused', {
    value: paused,
    configurable: true,
  });
  element.play = vi.fn(() => Promise.resolve());
  element.pause = vi.fn();
  return element;
}

function renderShortcuts(
  media: HTMLMediaElement,
  overrides: { onTogglePlayback?: () => void } = {},
) {
  const videoRef = { current: media };
  return renderHook(() =>
    useKeyboardShortcuts({
      videoRef,
      cues: [],
      activeCueId: null,
      playbackRate: 1,
      setPlaybackRate: () => {},
      onCueClick: () => {},
      enabled: true,
      ...overrides,
    }),
  );
}

/** Dispatch Space on window (the hook listens there) and report the event. */
function pressSpace(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: ' ',
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Space — delegated transport', () => {
  it('calls onTogglePlayback and never touches the element', () => {
    const media = makeMedia(true);
    const onTogglePlayback = vi.fn();
    renderShortcuts(media, { onTogglePlayback });

    const event = pressSpace();

    expect(onTogglePlayback).toHaveBeenCalledTimes(1);
    // The native path must not fall back to the element: `media.paused` is a
    // lie there, and a `play()` on an undecodable source rejects silently.
    expect(media.play).not.toHaveBeenCalled();
    expect(media.pause).not.toHaveBeenCalled();
    // Space must still be swallowed so the page never scrolls.
    expect(event.defaultPrevented).toBe(true);
  });

  it('delegates again on a second press instead of trusting the element', () => {
    const media = makeMedia(true);
    const onTogglePlayback = vi.fn();
    renderShortcuts(media, { onTogglePlayback });

    pressSpace();
    pressSpace();

    // Two presses are two intents: the caller decides play vs pause from its
    // own state, so the count must not collapse to one "play" branch.
    expect(onTogglePlayback).toHaveBeenCalledTimes(2);
    expect(media.play).not.toHaveBeenCalled();
  });
});

describe('Space — element transport (browser build)', () => {
  it('plays a paused element when no override is supplied', () => {
    const media = makeMedia(true);
    renderShortcuts(media);

    pressSpace();

    expect(media.play).toHaveBeenCalledTimes(1);
    expect(media.pause).not.toHaveBeenCalled();
  });

  it('pauses a playing element when no override is supplied', () => {
    const media = makeMedia(false);
    renderShortcuts(media);

    pressSpace();

    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(media.play).not.toHaveBeenCalled();
  });
});
