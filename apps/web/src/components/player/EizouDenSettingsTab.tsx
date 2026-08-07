/**
 * EizouDenSettingsTab — YouTube download mode (Quality / Speed) settings.
 * ---------------------------------------------------------------------------
 * EIZOU_DENDENSHI.md "YouTube 再生モード設定 (2026-08-07)".
 *
 * - Quality (default): DASH 1080p cap, plays after mux completes.
 * - Speed: progressive formats preferred (360p-1080p), plays while
 *   downloading (ED-2H instant-playback flow).
 *
 * Persisted to localStorage under `entei.eizou.yt-mode.v1`. The setting
 * applies to the NEXT download (never the in-flight job).
 * ---------------------------------------------------------------------------
 */

'use client';

import { useState } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/player/ui/radio-group';
import type { Dictionary } from '@i18n/types';
import {
  readYtDownloadMode,
  writeYtDownloadMode,
  type YtDownloadMode,
} from '@/features/player/yt-download-mode';

export type EizouDenPlayerUI = Pick<
  Dictionary['playerUI'],
  | 'settingsTabEizouDen'
  | 'ytModeQuality'
  | 'ytModeSpeed'
  | 'ytModeQualityDesc'
  | 'ytModeSpeedDesc'
>;

interface EizouDenSettingsTabProps {
  dict: EizouDenPlayerUI;
}

export function EizouDenSettingsTab({ dict }: EizouDenSettingsTabProps) {
  const [mode, setMode] = useState<YtDownloadMode>(() =>
    readYtDownloadMode(),
  );

  const handleChange = (value: string) => {
    const next = value as YtDownloadMode;
    setMode(next);
    writeYtDownloadMode(next);
  };

  return (
    <div className="entei-settings-section">
      <p className="entei-settings-label">{dict.settingsTabEizouDen}</p>
      <RadioGroup
        className="entei-eizouden-mode-group"
        value={mode}
        onValueChange={handleChange}
        aria-label={dict.settingsTabEizouDen}
      >
        <div className="entei-eizouden-mode-option">
          <RadioGroupItem
            value="quality"
            id="entei-yt-mode-quality"
            className="entei-eizouden-mode-radio"
          />
          <label
            htmlFor="entei-yt-mode-quality"
            className="entei-eizouden-mode-label"
          >
            <span className="entei-eizouden-mode-name">
              {dict.ytModeQuality}
            </span>
            <span className="entei-eizouden-mode-desc">
              {dict.ytModeQualityDesc}
            </span>
          </label>
        </div>
        <div className="entei-eizouden-mode-option">
          <RadioGroupItem
            value="speed"
            id="entei-yt-mode-speed"
            className="entei-eizouden-mode-radio"
          />
          <label
            htmlFor="entei-yt-mode-speed"
            className="entei-eizouden-mode-label"
          >
            <span className="entei-eizouden-mode-name">{dict.ytModeSpeed}</span>
            <span className="entei-eizouden-mode-desc">
              {dict.ytModeSpeedDesc}
            </span>
          </label>
        </div>
      </RadioGroup>
    </div>
  );
}