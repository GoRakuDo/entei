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
import { YouTubeMark } from '@/components/player/YouTubeMark';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import { isFirefox } from '@/features/player/browser-detect';
import {
  notifyPlayerInputError,
  notifyFirefoxUnsupported,
} from '@/features/player/eizouden-toast';
import { trace } from '@/features/trace/trace-logger';
import {
  getVideoInfoDirect,
  streamYouTubeDirect,
  type YtdlpStreamMode,
  type YtdlpStreamSource,
  type YtdlpVideoInfo,
} from '@/features/player/tauri-bridge';

export type YouTubeInputError = 'invalid' | 'generic' | null;

export interface YouTubeInputDict {
  youtubeInputLabel: string;
  youtubeInputTitle: string;
  youtubeInputFieldLabel: string;
  youtubeInputCancel: string;
  youtubeInputPlaceholder: string;
  youtubeInputSubmit: string;
  youtubeInputErrorInvalid: string;
  youtubeInputErrorGeneric: string;
  dialogClose: string;
  firefoxUnsupported: string;
}

interface YouTubeInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolve and relay the media through the in-process Tauri yt-dlp plugin. */
  streamMode?: YtdlpStreamMode;
  onStreamAccepted: (
    source: YtdlpStreamSource,
    info: YtdlpVideoInfo | null,
  ) => void;
  /** Supplies a validated video id without retaining the original URL. */
  onVideoIdParsed?: (videoId: string) => void;
  dict: YouTubeInputDict;
}

/**
 * Removes share-page tracking parameters while keeping supported YouTube
 * watch, short, embed, and live URL shapes intact.
 */
export function sanitizeYouTubeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  if (url.protocol !== 'https:') return raw.trim();

  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
    return id ? `https://youtu.be/${id}` : raw.trim();
  }
  if (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com'
  ) {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id ? `https://${host}/watch?v=${id}` : `https://${host}/watch`;
    }
    if (/^\/(?:shorts|embed|live)\//.test(url.pathname)) {
      return `https://${host}${url.pathname}`;
    }
  }
  return raw.trim();
}

/** Parse an 11-character YouTube video id from a supported HTTPS URL. */
export function parseYouTubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0];
  } else if (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com'
  ) {
    id = url.pathname === '/watch'
      ? url.searchParams.get('v') ?? undefined
      : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function isMobileLayout(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767px)').matches
  );
}

const errorMessages: Record<Exclude<YouTubeInputError, null>, (dict: YouTubeInputDict) => string> = {
  invalid: (dict) => dict.youtubeInputErrorInvalid,
  generic: (dict) => dict.youtubeInputErrorGeneric,
};

export function YouTubeInput({
  open,
  onOpenChange,
  streamMode = 'video',
  onStreamAccepted,
  onVideoIdParsed,
  dict,
}: YouTubeInputProps) {
  const [url, setUrl] = useState('');
  const [isMobile, setIsMobile] = useState(isMobileLayout);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<YouTubeInputError>(null);
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const dictRef = useRef(dict);
  dictRef.current = dict;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    openRef.current = open;
    if (!open) setSubmitting(false);
    else {
      setUrl('');
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (error === null) return;
    notifyPlayerInputError(errorMessages[error](dictRef.current), 'youtube-input-error');
  }, [error]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (isFirefox()) {
      notifyFirefoxUnsupported(dict.firefoxUnsupported);
      return;
    }
    const sanitizedUrl = sanitizeYouTubeUrl(url);
    const videoId = parseYouTubeVideoId(sanitizedUrl);
    if (videoId === null) {
      setError('invalid');
      trace('player', 'youtube_submit', { valid: false, mode: streamMode });
      return;
    }

    trace('player', 'youtube_submit', {
      valid: true,
      mode: streamMode,
      videoId,
    });
    setSubmitting(true);
    setError(null);
    try {
      const [source, info] = await Promise.all([
        streamYouTubeDirect(sanitizedUrl, streamMode),
        getVideoInfoDirect(sanitizedUrl).catch(() => null),
      ]);
      if (!mountedRef.current || !openRef.current) return;
      setUrl('');
      onVideoIdParsed?.(videoId);
      onStreamAccepted(source, info);
    } catch {
      // The native error may include an upstream URL; only show generic copy.
      trace('player', 'youtube_submit_failed', { reason: 'plugin' });
      setError('generic');
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [dict.firefoxUnsupported, onStreamAccepted, onVideoIdParsed, streamMode, url]);

  const orientation = isMobile ? 'vertical' : 'horizontal';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="entei-youtube-dialog"
        closeLabel={dict.dialogClose}
        hideClose
      >
        <form
          className="entei-youtube-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!submitting) void handleSubmit();
          }}
        >
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
              onChange={(event) => setUrl(event.target.value)}
            />
          </ButtonGroup>
          <ButtonGroup
            orientation={orientation}
            className="entei-youtube-actions"
          >
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
