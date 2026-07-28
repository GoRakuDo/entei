/**
 * WebTorrent Adapter — Typed boundary for browser WebTorrent streaming.
 * ---------------------------------------------------------------------------
 * WT-1: Encapsulates all WebTorrent interactions behind a mockable interface.
 * WebTorrent is dynamically imported only when a magnet URI is submitted.
 * No public tracker hardcoding — uses only trackers inside the magnet.
 * No private _selections access — uses public API only.
 *
 * Official streaming path (from WebTorrent docs):
 *   1. Register Service Worker (sw.min.js from webtorrent dist)
 *   2. client.createServer({ controller })
 *   3. file.streamURL → set as <video>/<audio> src; Service Worker intercepts
 * --------------------------------------------------------------------------- */

import type {
  MagnetValidation,
  TorrentFileInfo,
  TorrentContentResult,
  PeerStatus,
  TorrentAdapterCallbacks,
  TorrentAdapterError,
} from './webtorrent-types';
import {
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
} from './media-url';
type WebTorrentClient = {
  add: (...args: unknown[]) => void;
  createServer: (options: { controller: ServiceWorkerRegistration }) => void;
  destroy: () => void;
};

type WebTorrentConstructor = new () => WebTorrentClient;

export const MIN_WEBRTC_PEERS = 1;
const SERVICE_WORKER_CONTROL_TIMEOUT_MS = 5_000;

let webTorrentLoadPromise: Promise<WebTorrentConstructor> | null = null;
const webTorrentBundleUrl = '/webtorrent.min.js';

/**
 * Load WebTorrent's official browser ESM bundle. Importing the package root
 * makes Vite select the Node entry in this project, which pulls in unsupported
 * fs/os/UTP code. The raw static asset keeps it out of normal local playback.
 */
export function loadWebTorrentBrowserBundle(): Promise<WebTorrentConstructor> {
  if (webTorrentLoadPromise) return webTorrentLoadPromise;

  webTorrentLoadPromise = import(/* @vite-ignore */ webTorrentBundleUrl).then(
    (module: unknown) => {
      const constructor = (module as { default?: unknown }).default;
      if (typeof constructor !== 'function') {
        throw new Error(
          'WebTorrent browser bundle did not export a constructor.',
        );
      }
      return constructor as WebTorrentConstructor;
    },
  );

  return webTorrentLoadPromise;
}

// ---------------------------------------------------------------------------
// Magnet URI validation
// ---------------------------------------------------------------------------

const MAGNET_PREFIX = 'magnet:';

/**
 * Validate a magnet URI string.
 * Does not persist the input anywhere.
 */
export function validateMagnetUri(input: string): MagnetValidation {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (!trimmed.startsWith(MAGNET_PREFIX))
    return { ok: false, reason: 'not-magnet' };
  // Basic structural check: must contain xt=urn:btih
  if (!trimmed.includes('xt=urn:btih'))
    return { ok: false, reason: 'malformed' };
  return { ok: true, uri: trimmed };
}

// ---------------------------------------------------------------------------
// WebRTC support check
// ---------------------------------------------------------------------------

/**
 * Check if the current browser supports WebRTC (required for WebTorrent peers).
 * Uses a non-destructive check — does not create any connections.
 */
export function isWebRTCSupported(): boolean {
  try {
    return (
      typeof RTCPeerConnection !== 'undefined' ||
      typeof globalThis.RTCPeerConnection !== 'undefined'
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// File classification helpers
// ---------------------------------------------------------------------------

function classifyTorrentFile(name: string): TorrentFileInfo['kind'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle';
  return 'other';
}

function isPlayableKind(kind: TorrentFileInfo['kind']): boolean {
  return kind === 'video' || kind === 'audio';
}

// ---------------------------------------------------------------------------
// Service Worker registration
// ---------------------------------------------------------------------------

/**
 * Register the WebTorrent Service Worker from the public directory.
 * Scope is '/' so it covers the entire origin for GitHub Pages custom domain.
 * Returns the ServiceWorkerRegistration controller.
 * Throws if registration fails.
 */
export async function registerWebTorrentServiceWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(
    '/entei-webtorrent-sw.js',
    { scope: '/' },
  );
  await navigator.serviceWorker.ready;
  await waitForWebTorrentServiceWorkerControl();
  return registration;
}

/**
 * `ready` only means a worker is active; it does not guarantee this tab is
 * already controlled. WebTorrent's /webtorrent/ URLs otherwise fall through
 * to Astro/Vite and return 404 instead of being answered by sw.min.js.
 */
export function waitForWebTorrentServiceWorkerControl(): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let pollInterval: number | null = null;
    let timeout: number | null = null;
    const cleanup = () => {
      if (pollInterval !== null) window.clearInterval(pollInterval);
      if (timeout !== null) window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        checkController,
      );
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const checkController = () => {
      if (navigator.serviceWorker.controller) finish();
    };
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      checkController,
    );
    pollInterval = window.setInterval(checkController, 50);
    timeout = window.setTimeout(() => {
      cleanup();
      reject(
        Object.assign(new Error('Service Worker did not control this tab.'), {
          code: 'WORKER_NOT_CONTROLLING' as const,
        }),
      );
    }, SERVICE_WORKER_CONTROL_TIMEOUT_MS);
    checkController();
  });
}

