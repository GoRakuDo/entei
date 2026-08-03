/**
 * MagnetInput — ED-2G magnet source dialog (real companion torrent flow).
 * ---------------------------------------------------------------------------
 * A real, controlled dialog: magnet textarea + required tracker-consent
 * checkbox + submit that creates a torrent source job on the paired
 * localhost companion (POST /v1/source/torrents?token=…), polls the redacted
 * job status, lists the sanitized files when the metadata arrived, lets
 * the user pick exactly one `video` file (and optionally one `subtitle`),
 * and submits the selection (POST …/select). On acceptance the opaque job
 * id is handed to the bridge session (kind 'torrent') and the dialog closes
 * to the Player immediately; payload download progress is NOT shown in the
 * dialog by contract.
 *
 * Flow semantics:
 * - After create the job is in its metadata-fetch phase: the dialog shows
 *   only a localized "checking metadata" label + spinner, NEVER byte counts
 *   (the payload has not started yet; `0 B / 0 B` would be a lie).
 * - The file picker appears once the companion reports `buffering` (the
 *   metadata is listed); payload download only begins after selection.
 * - Batal / dialog close cancel the owned job asynchronously and the UI
 *   stays non-actionable ('settling') until the cancel response settles, so
 *   a second create can never race the first job's cleanup.
 * - An operation epoch isolates attempts: a stale poll/create/cancel
 *   response from a previous attempt can never mutate the current one.
 * - A cancel 404 (job already freed — genuine completion or an earlier
 *   settle) is treated as clean; any other non-OK cancel surfaces a
 *   localized, recoverable error instead of pretending it stopped.
 *
 * Hygiene contract:
 * - The magnet and job state live in component/page memory only — never
 *   localStorage / IndexedDB / sessionStorage / cookies / history / logs.
 *   (The capability token itself is persisted opaquely by the pairing
 *   controller; this dialog never writes any storage.)
 * - Unpaired: only a pairing-needed notice; no input / consent / submit.
 * - The consent checkbox is REQUIRED before submit (trackers/peers see the
 *   user's IP); memory-only, never persisted.
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
  DialogDescription,
} from '@/components/player/ui/dialog';
import { Button } from '@/components/player/ui/button';
import { Checkbox } from '@/components/player/ui/checkbox';
import {
  Magnet,
  Film,
  Subtitles,
  FileText,
  Loader2,
} from 'lucide-react';

/** Loopback companion origin; the only accepted torrent endpoint. */
const COMPANION_BASE_URL = 'http://127.0.0.1:4322';

type ErrorKind =
  | 'invalid'
  | 'repair'
  | 'conflict'
  | 'network'
  | 'generic'
  | 'novideo'
  | null;

type Phase =
  | 'input'
  | 'creating'
  | 'checking' // metadata fetch (before the file picker)
  | 'selecting'
  | 'submitting'
  | 'settling'; // awaiting the owned job's cancel settlement

export interface TorrentFileInfo {
  id: string;
  basename: string;
  extension: string;
  byteSize: number;
  kind: 'video' | 'audio' | 'subtitle' | 'other';
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
  magnetInputSubmitting: string;
  magnetCheckMetadata: string;
  magnetFilesTitle: string;
  magnetFilesBody: string;
  magnetVideoKindLabel: string;
  magnetSubtitleKindLabel: string;
  magnetOtherKindLabel: string;
  magnetNoVideoError: string;
  magnetSelectSubmit: string;
  magnetCancel: string;
  dialogClose: string;
}

interface MagnetInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Paired state: job creation is allowed only after a successful pairing. */
  isPaired: boolean;
  /** Capability token (persisted opaquely by the pairing controller);
   *  used only in the request query string. */
  token: string | null;
  /** Called with the opaque job id once the selection was accepted, plus
   *  the SANITIZED basename of the selected video (from the companion's
   *  file list — basename only, no path) so the player can show it in the
   *  top-left controls / history. */
  onJobAccepted: (jobId: string, selectedVideoName: string) => void;
  dict: MagnetInputDict;
}

