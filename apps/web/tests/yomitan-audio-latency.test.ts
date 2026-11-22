/**
 * Audio LATENCY + menu-template mounting.
 * ---------------------------------------------------------------------------
 * Two fixes, each the unit-testable half of a "nothing happens / it's slow"
 * report against the `/search/` page (the browser-only halves — whether a real
 * `<audio>` actually streams — are exercised on the surface, not here):
 *
 * 1. `playUrl` must call `play()` WITHOUT waiting for the element's
 *    `loadeddata`, and must reuse one element per url. Awaiting `loadeddata`
 *    held every press for the full download; no cache meant a fresh network
 *    round trip on every click. We stub the global `Audio` constructor with a
 *    fake that records the order play/load/loadeddata happen in, so the test
 *    asserts `play()` is reached while the fake still reports "not yet
 *    loaded" — the exact thing the old `await`-`loadeddata` path could not do.
 *
 * 2. `mountAudioMenuTemplates` must put the audio-source menu's `<template>`s
 *    into the document. `openAudioMenu` looks them up by id
 *    (`audio-button-popup-menu-template` / `-item-template`); the `/search/`
 *    page never mounted them, so a right-click bailed out at
 *    `getElementById(...) === null` and no menu opened. We feed it the REAL
 *    vendored `templates-display.html` and assert the two ids land in the DOM.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  playUrl,
  preloadAudioUrl,
  clearAudioCache,
} from '@/modules/yomitan/audio/audio-resolver';
import { mountAudioMenuTemplates } from '@/modules/yomitan/search/audio-controller';

const TEMPLATES_PATH = resolve(
  process.cwd(),
  'public/yomitan/templates-display.html',
);

/** The order of interesting calls the fake `Audio` records, for ordering asserts. */
type FakeEvent = 'constructed' | 'load' | 'play' | 'loadeddata';

/**
 * A minimal `HTMLAudioElement` stand-in.
 *
 * Records every call in `calls` (shared, so a test reads the whole sequence),
 * reports `loadeddata` only when the test explicitly marks the url loaded, and
 * returns a resolved promise from `play()` — so `playUrl` reaches its post-play
 * bookkeeping without a real decoder.
 */
class FakeAudio {
  static calls: FakeEvent[] = [];
  static instances: FakeAudio[] = [];

  src: string;
  volume = 1;
  currentTime = 0;
  preload = '';
  error: unknown = null;
  paused = true;
  /** The listener `playUrl` used to (and we no longer) wait on. */
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(url: string) {
    this.src = url;
    FakeAudio.instances.push(this);
    FakeAudio.calls.push('constructed');
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const at = list.indexOf(listener);
    if (at !== -1) list.splice(at, 1);
  }

  load(): void {
    FakeAudio.calls.push('load');
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  pause(): void {
    this.paused = true;
  }

  play(): Promise<void> {
    FakeAudio.calls.push('play');
    this.paused = false;
    return Promise.resolve();
  }

  /** Test hook: simulate the browser finishing load (fires `loadeddata`). */
  finishLoading(): void {
    FakeAudio.calls.push('loadeddata');
    for (const listener of this.listeners.get('loadeddata') ?? []) listener();
  }
}

/** Install the fake over the global `Audio` for the duration of a test. */
function installFakeAudio(): void {
  (globalThis as unknown as Record<string, unknown>).Audio = FakeAudio;
}

const originalAudio = (globalThis as unknown as Record<string, unknown>).Audio;

beforeEach(() => {
  installFakeAudio();
  FakeAudio.calls = [];
  FakeAudio.instances = [];
  clearAudioCache();
});

afterEach(() => {
  clearAudioCache();
  (globalThis as unknown as Record<string, unknown>).Audio = originalAudio;
});

describe('audio-resolver play latency', () => {
  it('calls play() WITHOUT waiting for loadeddata', async () => {
    const played = await playUrl('https://cdn.example/a.mp3', 80, null);
    expect(played).toBeInstanceOf(FakeAudio);
    // The fake never fires `loadeddata` unless a test asks it to, so reaching
    // `play` at all proves the old `await loadeddata` gate is gone.
    expect(FakeAudio.calls).toContain('play');
    expect(FakeAudio.calls).not.toContain('loadeddata');
    // Volume is applied before play, from the 0–100 stored value.
    expect(played?.volume).toBeCloseTo(0.8);
  });

  it('reuses ONE element per url across presses (cache)', async () => {
    const first = await playUrl('https://cdn.example/reuse.mp3', 80, null);
    const second = await playUrl('https://cdn.example/reuse.mp3', 80, first);
    expect(second).toBe(first);
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it('stops the previous element before the next plays', async () => {
    const first = await playUrl('https://cdn.example/one.mp3', 80, null);
    expect(first?.paused).toBe(false);
    await playUrl('https://cdn.example/two.mp3', 80, first);
    expect(first?.paused).toBe(true);
  });

  it('preloadAudioUrl builds the element without playing it', () => {
    const audio = preloadAudioUrl('https://cdn.example/pre.mp3');
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.calls).not.toContain('play');
    // The later play() reuses the preloaded element — no second construction.
    void playUrl('https://cdn.example/pre.mp3', 80, null);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(audio.paused).toBe(false);
  });
});

describe('mountAudioMenuTemplates (/search/ menu)', () => {
  const templates = readFileSync(TEMPLATES_PATH, 'utf8');

  it('mounts both audio menu <template> elements into the document', () => {
    mountAudioMenuTemplates(templates);
    const menu = document.getElementById('audio-button-popup-menu-template');
    const item = document.getElementById(
      'audio-button-popup-menu-item-template',
    );
    expect(menu).toBeInstanceOf(HTMLTemplateElement);
    expect(item).toBeInstanceOf(HTMLTemplateElement);
  });

  it('is idempotent — a second call does not duplicate the templates', () => {
    mountAudioMenuTemplates(templates);
    mountAudioMenuTemplates(templates);
    expect(
      document.querySelectorAll('#audio-button-popup-menu-template'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('#audio-button-popup-menu-item-template'),
    ).toHaveLength(1);
  });

  it('clones cleanly from the mounted template (what openAudioMenu does)', () => {
    mountAudioMenuTemplates(templates);
    const template = document.getElementById(
      'audio-button-popup-menu-template',
    );
    expect(template).not.toBeNull();
    const clone = (template as HTMLTemplateElement).content.firstElementChild;
    expect(clone).not.toBeNull();
    // The upstream container markup survives the round trip into the document.
    expect(clone?.classList.contains('popup-menu-container')).toBe(true);
  });
});