// ---------------------------------------------------------------------------
// Adapter interface (injectable for tests)
// ---------------------------------------------------------------------------

export interface WebTorrentAdapter {
  /** Connect to a magnet URI. Returns when torrent metadata is available. */
  connect(magnetUri: string, callbacks: TorrentAdapterCallbacks): Promise<void>;
  /** Get the list of files in the current torrent. */
  getFiles(): TorrentFileInfo[];
  /** Evaluate torrent content and return the selection result. */
  selectContent(): TorrentContentResult;
  /** Get current peer status. */
  getPeerStatus(): PeerStatus;
  /** Destroy the session and clean up all resources. */
  destroy(): void;
  /** Whether the adapter is currently connected. */
  isConnected(): boolean;
}

// ---------------------------------------------------------------------------
// Live adapter implementation (wraps WebTorrent)
// ---------------------------------------------------------------------------

/** Default peer-gate deadline (ms). If the minimum WebRTC peer count is never
 *  reached within this window, the session is destroyed with a typed error. */
const PEER_GATE_TIMEOUT_MS = 30_000;

class LiveWebTorrentAdapter implements WebTorrentAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private torrent: any = null;
  private registration: ServiceWorkerRegistration | null = null;
  private peerInterval: ReturnType<typeof setInterval> | null = null;
  private peerGateTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private _activeError: TorrentAdapterError | null = null;

  async connect(
    magnetUri: string,
    callbacks: TorrentAdapterCallbacks,
  ): Promise<void> {
    // Reflect the explicit user action immediately, including while a newly
    // registered Service Worker is taking control of this tab.
    callbacks.onPhaseChange('connecting');

    // Browser bundle is loaded only when a magnet URI is submitted.
    const WebTorrentConstructor = await loadWebTorrentBrowserBundle();

    // Register Service Worker
    this.registration = await registerWebTorrentServiceWorker();

    // Create client
    this.client = new WebTorrentConstructor();

    // Create server using the Service Worker controller
    this.client.createServer({ controller: this.registration });

    return new Promise<void>((resolve, reject) => {
      // Metadata can only arrive through a WebRTC-accessible peer. Treat a
      // timeout exactly like the later 3-peer gate: the user needs another
      // magnet URI, not an internal generic failure message.
      const metadataTimeout = setTimeout(() => {
        callbacks.onError({
          code: 'PEER_INSUFFICIENT',
          message: '',
        });
        this.destroy();
        reject(new Error('WebRTC peer threshold was not reached.'));
      }, 30_000);

      this.client.add(
        magnetUri,
        (
          torrent: /* eslint-disable-line @typescript-eslint/no-explicit-any */ any,
        ) => {
          clearTimeout(metadataTimeout);
          this.torrent = torrent;
          this._connected = true;

          // Listen for tracker/noPeers warnings
          this.torrent.on('warning', (err: Error) => {
            if (!this._activeError) {
              this._activeError = {
                code: 'TRACKER_ERROR',
                message: err.message,
              };
            }
          });

          this.torrent.on('noPeers', (announceType: string) => {
            if (!this._activeError) {
              this._activeError = {
                code: 'NO_PEERS',
                message: `No peers found via ${announceType}`,
              };
            }
          });

          // Start peer monitoring
          this.startPeerMonitoring(callbacks);

          // Start peer-gate deadline: 30s to reach the minimum peer count
          this.startPeerGateTimer(callbacks);

          callbacks.onPhaseChange('gate');
          resolve();
        },
      );

      this.client.on('error', (err: Error) => {
        clearTimeout(metadataTimeout);
        callbacks.onError({
          code: 'GENERIC',
          message: err.message,
        });
        this.destroy();
        reject(err);
      });
    });
  }

  private startPeerGateTimer(callbacks: TorrentAdapterCallbacks): void {
    this.clearPeerGateTimer();
    this.peerGateTimer = setTimeout(() => {
      if (!this._connected || !this.torrent) return;
      const peers = this.torrent.numPeers ?? 0;
      if (peers < MIN_WEBRTC_PEERS) {
        // Emit typed error; PlayerApp maps code → localized message
        callbacks.onError({
          code: 'PEER_INSUFFICIENT',
          message: '',
        });
        this.destroy();
      }
    }, PEER_GATE_TIMEOUT_MS);
  }

  private clearPeerGateTimer(): void {
    if (this.peerGateTimer) {
      clearTimeout(this.peerGateTimer);
      this.peerGateTimer = null;
    }
  }

  private startPeerMonitoring(callbacks: TorrentAdapterCallbacks): void {
    if (this.peerInterval) clearInterval(this.peerInterval);

    this.peerInterval = setInterval(() => {
      if (!this.torrent) return;

      const status: PeerStatus = {
        numPeers: this.torrent.numPeers ?? 0,
        downloadSpeed: this.torrent.downloadSpeed ?? 0,
        uploadSpeed: this.torrent.uploadSpeed ?? 0,
        progress: this.torrent.progress ?? 0,
      };

      callbacks.onPeerStatus(status);
    }, 1000);
  }

  getFiles(): TorrentFileInfo[] {
    if (!this.torrent) return [];

    return this.torrent.files.map(
      (
        file: /* eslint-disable-line @typescript-eslint/no-explicit-any */ any,
        index: number,
      ) => ({
        name: file.name,
        index,
        length: file.length,
        kind: classifyTorrentFile(file.name),
      }),
    );
  }

  selectContent(): TorrentContentResult {
    const files = this.getFiles();
    const playable = files.filter((f) => isPlayableKind(f.kind));

    if (playable.length === 0) {
      return { status: 'no-playable' };
    }

    if (playable.length === 1) {
      const file = playable[0]!;
      // Use official file.streamURL — requires createServer() to have run
      const wtFile = this.torrent?.files?.[file.index];
      const streamUrl = wtFile?.streamURL as string | undefined;
      if (!streamUrl) {
        throw Object.assign(new Error('streamURL unavailable'), {
          code: 'STREAM_UNAVAILABLE' as const,
          message: '',
        });
      }
      return {
        status: 'single-playable',
        file,
        streamUrl,
      };
    }

    return { status: 'multiple-playable', candidates: playable };
  }

  getPeerStatus(): PeerStatus {
    if (!this.torrent) {
      return { numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, progress: 0 };
    }
    return {
      numPeers: this.torrent.numPeers ?? 0,
      downloadSpeed: this.torrent.downloadSpeed ?? 0,
      uploadSpeed: this.torrent.uploadSpeed ?? 0,
      progress: this.torrent.progress ?? 0,
    };
  }

  destroy(): void {
    if (this.peerInterval) {
      clearInterval(this.peerInterval);
      this.peerInterval = null;
    }

    this.clearPeerGateTimer();

    if (this.torrent) {
      try {
        this.torrent.destroy();
      } catch {
        // Ignore destroy errors
      }
      this.torrent = null;
    }

    if (this.client) {
      try {
        // Only use the public destroy() — no _server access
        this.client.destroy();
      } catch {
        // Ignore destroy errors
      }
      this.client = null;
    }

    this.registration = null;
    this._connected = false;
    this._activeError = null;
  }

  isConnected(): boolean {
    return this._connected;
  }
}