// Basic client-side magnet shape check only; the companion is the source of
// truth. Rejects clearly-invalid input before any network call.
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
};

function kindLabel(kind: TorrentFileInfo['kind'], dict: MagnetInputDict): string {
  switch (kind) {
    case 'video':
      return dict.magnetVideoKindLabel;
    case 'subtitle':
      return dict.magnetSubtitleKindLabel;
    default:
      return dict.magnetOtherKindLabel;
  }
}

function kindIcon(kind: TorrentFileInfo['kind'], size: number) {
  switch (kind) {
    case 'video':
      return <Film size={size} aria-hidden="true" />;
    case 'subtitle':
      return <Subtitles size={size} aria-hidden="true" />;
    default:
      return <FileText size={size} aria-hidden="true" />;
  }
}

export function MagnetInput({
  open,
  onOpenChange,
  isPaired,
  token,
  onJobAccepted,
  dict,
}: MagnetInputProps) {
  const [magnet, setMagnet] = useState('');
  const [consented, setConsented] = useState(false);
  const [phase, setPhase] = useState<Phase>('input');
  const [jobId, setJobId] = useState('');
  const [files, setFiles] = useState<TorrentFileInfo[]>([]);
  const [videoId, setVideoId] = useState('');
  const [subtitleId, setSubtitleId] = useState('');
  const [error, setError] = useState<ErrorKind>(null);

  // Stale-callback guards: async work that settles after the dialog closed
  // or the component unmounted must not fire callbacks or mutate UI state.
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  // Owned job id (mirrors `jobId` for synchronous reads inside handlers).
  const jobIdRef = useRef<string | null>(null);
  // Operation epoch: every create/cancel/close bumps it; async continuations
  // capture their epoch and refuse to mutate state once it moved on.
  const epochRef = useRef(0);
  // The in-flight cancel settlement. Reopening awaits it before exposing a
  // fresh input, so a re-open while cleanup runs can never reinitialize and
  // create a new job first.
  const settleRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    openRef.current = open;
    if (!open && !settleRef.current) {
      // Reset only when no cancel settlement is pending: while a settle is
      // in flight the dialog must stay non-actionable, even across a close/
      // reopen, until the cleanup resolves.
      setPhase('input');
    }
  }, [open]);

  // Clear everything whenever the dialog (re)opens — but only after any
  // in-flight cancel settlement resolves (see settleRef above).
  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      if (settleRef.current) {
        try {
          await settleRef.current;
        } catch {
          // settle never rejects; belt-and-braces only.
        }
      }
      if (!active) return;
      epochRef.current += 1;
      jobIdRef.current = null;
      settleRef.current = null;
      setMagnet('');
      setConsented(false);
      setPhase('input');
      setJobId('');
      setFiles([]);
      setVideoId('');
      setSubtitleId('');
      setError(null);
    })();
    return () => {
      active = false;
    };
  }, [open]);

  // Cancels the torrent job this dialog owns and returns a promise that
  // settles when the companion acknowledged the cancel (or the request
  // failed). The UI stays non-actionable ('settling') until then; a 404
  // (job already freed) is a clean settle; any other failure is surfaced as
  // a localized, recoverable error.
  const runCancel = useCallback((): Promise<void> => {
    const id = jobIdRef.current;
    if (!id) {
      // Nothing owned: nothing to settle. An already-running settle (if
      // any) stays in place and keeps gating.
      return Promise.resolve();
    }
    // This cancel IS the settlement of the current attempt: invalidate all
    // in-flight callbacks of the previous attempt before the job reference
    // is dropped, so no stale poll/create/select response can resurrect it.
    epochRef.current += 1;
    const attempt = epochRef.current;
    jobIdRef.current = null;
    setJobId('');
    setFiles([]);
    setVideoId('');
    setSubtitleId('');
    setError(null);
    setPhase('settling');
    const settle = (async () => {
      try {
        const res = await fetch(
          `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(id)}/cancel?token=${encodeURIComponent(token ?? '')}`,
          { method: 'POST', cache: 'no-store' },
        );
        if (res.status !== 200 && res.status !== 404) {
          // Non-OK cancel (other than "already gone"): recoverable error,
          // never a silent "stopped".
          if (attempt === epochRef.current && mountedRef.current) {
            setError(res.status === 401 || res.status === 403 ? 'repair' : 'generic');
          }
        }
      } catch {
        // Companion unreachable: recoverable error, never silent.
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
  }, [token]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Invalidate any in-flight create/select of this attempt before
        // cancelling, so a late 201 can never re-own a job behind the
        // closing dialog.
        epochRef.current += 1;
        void runCancel();
      }
      onOpenChange(nextOpen);
    },
    [runCancel, onOpenChange],
  );

  const handleCancel = useCallback(() => {
    void runCancel();
  }, [runCancel]);

  const handleCreate = useCallback(async () => {
    if (!isPaired || !token) return;
    if (settleRef.current) return; // a cancel is still settling
    if (!isValidMagnetUri(magnet)) {
      setError('invalid');
      return;
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
      if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
      if (res.status === 201) {
        let id = '';
        try {
          const body = (await res.json()) as { id?: unknown };
          if (typeof body.id === 'string' && body.id.length > 0) id = body.id;
        } catch {
          // Fall through to generic below.
        }
        if (!id) {
          setError('generic');
          setPhase('input');
          return;
        }
        if (attempt !== epochRef.current || !mountedRef.current) return;
        jobIdRef.current = id;
        setJobId(id);
        setPhase('checking');
        return;
      }
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
  }, [isPaired, token, magnet]);

  // Redacted status polling while checking metadata (state only — payload
  // bytes are never shown in this phase).
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
        const body = (await res.json()) as { state?: string };
        if (!safe()) return;
        if (body.state === 'buffering') {
          // Metadata arrived: fetch the sanitized file list and show the
          // picker. Payload download starts only after selection.
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
          const filesBody = (await filesRes.json()) as { files?: TorrentFileInfo[] };
          if (!safe()) return;
          const list = Array.isArray(filesBody.files) ? filesBody.files : [];
          if (!list.some((f) => f.kind === 'video')) {
            setError('novideo');
            setPhase('input');
            return;
          }
          setFiles(list);
          setPhase('selecting');
          return;
        }
        if (body.state === 'error') {
          setError('generic');
          setPhase('input');
          return;
        }
        // queued / downloading: metadata still in flight — keep checking;
        // no byte display in this phase by design.
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

  const handleSelect = useCallback(async () => {
    if (!token || !jobId || !videoId) return;
    if (!files.some((f) => f.id === videoId && f.kind === 'video')) {
      setError('generic');
      return;
    }
    if (
      subtitleId !== '' &&
      !files.some((f) => f.id === subtitleId && f.kind === 'subtitle')
    ) {
      setError('generic');
      return;
    }
    setPhase('submitting');
    setError(null);
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
        if (!mountedRef.current || !openRef.current) return;
        const selected = files.find((f) => f.id === videoId);
        jobIdRef.current = null;
        setPhase('input');
        setMagnet('');
        setConsented(false);
        // Hand the job id together with the companion-sanitized basename
        // of the selected video (never a path).
        onJobAccepted(jobId, selected ? selected.basename : '');
        return;
      }
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
      setError('network');
      setPhase('selecting');
    }
  }, [token, jobId, videoId, subtitleId, files, onJobAccepted]);

  const busy = phase === 'creating' || phase === 'submitting' || phase === 'settling';
  const canSubmit =
    isPaired &&
    phase === 'input' &&
    !busy &&
    isValidMagnetUri(magnet) &&
    consented;

  const submittingLabel = dict.magnetInputSubmitting;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="entei-magnet-dialog" closeLabel={dict.dialogClose}>
        <DialogHeader>
          <DialogTitle className="entei-magnet-dialog-title">
            <Magnet size={16} aria-hidden="true" />
            {dict.magnetInputLabelTitle}
          </DialogTitle>
          <DialogDescription>
            {isPaired
              ? dict.magnetInputLabel
              : dict.magnetInputUnpairedBody}
          </DialogDescription>
        </DialogHeader>

        {!isPaired ? null : phase === 'checking' || phase === 'settling' ? (
          <div className="entei-magnet-progress" role="status">
            <Loader2 size={16} className="entei-spin" aria-hidden="true" />
            <span>{phase === 'checking' ? dict.magnetCheckMetadata : dict.magnetCancel}</span>
            {error !== null && (
              <p className="entei-magnet-error" role="alert">
                {errorMessages[error](dict)}
              </p>
            )}
            {phase === 'checking' && (
              <Button
                type="button"
                variant="outline"
                className="entei-magnet-cancel"
                onClick={handleCancel}
              >
                {dict.magnetCancel}
              </Button>
            )}
          </div>
        ) : phase === 'selecting' ? (
          <div className="entei-magnet-files">
            <p className="entei-magnet-files-title">{dict.magnetFilesTitle}</p>
            <p className="entei-magnet-files-body">{dict.magnetFilesBody}</p>
            <div className="entei-magnet-file-list" role="radiogroup" aria-label={dict.magnetFilesBody}>
              {files.map((f) => (
                <label
                  key={f.id}
                  className={
                    f.kind === 'video'
                      ? 'entei-magnet-file-row'
                      : 'entei-magnet-file-row entei-magnet-file-row--sub'
                  }
                >
                  <input
                    type="radio"
                    name="entei-magnet-video"
                    className="entei-magnet-file-radio"
                    checked={f.kind === 'video' ? videoId === f.id : subtitleId === f.id}
                    onChange={() => {
                      if (f.kind === 'video') setVideoId(f.id);
                      else if (f.kind === 'subtitle') setSubtitleId(f.id);
                    }}
                    disabled={busy}
                    aria-label={`${kindLabel(f.kind, dict)}: ${f.basename}`}
                  />
                  <span className="entei-magnet-file-icon">
                    {kindIcon(f.kind, 16)}
                  </span>
                  <span className="entei-magnet-file-main">
                    <span className="entei-magnet-file-name">{f.basename}</span>
                    <span className="entei-magnet-file-meta">
                      {kindLabel(f.kind, dict)} · {f.extension} · {formatBytes(f.byteSize)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {error !== null && (
              <p className="entei-magnet-error" role="alert">
                {errorMessages[error](dict)}
              </p>
            )}
            <div className="entei-magnet-files-actions">
              <Button
                type="button"
                variant="outline"
                className="entei-magnet-cancel"
                onClick={handleCancel}
                disabled={busy}
              >
                {dict.magnetCancel}
              </Button>
              <Button
                type="button"
                className="entei-magnet-submit"
                onClick={() => void handleSelect()}
                disabled={busy || videoId === ''}
              >
                {busy ? submittingLabel : dict.magnetSelectSubmit}
              </Button>
            </div>
          </div>
        ) : (
          <div className="entei-magnet-form">
            <textarea
              className="entei-magnet-input"
              placeholder={dict.magnetInputPlaceholder}
              aria-label={dict.magnetInputLabel}
              aria-invalid={error === 'invalid'}
              value={magnet}
              onChange={(e) => {
                setMagnet(e.target.value);
                if (error) setError(null);
              }}
              rows={3}
              spellCheck={false}
            />
            <label className="entei-magnet-consent">
              <Checkbox
                checked={consented}
                onCheckedChange={(checked) => setConsented(checked === true)}
                aria-label={dict.magnetConsentLabel}
              />
              <span>{dict.magnetConsentLabel}</span>
            </label>
            {error !== null && (
              <p className="entei-magnet-error" role="alert">
                {errorMessages[error](dict)}
              </p>
            )}
            <Button
              type="button"
              className="entei-magnet-submit"
              onClick={() => void handleCreate()}
              disabled={!canSubmit}
            >
              {busy ? submittingLabel : dict.magnetInputSubmit}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
