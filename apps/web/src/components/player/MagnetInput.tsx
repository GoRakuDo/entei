/**
 * MagnetInput — Dialog for entering magnet URIs to start torrent streaming.
 * ---------------------------------------------------------------------------
 * WT-1: Uses existing shadcn Dialog/Input patterns. Validates magnet: prefix
 * before invoking WebTorrent. Does not persist input in URL, localStorage,
 * logs, or analytics.
 *
 * Layout: title row → input+submit inline row → error. No footer; the X
 * close button serves as cancel. The submit action is an icon-only button
 * immediately right of the input.
 * --------------------------------------------------------------------------- */
'use client';

import { useState, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';
import { Input } from '@/components/player/ui/input';
import { Button } from '@/components/player/ui/button';
import { Magnet, Loader2 } from 'lucide-react';
import { validateMagnetUri } from '@/features/player/webtorrent-adapter';
import type { TorrentErrorMessages } from '@/features/player/webtorrent-types';

interface MagnetInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (magnetUri: string) => void;
  isConnecting: boolean;
  dict: TorrentErrorMessages & {
    magnetInputLabel: string;
    magnetInputPlaceholder: string;
    magnetInputLabelTitle: string;
    magnetConnect: string;
  };
}

export function MagnetInput({
  open,
  onOpenChange,
  onSubmit,
  isConnecting,
  dict,
}: MagnetInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    const result = validateMagnetUri(inputValue);
    if (!result.ok) {
      switch (result.reason) {
        case 'empty':
        case 'not-magnet':
        case 'malformed':
          setError(dict.magnetErrorInvalid);
          break;
      }
      return;
    }
    setError(null);
    onSubmit(result.uri);
  }, [inputValue, dict, onSubmit]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Clear state on close — no persistence
        setInputValue('');
        setError(null);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !isConnecting) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [isConnecting, handleSubmit],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="entei-magnet-dialog">
        <DialogHeader>
          <DialogTitle className="entei-magnet-dialog-title">
            {dict.magnetInputLabelTitle}
          </DialogTitle>
          {/* Visually hidden — screen readers use the input's aria-label */}
          <DialogDescription className="entei-sr-only">
            {dict.magnetInputLabel}
          </DialogDescription>
        </DialogHeader>
        <div className="entei-magnet-input-row">
          <Input
            ref={inputRef}
            type="text"
            placeholder={dict.magnetInputPlaceholder}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            disabled={isConnecting}
            className="entei-magnet-input"
            aria-label={dict.magnetInputLabel}
            autoFocus
          />
          <Button
            variant="outline"
            size="icon"
            type="button"
            className="entei-magnet-submit-btn"
            onClick={handleSubmit}
            disabled={isConnecting || inputValue.trim().length === 0}
            aria-label={dict.magnetConnect}
            title={dict.magnetConnect}
          >
            {isConnecting ? (
              <Loader2 size={16} className="entei-magnet-spinner" />
            ) : (
              <Magnet size={16} />
            )}
          </Button>
        </div>
        {error && (
          <p className="entei-magnet-error" role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
