/**
 * MagnetInput — Dialog visual shell for entering magnet URIs.
 * ---------------------------------------------------------------------------
 * ED-1: Browser WebTorrent runtime was removed; this dialog is the retained
 * visual shell only. It keeps the entered URI in React state, validates the
 * basic magnet: format locally, and on a valid submit shows the localized
 * EizouDendenshi not-connected status. It never initiates a torrent
 * connection, and the URI never reaches URL, localStorage, IndexedDB, or logs.
 *
 * Layout: title row → input+submit inline row → error / status. No footer;
 * the X close button serves as cancel. The submit action is an icon-only
 * button immediately right of the input.
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
import { Magnet } from 'lucide-react';

interface MagnetInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dict: {
    magnetInputLabel: string;
    magnetInputPlaceholder: string;
    magnetInputLabelTitle: string;
    magnetConnect: string;
    magnetErrorInvalid: string;
    magnetNotConnectedTitle: string;
    magnetNotConnectedBody: string;
  };
}

/**
 * Basic local magnet URI validation: `magnet:?` scheme with an
 * `xt=urn:btih:` parameter carrying a 40-char hex or 32-char base32
 * info hash. No torrent runtime is involved — ED-1 keeps this purely
 * presentational until the EizouDendenshi companion lands (ED-2+).
 */
function isValidMagnetUri(value: string): boolean {
  const trimmed = value.trim();
  if (!/^magnet:\?/i.test(trimmed)) return false;
  const xtMatch = trimmed.match(/[?&]xt=urn:btih:([^&]+)/i);
  if (!xtMatch) return false;
  const hash = xtMatch[1];
  if (!hash) return false;
  return /^[0-9a-f]{40}$/i.test(hash) || /^[a-z2-7]{32}$/i.test(hash);
}

export function MagnetInput({ open, onOpenChange, dict }: MagnetInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    if (!isValidMagnetUri(inputValue)) {
      setError(dict.magnetErrorInvalid);
      setNotice(false);
      return;
    }
    // Valid but no companion: show the honest unavailable state.
    // No torrent connection is initiated.
    setError(null);
    setNotice(true);
  }, [inputValue, dict]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Clear state on close — no persistence
        setInputValue('');
        setError(null);
        setNotice(false);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
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
            disabled={inputValue.trim().length === 0}
            aria-label={dict.magnetConnect}
            title={dict.magnetConnect}
          >
            <Magnet size={16} />
          </Button>
        </div>
        {error && (
          <p className="entei-magnet-error" role="alert">
            {error}
          </p>
        )}
        {notice && !error && (
          <div className="entei-magnet-notice" role="status">
            <p className="entei-magnet-notice-title">
              {dict.magnetNotConnectedTitle}
            </p>
            <p className="entei-magnet-notice-body">
              {dict.magnetNotConnectedBody}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
