/**
 * MediaPicker — File picker for video/audio media.
 */
'use client';

import { useRef } from 'react';
import { Button } from '@/components/player/ui/button';
import { Upload } from 'lucide-react';

interface MediaPickerProps {
  onSelect: (file: File) => void;
  accept: string;
  label: string;
}

export function MediaPicker({ onSelect, accept, label }: MediaPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

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
