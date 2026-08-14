// SubtitleSyncDialog — Magnet audio-mode sync: explains that voice sync
// needs the full download, then polls DL% and runs fetchMagnetPcm once the
// media is complete. Built on the existing shadcn-style Dialog (there is no
// AlertDialog in this project yet), scoped with Entei tokens.
import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';
import { fetchMagnetPcm } from '@/features/player/companion-media';
import type { DecodedAudio } from '@/features/player/audio-decoder';
import type { Dictionary } from '@i18n/index';

export interface SubtitleSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dict: Dictionary['playerUI'];
  token: string;
  onComplete: (audio: DecodedAudio) => void;
}

export function SubtitleSyncDialog({
  open,
  onOpenChange,
  dict,
  token,
  onComplete,
}: SubtitleSyncDialogProps) {
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setPct(null);
      setError(null);
    }
  }, [open]);

  // Clean up polling on unmount / close.
  useEffect(() => {
    return () => {
      if (pollingRef.current !== null) clearInterval(pollingRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const startPolling = () => {
    if (pollingRef.current !== null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    pollingRef.current = setInterval(async () => {
      try {
        const audio = await fetchMagnetPcm(token, { signal: controller.signal });
        // 200 → PCM ready; stop polling and hand the audio back.
        if (pollingRef.current !== null) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
        setPct(100);
        onComplete(audio);
        onOpenChange(false);
      } catch (err) {
        if (err instanceof Error && err.name === 'CompanionBufferingError') {
          // Still downloading: report progress.
          const avail = (err as unknown as { available?: number }).available;
          const total = (err as unknown as { total?: number }).total;
          if (typeof avail === 'number' && typeof total === 'number' && total > 0) {
            setPct(Math.min(99, Math.round((avail / total) * 100)));
          }
        } else {
          setError(err instanceof Error ? err.message : 'sync failed');
          if (pollingRef.current !== null) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
        }
      }
    }, 1000);
  };

  const handleCancel = () => {
    if (pollingRef.current !== null) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="entei-subtitle-sync-dialog">
        <DialogHeader>
          <DialogTitle>{dict.subtitleSyncWaitTitle}</DialogTitle>
          <DialogDescription>{dict.subtitleSyncWaitDesc}</DialogDescription>
        </DialogHeader>
        <div className="entei-subtitle-sync-dialog-actions">
          {pct === null ? (
            <>
              <button
                type="button"
                className="entei-subtitle-sync-dialog-cancel"
                onClick={handleCancel}
              >
                {dict.subtitleSyncWaitCancel}
              </button>
              <button
                type="button"
                className="entei-subtitle-sync-dialog-confirm"
                onClick={startPolling}
              >
                {dict.subtitleSyncWaitConfirm}
              </button>
            </>
          ) : (
            <span className="entei-subtitle-sync-dialog-progress" role="status">
              {dict.subtitleSyncProgress.replace('{pct}', String(pct ?? 0))}
            </span>
          )}
        </div>
        {error !== null && (
          <p className="entei-subtitle-sync-dialog-error">{error}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
