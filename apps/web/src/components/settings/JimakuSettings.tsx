/**
 * JimakuSettings — jimaku.cc auto-load settings card (Module › Jimaku.cc).
 * ---------------------------------------------------------------------------
 * Extracted verbatim from SubtitleAppearanceTab's jimaku section so the same
 * controls can live under the settings page's Module group without the
 * Appearance tab. Auto-saves on every keystroke / toggle (jimaku style) and
 * dispatches `entei:player-jimaku-key-changed` so an open jimaku search dialog
 * reflects key presence live.
 *
 * Privacy: the API key stays in localStorage (mirrored to the desktop DB by
 * settings-store) — never logged, never put into URLs or error surfaces.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useState } from 'react';
import { Eye, EyeOff, Eraser } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Input } from '@/components/player/ui/input';
import { Switch } from '@/components/player/ui/switch';
import {
  readJimakuPreferences,
  setJimakuApiKey,
  setJimakuAutoLoad,
} from '@/features/player/jimaku-preferences';
import { dispatchJimakuKeyChanged } from '@/features/player/settings-bridge';
import type { Dictionary } from '@i18n/types';

interface JimakuSettingsProps {
  /** playerUI dictionary (jimaku strings live there). */
  dict: Dictionary['playerUI'];
}

export function JimakuSettings({ dict }: JimakuSettingsProps) {
  const [apiKey, setApiKeyState] = useState(() => readJimakuPreferences().apiKey);
  const [showKey, setShowKey] = useState(false);
  const [autoLoad, setAutoLoadState] = useState(
    () => readJimakuPreferences().autoLoadEnabled,
  );

  return (
    <div className="entei-jimaku-section">
      <h3 className="entei-settings-label">{dict.jimakuHeading}</h3>
      <p className="entei-settings-hint">{dict.jimakuDesc}</p>
      <div className="entei-jimaku-key-row">
        <label htmlFor="entei-jimaku-api-key">{dict.jimakuApiKeyLabel}</label>
        <ButtonGroup className="entei-nadeshiko-form-group">
          <Input
            id="entei-jimaku-api-key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => {
              const value = e.target.value;
              setApiKeyState(value);
              setJimakuApiKey(value); // persist immediately
              // Notify a (possibly open) jimaku search dialog so it reflects
              // key presence live without polling localStorage.
              dispatchJimakuKeyChanged(value.trim().length > 0);
            }}
            placeholder={dict.jimakuApiKeyPlaceholder}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="entei-nadeshiko-search-btn"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? dict.jimakuHide : dict.jimakuShow}
            title={showKey ? dict.jimakuHide : dict.jimakuShow}
          >
            {showKey ? (
              <EyeOff size={16} aria-hidden="true" />
            ) : (
              <Eye size={16} aria-hidden="true" />
            )}
          </Button>
          {apiKey.trim().length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="entei-nadeshiko-search-btn"
              onClick={() => {
                setApiKeyState('');
                setJimakuApiKey('');
                dispatchJimakuKeyChanged(false);
              }}
              aria-label={dict.jimakuClear}
              title={dict.jimakuClear}
            >
              <Eraser size={16} aria-hidden="true" />
            </Button>
          )}
        </ButtonGroup>
      </div>
      <div className="entei-jimaku-auto-row">
        <div>
          <span>{dict.jimakuAutoLoadLabel}</span>
          <p className="entei-settings-hint">{dict.jimakuAutoLoadDesc}</p>
        </div>
        <Switch
          checked={autoLoad}
          onCheckedChange={(v) => {
            setAutoLoadState(v);
            setJimakuAutoLoad(v); // persist immediately
          }}
          aria-label={dict.jimakuAutoLoadLabel}
        />
      </div>
    </div>
  );
}
