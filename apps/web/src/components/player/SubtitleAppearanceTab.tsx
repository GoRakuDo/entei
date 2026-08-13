/**
 * SubtitleAppearanceTab — Focused Subtitle Appearance Settings Tab
 * ---------------------------------------------------------------------------
 * P2.1: Live controls for subtitle overlay appearance.
 * - Font size (16–48px)
 * - Text color (color input → oklch)
 * - Background color including opacity (color input → oklch)
 * - Uniform background padding (0–32px)
 * - Vertical position: responsive bottom offset (0–200px, moving overlay up/down)
 * All controls live-update the SubtitleOverlay via onChange callback.
 * Persisted via PlayerPreferences (oklch strings only).
 * ---------------------------------------------------------------------------
 */

'use client';

import { useMemo, useCallback, useState, useEffect } from 'react';
import type { Dictionary } from '@i18n/types';
import { Slider } from './ui/slider';
import { Button } from './ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/player/ui/toggle-group';
import type { SubtitleSyncMode } from '@/features/player/preferences';
import {
  Palette,
  RotateCcw,
  Type,
  Square,
  MoveVertical,
  Captions,
  AudioLines,
  Wand2,
} from 'lucide-react';

interface SubtitleAppearanceSettings {
  fontSize: number; // 16-48
  textColor: string; // oklch(...) string
  backgroundColor: string; // oklch(...) string with alpha
  backgroundPadding: number; // 0-32
  verticalPosition: number; // 0-200 (bottom offset in px)
  // subomatic sync mode — engine wiring deferred to a later stage
  syncMode?: SubtitleSyncMode;
}

export type { SubtitleAppearanceSettings };

interface SubtitleAppearanceTabProps {
  dict: Dictionary['playerUI'];
  settings: SubtitleAppearanceSettings;
  onChange: (settings: Partial<SubtitleAppearanceSettings>) => void;
  onReset: () => void;
}

/** Sync mode options for the subomatic engine (stage ③). */
const SYNC_MODES = [
  { value: 'subtitle', icon: Captions },
  { value: 'audio', icon: AudioLines },
  { value: 'auto', icon: Wand2 },
] as const;

/** Safe default returned when hex input is malformed or non-finite. */
const SAFE_HEX_DEFAULT = '#fcfcfc';

/**
 * Convert a hex color string (e.g., #rrggbb or #rgb) to a canonical oklch(...) string.
 * When `alpha` is provided and finite, appends ` / alpha` to the result.
 * Returns a safe default on malformed input — never produces NaN.
 */
function hexToOklch(hex: string, alpha?: number): string {
  // Remove # if present
  const cleanHex = hex.startsWith('#') ? hex.slice(1) : hex;

  // Handle 3-digit hex
  const fullHex = cleanHex.length === 3
    ? cleanHex.split('').map(c => c + c).join('')
    : cleanHex;

  // Guard: must be exactly 6 hex chars after normalization
  if (fullHex.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(fullHex)) {
    return SAFE_HEX_DEFAULT;
  }

  // Parse RGB — parseInt returns NaN for non-hex chars, guarded below
  const rRaw = parseInt(fullHex.slice(0, 2), 16);
  const gRaw = parseInt(fullHex.slice(2, 4), 16);
  const bRaw = parseInt(fullHex.slice(4, 6), 16);
  if (!Number.isFinite(rRaw) || !Number.isFinite(gRaw) || !Number.isFinite(bRaw)) {
    return SAFE_HEX_DEFAULT;
  }

  const r = rRaw / 255;
  const g = gRaw / 255;
  const b = bRaw / 255;

  // Convert sRGB to linear RGB
  const toLinear = (c: number) => {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const rl = toLinear(r);
  const gl = toLinear(g);
  const bl = toLinear(b);

  // Convert linear RGB to OKLab
  // OKLab matrix from https://bottosson.github.io/posts/oklab/
  const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
  const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
  const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  // Convert OKLab to OKLCH
  const C = Math.sqrt(a * a + b_ * b_);
  const h = Math.atan2(b_, a) * (180 / Math.PI);
  const hDeg = h < 0 ? h + 360 : h;

  // Clamp values
  const LClamped = Math.max(0, Math.min(1, L));
  const CClamped = Math.max(0, C);

  // Format as canonical oklch(L% C Hdeg / alpha) — alpha INSIDE parentheses
  const L_pct = Math.round(LClamped * 100);
  const C_val = CClamped.toFixed(4);
  const h_val = Math.round(hDeg);
  if (typeof alpha === 'number' && Number.isFinite(alpha)) {
    const clampedAlpha = Math.max(0, Math.min(1, alpha));
    return `oklch(${L_pct}% ${C_val} ${h_val}deg / ${clampedAlpha.toFixed(2)})`;
  }
  return `oklch(${L_pct}% ${C_val} ${h_val}deg)`;
}

/**
 * Extract the alpha component from an oklch(...) string.
 * Returns 1 (fully opaque) if no alpha is present or parsing fails.
 */
function parseOklchAlpha(oklchStr: string): number {
  const match = oklchStr.match(/\/\s*([\d.]+)%?\s*\)\s*$/);
  if (!match || !match[1]) return 1;
  const val = parseFloat(match[1]);
  return Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 1;
}

