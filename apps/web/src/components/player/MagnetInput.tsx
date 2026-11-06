/**
 * MagnetInput — ED-2G magnet source dialog (real companion torrent flow).
 * ---------------------------------------------------------------------------
 * Unified shell visible from modal open:
 * - Top: shadcn Input (magnet URI) + Lucide Magnet icon-only create button.
 * - Center: shadcn Table — empty state before metadata, spinner during
 *           checking, file/folder rows after metadata arrives.
 *           Table header "file name" column shows an ArrowUp button when
 *           navigating inside a subfolder (folderPath set).
 * - Bottom: "Pilih & putar" (select & play) / "Batal" (cancel during
 *           checking/settling). No chevron buttons; folder navigation is
 *           via clicking folder names in the table or the ArrowUp button.
 * - Tracker/peer IP disclosure shown as plain text above bottom nav.
 *
 * Only the explicit "Pilih & putar" button calls /select and hands the
 * accepted job to Player. Merely checking rows or navigating folders must
 * never start payload or Player playback.
 *
 * Flow semantics:
 * - After create the job is in its metadata-fetch phase: the table shows
 *   a spinner + localized "checking metadata" label, NEVER byte counts.
 * - The file picker appears once the companion reports `buffering` (the
 *   metadata is listed); payload download only begins after selection.
 * - Cancel / Back ("Kembali") / dialog close cancels the owned job
 *   asynchronously; the UI stays non-actionable ('settling') until the
 *   cancel response settles, so a second create can never race cleanup.
 * - A 201 answered after the dialog closed/reopened is parsed for its id
 *   and released with an immediate cancel (never owned, polled, or
 *   accepted), so the companion job can never be orphaned.
 * - An operation epoch isolates attempts: a stale poll/create/cancel
 *   response from a previous attempt can never mutate the current one.
 *
 * Desktop (Tauri) direct mode:
 * - Inside the Entei desktop app there is no companion and no capability
 *   token: the same dialog drives the in-process `tauri-plugin-torrent`
 *   (`add_torrent` / `get_torrent_status` / `select_torrent_files` /
 *   `cancel_torrent`) through `@/features/player/tauri-bridge`.
 * - The plugin returns a flat file list, so the rows are synthesized into
 *   the same folder/file table the companion flow shows (folders first,
 *   nested paths grouped per level) and folder navigation filters that
 *   list locally — no extra IPC round trip per folder.
 * - "Pilih & putar" calls `select_torrent_files`, which restricts the
 *   download to the chosen files and answers with loopback relay URLs
 *   (127.0.0.1 Range server) once the video's first byte is on disk. Those
 *   URLs are handed to the Player through `onJobAccepted`'s `direct`
 *   argument; the companion job/token path is skipped entirely.
 *
 * Hygiene contract:
 * - The magnet and job state live in component/page memory only — never
 *   localStorage / IndexedDB / sessionStorage / cookies / history / logs.
 * - Unpaired: only a pairing-needed notice; no input / submit.
 * - Errors are generic and localized; raw server/magnet/tracker/URL detail
 *   is suppressed. 400 = invalid magnet, 401/403 = re-pair, 409 = active
 *   job, network = companion unavailable.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/player/ui/dialog';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Checkbox } from '@/components/player/ui/checkbox';
import { Input } from '@/components/player/ui/input';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/player/ui/table';
import {
  Magnet,
  Film,
  Subtitles,
  FileText,
  Folder,
  ArrowUp,
} from 'lucide-react';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import { waitForPlayable } from '@/features/player/companion-media';
import { isFirefox } from '@/features/player/browser-detect';
import {
  notifyCompanionError,
  notifyFirefoxUnsupported,
} from '@/features/player/eizouden-toast';
import {
  addTorrentDirect,
  cancelTorrentDirect,
  getTorrentStatusDirect,
  isTauri,
  selectTorrentFilesDirect,
  type DirectTorrentFile,
} from '@/features/player/tauri-bridge';

/** Loopback companion origin; the only accepted torrent endpoint. */
const COMPANION_BASE_URL = 'http://127.0.0.1:4322';

/** Desktop direct mode: metadata poll interval (matches the companion flow). */
const DIRECT_POLL_INTERVAL_MS = 5000;
/** Desktop direct mode: bounded metadata polls before the timeout error. */
const DIRECT_METADATA_MAX_POLLS = 6;

type ErrorKind =
  | 'invalid'
  | 'repair'
  | 'conflict'
  | 'network'
  | 'generic'
  | 'novideo'
  | 'metadataTimeout'
  | 'evicted'
  | 'v2unsupported'
  | null;

type Phase =
  | 'input'
  | 'creating'
  | 'checking' // metadata fetch (before the file picker)
  | 'selecting'
  | 'submitting'
  | 'settling'; // awaiting the owned job's cancel settlement

