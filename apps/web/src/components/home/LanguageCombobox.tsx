/**
 * LanguageCombobox — desktop-only React island for locale selection.
 * ---------------------------------------------------------------------------
 * Uses shadcn Popover + Command pattern (NAVIGATION_BAR.md §3).
 * Replaces the native <select> on desktop. Mobile keeps the native selector.
 *
 * - Trigger shows current locale label in its own name (8.205).
 * - Popover lists all 3 locales, current indicated by aria-selected.
 * - On select: dispatches LOCALE_REQUEST_EVENT. locale-switcher owns
 *   applyLocale + writePreference + LOCALE_CHANGE_EVENT (single source
 *   of truth — no duplicated DOM mutation in this island).
 * - Listens for entei:locale-change to sync own label after locale-switcher
 *   applies, or after native select / pageshow changes.
 * --------------------------------------------------------------------------- */
import { useState, useEffect, useCallback, useId } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/player/ui/popover';
import {
  Command,
  CommandList,
  CommandItem,
} from '@/components/player/ui/command';
import { LOCALE_LABELS, type Locale } from '@i18n/types';
import {
  LOCALE_CHANGE_EVENT,
  LOCALE_REQUEST_EVENT,
  type LocaleChangeDetail,
  type LocaleRequestDetail,
} from '@i18n/locale-events';

/* -------------------------------------------------------------------------- */
/*  Component                                                                */
/* -------------------------------------------------------------------------- */

const LOCALE_ORDER: Locale[] = ['id', 'ja', 'en'];

interface LanguageComboboxProps {
  currentLocale: Locale;
  selectLabel: string;
}

export function LanguageCombobox({
  currentLocale,
  selectLabel,
}: LanguageComboboxProps) {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState<Locale>(currentLocale);
  const listboxId = useId();

  // Sync with external locale changes (locale-switcher apply, native select, etc.)
  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<LocaleChangeDetail>;
      if (customEvent.detail?.locale) {
        setLocale(customEvent.detail.locale);
      }
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler);
  }, []);

  const handleSelect = useCallback((newLocale: Locale) => {
    if (newLocale === locale) {
      setOpen(false);
      return;
    }

    // Request locale switch — locale-switcher owns the actual apply + persist.
    window.dispatchEvent(
      new CustomEvent<LocaleRequestDetail>(LOCALE_REQUEST_EVENT, {
        detail: { locale: newLocale },
      }),
    );

    setOpen(false);
  }, [locale]);

  return (
    <div className="entei-language-combobox" data-entei-language-combobox>
      <label
        className="entei-sr-only"
        htmlFor={`${listboxId}-trigger`}
        data-i18n="language.comboboxLabel"
      >
        {selectLabel}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={`${listboxId}-trigger`}
            className="entei-combobox-trigger"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={selectLabel}
            data-entei-language-combobox-trigger
          >
            <span className="entei-combobox-trigger-label">
              {LOCALE_LABELS[locale]}
            </span>
            <ChevronsUpDown
              className="entei-combobox-trigger-chevron"
              size={14}
              aria-hidden="true"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="entei-combobox-content">
          <Command>
            <CommandList id={`${listboxId}-listbox`} role="listbox">
              {LOCALE_ORDER.map((l) => (
                <CommandItem
                  key={l}
                  value={LOCALE_LABELS[l]}
                  onSelect={() => handleSelect(l)}
                  role="option"
                  aria-selected={l === locale}
                >
                  <span>{LOCALE_LABELS[l]}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
