'use client';

/**
 * SettingsChoiceGroup — shared single-select buttongroup for settings surfaces.
 * ---------------------------------------------------------------------------
 * Standardizes choice buttongroups across SubtitleAppearanceTab (Subtitle /
 * Audio / Otomatis) and ScanningInputManager (Input types, Search for, Scan on).
 *
 * - Equal-width items (`flex: 1`) within a 15rem–22rem container (or 100% width)
 * - 44px touch target height (`var(--entei-touch-min)`)
 * - 1:1 icon-to-font alignment with `--entei-space-8` gap when icons are present
 * - Centered text when iconless
 * - Gold text highlight (`var(--entei-status-locked)`) on hover
 * - Selected item (`data-state="on"`) uses `--entei-btn-color` background,
 *   unselected items (`data-state="off"`) use `--entei-surface` background
 */

import type { LucideIcon } from 'lucide-react';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/player/ui/toggle-group';

export interface SettingsChoiceItem {
  value: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SettingsChoiceGroupProps {
  /** Currently selected item value. */
  value: string;
  /** Callback fired when an item is selected (ignores empty deselection). */
  onValueChange: (value: string) => void;
  /** Choice items to render. */
  items: readonly SettingsChoiceItem[];
  /** Optional extra class name for the root container. */
  className?: string;
  /** Accessible label for the buttongroup. */
  ariaLabel?: string;
  /** Whether the entire buttongroup is disabled. */
  disabled?: boolean;
}

export function SettingsChoiceGroup({
  value,
  onValueChange,
  items,
  className = '',
  ariaLabel,
  disabled = false,
}: SettingsChoiceGroupProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`entei-choice-group${className ? ` ${className}` : ''}`}
      onValueChange={(next) => {
        /* Clicking the active choice must not clear the selection. */
        if (next === '') return;
        onValueChange(next);
      }}
    >
      {items.map(({ value: itemValue, label, icon: Icon, disabled: itemDisabled }) => (
        <ToggleGroupItem
          key={itemValue}
          value={itemValue}
          aria-label={label}
          disabled={disabled || itemDisabled}
          className="entei-choice-group-item"
        >
          {Icon !== undefined && <Icon size={16} aria-hidden="true" />}
          <span>{label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}