/** API file entry (file or folder) from the /files endpoint. */
export interface FileEntry {
  id?: string; // present for files ("f0"), absent for folders
  basename: string;
  extension?: string;
  byteSize?: number;
  kind: 'video' | 'audio' | 'subtitle' | 'other' | 'folder';
  relativePath?: string;
}

export interface MagnetInputDict {
  magnetInputLabel: string;
  magnetInputPlaceholder: string;
  magnetInputLabelTitle: string;
  magnetErrorInvalid: string;
  magnetInputSubmit: string;
  magnetInputUnpairedBody: string;
  magnetConsentLabel: string;
  magnetInputErrorRepair: string;
  magnetInputErrorConflict: string;
  magnetInputErrorNetwork: string;
  magnetInputErrorGeneric: string;
  magnetInputErrorMetadataTimeout: string;
  magnetInputErrorEvicted: string;
  magnetInputErrorV2Unsupported: string;
  magnetInputSubmitting: string;
  magnetCheckMetadata: string;
  magnetFilesTitle: string;
  magnetFilesBody: string;
  magnetNoVideoError: string;
  magnetSelectSubmit: string;
  magnetCancel: string;
  dialogClose: string;
  // ED-2G: File browser table
  magnetTableFileName: string;
  magnetTableSize: string;
  magnetFileKindVideo: string;
  magnetFileKindSubtitle: string;
  magnetFileKindFolder: string;
  magnetFileKindOther: string;
  magnetTableNavUp: string;
  magnetNoVideosInFolder: string;
  firefoxUnsupported: string;
}

interface MagnetInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Kept for existing callers (PlayerApp still passes the pairing state)
   * but it no longer gates the form: the dialog always renders its input.
   */
  isPaired?: boolean;
  token: string | null;
  onJobAccepted: (
    jobId: string,
    selectedVideoName: string,
    subtitleFileId: string,
    /** Desktop (Tauri) direct mode: loopback relay URLs, no companion job. */
    direct?: DirectTorrentHandoff,
  ) => void;
  dict: MagnetInputDict;
}

/** Desktop direct handoff: the relay URLs the Player mounts directly. */
export interface DirectTorrentHandoff {
  videoUrl: string;
  subtitleUrl: string | null;
}

// Basic client-side magnet shape check only; the companion is the source of truth.
function isValidMagnetUri(value: string): boolean {
  const trimmed = value.trim();
  if (!/^magnet:\?/i.test(trimmed)) return false;
  const xtMatch = trimmed.match(/[?&]xt=urn:btih:([^&]+)/i);
  if (!xtMatch) return false;
  const hash = xtMatch[1];
  if (!hash) return false;
  return /^[0-9a-f]{40}$/i.test(hash) || /^[a-z2-7]{32}$/i.test(hash);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const errorMessages: Record<Exclude<ErrorKind, null>, (d: MagnetInputDict) => string> = {
  invalid: (d) => d.magnetErrorInvalid,
  repair: (d) => d.magnetInputErrorRepair,
  conflict: (d) => d.magnetInputErrorConflict,
  network: (d) => d.magnetInputErrorNetwork,
  generic: (d) => d.magnetInputErrorGeneric,
  novideo: (d) => d.magnetNoVideoError,
  metadataTimeout: (d) => d.magnetInputErrorMetadataTimeout,
  evicted: (d) => d.magnetInputErrorEvicted,
  v2unsupported: (d) => d.magnetInputErrorV2Unsupported,
};

function kindIcon(kind: FileEntry['kind'], size: number) {
  switch (kind) {
    case 'video':
      return <Film size={size} aria-hidden="true" />;
    case 'subtitle':
      return <Subtitles size={size} aria-hidden="true" />;
    case 'folder':
      return <Folder size={size} aria-hidden="true" />;
    default:
      return <FileText size={size} aria-hidden="true" />;
  }
}

function kindLabel(entry: FileEntry, dict: MagnetInputDict): string {
  switch (entry.kind) {
    case 'video':
      return dict.magnetFileKindVideo;
    case 'subtitle':
      return dict.magnetFileKindSubtitle;
    case 'folder':
      return dict.magnetFileKindFolder;
    default:
      return dict.magnetFileKindOther;
  }
}

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'webm',
  'avi',
  'mov',
  'm4v',
  'ts',
  'm2ts',
  'ogv',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
]);
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'opus',
  'wav',
]);
const SUBTITLE_EXTENSIONS = new Set([
  'srt',
  'vtt',
  'ass',
  'ssa',
  'sub',
  'idx',
  'ttml',
  'dfxp',
]);

/** Extension of a path, lowercased, or an empty string when it has none. */
function pathExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function kindForPath(path: string): FileEntry['kind'] {
  const extension = pathExtension(path);
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (SUBTITLE_EXTENSIONS.has(extension)) return 'subtitle';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return 'other';
}

