/**
 * SubtitlePicker — File picker for subtitle files.
 */
'use client';

import { useRef } from 'react';
import { Button } from '@/components/player/ui/button';
import { Subtitles } from 'lucide-react';

interface SubtitlePickerProps {
  onSelect: (file: File) => void;
  accept: string;
  label: string;
  disabled?: boolean;
  compact?: boolean;
}

export function SubtitlePicker({
  onSelect,
  accept,
  label,
  disabled = false,
  compact = false,
}: SubtitlePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onSelect(file);
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
        disabled={disabled}
      />
      <Button
        variant="outline"
        size={compact ? 'sm' : 'lg'}
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="entei-picker-btn"
        title={label}
      >
        <Subtitles className="size-4" />
        <span className="entei-picker-label">{label}</span>
      </Button>
    </div>
  );
}
