/**
 * WebTorrent Adapter — Unit Tests
 * ---------------------------------------------------------------------------
 * WT-1: Tests for magnet URI validation, WebRTC support check,
 * MockWebTorrentAdapter behavior, and file classification.
 * No external peer network required.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateMagnetUri,
  isWebRTCSupported,
  MockWebTorrentAdapter,
} from '@/features/player/webtorrent-adapter';
import type { TorrentAdapterCallbacks } from '@/features/player/webtorrent-types';

// ---------------------------------------------------------------------------
// Magnet URI validation
// ---------------------------------------------------------------------------

describe('validateMagnetUri', () => {
  it('rejects empty string', () => {
    const result = validateMagnetUri('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('rejects whitespace-only string', () => {
    const result = validateMagnetUri('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('rejects non-magnet string', () => {
    const result = validateMagnetUri('https://example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-magnet');
  });

  it('rejects magnet without xt=urn:btih', () => {
    const result = validateMagnetUri('magnet:?dn=test');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('accepts valid magnet URI', () => {
    const uri =
      'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel';
    const result = validateMagnetUri(uri);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uri).toBe(uri);
  });

  it('accepts magnet URI with leading/trailing whitespace', () => {
    const uri =
      '  magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10  ';
    const result = validateMagnetUri(uri);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uri).toBe(uri.trim());
  });

  it('accepts magnet URI with trackers', () => {
    const uri =
      'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&tr=udp%3A%2F%2Fexplodie.org%3A6969';
    const result = validateMagnetUri(uri);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WebRTC support check
// ---------------------------------------------------------------------------

describe('isWebRTCSupported', () => {
  it('returns true when RTCPeerConnection exists', () => {
    // jsdom doesn't define RTCPeerConnection, so we mock it
    const OriginalRTCPeerConnection = globalThis.RTCPeerConnection;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).RTCPeerConnection = class {};
    expect(isWebRTCSupported()).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).RTCPeerConnection = OriginalRTCPeerConnection;
  });

  it('returns false when RTCPeerConnection is undefined', () => {
    const OriginalRTCPeerConnection = globalThis.RTCPeerConnection;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).RTCPeerConnection = undefined;
    expect(isWebRTCSupported()).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).RTCPeerConnection = OriginalRTCPeerConnection;
  });
});

// ---------------------------------------------------------------------------
// MockWebTorrentAdapter
// ---------------------------------------------------------------------------

describe('MockWebTorrentAdapter', () => {
  let adapter: MockWebTorrentAdapter;
  let callbacks: TorrentAdapterCallbacks;

  beforeEach(() => {
    adapter = new MockWebTorrentAdapter();
    callbacks = {
      onPhaseChange: vi.fn(),
      onPeerStatus: vi.fn(),
      onError: vi.fn(),
    };
  });

  describe('connect', () => {
    it('sets connected and calls onPhaseChange with gate', async () => {
      await adapter.connect('magnet:?xt=urn:btih:abc', callbacks);
      expect(adapter.isConnected()).toBe(true);
      expect(callbacks.onPhaseChange).toHaveBeenCalledWith('gate');
    });

    it('rejects when connectShouldFail is true', async () => {
      adapter.connectShouldFail = true;
      adapter.connectError = {
        code: 'WEBRTC_UNSUPPORTED',
        message: 'WebRTC not available',
      };
      await expect(
        adapter.connect('magnet:?xt=urn:btih:abc', callbacks),
      ).rejects.toThrow('WebRTC not available');
      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'WEBRTC_UNSUPPORTED' }),
      );
    });
  });

  describe('selectContent', () => {
    it('returns no-playable when no files', () => {
      adapter.setFiles([]);
      const result = adapter.selectContent();
      expect(result.status).toBe('no-playable');
    });

    it('returns single-playable for exactly one video file', () => {
      adapter.setFiles([
        { name: 'movie.mp4', index: 0, length: 1_000_000, kind: 'video' },
        { name: 'subs.srt', index: 1, length: 5000, kind: 'subtitle' },
      ]);
      const result = adapter.selectContent();
      expect(result.status).toBe('single-playable');
      if (result.status === 'single-playable') {
        expect(result.file.name).toBe('movie.mp4');
        expect(result.file.kind).toBe('video');
      }
    });

    it('returns single-playable for exactly one audio file', () => {
      adapter.setFiles([
        { name: 'track.mp3', index: 0, length: 5_000_000, kind: 'audio' },
      ]);
      const result = adapter.selectContent();
      expect(result.status).toBe('single-playable');
      if (result.status === 'single-playable') {
        expect(result.file.name).toBe('track.mp3');
        expect(result.file.kind).toBe('audio');
      }
    });

    it('returns multiple-playable for two video files', () => {
      adapter.setFiles([
        { name: 'part1.mp4', index: 0, length: 1_000_000, kind: 'video' },
        { name: 'part2.mp4', index: 1, length: 1_000_000, kind: 'video' },
      ]);
      const result = adapter.selectContent();
      expect(result.status).toBe('multiple-playable');
    });

    it('returns no-playable for subtitle-only torrent', () => {
      adapter.setFiles([
        { name: 'subs.srt', index: 0, length: 5000, kind: 'subtitle' },
        { name: 'readme.txt', index: 1, length: 1000, kind: 'other' },
      ]);
      const result = adapter.selectContent();
      expect(result.status).toBe('no-playable');
    });
  });

  describe('getPeerStatus', () => {
    it('returns zero status before connection', () => {
      const status = adapter.getPeerStatus();
      expect(status.numPeers).toBe(0);
      expect(status.downloadSpeed).toBe(0);
      expect(status.uploadSpeed).toBe(0);
      expect(status.progress).toBe(0);
    });
  });

  describe('destroy', () => {
    it('sets connected to false', async () => {
      await adapter.connect('magnet:?xt=urn:btih:abc', callbacks);
      expect(adapter.isConnected()).toBe(true);
      adapter.destroy();
      expect(adapter.isConnected()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// File classification (via adapter)
// ---------------------------------------------------------------------------

describe('Torrent file classification', () => {
  it('classifies mp4 as video', () => {
    const adapter = new MockWebTorrentAdapter();
    adapter.setFiles([
      { name: 'test.mp4', index: 0, length: 1000, kind: 'video' },
    ]);
    const files = adapter.getFiles();
    expect(files[0]!.kind).toBe('video');
  });

  it('classifies mp3 as audio', () => {
    const adapter = new MockWebTorrentAdapter();
    adapter.setFiles([
      { name: 'test.mp3', index: 0, length: 1000, kind: 'audio' },
    ]);
    const files = adapter.getFiles();
    expect(files[0]!.kind).toBe('audio');
  });

  it('classifies srt as subtitle', () => {
    const adapter = new MockWebTorrentAdapter();
    adapter.setFiles([
      { name: 'test.srt', index: 0, length: 1000, kind: 'subtitle' },
    ]);
    const files = adapter.getFiles();
    expect(files[0]!.kind).toBe('subtitle');
  });
});
