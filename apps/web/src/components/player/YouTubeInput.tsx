/**
 * YouTubeInput — ED-2F YouTube URL source dialog.
 * ---------------------------------------------------------------------------
 * A real, controlled dialog: a URL text input + submit that creates a
 * YouTube source job on the paired localhost companion (POST
 * /v1/source/jobs?token=…). The companion server validation is the source
 * of truth; a light client-side shape check gives immediate feedback for
 * clearly invalid input. The URL lives in component/page memory only —
 * never localStorage / IndexedDB / sessionStorage / cookies / history /
 * console / errors / analytics — and is cleared on close and unmount.
 * (The capability token itself is persisted opaquely by the pairing
 * controller; this dialog never writes any storage.) Unpaired: only a
 * pairing-needed notice; no URL can be entered. Errors are generic and
 * localized; raw server/URL details are suppressed.
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
import { Input } from '@/components/player/ui/input';
import { YouTubeMark } from '@/components/player/YouTubeMark';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import { readYtDownloadMode } from '@/features/player/yt-download-mode';
import { isFirefox } from '@/features/player/hevc-detect';
import { notifyFirefoxUnsupported } from '@/features/player/eizouden-toast';
import { waitForPlayable } from '@/features/player/companion-media';

/** Loopback companion origin; the only accepted job endpoint. */
const COMPANION_BASE_URL = 'http://127.0.0.1:4322';

type ErrorKind =
  | 'invalid'
  | 'repair'
  | 'conflict'
  | 'network'
  | 'generic'
  | null;

export interface YouTubeInputDict {
  youtubeInputLabel: string;
  youtubeInputTitle: string;
  youtubeInputPlaceholder: string;
  youtubeInputSubmit: string;
  youtubeInputErrorInvalid: string;
  youtubeInputErrorRepair: string;
  youtubeInputErrorConflict: string;
  youtubeInputErrorNetwork: string;
  youtubeInputErrorGeneric: string;
  youtubeInputSubmitting: string;
  dialogClose: string;
  firefoxUnsupported: string;
}

interface YouTubeInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Paired state: job creation is allowed only after a successful pairing. */
  isPaired: boolean;
  /** Page-memory capability token; used only in the request query string. */
  token: string | null;
  /** Called with the opaque job id once the companion accepted the job. */
  onJobAccepted: (jobId: string) => void;
  /** Fire-and-forget cancel of the currently active YouTube job.
   *  When a new URL is submitted, the old job is cancelled first so the
   *  companion's one-active policy is satisfied without a 409 conflict. */
  cancelActiveJob?: () => void;
  dict: YouTubeInputDict;
}

// Light client-side shape check only; the companion is the source of truth.
// Rejects clearly-invalid input (non-https / wrong host / empty) before any
// network call. The strict video-id rules live server-side.
function isYouTubeUrlShape(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  switch (u.hostname.toLowerCase()) {
    case 'youtube.com':
    case 'www.youtube.com':
    case 'm.youtube.com':
    case 'music.youtube.com':
    case 'youtu.be':
      return true;
    default:
      return false;
  }
}

const errorMessages: Record<Exclude<ErrorKind, null>, (d: YouTubeInputDict) => string> = {
  invalid: (d) => d.youtubeInputErrorInvalid,
  repair: (d) => d.youtubeInputErrorRepair,
  conflict: (d) => d.youtubeInputErrorConflict,
  network: (d) => d.youtubeInputErrorNetwork,
  generic: (d) => d.youtubeInputErrorGeneric,
};

