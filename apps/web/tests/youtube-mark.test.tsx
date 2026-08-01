import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { YouTubeMark } from '../src/components/player/YouTubeMark';

describe('YouTubeMark — theSVG mono play mark (CC0-1.0)', () => {
  it('renders the exact theSVG mono path with currentColor fill', () => {
    const { container } = render(<YouTubeMark />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('fill')).toBe('currentColor');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    const path = container.querySelector('path');
    expect(path?.getAttribute('d')).toBe(
      'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
    );
  });

  it('is decorative (no accessible name) and sized like the replaced lucide icon', () => {
    const { container } = render(<YouTubeMark />);
    const svg = container.querySelector('svg');
    expect(screen.queryByRole('img')).toBeNull();
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.getAttribute('height')).toBe('24');
  });

  it('accepts overrides for color/size via props', () => {
    const { container } = render(<YouTubeMark className="y-icon" width={20} height={20} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toBe('y-icon');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
  });
});
