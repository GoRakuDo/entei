'use client';

/**
 * ModuleSecretField — the platform's SECRET row (an API key and its kin).
 * ---------------------------------------------------------------------------
 * A credential is the one settings value a plain descriptor cannot own end to
 * end. Three things have to be true at once:
 *
 * 1. the row shows whether something is SAVED, never what it is (a masked
 *    input, a reveal toggle, a one-click clear);
 * 2. the value belongs to the MODULE's own store, not to whoever renders the
 *    row (jimaku keeps `entei.jimaku.v1`, Nadeshiko keeps its own key entry);
 * 3. a change made somewhere else — another tab, the module's own inline form —
 *    shows up here without a reload.
 *
 * So the editor is HOST-OWNED: `components/settings/module-data-sources`
 * registers one per credential under the row's `source` id, and the manifest
 * only declares the row's text. `createSecretField` binds a single credential
 * through four functions and never learns which module it is editing:
 * `read` (the stored value, `''` when unset), `write` / `clear` (that module's
 * own helpers — they own trimming, validation and any change announcement) and
 * the `syncEvents` that mean "the stored value changed elsewhere".
 *
 * While the input has focus an external sync never clobbers what is being
 * typed: it records the new stored value and the input catches up when focus
 * leaves (or on the next event). That is the behaviour the hand-written card had,
 * kept because losing half a pasted key to a storage event from another tab is
 * exactly the sort of thing a user reports as "it keeps deleting my key".
 *
 * Privacy: the value goes straight through to the module's store — never
 * logged, never put into a URL — and only its PRESENCE is rendered.
 * ---------------------------------------------------------------------------
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { Eye, EyeOff, Eraser } from 'lucide-react';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Input } from '@/components/player/ui/input';

/** What a host-owned field row hands its editor: the row's own text, nothing else. */
export interface ModuleSecretFieldProps {
  /** Row label (the manifest's literal English). */
  label: string;
  /** Sentence under the label. */
  description?: string;
  /** Input placeholder (the descriptor's, when the tree declares one). */
  placeholder?: string;
}

/** One credential, as the host binds it. */
export interface ModuleSecretFieldBinding {
  /** The stored value, or `''` when nothing is saved. */
  read: () => string;
  /** Persist a value (the binding trims and validates — the store's own rules). */
  write: (value: string) => void;
  /** Remove the stored value. */
  clear: () => void;
  /** Events meaning "the stored value changed somewhere else". */
  syncEvents: readonly string[];
}

/**
 * English chrome this editor owns itself.
 *
 * Same reasoning as `module-copy`: the strings a PLATFORM layout draws are not
 * manifest data, and Entei's locales do not translate a host-owned control's own
 * aria labels. The manifest owns the row's label / description / placeholder.
 */
const SECRET_COPY = {
  show: 'Show',
  hide: 'Hide',
  clear: 'Clear',
  saved: 'Key saved',
  empty: 'No key saved',
} as const;

/** Bind one credential to a ready-to-register field editor. */
export function createSecretField(
  binding: ModuleSecretFieldBinding,
): ComponentType<ModuleSecretFieldProps> {
  return function SecretField({ label, description, placeholder }) {
    const inputId = useId();
    const descriptionId = `${inputId}-description`;
    const statusId = `${inputId}-status`;
    const inputRef = useRef<HTMLInputElement | null>(null);
    /* `draft` is what the input shows; `saved` is what the store holds (it
       decides the saved-state line and the clear button, so a half-typed key
       never reads as "saved"). Both start from the same read so a re-mounted
       settings page opens populated. */
    const [draft, setDraft] = useState(() => binding.read());
    const [saved, setSaved] = useState(() => binding.read());
    const [revealed, setRevealed] = useState(false);
    /* The value the input already mirrors, so an unrelated event does not cause
       a redundant render. */
    const lastSyncedRef = useRef(saved);

    /* Adopt what the store holds — the input and the saved-state line move
       together, so a half-typed key can never read as "saved". */
    const applyStored = useCallback((current: string) => {
      lastSyncedRef.current = current;
      setDraft(current);
      setSaved(current);
    }, []);

    useEffect(() => {
      const sync = () => {
        const current = binding.read();
        if (current === lastSyncedRef.current) return;
        if (
          inputRef.current !== null &&
          typeof document !== 'undefined' &&
          document.activeElement === inputRef.current
        ) {
          // Being typed in right now: leave the draft alone. The value is NOT
          // recorded as seen — leaving the field is what adopts it (below).
          return;
        }
        applyStored(current);
      };
      for (const event of binding.syncEvents) {
        window.addEventListener(event, sync);
      }
      window.addEventListener('storage', sync);
      return () => {
        for (const event of binding.syncEvents) {
          window.removeEventListener(event, sync);
        }
        window.removeEventListener('storage', sync);
      };
    }, [binding, applyStored]);

    /* Autosave on every keystroke (jimaku-style): the draft IS the live value,
       and emptying the field wipes the stored key. */
    const handleChange = (value: string) => {
      setDraft(value);
      if (value.trim() === '') {
        binding.clear();
      } else {
        binding.write(value);
      }
      const current = binding.read();
      lastSyncedRef.current = current;
      setSaved(current);
    };

    const handleClear = () => {
      binding.clear();
      lastSyncedRef.current = '';
      setDraft('');
      setSaved('');
    };

    const hasSaved = saved.trim() !== '';

    return (
      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <label className="entei-module-field-label" htmlFor={inputId}>
            {label}
          </label>
          {description !== undefined && (
            <p className="entei-module-field-description" id={descriptionId}>
              {description}
            </p>
          )}
          {/* Presence only, announced politely: a screen reader hears "Key
              saved" without ever hearing the key. */}
          <p
            className="entei-module-field-description"
            id={statusId}
            aria-live="polite"
          >
            {hasSaved ? SECRET_COPY.saved : SECRET_COPY.empty}
          </p>
        </div>

        <div className="entei-module-field-control">
          <ButtonGroup className="entei-nadeshiko-form-group">
            <Input
              id={inputId}
              ref={inputRef}
              className="entei-module-input"
              type={revealed ? 'text' : 'password'}
              value={draft}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={
                description !== undefined
                  ? `${descriptionId} ${statusId}`
                  : statusId
              }
              onChange={(event) => handleChange(event.target.value)}
              onBlur={() => {
                /* Focus is leaving: whatever an external change wrote while the
                   field was being edited is now safe to adopt. */
                const current = binding.read();
                if (current !== lastSyncedRef.current) applyStored(current);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="entei-nadeshiko-search-btn"
              onClick={() => setRevealed((value) => !value)}
              aria-label={revealed ? SECRET_COPY.hide : SECRET_COPY.show}
              title={revealed ? SECRET_COPY.hide : SECRET_COPY.show}
            >
              {revealed ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
            </Button>
            {hasSaved && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="entei-nadeshiko-search-btn"
                onClick={handleClear}
                aria-label={SECRET_COPY.clear}
                title={SECRET_COPY.clear}
              >
                <Eraser size={16} aria-hidden="true" />
              </Button>
            )}
          </ButtonGroup>
        </div>
      </div>
    );
  };
}