export function YouTubeInput({
  open,
  onOpenChange,
  isPaired,
  token,
  onJobAccepted,
  cancelActiveJob,
  dict,
}: YouTubeInputProps) {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorKind>(null);
  // Stale-callback guards: a submit that resolves after the dialog closed
  // or the component unmounted must not fire the acceptance callback or
  // mutate UI state.
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  // Aborts the playable-wait poll when the dialog closes or unmounts (the
  // late result is additionally dropped by the mounted/open guards).
  const waitAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      waitAbortRef.current?.abort();
    };
  }, []);
  useEffect(() => {
    openRef.current = open;
    if (!open) {
      setSubmitting(false);
      waitAbortRef.current?.abort();
    }
  }, [open]);

  // Clear the URL and error whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setUrl('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (!isPaired || !token) return;
    // Firefox playback guard: block all media selection with a toast
    if (isFirefox()) {
      notifyFirefoxUnsupported(dict.firefoxUnsupported);
      return;
    }
    if (!isYouTubeUrlShape(url)) {
      setError('invalid');
      return;
    }
    // Server-side auto-cancel now handles this (ANY state): the create
    // endpoint cancels a leftover YouTube job itself. The fire-and-forget
    // cancel here is a belt-and-suspenders safety net for the
    // downloading/buffering window before the server processes the new
    // create (companion's Cancel is synchronous, so we do not await it).
    if (cancelActiveJob) cancelActiveJob();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `${COMPANION_BASE_URL}/v1/source/jobs?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: url.trim(),
            // YouTube DL mode (Quality/Speed) from the EizouDen settings tab;
            // the companion defaults to speed when the field is absent.
            mode: readYtDownloadMode(),
          }),
          cache: 'no-store',
        },
      );
      if (res.status === 201) {
        let jobId = '';
        try {
          const body = (await res.json()) as { id?: unknown };
          if (typeof body.id === 'string' && body.id.length > 0) {
            jobId = body.id;
          }
        } catch {
          // Fall through to generic below.
        }
        if (!jobId) {
          setError('generic');
          return;
        }
        if (!mountedRef.current || !openRef.current) return; // stale close/unmount
        // Job created — wait until the companion reports playable before
        // handing it to the Player; otherwise the Player mounts a media
        // element over a still-preparing job and shows the "Unduhan gagal"
        // error fallback. The wait stays inside the modal (the submit
        // button shows the loading animation).
        waitAbortRef.current?.abort();
        const waitAbort = new AbortController();
        waitAbortRef.current = waitAbort;
        const playable = await waitForPlayable(token, {
          signal: waitAbort.signal,
        });
        if (!mountedRef.current || !openRef.current) return; // stale close/unmount
        if (!playable.ok) {
          // Do NOT hand the job to the Player — stay in the modal with a
          // localized error (companion down / job error / timeout).
          setError(playable.reason === 'network' ? 'network' : 'generic');
          return;
        }
        setUrl('');
        setSubmitting(false);
        onJobAccepted(jobId);
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
    } catch {
      setError('network');
    } finally {
      setSubmitting(false);
    }
  }, [isPaired, token, url, onJobAccepted, cancelActiveJob]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={dict.dialogClose}>
        <DialogHeader>
          <DialogTitle className="entei-magnet-dialog-title">
            <YouTubeMark width={16} height={16} aria-hidden="true" />
            {dict.youtubeInputTitle}
          </DialogTitle>
        </DialogHeader>
        {isPaired ? (
          <div className="entei-youtube-form">
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder={dict.youtubeInputPlaceholder}
              aria-label={dict.youtubeInputLabel}
              aria-invalid={error !== null}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !submitting) {
                  void handleSubmit();
                }
              }}
            />
            {error !== null && (
              <p className="entei-youtube-form-error" role="alert">
                {errorMessages[error](dict)}
              </p>
            )}
            <Button
              type="button"
              className="entei-youtube-form-submit"
              onClick={() => void handleSubmit()}
              disabled={submitting || url.trim() === ''}
              aria-label={dict.youtubeInputSubmit}
            >
              {submitting ? (
                <TypewriterLoading
                  aria-hidden="true"
                  className="entei-typewriter--btn"
                />
              ) : (
                dict.youtubeInputSubmit
              )}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
