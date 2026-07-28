/**
 * WebTorrent Types — Shared types for the torrent streaming adapter.
 * ---------------------------------------------------------------------------
 * WT-1: Typed boundary between WebTorrent internals and PlayerApp.
 * No WebTorrent imports leak beyond the adapter module.
 * --------------------------------------------------------------------------- */

/** Magnet URI validation result. */
export type MagnetValidation =
  | { ok: true; uri: string }
  | { ok: false; reason: 'empty' | 'not-magnet' | 'malformed' };

/** Torrent session state machine. */
export type TorrentSessionPhase =
  | 'idle'
  | 'connecting'
  | 'gate' // waiting for the configured minimum peer count
  | 'streaming'
  | 'error'
  | 'destroyed';

/** Info about a single file inside a torrent. */
export interface TorrentFileInfo {
  name: string;
  index: number;
  length: number;
  /** Determined by extension against the admission matrix. */
  kind: 'video' | 'audio' | 'subtitle' | 'other';
}

/** Result of evaluating torrent contents after peer gate. */
export type TorrentContentResult =
  | {
      status: 'single-playable';
      file: TorrentFileInfo;
      /** Official file.streamURL — produced by the adapter after createServer(). */
      streamUrl: string;
    }
  | {
      status: 'multiple-playable';
      candidates: TorrentFileInfo[];
    }
  | {
      status: 'no-playable';
    };

/** Peer status snapshot for UI display. */
export interface PeerStatus {
  numPeers: number;
  downloadSpeed: number;
  uploadSpeed: number;
  progress: number;
}

/** Typed error codes for torrent flow — not matched by prose. */
export type TorrentErrorCode =
  | 'INVALID_MAGNET'
  | 'WEBRTC_UNSUPPORTED'
  | 'PEER_INSUFFICIENT'
  | 'TRACKER_ERROR'
  | 'NO_PEERS'
  | 'NO_PLAYABLE_MEDIA'
  | 'STREAM_UNAVAILABLE'
  | 'GENERIC';

/** Adapter error: typed code + localized message. */
export interface TorrentAdapterError {
  code: TorrentErrorCode;
  message: string;
}

/** Localized error messages for the torrent flow. */
export interface TorrentErrorMessages {
  magnetErrorInvalid: string;
  magnetErrorWebRTC: string;
  magnetErrorPeerInsufficient: string;
  magnetErrorTracker: string;
  magnetErrorNoPeer: string;
  magnetErrorNoMedia: string;
  magnetErrorGeneric: string;
}

/** Events emitted by the adapter for PlayerApp integration. */
export interface TorrentAdapterCallbacks {
  onPhaseChange: (phase: TorrentSessionPhase) => void;
  onPeerStatus: (status: PeerStatus) => void;
  onError: (error: TorrentAdapterError) => void;
}
