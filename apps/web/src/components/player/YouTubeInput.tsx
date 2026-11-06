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
  DialogTitle,
} from '@/components/player/ui/dialog';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Input } from '@/components/player/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/player/ui/select';
import { YouTubeMark } from '@/components/player/YouTubeMark';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import {
  readYtDownloadMode,
  type YtDownloadMode,
} from '@/features/player/yt-download-mode';
import { isFirefox } from '@/features/player/browser-detect';
import {
  notifyCompanionError,
  notifyFirefoxUnsupported,
} from '@/features/player/eizouden-toast';
import { waitForPlayable } from '@/features/player/companion-media';
import {
  isTauri,
  streamYouTubeDirect,
  getVideoInfoDirect,
  type YtdlpStreamMode,
  type YtdlpStreamSource,
  type YtdlpVideoInfo,
} from '@/features/player/tauri-bridge';

/** Loopback companion origin; the only accepted job endpoint. */
const COMPANION_BASE_URL = 'http://127.0.0.1:4322';

type ErrorKind =
  'invalid' | 'repair' | 'conflict' | 'network' | 'generic' | null;

/**
 * Quality options shown in the dialog's Select.
 *
 * DESIGN.md 8.9: 720p is the floor — lower heights (480p/360p) were removed
 * because the user's minimum accepted resolution is 720p.
 *
 * Note: the companion create contract (`POST /v1/source/jobs`) only accepts
 * `url` + `mode` — there is no height parameter yet (quality is capped at
 * 1080p server-side). Until that wiring lands, the selected option maps onto
 * the existing mode contract: 1080p opts into the DASH `quality` strategy,
 * every other height keeps the instant-playback `speed` strategy. The
 * selected height is UI state only and never persisted.
 */
type YouTubeQuality = '1080p' | '720p';

const QUALITY_OPTIONS: readonly {
  value: YouTubeQuality;
  label: string;
  mode: YtDownloadMode;
}[] = [
  { value: '1080p', label: 'FHD 1080p', mode: 'quality' },
  { value: '720p', label: 'HD 720p', mode: 'speed' },
];

const DEFAULT_QUALITY: YouTubeQuality = '720p';

/** Seed the Select from the persisted EizouDen mode (quality → 1080p). */
function initialQuality(): YouTubeQuality {
  return readYtDownloadMode() === 'quality' ? '1080p' : DEFAULT_QUALITY;
}

function qualityMode(quality: YouTubeQuality): YtDownloadMode {
  return (
    QUALITY_OPTIONS.find((option) => option.value === quality)?.mode ?? 'speed'
  );
}

/**
 * Quality → yt-dlp plugin mode for the desktop (Tauri) path.
 *
 * The plugin's mode contract is `video` | `audio` and `stream_youtube` takes no
 * height argument — its format selector caps at 1080p and prefers a muxed
 * stream — so every height currently resolves to `video`. Kept as a mapping
 * instead of a hard-coded literal so a future height argument only has to touch
 * this table.
 *
 * Note: until that argument exists the Select is UI-only on the desktop path;
 * the chosen height never reaches yt-dlp there.
 */
function desktopStreamMode(_quality: YouTubeQuality): YtdlpStreamMode {
  return 'video';
}

/** Mobile (<768px) stacks the button groups vertically (mockup). */
function isMobileLayout(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767px)').matches
  );
}

export interface YouTubeInputDict {
  youtubeInputLabel: string;
  youtubeInputTitle: string;
  youtubeInputFieldLabel: string;
  youtubeInputQuality: string;
  youtubeInputCancel: string;
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
  /**
   * Kept for existing callers (PlayerApp still passes the pairing state)
   * but it no longer gates the form: the dialog always renders its input.
   */
  isPaired?: boolean;
  /** Page-memory capability token; used only in the request query string. */
  token: string | null;
  /** Called with the opaque job id once the companion accepted the job. */
  onJobAccepted: (jobId: string) => void;
  /**
   * Desktop (Tauri) path: called with the resolved stream instead of a job id.
   * The desktop app runs the yt-dlp plugin in-process, so there is no companion
   * and no capability token — `source.url` is a loopback relay URL the player
   * can mount directly. `info` carries the title/subtitles when the parallel
   * metadata lookup succeeded, and is null when it did not (playback still
   * works). Omitted in the browser build.
   */
  onStreamAccepted?: (
    source: YtdlpStreamSource,
    info: YtdlpVideoInfo | null,
  ) => void;
  /** Supplies the accepted video's id without retaining the raw watch URL. */
  onVideoIdParsed?: (videoId: string) => void;
  /** Fire-and-forget cancel of the currently active YouTube job.
   *  When a new URL is submitted, the old job is cancelled first so the
   *  companion's one-active policy is satisfied without a 409 conflict. */
  cancelActiveJob?: () => void;
  dict: YouTubeInputDict;
}

