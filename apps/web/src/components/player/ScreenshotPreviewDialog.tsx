/**
 * ScreenshotPreviewDialog — AM-2 preview for captured video frames.
 * ---------------------------------------------------------------------------
 * Shows a JPEG preview with Retry / Close actions. Uses the existing
 * ui/dialog.tsx wrapper (Radix Dialog). No nested dialogs.
 * Responsive: mobile sheet-like, desktop centered modal, fullscreen-aware.
 * Controlled via Dialog onOpenChange — Escape/backdrop/close-button all
 * route through the same callback. No redundant event props.
 * --------------------------------------------------------------------------- */

'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';

interface ScreenshotPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string | null;
  error: boolean;
  onRetry: () => void;
  onClose: () => void;
  isCapturing: boolean;
  dict: {
    screenshotPreviewTitle: string;
    screenshotRetry: string;
    screenshotClose: string;
    screenshotError: string;
    screenshotNoPreview: string;
    screenshotCapturing: string;
    dialogClose: string;
  };
}

export function ScreenshotPreviewDialog({
  open,
  onOpenChange,
  imageUrl,
  error,
  onRetry,
  onClose,
  isCapturing,
  dict,
}: ScreenshotPreviewDialogProps) {
  const hasImage = imageUrl !== null;
  const hasError = error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="entei-screenshot-dialog"
        closeLabel={dict.dialogClose}
      >
        <DialogHeader>
          <DialogTitle>{dict.screenshotPreviewTitle}</DialogTitle>
          <DialogDescription>
            {hasError ? dict.screenshotError : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="entei-screenshot-body">
          {hasError && (
            <div className="entei-screenshot-error" role="alert">
              <p>{dict.screenshotError}</p>
            </div>
          )}

          {hasImage && !hasError && (
            <div className="entei-screenshot-image-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={dict.screenshotPreviewTitle}
                className="entei-screenshot-image"
                loading="eager"
              />
            </div>
          )}

          {!hasImage && !hasError && (
            <div className="entei-screenshot-placeholder">
              <p>{dict.screenshotNoPreview}</p>
            </div>
          )}
        </div>

        <div className="entei-screenshot-footer">
          {hasError && (
            <button
              type="button"
              className="entei-dialog-footer-btn entei-dialog-footer-btn--primary"
              onClick={onRetry}
              disabled={isCapturing}
              aria-label={isCapturing ? dict.screenshotCapturing : dict.screenshotRetry}
              title={isCapturing ? dict.screenshotCapturing : dict.screenshotRetry}
            >
              {dict.screenshotRetry}
            </button>
          )}
          <button
            type="button"
            className="entei-dialog-footer-btn"
            onClick={onClose}
          >
            {dict.screenshotClose}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
