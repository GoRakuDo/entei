/**
 * KeyboardShortcutsHelp — Accessible dialog for keyboard shortcuts.
 * ---------------------------------------------------------------------------
 * Uses Radix Dialog for focus trap, aria-modal, Escape, and return-focus.
 * All visible strings come from the typed playerUI locale dictionary.
 * --------------------------------------------------------------------------- */

'use client';

import { Keyboard } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from './ui/dialog';

interface ShortcutEntry {
  key: string;
  desc: string;
}

interface KeyboardShortcutsHelpProps {
  label?: string;
  dialogTitle?: string;
  dialogDescription?: string;
  closeLabel?: string;
  shortcuts?: ShortcutEntry[];
  showAriaLabel?: string;
}

export function KeyboardShortcutsHelp({
  label = 'Shortcuts',
  dialogTitle = 'Keyboard Shortcuts',
  dialogDescription = 'Keyboard shortcuts for controlling playback and navigating subtitles.',
  closeLabel = 'Close',
  shortcuts = [
    { key: 'Space', desc: 'Play / Pause' },
    { key: '\u2190', desc: 'Previous cue' },
    { key: '\u2192', desc: 'Next cue' },
    { key: 'Home', desc: 'Seek to current cue start' },
    { key: '[', desc: 'Decrease speed' },
    { key: ']', desc: 'Increase speed' },
  ],
  showAriaLabel = 'Show keyboard shortcuts',
}: KeyboardShortcutsHelpProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="entei-player-shortcuts-btn"
          aria-label={showAriaLabel}
        >
          <Keyboard size={14} />
          <span>{label}</span>
        </button>
      </DialogTrigger>
      <DialogContent closeLabel={closeLabel} aria-describedby="shortcuts-dialog-desc">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription id="shortcuts-dialog-desc">
            {dialogDescription}
          </DialogDescription>
        </DialogHeader>
        <div className="entei-dialog-body">
          {shortcuts.map((s) => (
            <div key={s.key} className="entei-shortcut-row">
              <kbd className="entei-shortcut-key">{s.key}</kbd>
              <span className="entei-shortcut-desc">{s.desc}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