/**
 * Sanitizes a YouTube share link into a shape the companion accepts.
 * Mobile-app and browser share links often carry tracking params
 * (?si=…, ?pp=…, ?list=…, ?t=…) that the companion's strict URL
 * validator rejects with 400. Returns the trimmed input unchanged for
 * anything that is not an https YouTube URL we know how to clean.
 */
export function sanitizeYouTubeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  if (u.protocol !== 'https:') return raw.trim();

  const host = u.hostname.toLowerCase();
  switch (host) {
    case 'youtu.be': {
      // youtu.be/<id> — strip all query params (e.g. ?si=..., ?t=..., bare ?)
      // and trailing slashes. Companion strictly expects https://youtu.be/<id>
      // with no query and exactly one 11-char path segment.
      const id = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
      return id ? `https://youtu.be/${id}` : raw.trim();
    }
    case 'youtube.com':
    case 'www.youtube.com':
    case 'm.youtube.com':
    case 'music.youtube.com': {
      const path = u.pathname;
      if (path === '/watch') {
        // Keep only 'v' parameter; strip ?si=, ?pp=, ?list=, etc.
        const v = u.searchParams.get('v');
        return v ? `https://${host}/watch?v=${v}` : `https://${host}/watch`;
      }
      if (
        path.startsWith('/shorts/') ||
        path.startsWith('/embed/') ||
        path.startsWith('/live/')
      ) {
        // Strip all query params for shorts, embed, and live
        return `https://${host}${path}`;
      }
      return raw.trim();
    }
    default:
      return raw.trim();
  }
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

const errorMessages: Record<
  Exclude<ErrorKind, null>,
  (d: YouTubeInputDict) => string
> = {
  invalid: (d) => d.youtubeInputErrorInvalid,
  repair: (d) => d.youtubeInputErrorRepair,
  conflict: (d) => d.youtubeInputErrorConflict,
  network: (d) => d.youtubeInputErrorNetwork,
  generic: (d) => d.youtubeInputErrorGeneric,
};

/** Extract a validated YouTube video id from a URL accepted by the companion. */
export function parseYouTubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  let videoId: string | undefined;
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0];
  } else if (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com'
  ) {
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v') ?? undefined;
    } else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
      videoId = match?.[1];
    }
  }

  return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
}

