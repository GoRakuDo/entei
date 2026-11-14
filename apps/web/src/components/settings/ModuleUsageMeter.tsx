'use client';

/**
 * ModuleUsageMeter — the platform's STANDARD "how much is this using" row.
 * ---------------------------------------------------------------------------
 * A settings page whose items are large (dictionaries, offline packs, caches)
 * has to show the size of what the app holds, and only the host can measure
 * that. The layout is generic: it takes a host-owned reader plus a copy
 * template and owns the presentation —
 *
 *   { "layout": "usage", "source": "yomitan-dictionaries",
 *     "labelKey": "storage", "usageKey": "storageUsage",
 *     "actionKey": "refresh" }
 *
 * `template` carries `{used}` / `{total}` placeholders (the row's own sentence,
 * in the module's copy: "Yomitan is using approximately {used} of {total}.").
 * An unavailable measurement reads as `—`: a meter that cannot measure must
 * never print a fabricated `0 bytes`.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, type LucideIcon } from 'lucide-react';
import { SettingsButton } from '@/components/settings/SettingsButton';
import type { StorageUsageSnapshot } from '@/features/settings/storage-usage';
import { formatStorageUsage } from '@/features/settings/storage-usage';

/** Copy template with both placeholders replaced by an ellipsis. */
const PENDING_PLACEHOLDER = '…';

export interface ModuleUsageMeterProps {
  /** Row label (e.g. "Storage"). */
  label: string;
  /** Sentence template with `{used}` / `{total}` placeholders. */
  template: string;
  /** Host-owned measurement (e.g. the browser's storage estimate). */
  read: () => Promise<StorageUsageSnapshot | null>;
  /** Refresh button label. */
  actionLabel: string;
  /** Leading action icon (defaults to a refresh mark). */
  actionIcon?: LucideIcon;
}

export function ModuleUsageMeter({
  label,
  template,
  read,
  actionLabel,
  actionIcon = RefreshCw,
}: ModuleUsageMeterProps) {
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | null>(null);
  const [pending, setPending] = useState(true);

  const refresh = useCallback(async () => {
    setPending(true);
    try {
      setSnapshot(await read());
    } finally {
      setPending(false);
    }
  }, [read]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usage = pending
    ? template.replace(/\{used\}|\{total\}/g, PENDING_PLACEHOLDER)
    : formatStorageUsage(template, snapshot);

  return (
    <div className="entei-module-field">
      <div className="entei-module-field-text">
        <span className="entei-module-field-label">{label}</span>
        <p className="entei-module-field-description" aria-live="polite">
          {usage}
        </p>
      </div>
      <div className="entei-module-field-control">
        <SettingsButton
          icon={actionIcon}
          disabled={pending}
          aria-busy={pending}
          onClick={() => void refresh()}
        >
          {actionLabel}
        </SettingsButton>
      </div>
    </div>
  );
}