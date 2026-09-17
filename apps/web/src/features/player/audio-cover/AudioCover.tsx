import { useEffect, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { AudioCoverFallback, YouTubeCover } from './YouTubeCover';

export interface AudioCoverProps {
  title: string;
  coverUrl?: string | null;
  youtubeVideoId?: string | null;
}

/** Display local extracted art, YouTube fallback art, or a title card. */
export function AudioCover({
  title,
  coverUrl = null,
  youtubeVideoId = null,
}: AudioCoverProps) {
  const [localImageFailed, setLocalImageFailed] = useState(false);

  useEffect(() => {
    setLocalImageFailed(false);
  }, [coverUrl]);

  if (coverUrl !== null && !localImageFailed) {
    return (
      <img
        className="audio-cover__image"
        src={coverUrl}
        alt={`${title} cover`}
        onError={() => setLocalImageFailed(true)}
      />
    );
  }

  if (youtubeVideoId !== null) {
    return <YouTubeCover title={title} videoId={youtubeVideoId} />;
  }

  return (
    <div className="audio-cover" data-testid="audio-cover-fallback">
      <AudioLines className="audio-cover__music-icon" size={56} aria-hidden="true" />
      <AudioCoverFallback title={title} />
    </div>
  );
}