export function YouTubeInput({
  open,
  onOpenChange,
  token,
  onJobAccepted,
  onStreamAccepted,
  onVideoIdParsed,
  cancelActiveJob,
  dict,
}: YouTubeInputProps) {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState<YouTubeQuality>(initialQuality);
  const [isMobile, setIsMobile] = useState(isMobileLayout);
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
      setQuality(initialQuality());
    }
  }, [open]);

  // Errors are surfaced as a Toast, never as inline text inside the dialog
  // (DESIGN.md 8.6/8.8): the dialog body keeps its layout and the message
  // cannot push the buttons around. `error` still drives `aria-invalid`.
  // `dict` is read through a ref so a new dictionary object cannot re-fire the
  // toast for the same error.
  const dictRef = useRef(dict);
  dictRef.current = dict;
  useEffect(() => {
    if (error === null) return;
    notifyCompanionError(errorMessages[error](dictRef.current), 'youtube-input-error');
  }, [error]);

  // Track the mobile breakpoint so the ButtonGroups can stack vertically.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (event: MediaQueryListEvent) =>
      setIsMobile(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const handleSubmit = useCallback(async () => {
    // Desktop (Tauri) runs the yt-dlp plugin in-process: no companion, no
    // capability token, no job polling. The browser build keeps the companion
    // contract and its re-pair message.
    const desktop = isTauri();
    // Firefox playback guard: block all media selection with a toast
    if (isFirefox()) {
      notifyFirefoxUnsupported(dict.firefoxUnsupported);
      return;
    }
    const sanitizedUrl = sanitizeYouTubeUrl(url);
    if (!isYouTubeUrlShape(sanitizedUrl)) {
      setError('invalid');
      return;
    }
    if (desktop) {
      if (!onStreamAccepted) {
        setError('generic');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        // Mode comes from the quality Select (see desktopStreamMode). The
        // metadata lookup runs in parallel and is optional (title/subtitles
        // only).
        const [source, info] = await Promise.all([
          streamYouTubeDirect(sanitizedUrl, desktopStreamMode(quality)),
          getVideoInfoDirect(sanitizedUrl).catch(() => null),
        ]);
        if (!mountedRef.current || !openRef.current) return; // stale close/unmount
        const videoId = parseYouTubeVideoId(sanitizedUrl);
        setUrl('');
        setSubmitting(false);
        if (videoId !== null) onVideoIdParsed?.(videoId);
        onStreamAccepted(source, info);
      } catch {
        // Plugin failures (yt-dlp missing, extraction error) stay generic:
        // the raw message can name the tokenised upstream URL.
        setError('generic');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    // Browser build: the form is never gated on pairing, but without a
    // capability token the companion would reject the create, so surface the
    // localized re-pair message instead of failing silently.
    if (!token) {
      setError('repair');
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
            url: sanitizedUrl,
            // Mode contract (url + mode only): the Select's height maps onto
            // the existing quality/speed strategies until a height parameter
            // exists in the companion create endpoint.
            mode: qualityMode(quality),
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
        const videoId = parseYouTubeVideoId(sanitizedUrl);
        if (videoId === null) {
          setError('generic');
          return;
        }
        setUrl('');
        setSubmitting(false);
        onVideoIdParsed?.(videoId);
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
  }, [
    token,
    url,
    quality,
    onJobAccepted,
    onStreamAccepted,
    onVideoIdParsed,
    cancelActiveJob,
  ]);

  const orientation = isMobile ? 'vertical' : 'horizontal';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="entei-youtube-dialog"
        closeLabel={dict.dialogClose}
        /* DESIGN.md 8.8: the form already has a Cancel action, so the
           corner X is omitted (never duplicate the affordance). */
        hideClose
      >
        <form
          className="entei-youtube-form"
          // Our own shape check owns validation so the localized error
          // message shows instead of the browser's native URL bubble.
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!submitting) void handleSubmit();
          }}
        >
          {/* Title lives inside the single form padding — no separate
              DialogHeader band (DESIGN.md 8.8: one padding owner). */}
          <DialogTitle className="entei-magnet-dialog-title entei-youtube-dialog-title">
            <YouTubeMark width={16} height={16} aria-hidden="true" />
            {dict.youtubeInputTitle}
          </DialogTitle>
          <label
            className="entei-youtube-form-label"
            htmlFor="entei-youtube-url-input"
          >
            {dict.youtubeInputFieldLabel}
          </label>
          <ButtonGroup
            orientation={orientation}
            className="entei-youtube-input-group"
          >
            <Input
              id="entei-youtube-url-input"
              className="entei-youtube-url-input"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder={dict.youtubeInputPlaceholder}
              aria-invalid={error !== null}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Select
              value={quality}
              onValueChange={(value) => setQuality(value as YouTubeQuality)}
            >
              <SelectTrigger
                className="entei-youtube-quality"
                aria-label={dict.youtubeInputQuality}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="entei-youtube-quality-content">
                {QUALITY_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    className="entei-youtube-quality-item"
                    value={option.value}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ButtonGroup>
          <ButtonGroup
            orientation={orientation}
            className="entei-youtube-actions"
          >
            {/* DOM order is Stream Now → Cancel (mobile stacking order).
                Desktop CSS mirrors the row so Cancel sits left. */}
            <Button
              type="submit"
              className="entei-youtube-form-submit"
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
            <Button
              type="button"
              variant="outline"
              className="entei-youtube-cancel"
              onClick={() => onOpenChange(false)}
            >
              {dict.youtubeInputCancel}
            </Button>
          </ButtonGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