/** Convert oklch string to hex for color input display (approximate). */
function oklchToHex(oklchStr: string): string {
  // Parse oklch(L% C h) or oklch(L C h)
  const match = oklchStr.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)(deg|rad|turn)?\s*(?:\/\s*([\d.]+)%?)?\s*\)/i);
  if (!match) return '#fcfcfc';

  const L = parseFloat(match[1]!) / 100;
  const C = parseFloat(match[2]!);
  const h = parseFloat(match[3]!);
  // Alpha is ignored for hex conversion

  // OKLCH to OKLab
  const hRad = (match[4] === 'rad') ? h : (match[4] === 'turn') ? h * 2 * Math.PI : h * Math.PI / 180;
  const a = C * Math.cos(hRad);
  const b_ = C * Math.sin(hRad);

  // OKLab to linear RGB (inverse matrix)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b_;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b_;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b_;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  // Linear RGB to sRGB
  const rl = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  const toSrgb = (c: number) => {
    const clamped = Math.max(0, Math.min(1, c));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };

  const r = Math.round(toSrgb(rl) * 255);
  const g = Math.round(toSrgb(gl) * 255);
  const b = Math.round(toSrgb(bl) * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Generate a live preview subtitle element style object. */
function getPreviewStyle(settings: SubtitleAppearanceSettings): React.CSSProperties {
  return {
    fontSize: `${settings.fontSize}px`,
    color: settings.textColor,
    backgroundColor: settings.backgroundColor,
    padding: `${settings.backgroundPadding}px ${settings.backgroundPadding * 2}px`,
    borderRadius: '4px',
    display: 'inline-block',
    fontFamily: 'var(--entei-font-ui), system-ui, sans-serif',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    textAlign: 'center',
    userSelect: 'text',
    maxWidth: '90%',
  };
}

export function SubtitleAppearanceTab({
  dict,
  settings,
  onChange,
  onReset,
}: SubtitleAppearanceTabProps) {
  // Local state for color inputs (hex) - synced from oklch props
  const [textColorHex, setTextColorHex] = useState(() => oklchToHex(settings.textColor));
  const [bgColorHex, setBgColorHex] = useState(() => oklchToHex(settings.backgroundColor));

  // Extract current alpha from the background oklch string
  const bgAlpha = useMemo(() => parseOklchAlpha(settings.backgroundColor), [settings.backgroundColor]);
  const bgOpacityPercent = Math.round(bgAlpha * 100);

  // Sync hex state when oklch props change (e.g., after reset or external update).
  // Prevents stale hex state from producing wrong colors on subsequent changes.
  useEffect(() => {
    setBgColorHex(oklchToHex(settings.backgroundColor));
  }, [settings.backgroundColor]);

  useEffect(() => {
    setTextColorHex(oklchToHex(settings.textColor));
  }, [settings.textColor]);

  // Convert hex to oklch (preserving current alpha) and notify parent
  const handleTextColorChange = useCallback((hex: string) => {
    const oklch = hexToOklch(hex);
    setTextColorHex(hex);
    onChange({ textColor: oklch });
  }, [onChange]);

  const handleBgColorChange = useCallback((hex: string) => {
    const currentAlpha = parseOklchAlpha(settings.backgroundColor);
    const oklch = hexToOklch(hex, currentAlpha);
    setBgColorHex(hex);
    onChange({ backgroundColor: oklch });
  }, [onChange, settings.backgroundColor]);

  const handleBgOpacityChange = useCallback((value: number[]) => {
    const opacity = (value[0] ?? 100) / 100;
    // Parse current oklch directly from settings — avoids stale bgColorHex closure
    // during rapid sequential changes (e.g., bg color picker then opacity slider).
    const match = settings.backgroundColor.match(
      /oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)(deg|rad|turn)?/i,
    );
    if (match && match[1] && match[2] && match[3]) {
      const L = Math.round(parseFloat(match[1]) );
      const C = parseFloat(match[2]).toFixed(4);
      const h = Math.round(parseFloat(match[3]));
      onChange({
        backgroundColor: `oklch(${L}% ${C} ${h}deg / ${opacity.toFixed(2)})`,
      });
    } else {
      // Fallback: use hex roundtrip if oklch parsing fails
      const hex = oklchToHex(settings.backgroundColor);
      onChange({ backgroundColor: hexToOklch(hex, opacity) });
    }
  }, [onChange, settings.backgroundColor]);

  const handleFontSizeChange = useCallback((value: number[]) => {
    onChange({ fontSize: value[0] });
  }, [onChange]);

  const handlePaddingChange = useCallback((value: number[]) => {
    onChange({ backgroundPadding: value[0] });
  }, [onChange]);

  const handleVerticalPositionChange = useCallback((value: number[]) => {
    onChange({ verticalPosition: value[0] });
  }, [onChange]);

  const previewStyle = useMemo(() => getPreviewStyle(settings), [settings]);

  return (
    <div className="entei-subtitle-appearance-tab">
      {/* Live Preview */}
      <div className="entei-subtitle-preview-section">
        <div className="entei-subtitle-preview-container">
          <div className="entei-subtitle-preview-surface">
            <p style={previewStyle} className="entei-subtitle-preview-text">
              サンプル字幕テキスト / Sample subtitle text / Contoh teks subtitle
            </p>
          </div>
        </div>
      </div>

      <div className="entei-subtitle-appearance-section">
        <h3 className="entei-settings-label">{dict.subtitleAppearance}</h3>

        {/* Font Size */}
        <div className="entei-subtitle-control-row">
          <div className="entei-subtitle-control-label">
            <Type size={16} />
            <span>{dict.subtitleFontSize}</span>
          </div>
          <div className="entei-subtitle-control-input">
            <Slider
              className="entei-subtitle-slider"
              value={[settings.fontSize]}
              min={16}
              max={48}
              step={1}
              onValueChange={handleFontSizeChange}
              aria-label={dict.subtitleFontSize}
            />
            <span className="entei-subtitle-value-display">{settings.fontSize}px</span>
          </div>
        </div>

        {/* Text Color */}
        <div className="entei-subtitle-control-row">
          <div className="entei-subtitle-control-label">
            <Palette size={16} />
            <span>{dict.subtitleTextColor}</span>
          </div>
          <div className="entei-subtitle-control-input">
            <input
              type="color"
              value={textColorHex}
              onChange={(e) => handleTextColorChange(e.target.value)}
              className="entei-subtitle-color-input"
              aria-label={dict.subtitleTextColor}
            />
            <span className="entei-subtitle-value-display oklch-display" title={settings.textColor}>
              {settings.textColor}
            </span>
          </div>
        </div>

        {/* Background Color */}
        <div className="entei-subtitle-control-row">
          <div className="entei-subtitle-control-label">
            <Square size={16} />
            <span>{dict.subtitleBackgroundColor}</span>
          </div>
          <div className="entei-subtitle-control-input">
            <input
              type="color"
              value={bgColorHex}
              onChange={(e) => handleBgColorChange(e.target.value)}
              className="entei-subtitle-color-input"
              aria-label={dict.subtitleBackgroundColor}
            />
            <span className="entei-subtitle-value-display oklch-display" title={settings.backgroundColor}>
              {settings.backgroundColor}
            </span>
          </div>
        </div>

        {/* Background Opacity */}
        <div className="entei-subtitle-control-row">
          <div className="entei-subtitle-control-label">
            <Square size={16} style={{ opacity: 0.6 }} />
            <span>{dict.subtitleBackgroundOpacity}</span>
          </div>
          <div className="entei-subtitle-control-input">
            <Slider
              className="entei-subtitle-slider"
              value={[bgOpacityPercent]}
              min={0}
              max={100}
              step={1}
              onValueChange={handleBgOpacityChange}
              aria-label={dict.subtitleBackgroundOpacity}
            />
            <span className="entei-subtitle-value-display">{bgOpacityPercent}%</span>
          </div>
        </div>

        {/* Background Padding */}
        <div className="entei-subtitle-control-row">
          <div className="entei-subtitle-control-label">
            <Square size={16} style={{ opacity: 0.5 }} />
            <span>{dict.subtitleBackgroundPadding}</span>
          </div>
          <div className="entei-subtitle-control-input">
            <Slider
              className="entei-subtitle-slider"
              value={[settings.backgroundPadding]}
              min={0}
              max={32}
              step={1}
              onValueChange={handlePaddingChange}
              aria-label={dict.subtitleBackgroundPadding}
            />
            <span className="entei-subtitle-value-display">{settings.backgroundPadding}px</span>
          </div>
        </div>

        {/* Vertical Position */}
        <div className="entei-subtitle-control-row">
          <div className="entei-subtitle-control-label">
            <MoveVertical size={16} />
            <span>{dict.subtitleVerticalPosition}</span>
          </div>
          <div className="entei-subtitle-control-input">
            <Slider
              className="entei-subtitle-slider"
              value={[settings.verticalPosition]}
              min={0}
              max={200}
              step={4}
              onValueChange={handleVerticalPositionChange}
              aria-label={dict.subtitleVerticalPosition}
            />
            <span className="entei-subtitle-value-display">{settings.verticalPosition}px</span>
          </div>
        </div>
      </div>

      {/* Subtitle Sync Mode (stage ③ — value persisted, engine wired later) */}
      <div className="entei-subtitle-sync-section">
        <h3 className="entei-settings-label">{dict.subtitleSyncMode}</h3>
        {/* ToggleGroup with the same mining-controls-row style as export mode picker */}
        <div className="entei-mining-controls-row">
          <ToggleGroup
            type="single"
            value={settings.syncMode ?? 'subtitle'}
            onValueChange={(v) => {
              if (v === 'subtitle' || v === 'audio' || v === 'auto') {
                onChange({ syncMode: v });
              }
            }}
            variant="outline"
            aria-label={dict.subtitleSyncMode}
          >
            {SYNC_MODES.map(({ value, icon: Icon }) => {
              const label =
                value === 'subtitle'
                  ? dict.subtitleSyncSubtitle
                  : value === 'audio'
                    ? dict.subtitleSyncAudio
                    : dict.subtitleSyncAuto;
              return (
                <ToggleGroupItem key={value} value={value} aria-label={label}>
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        </div>
        <p className="entei-subtitle-sync-desc">
          {settings.syncMode === 'audio'
            ? dict.subtitleSyncAudioDesc
            : settings.syncMode === 'auto'
              ? dict.subtitleSyncAutoDesc
              : dict.subtitleSyncSubtitleDesc}
        </p>
      </div>

      {/* Reset Button */}
      <div className="entei-subtitle-reset-section">
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          className="entei-subtitle-reset-btn"
        >
          <RotateCcw size={14} />
          <span>{dict.subtitleReset}</span>
        </Button>
      </div>
    </div>
  );
}
