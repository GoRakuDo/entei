import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SettingsButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Optional leading SVG icon (rendered with matching 14px size and aria-hidden). */
  icon?: LucideIcon | React.ComponentType<{ className?: string; size?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** When true, expands button to 100% full width of its parent container. */
  fullWidth?: boolean;
  children: React.ReactNode;
}

/**
 * SettingsButton — standardized action button across settings and cards.
 * Provides the canonical Entei button surface:
 * - borderless background with --entei-btn-color
 * - purple glow hover highlight
 * - tactile scale(0.98) press feedback
 * - 1:1 icon-to-font ratio with 8px gap
 */
export const SettingsButton = React.forwardRef<HTMLButtonElement, SettingsButtonProps>(
  ({ icon: Icon, fullWidth = false, className = '', children, ...props }, ref) => {
    const classNames = [
      'entei-action-btn',
      'entei-anki-connect-btn',
      fullWidth ? 'entei-action-btn--full' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button ref={ref} type="button" className={classNames} {...props}>
        {Icon && <Icon size={14} aria-hidden="true" className="entei-action-btn-icon" />}
        <span>{children}</span>
      </button>
    );
  },
);

SettingsButton.displayName = 'SettingsButton';
