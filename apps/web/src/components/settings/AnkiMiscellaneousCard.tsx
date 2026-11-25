/**
 * AnkiMiscellaneousCard — /settings/ Anki page, "Miscellaneous Configuration"
 * card.
 * ---------------------------------------------------------------------------
 * Faithful hand-drawn spec:
 * Heading Lucide BookA + "Miscellaneous Configuration".
 * 1 "Yomitan Module Control" Switch (default OFF).
 * Description: Yomitan Module Anki Settings.
 *
 * WHAT THE SWITCH DOES: bridge Yomitan and this page. ON, Yomitan backup's Anki
 * carries over to the Anki Connection card, and reset restores Yomitan defaults.
 * OFF (the default) Yomitan never touches Anki — the two stay independent. The
 * bridge lives in `modules/yomitan/settings-backup.ts`.
 *
 * Persistence: `updateAnkiConnectionPreferences` (localStorage on web / desktop
 * SQLite settings-store mirror) — the moment it happens there is no Save button,
 * like every other Anki card.
 * ---------------------------------------------------------------------------
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookA } from 'lucide-react';
import { Switch } from '@/components/player/ui/switch';
import {
  DEFAULT_ANKI_CONNECTION_PREFERENCES,
  readAnkiConnectionPreferences,
  updateAnkiConnectionPreferences,
} from '@/features/player/anki-connection-preferences';

export interface AnkiMiscellaneousCopy {
  title: string;
  yomitanModuleControlLabel: string;
  yomitanModuleControlDescription: string;
}

export function AnkiMiscellaneousCard({
  dict,
}: {
  dict: AnkiMiscellaneousCopy;
}) {
  const [yomitanModuleControl, setYomitanModuleControl] = useState<boolean>(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.yomitanModuleControl,
  );

  /* Seed the persisted value on mount (web cache / desktop DB-seeded cache). */
  useEffect(() => {
    setYomitanModuleControl(readAnkiConnectionPreferences().yomitanModuleControl);
  }, []);

  const handleToggle = useCallback((value: boolean) => {
    setYomitanModuleControl(value);
    updateAnkiConnectionPreferences({ yomitanModuleControl: value });
  }, []);

  return (
    <section className="entei-settings-section-card entei-anki-misc-card">
      <h3 className="entei-settings-label">
        <BookA aria-hidden="true" />
        <span>{dict.title}</span>
      </h3>

      {/* Row 1 — Yomitan Module Control bridge switch */}
      <div className="entei-module-field entei-module-field--switch">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.yomitanModuleControlLabel}
          </span>
          <p className="entei-module-field-description">
            {dict.yomitanModuleControlDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <Switch
            checked={yomitanModuleControl}
            onCheckedChange={handleToggle}
            aria-label={dict.yomitanModuleControlLabel}
          />
        </div>
      </div>
    </section>
  );
}
