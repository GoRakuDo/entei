import { useEffect, useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';

export interface YouTubeCoverProps {
  title: string;
  videoId: string;
}

interface CoverFallbackProps {
  title: string;
  className?: string;
}

/** Letter/title card used when neither local nor YouTube artwork is usable. */
export function AudioCoverFallback({ title, className = '' }: CoverFallbackProps) {
  const firstCharacter = Array.from(title.trim())[0]?.toUpperCase() ?? '♪';

  return (
    <div className={`audio-cover__fallback ${className}`.trim()} role="img" aria-label={title}>
      <span className="audio-cover__letter" aria-hidden="true">
        {firstCharacter}
      </span>
      <ImageOff className="audio-cover__fallback-icon" size={28} aria-hidden="true" />
      <span className="audio-cover__fallback-title">{title}</span>
    </div>
  );
}

/**
 * YouTube artwork resolver.
 *
 * This intentionally performs no fetching or metadata lookup. The browser's
 * image request tries the public thumbnail URLs in the documented order.
 */
export function YouTubeCover({ title, videoId }: YouTubeCoverProps) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const sources = useMemo(
    () => [
      `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    ],
    [videoId],
  );

  useEffect(() => {
    setSourceIndex(0);
  }, [videoId]);

  if (sourceIndex >= sources.length) {
    return <AudioCoverFallback title={title} />;
  }

  return (
    <img
      className="audio-cover__image"
      src={sources[sourceIndex]}
      alt={`${title} cover`}
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
}
