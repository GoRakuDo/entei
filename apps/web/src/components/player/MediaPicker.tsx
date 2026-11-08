/**
 * MediaPicker — File picker for video/audio media.
 *
 * In the Tauri desktop build a browser file input cannot produce an absolute
 * path (WebView2 never exposes `File.path` — tauri-apps/tauri#11156,
 * wry#87), so the pick goes through the native dialog plugin and hands the
 * caller the real `Z:\...` path. The HTML input stays as the browser path and
 * as the fallback when the dialog is unavailable.
 */
'use client';

import { useCallback, useRef } from 'react';
import { Button } from '@/components/player/ui/button';
import { Upload } from 'lucide-react';
import { isTauri } from '@/features/player/tauri-bridge';

interface MediaPickerProps {
  onSelect: (file: File) => void;
  /** Tauri only: absolute path + basename from the native dialog. */
  onSelectPath?: (path: string, name: string) => void;
  accept: string;
  label: string;
}

/** Turn an `accept` attribute into native-dialog extensions (no MIME types). */
export function acceptToExtensions(accept: string): string[] {
  return accept
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('.') && part.length > 1)
    .map((part) => part.slice(1).toLowerCase());
}

/** Basename of a Windows, UNC or POSIX path. */
export function pathFileName(path: string): string {
  const normalized = path.replace(/[\\/]+/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function MediaPicker({
  onSelect,
  onSelectPath,
  accept,
  label,
}: MediaPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(async () => {
    if (onSelectPath && isTauri()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const extensions = acceptToExtensions(accept);
        const picked = await open({
          multiple: false,
          directory: false,
          title: label,
          ...(extensions.length > 0
            ? { filters: [{ name: label, extensions }] }
            : {}),
        });
        if (typeof picked === 'string' && picked.length > 0) {
          onSelectPath(picked, pathFileName(picked));
          return;
        }
        // A cancelled native dialog must not fall through to the HTML input.
        if (picked === null) return;
      } catch {
        // Dialog plugin unavailable: fall back to the browser picker.
      }
    }
    inputRef.current?.click();
  }, [accept, label, onSelectPath]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onSelect(file);
      // Reset input so the same file can be selected again
      e.target.value = '';
    }
  };

  return (
    <div className="entei-picker">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        className="entei-sr-only"
        aria-label={label}
        tabIndex={-1}
      />
      <Button
        variant="outline"
        size="lg"
        type="button"
        onClick={handleClick}
        className="entei-picker-btn"
        title={label}
      >
        <Upload className="size-4" />
        <span className="entei-picker-label">{label}</span>
      </Button>
    </div>
  );
}
