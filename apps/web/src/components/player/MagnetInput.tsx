/**
 * MagnetInput — ED-2G magnet source dialog (real companion torrent flow).
 * ---------------------------------------------------------------------------
 * A real, controlled dialog: magnet textarea + required tracker-consent
 * checkbox + submit that creates a torrent source job on the paired
 * localhost companion (POST /v1/source/torrents?token=…), polls the redacted
 * job status, lists the sanitized files when the download completed, lets
 * the user pick exactly one `video` file (and optionally one `subtitle`),
 * and submits the selection (POST …/select). On acceptance the opaque job
 * id is handed to the bridge session (kind 'torrent'); the media is only
 * served after `complete` by the existing load behavior.
 *
 * Hygiene contract:
 * - The magnet and token live in component/page memory only — never
 *   localStorage / IndexedDB / sessionStorage / cookies / history / logs.
 * - Unpaired: only a pairing-needed notice; no input / consent / submit.
 * - The consent checkbox is REQUIRED before submit (trackers/peers see the
 *   user's IP); memory-only, never persisted.
 * - Errors are generic and localized; raw server/magnet/tracker/URL detail
 *   is suppressed. 400 = invalid magnet, 401/403 = re-pair, 409 = active
 *   job, network = companion unavailable.
 * - Close / unmount / Cancel: the torrent job is cancelled best-effort on
 *   the companion; stale callbacks never fire after close/unmount.
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

type Phase = 'input' | 'creating' | 'downloading' | 'selecting' | 'submitting';

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
  magnetDownloading: string;
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
  /** Page-memory capability token; used only in the request query string. */
  token: string | null;
  /** Called with the opaque job id once the selection was accepted. */
  onJobAccepted: (jobId: string) => void;
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
  const [bytes, setBytes] = useState<{ available: number; total: number } | null>(null);
  const [files, setFiles] = useState<TorrentFileInfo[]>([]);
  const [videoId, setVideoId] = useState('');
  const [subtitleId, setSubtitleId] = useState('');
  const [error, setError] = useState<ErrorKind>(null);

  // Stale-callback guards: async work that settles after the dialog closed
  // or the component unmounted must not fire callbacks or mutate UI state.
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const jobRef = useRef('');
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    openRef.current = open;
    if (!open) {
      setPhase('input');
    }
  }, [open]);

  // Clear everything whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setMagnet('');
      setConsented(false);
      setPhase('input');
      setJobId('');
      jobRef.current = '';
      setBytes(null);
      setFiles([]);
      setVideoId('');
      setSubtitleId('');
      setError(null);
    }
  }, [open]);

  // Best-effort cancel of the torrent job this dialog owns (never touches
  // the user's files; the companion removes only its own private job dir).
  const cancelOwnedJob = useCallback(async () => {
    const id = jobRef.current;
    if (!id) return;
    jobRef.current = '';
    setJobId('');
    try {
      await fetch(
        `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(id)}/cancel?token=${encodeURIComponent(token ?? '')}`,
        { method: 'POST', cache: 'no-store' },
      );
    } catch {
      // Companion unreachable: nothing more to do.
    }
  }, [token]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        void cancelOwnedJob();
      }
      onOpenChange(nextOpen);
    },
    [cancelOwnedJob, onOpenChange],
  );

  const handleCancel = useCallback(() => {
    void cancelOwnedJob();
    setPhase('input');
    setError(null);
  }, [cancelOwnedJob]);

  const handleCreate = useCallback(async () => {
    if (!isPaired || !token) return;
    if (!isValidMagnetUri(magnet)) {
      setError('invalid');
      return;
    }
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
          // Fall through to generic below.
        }
        if (!id) {
          setError('generic');
          setPhase('input');
          return;
        }
        if (!mountedRef.current || !openRef.current) return;
        jobRef.current = id;
        setJobId(id);
        setPhase('downloading');
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
      setError('network');
      setPhase('input');
    }
  }, [isPaired, token, magnet]);

  // Redacted status polling while downloading (only state + bytes).
  useEffect(() => {
    if (phase !== 'downloading' || !jobId || !token) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled || !mountedRef.current || !openRef.current) return;
      try {
        const res = await fetch(
          `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) setError('repair');
          else setError('generic');
          setPhase('input');
          return;
        }
        const body = (await res.json()) as {
          state?: string;
          media?: { available?: number; total?: number };
        };
        if (body.state === 'buffering') {
          setBytes({
            available: body.media?.available ?? 0,
            total: body.media?.total ?? 0,
          });
          const filesRes = await fetch(
            `${COMPANION_BASE_URL}/v1/source/torrents/${encodeURIComponent(jobId)}/files?token=${encodeURIComponent(token)}`,
            { cache: 'no-store' },
          );
          if (!filesRes.ok) {
            setError('generic');
            setPhase('input');
            return;
          }
          const filesBody = (await filesRes.json()) as { files?: TorrentFileInfo[] };
          const list = Array.isArray(filesBody.files) ? filesBody.files : [];
          if (!list.some((f) => f.kind === 'video')) {
            setError('novideo');
            setPhase('input');
            return;
          }
          if (cancelled) return;
          setFiles(list);
          setPhase('selecting');
          return;
        }
        if (body.state === 'error') {
          setError('generic');
          setPhase('input');
          return;
        }
        setBytes({
          available: body.media?.available ?? 0,
          total: body.media?.total ?? 0,
        });
      } catch {
        setError('network');
        setPhase('input');
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
        jobRef.current = '';
        setPhase('input');
        setMagnet('');
        setConsented(false);
        onJobAccepted(jobId);
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

  const busy = phase === 'creating' || phase === 'submitting';
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

        {!isPaired ? null : phase === 'input' ? (
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
        ) : phase === 'downloading' ? (
          <div className="entei-magnet-progress" role="status">
            <Loader2 size={16} className="entei-spin" aria-hidden="true" />
            <span>
              {dict.magnetDownloading}
              {bytes
                ? ` ${formatBytes(bytes.available)} / ${formatBytes(bytes.total)}`
                : ''}
            </span>
            {error !== null && (
              <p className="entei-magnet-error" role="alert">
                {errorMessages[error](dict)}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className="entei-magnet-cancel"
              onClick={handleCancel}
            >
              {dict.magnetCancel}
            </Button>
          </div>
        ) : (
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
        )}
      </DialogContent>
    </Dialog>
  );
}