// ---------------------------------------------------------------------------
// Mock adapter for tests
// ---------------------------------------------------------------------------

export class MockWebTorrentAdapter implements WebTorrentAdapter {
  private connected = false;
  private files: TorrentFileInfo[] = [];
  private peerStatus: PeerStatus = {
    numPeers: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    progress: 0,
  };

  // Test configuration
  public connectShouldFail = false;
  public connectError: TorrentAdapterError = {
    code: 'GENERIC',
    message: 'Connection failed',
  };
  public streamUrl = 'blob:mock-stream-url';

  async connect(
    _magnetUri: string,
    callbacks: TorrentAdapterCallbacks,
  ): Promise<void> {
    if (this.connectShouldFail) {
      callbacks.onError(this.connectError);
      throw new Error(this.connectError.message);
    }
    this.connected = true;
    callbacks.onPhaseChange('gate');
  }

  getFiles(): TorrentFileInfo[] {
    return this.files;
  }

  selectContent(): TorrentContentResult {
    const playable = this.files.filter((f) => isPlayableKind(f.kind));
    if (playable.length === 0) return { status: 'no-playable' };
    if (playable.length === 1) {
      return {
        status: 'single-playable',
        file: playable[0]!,
        streamUrl: this.streamUrl,
      };
    }
    return { status: 'multiple-playable', candidates: playable };
  }

  getPeerStatus(): PeerStatus {
    return this.peerStatus;
  }

  destroy(): void {
    this.connected = false;
    this.files = [];
    this.peerStatus = {
      numPeers: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      progress: 0,
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Test helpers
  setFiles(files: TorrentFileInfo[]): void {
    this.files = files;
  }

  setPeerStatus(status: PeerStatus): void {
    this.peerStatus = status;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WebTorrent adapter. Uses the live adapter in production,
 * but can be replaced with MockWebTorrentAdapter for tests.
 */
export function createWebTorrentAdapter(): WebTorrentAdapter {
  return new LiveWebTorrentAdapter();
}