/**
 * Synthesize the folder/file table rows for one level of a flat torrent file
 * list (desktop direct mode).
 *
 * The plugin returns paths like `Show/Season 1/Episode 01.mkv`, while the
 * table browses one level at a time: rows for the current level's files plus
 * one folder row per immediate subdirectory. Folders come first, in first-seen
 * order, matching the companion's synthesized listing.
 *
 * `parentPath` is the folder currently open ('' = torrent root).
 */
export function synthesizeEntries(
  files: DirectTorrentFile[],
  parentPath: string,
): FileEntry[] {
  const prefix = parentPath ? `${parentPath.replace(/\/$/, '')}/` : '';
  const folders: FileEntry[] = [];
  const seenFolders = new Set<string>();
  const rows: FileEntry[] = [];

  for (const file of files) {
    const normalized = file.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (prefix && !normalized.startsWith(prefix)) continue;
    const relative = normalized.slice(prefix.length);
    if (!relative) continue;

    const slash = relative.indexOf('/');
    if (slash === -1) {
      rows.push({
        id: `f${file.index}`,
        basename: relative,
        extension: pathExtension(relative),
        byteSize: file.length,
        kind: kindForPath(relative),
        relativePath: normalized,
      });
      continue;
    }

    const folderName = relative.slice(0, slash);
    if (!folderName || seenFolders.has(folderName)) continue;
    seenFolders.add(folderName);
    folders.push({
      basename: folderName,
      kind: 'folder',
      relativePath: `${prefix}${folderName}`,
    });
  }

  return [...folders, ...rows];
}

