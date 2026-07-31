/**
 * YouTubeInput — ED-3 YouTube URL entrance (honest unimplemented state).
 * ---------------------------------------------------------------------------
 * Visual shell only, same dialog language as MagnetInput: it explains that
 * YouTube streaming is not available yet and that EizouDendenshi pairing
 * comes first. There is deliberately NO input field — no user URL is ever
 * captured, persisted, or sent anywhere. X close is the only affordance.
 * --------------------------------------------------------------------------- */
'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/player/ui/dialog';
import { Link } from 'lucide-react';

interface YouTubeInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dict: {
    youtubeInputLabel: string;
    youtubeInputTitle: string;
    youtubeInputBody: string;
    dialogClose: string;
  };
}

export function YouTubeInput({ open, onOpenChange, dict }: YouTubeInputProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={dict.dialogClose}>
        <DialogHeader>
          <DialogTitle className="entei-magnet-dialog-title">
            <Link size={16} aria-hidden="true" />
            {dict.youtubeInputTitle}
          </DialogTitle>
          <DialogDescription>{dict.youtubeInputBody}</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