/** Parse the metadata file index out of a synthesized row id (`f12`). */
function directIndexFromId(id: string): number | null {
  if (!/^f\d+$/.test(id)) return null;
  const index = Number.parseInt(id.slice(1), 10);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** Map a plugin rejection onto the dialog's localized error kinds. */
function mapDirectError(error: unknown): ErrorKind {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /invalid magnet/i.test(message) ? 'invalid' : 'generic';
}

export function MagnetInput({
  open,
  onOpenChange,
  token,
  onJobAccepted,
  dict,
}: MagnetInputProps) {
  const [magnet, setMagnet] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [jobId, setJobId] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [videoId, setVideoId] = useState('');
  const [subtitleId, setSubtitleId] = useState('');
  const [error, setError] = useState<ErrorKind>(null);
  // Folder navigation: internal path state (never sent to cancel/recreate)
  const [folderPath, setFolderPath] = useState('');

  // Errors are surfaced as a Toast, never as inline text inside the dialog
  // (DESIGN.md 8.6/8.8): the table and the bottom actions keep their layout.
  // `error` still drives `aria-invalid`. `dict` is read through a ref so a new
  // dictionary object cannot re-fire the toast for the same error.
  const dictRef = useRef(dict);
  dictRef.current = dict;
  useEffect(() => {
    if (error === null) return;
    notifyCompanionError(errorMessages[error](dictRef.current), 'magnet-input-error');
  }, [error]);

  // Desktop (Tauri) direct mode: the plugin's flat file list, kept so folder
  // navigation filters locally instead of re-querying the torrent. Page
  // memory only; cleared with the job like every other torrent field.
  const directFilesRef = useRef<DirectTorrentFile[]>([]);

  // Stale-callback guards
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const jobIdRef = useRef<string | null>(null);
  // Mirrors the newest capability token for the unmount-only cleanup below:
  // that effect must not re-run on token changes, or it would cancel a live
  // job just because the token was refreshed.
  const tokenRef = useRef(token);
  // Monotonic generation counter for the async flows this dialog owns
  // (create/poll/select/cancel). Every dialog close, reopen, cancel, or new
  // attempt bumps it, so responses that were in flight for a PREVIOUS
  // generation are detected (`attempt !== epochRef.current`) and dropped —
  // a stale poll must never resurrect the file picker, a stale select must
  // never reach the Player, and a stale cancel must never mutate state.
  const epochRef = useRef(0);
  // Aborts the playable-wait poll when the dialog closes or unmounts (the
  // late result is additionally dropped by the epoch/mounted/open guards).
  const waitAbortRef = useRef<AbortController | null>(null);
  // The in-flight cancel settlement for the job this dialog owns. While it
  // is set, close/reopen wait for it and never fire a second cancel for the
  // same job; the promise is cleared only by its own finally (guarded by
  // the epoch), so a reopen cannot race past an unsettled cancel.
  const settleRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      waitAbortRef.current?.abort();
      // A torrent this dialog created but never handed off (the dialog or the
      // whole island unmounts before select/cancel) would otherwise keep
      // downloading forever. Fire-and-forget: unmount cleanup cannot await.
      const abandonedId = jobIdRef.current;
      jobIdRef.current = null;
      if (!abandonedId) return;
      if (isTauri()) {
        void cancelTorrentDirect(abandonedId).catch(() => undefined);
        return;
      }
      const currentToken = tokenRef.current;
      if (!currentToken) return;
      void fetch(
        `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(abandonedId)}/cancel?token=${encodeURIComponent(currentToken)}`,
        { method: 'POST', cache: 'no-store' },
      ).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    openRef.current = open;
    if (!open && !settleRef.current) {
      setPhase('input');
    }
  }, [open]);

  // Clear everything whenever the dialog (re)opens
  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      if (settleRef.current) {
        try {
          await settleRef.current;
        } catch {
          // settle never rejects
        }
      }
      if (!active) return;
      epochRef.current += 1;
      jobIdRef.current = null;
      settleRef.current = null;
      directFilesRef.current = [];
      setMagnet('');
      setPhase('input');
      setJobId('');
      setEntries([]);
      setVideoId('');
      setSubtitleId('');
      setError(null);
      setFolderPath('');
    })();
    return () => {
      active = false;
    };
  }, [open]);

  // Cancels the torrent job this dialog owns
  const runCancel = useCallback(
    (): Promise<void> => {
      const id = jobIdRef.current;
      if (!id) {
        return Promise.resolve();
      }
      epochRef.current += 1;
      waitAbortRef.current?.abort();
      const attempt = epochRef.current;
      jobIdRef.current = null;
      setJobId('');
      setEntries([]);
      setVideoId('');
      setSubtitleId('');
      setError(null);
      setPhase('settling');
      setFolderPath('');
      const settle = (async () => {
        try {
          if (isTauri()) {
            // Desktop direct mode: cancel the in-process torrent. A rejection
            // is best-effort (the session may already be gone).
            await cancelTorrentDirect(id).catch(() => undefined);
            return;
          }
          const res = await fetch(
            `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(id)}/cancel?token=${encodeURIComponent(token ?? '')}`,
            { method: 'POST', cache: 'no-store' },
          );
          if (res.status !== 200 && res.status !== 404) {
            if (attempt === epochRef.current && mountedRef.current) {
              setError(res.status === 401 || res.status === 403 ? 'repair' : 'generic');
            }
          }
        } catch {
          if (attempt === epochRef.current && mountedRef.current) {
            setError('network');
          }
        } finally {
          if (attempt === epochRef.current && mountedRef.current) {
            settleRef.current = null;
            setPhase('input');
          }
        }
      })();
      settleRef.current = settle;
      return settle;
    },
    [token],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        epochRef.current += 1;
        waitAbortRef.current?.abort();
        void runCancel();
      }
      onOpenChange(nextOpen);
    },
    [runCancel, onOpenChange],
  );

  const handleCancel = useCallback(() => {
    void runCancel();
  }, [runCancel]);

  // Releases a job the companion accepted for a create request this dialog
  // no longer owns (the dialog was closed/reopened while the create was in
  // flight and the 201 arrived late). The orphaned job is cancelled
  // immediately, best-effort; its settlement joins the same settleRef gate
  // so a subsequent close/reopen waits for it instead of racing it.
  const releaseLateJob = useCallback(
    (id: string): void => {
      const settle = (async () => {
        try {
          const res = await fetch(
            `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(id)}/cancel?token=${encodeURIComponent(token ?? '')}`,
            { method: 'POST', cache: 'no-store' },
          );
          void res;
        } catch {
          // best-effort
        }
      })();
      const cleanup = () => {
        if (settleRef.current === settle) settleRef.current = null;
      };
      settle.then(cleanup, cleanup);
      settleRef.current = settle;
    },
    [token],
  );

  // Desktop (Tauri) direct create: no companion, no capability token. The
  // in-process plugin validates the magnet, resolves metadata (bounded) and
  // returns the file list; an empty list means "metadata still resolving",
  // which the direct poll below picks up.
  const createDirect = useCallback(async () => {
    if (settleRef.current) return;
    if (!isValidMagnetUri(magnet)) {
      setError('invalid');
      return;
    }

    // Replace any torrent this dialog already owns (same semantics as the
    // companion flow: the new attempt wins, the old session is dropped).
    const existingJobId = jobIdRef.current;
    if (existingJobId) {
      void cancelTorrentDirect(existingJobId).catch(() => undefined);
      jobIdRef.current = null;
      setJobId('');
      setEntries([]);
      setVideoId('');
      setSubtitleId('');
      setFolderPath('');
    }

    epochRef.current += 1;
    const attempt = epochRef.current;
    directFilesRef.current = [];
    setPhase('creating');
    setError(null);

    try {
      const added = await addTorrentDirect(magnet.trim());
      if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) {
        // The dialog was closed/reopened while the add was in flight: never
        // own the torrent, release it immediately instead of leaving it
        // downloading in the background.
        if (added.id) void cancelTorrentDirect(added.id).catch(() => undefined);
        return;
      }
      if (!added.id) {
        setError('generic');
        setPhase('input');
        return;
      }
      jobIdRef.current = added.id;
      setJobId(added.id);
      directFilesRef.current = added.files;
      if (added.files.length === 0) {
        // Metadata not resolved yet — the direct poll retries.
        setPhase('checking');
        return;
      }
      const list = synthesizeEntries(added.files, '');
      if (
        !list.some((entry) => entry.kind === 'video') &&
        !list.some((entry) => entry.kind === 'folder')
      ) {
        setError('novideo');
        setPhase('input');
        return;
      }
      setEntries(list);
      setFolderPath('');
      setPhase('selecting');
    } catch (err) {
      if (attempt !== epochRef.current || !mountedRef.current) return;
      setError(mapDirectError(err));
      setPhase('input');
    }
  }, [magnet]);

  const handleCreate = useCallback(async () => {
    if (isTauri()) {
      await createDirect();
      return;
    }
    // The form is never gated on pairing. Without a capability token the
    // companion would reject the create, so surface the localized
    // re-pair message instead of failing silently.
    if (!token) {
      setError('repair');
      return;
    }
    if (settleRef.current) return;
    if (!isValidMagnetUri(magnet)) {
      setError('invalid');
      return;
    }

    // If there is an existing job (checking/selecting), cancel it first
    // so the companion releases the session before we create a new one.
    const existingJobId = jobIdRef.current;
    if (existingJobId) {
      // Fire-and-forget: don't await the cancel response. Safe because
      // (1) the companion supports up to 2 concurrent torrent sessions
      //     with oldest-first eviction on a 3rd, so a stale session is
      //     automatically reclaimed, and (2) the companion's Cancel is
      //     synchronous (blocks until the engine stops), so awaiting it
      //     would block the UI unnecessarily.
      void fetch(
        `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(existingJobId)}/cancel?token=${encodeURIComponent(token)}`,
        { method: 'POST', cache: 'no-store' },
      ).catch(() => {
        // Best-effort: if the companion is unreachable the old session
        // will be evicted when the 2-session capacity is exceeded.
      });
      // Reset local state for the old job immediately.
      jobIdRef.current = null;
      setJobId('');
      setEntries([]);
      setVideoId('');
      setSubtitleId('');
      setFolderPath('');
    }

    epochRef.current += 1;
    const attempt = epochRef.current;
    setPhase('creating');
    setError(null);
    try {
      const res = await fetch(
        `${COMPANION_BASE_URL}/v1/source/torrents?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ magnet: magnet.trim() }),
          cache: 'no-store',
        },
      );
      if (res.status === 201) {
        let id = '';
        try {
          const body = (await res.json()) as { id?: unknown };
          if (typeof body.id === 'string' && body.id.length > 0) id = body.id;
        } catch {
          // Malformed body
        }
        if (attempt === epochRef.current && mountedRef.current) {
          if (!id) {
            setError('generic');
            setPhase('input');
            return;
          }
          jobIdRef.current = id;
          setJobId(id);
          setPhase('checking');
          return;
        }
        if (id) {
          releaseLateJob(id);
        }
        return;
      }
      if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
      switch (res.status) {
        case 400:
          setError('invalid');
          break;
        case 401:
        case 403:
          setError('repair');
          break;
        case 409:
          setError('conflict');
          break;
        default:
          setError('generic');
      }
      setPhase('input');
    } catch {
      if (attempt !== epochRef.current || !mountedRef.current) return;
      setError('network');
      setPhase('input');
    }
  }, [token, magnet, createDirect]);

  // Redacted status polling while checking metadata
  useEffect(() => {
    if (phase !== 'checking' || !jobId || !token) return;
    const attempt = epochRef.current;
    let cancelled = false;
    const safe = () =>
      !cancelled && attempt === epochRef.current && mountedRef.current && openRef.current;
    const timer = window.setInterval(async () => {
      if (!safe()) return;
      try {
        const res = await fetch(
          `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`,
          { cache: 'no-store' },
        );
        if (!safe()) return;
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) setError('repair');
          else setError('generic');
          setPhase('input');
          return;
        }
        const body = (await res.json()) as { state?: string; error?: string; errorCode?: string };
        if (!safe()) return;
        if (body.state === 'buffering') {
          // Metadata arrived: fetch the file listing (root level).
          const filesRes = await fetch(
            `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(jobId)}/files?token=${encodeURIComponent(token)}`,
            { cache: 'no-store' },
          );
          if (!safe()) return;
          if (!filesRes.ok) {
            setError('generic');
            setPhase('input');
            return;
          }
          const filesBody = (await filesRes.json()) as { files?: FileEntry[] };
          if (!safe()) return;
          const list = Array.isArray(filesBody.files) ? filesBody.files : [];
          // Root may legitimately contain only folder rows: SynthesizeEntries
          // hides nested files behind folder rows, so videos appear only after
          // folder navigation. Only a root with neither videos nor folders is
          // a genuine no-video torrent.
          const hasVideo = list.some((f) => f.kind === 'video');
          const hasFolder = list.some((f) => f.kind === 'folder');
          if (!hasVideo && !hasFolder) {
            setError('novideo');
            setPhase('input');
            return;
          }
          setEntries(list);
          setPhase('selecting');
          return;
        }
        if (body.state === 'error') {
          if (body.errorCode === 'torrent_concurrency_limit') {
            setError('evicted');
          } else if (body.errorCode === 'torrent_v2_unsupported') {
            setError('v2unsupported');
          } else if (body.error === 'metadata timed out') {
            setError('metadataTimeout');
          } else {
            setError('generic');
          }
          setPhase('input');
          return;
        }
      } catch {
        if (safe()) {
          setError('network');
          setPhase('input');
        }
      }
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, jobId, token]);

  // Desktop (Tauri) direct mode: poll the in-process torrent until the
  // metadata (file list) arrives. The plugin reports `initializing` while it
  // is still resolving peers, so the table keeps showing the "checking
  // metadata" spinner; a bounded poll count turns a torrent that never
  // resolves into the localized metadata-timeout error instead of an endless
  // spinner.
  useEffect(() => {
    if (!isTauri()) return;
    if (phase !== 'checking' || !jobId) return;
    const attempt = epochRef.current;
    let cancelled = false;
    let polls = 0;
    const safe = () =>
      !cancelled && attempt === epochRef.current && mountedRef.current && openRef.current;

    const timer = window.setInterval(async () => {
      if (!safe()) return;
      polls += 1;
      if (polls > DIRECT_METADATA_MAX_POLLS) {
        setError('metadataTimeout');
        setPhase('input');
        return;
      }
      try {
        const status = await getTorrentStatusDirect(jobId);
        if (!safe()) return;
        if (status.state === 'error') {
          setError('generic');
          setPhase('input');
          return;
        }
        if (status.files.length === 0) return;
        directFilesRef.current = status.files;
        const list = synthesizeEntries(status.files, '');
        if (
          !list.some((entry) => entry.kind === 'video') &&
          !list.some((entry) => entry.kind === 'folder')
        ) {
          setError('novideo');
          setPhase('input');
          return;
        }
        setEntries(list);
        setFolderPath('');
        setPhase('selecting');
      } catch {
        if (!safe()) return;
        setError('generic');
        setPhase('input');
      }
    }, DIRECT_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, jobId]);

  // Fetch files for a specific folder path (folder navigation)
  const fetchFolderContents = useCallback(
    async (targetPath: string) => {
      // Desktop direct mode: the full flat file list is already in memory, so
      // folder navigation is a pure filter — no IPC round trip, and the
      // torrent job is never re-created just to browse.
      if (isTauri()) {
        setError(null);
        setEntries(synthesizeEntries(directFilesRef.current, targetPath));
        setFolderPath(targetPath);
        return;
      }
      if (!jobId || !token) return;
      setError(null); // clear any recoverable error from previous navigation
      try {
        const params = new URLSearchParams({ token });
        if (targetPath) params.set('parentPath', targetPath);
        const res = await fetch(
          `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(jobId)}/files?${params.toString()}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          setError('generic');
          return;
        }
        const body = (await res.json()) as { files?: FileEntry[] };
        const list = Array.isArray(body.files) ? body.files : [];
        setEntries(list);
        setFolderPath(targetPath);
      } catch {
        setError('generic');
      }
    },
    [jobId, token],
  );

  const handleFolderForward = useCallback(
    (targetPath: string) => {
      void fetchFolderContents(targetPath);
    },
    [fetchFolderContents],
  );

  const handleFolderBack = useCallback(() => {
    if (!folderPath) return;
    const parts = folderPath.split('/').filter(Boolean);
    parts.pop();
    void fetchFolderContents(parts.join('/'));
  }, [folderPath, fetchFolderContents]);

  const handleSelect = useCallback(async () => {
    // Desktop direct mode has no capability token; the companion flow does.
    const desktop = isTauri();
    if (!desktop && !token) return;
    if (!jobId || !videoId) return;
    if (!entries.some((f) => f.id === videoId && f.kind === 'video')) {
      setError('generic');
      return;
    }
    if (
      subtitleId !== '' &&
      !entries.some((f) => f.id === subtitleId && f.kind === 'subtitle')
    ) {
      setError('generic');
      return;
    }

    // Firefox playback guard: block all media selection with a toast
    if (isFirefox()) {
      notifyFirefoxUnsupported(dict.firefoxUnsupported);
      return;
    }

    setPhase('submitting');
    setError(null);
    // Guard against stale select responses: a close/reopen (epoch bump) or
    // unmount while the select is in flight must drop the late 200/error —
    // the stale success must never reach onJobAccepted / the Player.
    const attempt = epochRef.current;

    if (desktop) {
      // Desktop direct mode: restrict the download to the chosen files and
      // take the loopback relay URLs. The plugin only answers once the
      // video's first byte is on disk, so the URLs are safe to mount.
      const videoIndex = directIndexFromId(videoId);
      const subtitleIndex = subtitleId ? directIndexFromId(subtitleId) : null;
      if (videoIndex === null || (subtitleId !== '' && subtitleIndex === null)) {
        setError('generic');
        setPhase('selecting');
        return;
      }
      try {
        const selection = await selectTorrentFilesDirect(jobId, videoIndex, subtitleIndex);
        if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
        const selected = entries.find((f) => f.id === videoId);
        jobIdRef.current = null;
        directFilesRef.current = [];
        setPhase('input');
        setMagnet('');
        setFolderPath('');
        onJobAccepted(
          jobId,
          selection.video_name || (selected ? selected.basename : ''),
          '',
          { videoUrl: selection.video_url, subtitleUrl: selection.subtitle_url },
        );
      } catch (err) {
        if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
        setError(mapDirectError(err));
        setPhase('selecting');
      }
      return;
    }

    // Companion flow below: a capability token is mandatory.
    if (!token) return;

    try {
      const res = await fetch(
        `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(jobId)}/select?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoFileId: videoId, subtitleFileId: subtitleId }),
          cache: 'no-store',
        },
      );
      if (res.status === 200) {
        if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
        // /select accepted the job — but it may still be preparing. Wait
        // until the companion reports playable (or complete) before handing
        // the job to the Player; otherwise the Player mounts a media element
        // over a still-buffering job and shows the "Unduhan gagal" error
        // fallback. The wait stays inside the modal (the select button shows
        // the loading animation) and can be cancelled via close / Batal.
        waitAbortRef.current?.abort();
        const waitAbort = new AbortController();
        waitAbortRef.current = waitAbort;
        const playable = await waitForPlayable(token, {
          signal: waitAbort.signal,
        });
        if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
        if (!playable.ok) {
          // Do NOT hand the job to the Player — keep the user in the modal
          // with a localized error (companion down / job error / timeout).
          setError(playable.reason === 'network' ? 'network' : 'generic');
          setPhase('selecting');
          return;
        }
        const selected = entries.find((f) => f.id === videoId);
        jobIdRef.current = null;
        setPhase('input');
        setMagnet('');
        setFolderPath('');
        onJobAccepted(jobId, selected ? selected.basename : '', subtitleId);
        return;
      }
      if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
      switch (res.status) {
        case 401:
        case 403:
          setError('repair');
          break;
        case 409:
          setError('conflict');
          break;
        default:
          setError('generic');
      }
      setPhase('selecting');
    } catch {
      if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
      setError('network');
      setPhase('selecting');
    }
  }, [token, jobId, videoId, subtitleId, entries, onJobAccepted]);

  // Checkbox change handler: video/subtitle selection with replacement logic
  const handleCheckboxChange = useCallback(
    (entry: FileEntry, checked: boolean) => {
      if (entry.kind === 'video') {
        setVideoId(checked && entry.id ? entry.id : '');
      } else if (entry.kind === 'subtitle') {
        setSubtitleId(checked && entry.id ? entry.id : '');
      }
    },
    [],
  );

  const busy = phase === 'creating' || phase === 'submitting' || phase === 'settling';
  const canCreate = !busy && isValidMagnetUri(magnet);
  const hasVideoSelected = videoId !== '';
  // Keep the file list visible during the playable wait (submitting): the
  // entries are still held and must not collapse into the empty state while
  // waitForPlayable runs after /select.
  const showTable = phase === 'selecting' || phase === 'submitting';
  const showChecking = phase === 'checking';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="entei-magnet-dialog" closeLabel={dict.dialogClose}>
        <DialogHeader>
          <DialogTitle className="entei-magnet-dialog-title">
            {dict.magnetInputLabelTitle}
          </DialogTitle>
        </DialogHeader>

        <div className="entei-magnet-shell">
          {/* ── Top: Input + create button ── */}
          <div className="entei-magnet-shell-top">
            <ButtonGroup className="entei-magnet-input-row">
              <Input
                className="entei-magnet-input"
                placeholder={dict.magnetInputPlaceholder}
                aria-label={dict.magnetInputLabel}
                aria-invalid={error === 'invalid'}
                value={magnet}
                onChange={(e) => {
                  setMagnet(e.target.value);
                  if (error) setError(null);
                }}
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="entei-magnet-add-btn"
                onClick={() => void handleCreate()}
                disabled={!canCreate}
                aria-label={dict.magnetInputLabelTitle}
                title={dict.magnetInputSubmit}
              >
                <Magnet size={16} aria-hidden="true" />
              </Button>
            </ButtonGroup>
          </div>

          {/* ── Center: Table with state-dependent content ── */}
          <div className="entei-magnet-table-wrap">
            <Table className="entei-magnet-table">
              <TableHeader>
                <TableRow className="entei-magnet-table-header-row">
                  <TableHead className="entei-magnet-table-head-check">
                    {/* ArrowUp: only rendered when folderPath is set (selecting
                        phase with a subfolder open). Positioned in the leftmost
                        column for consistent left-aligned navigation. */}
                    {folderPath && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="entei-magnet-arrow-up-btn"
                        onClick={handleFolderBack}
                        disabled={busy}
                        aria-label={dict.magnetTableNavUp}
                        title={dict.magnetTableNavUp}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                      </Button>
                    )}
                  </TableHead>
                  <TableHead className="entei-magnet-table-head-type" />
                  <TableHead className="entei-magnet-table-head-name">
                    {dict.magnetTableFileName}
                  </TableHead>
                  <TableHead className="entei-magnet-table-head-size">
                    {dict.magnetTableSize}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {showTable && entries.length === 0
                  ? (
                      <TableRow className="entei-magnet-table-row--static">
                        <TableCell colSpan={4} className="entei-magnet-table-cell-empty">
                          <div className="entei-magnet-empty">
                            <span className="entei-magnet-empty-title">
                              {dict.magnetNoVideosInFolder}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  : showTable
                    ? entries.map((entry) => {
                      const isFolder = entry.kind === 'folder';
                      const isVideo = entry.kind === 'video';
                      const isSubtitle = entry.kind === 'subtitle';
                      const isSelected =
                        (isVideo && videoId === entry.id) ||
                        (isSubtitle && subtitleId === entry.id);

                      return (
                        <TableRow
                          key={entry.id ?? entry.relativePath ?? entry.basename}
                          className={`entei-magnet-table-row ${isFolder ? 'entei-magnet-table-row--folder' : ''} ${isSelected ? 'entei-magnet-table-row--selected' : ''}`}
                        >
                          <TableCell className="entei-magnet-table-cell-check">
                            {isFolder ? (
                              <Checkbox
                                disabled
                                checked={false}
                                aria-label={`${dict.magnetFileKindFolder}: ${entry.basename}`}
                              />
                            ) : isVideo || isSubtitle ? (
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={(checked) =>
                                  handleCheckboxChange(entry, checked === true)
                                }
                                disabled={busy}
                                aria-label={`${kindLabel(entry, dict)}: ${entry.basename}`}
                              />
                            ) : null}
                          </TableCell>
                          <TableCell className="entei-magnet-table-cell-icon">
                            {kindIcon(entry.kind, 16)}
                          </TableCell>
                          <TableCell className="entei-magnet-table-cell-name">
                            {isFolder ? (
                              <button
                                type="button"
                                className="entei-magnet-folder-btn"
                                onClick={() =>
                                  handleFolderForward(entry.relativePath ?? entry.basename)
                                }
                                disabled={busy}
                              >
                                {entry.basename}
                              </button>
                            ) : (
                              <span className="entei-magnet-file-name-text">
                                {entry.basename}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="entei-magnet-table-cell-size">
                            {isFolder
                              ? ''
                              : entry.byteSize != null
                                ? formatBytes(entry.byteSize)
                                : ''}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  : showChecking
                    ? (
                        <TableRow className="entei-magnet-table-row--static">
                          <TableCell colSpan={4} className="entei-magnet-table-cell-empty">
                            <div className="entei-magnet-checking" role="status">
                              <span>{dict.magnetCheckMetadata}</span>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    : (
                        <TableRow className="entei-magnet-table-row--static">
                          <TableCell colSpan={4} className="entei-magnet-table-cell-empty">
                            <div className="entei-magnet-empty">
                              <span className="entei-magnet-empty-title">
                                {dict.magnetFilesTitle}
                              </span>
                              <span className="entei-magnet-empty-body">
                                {dict.magnetFilesBody}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
              </TableBody>
            </Table>
          </div>

          {/* ── Tracker/peer IP disclosure (plain text, no checkbox) ── */}
          <p className="entei-magnet-consent-text">
            {dict.magnetConsentLabel}
          </p>

          {/* ── Bottom: Select & play ── */}
          <div className="entei-magnet-browser-bottom">
            {(showChecking || phase === 'submitting' || phase === 'settling') ? (
              <Button
                type="button"
                variant="outline"
                className="entei-magnet-submit entei-magnet-cancel"
                onClick={handleCancel}
                aria-label={dict.magnetCancel}
              >
                {/* Loading animation while the dialog is busy (metadata
                    check / playable wait / cancel settle); the accessible
                    name above keeps the cancel affordance for SR users. */}
                <TypewriterLoading
                  aria-hidden="true"
                  className="entei-typewriter--btn"
                />
              </Button>
            ) : (
              <Button
                type="button"
                className="entei-magnet-submit entei-magnet-select-play"
                onClick={() => void handleSelect()}
                disabled={busy || !showTable || !hasVideoSelected}
                aria-label={dict.magnetSelectSubmit}
              >
                {busy ? (
                  <TypewriterLoading
                    aria-hidden="true"
                    className="entei-typewriter--btn"
                  />
                ) : (
                  dict.magnetSelectSubmit
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
