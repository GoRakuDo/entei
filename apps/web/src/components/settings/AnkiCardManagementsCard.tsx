'use client';

/**
 * AnkiCardManagementsCard — /settings/ Anki page, "Card Managements" card.
 * ---------------------------------------------------------------------------
 * Hand-drawn spec: a Layers-icon heading, six duplicate / add-behavior rows
 * (switches + selects), a divider, then an "Anki Card Templates" sub-section
 * holding an editable Handlebars template CodeBlock editor with line numbers
 * and a Reset button.
 *
 * Every row writes through `updateAnkiConnectionPreferences` the moment it
 * changes (no Save button — hybrid localStorage + desktop SQLite persistence,
 * same contract as AnkiConnectionCard). The template editor saves on every
 * keystroke and the Reset button restores DEFAULT_CARD_TEMPLATES.
 *
 * The template rendering itself is NOT wired to the mining pipeline yet; this
 * card owns storage + editing only (matching the anki-connection-preferences
 * note on DEFAULT_CARD_TEMPLATES).
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LayersPlus } from 'lucide-react';
import { Switch } from '@/components/player/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/player/ui/select';
import {
  DEFAULT_CARD_TEMPLATES,
  DEFAULT_ANKI_CONNECTION_PREFERENCES,
  readAnkiConnectionPreferences,
  updateAnkiConnectionPreferences,
  type DuplicateBehavior,
  type DuplicateScope,
  type OpenNoteViewer,
} from '@/features/player/anki-connection-preferences';
import type { Dictionary } from '@i18n/types';

/** Select options — value matches the persisted enum members exactly. */
const DUPLICATE_SCOPE_OPTIONS: readonly { value: DuplicateScope; label: string }[] = [
  { value: 'collection', label: 'Collection' },
  { value: 'deck', label: 'Deck' },
  { value: 'deck-root', label: 'Deck root' },
];
const DUPLICATE_BEHAVIOR_OPTIONS: readonly {
  value: DuplicateBehavior;
  label: string;
}[] = [
  { value: 'allow', label: 'Allow adding' },
  { value: 'prevent', label: 'Prevent adding' },
  { value: 'overwrite', label: 'Overwrite' },
];
const OPEN_NOTE_VIEWER_OPTIONS: readonly {
  value: OpenNoteViewer;
  label: string;
}[] = [
  { value: 'note-editor', label: 'Note Editor' },
  { value: 'browser', label: 'Browser' },
];

export interface AnkiCardManagementsCardProps {
  /** Localized copy for this card (dict.ankiCardManagements). */
  dict: Dictionary['ankiCardManagements'];
}

export function AnkiCardManagementsCard({
  dict,
}: AnkiCardManagementsCardProps) {
  const [checkForDuplicates, setCheckForDuplicates] = useState(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.checkForDuplicates,
  );
  const [checkAllModels, setCheckAllModels] = useState(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.checkAllModels,
  );
  const [duplicateScope, setDuplicateScope] = useState<DuplicateScope>(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.duplicateScope,
  );
  const [duplicateBehavior, setDuplicateBehavior] = useState<DuplicateBehavior>(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.duplicateBehavior,
  );
  const [suspendNewCards, setSuspendNewCards] = useState(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.suspendNewCards,
  );
  const [openNoteViewer, setOpenNoteViewer] = useState<OpenNoteViewer>(
    DEFAULT_ANKI_CONNECTION_PREFERENCES.openNoteViewer,
  );
  const [cardTemplates, setCardTemplates] = useState(DEFAULT_CARD_TEMPLATES);

  /* Template editor: line-number gutter syncs its scroll to the textarea. */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  /* Seed from persisted preferences on mount. */
  useEffect(() => {
    const saved = readAnkiConnectionPreferences();
    setCheckForDuplicates(saved.checkForDuplicates);
    setCheckAllModels(saved.checkAllModels);
    setDuplicateScope(saved.duplicateScope);
    setDuplicateBehavior(saved.duplicateBehavior);
    setSuspendNewCards(saved.suspendNewCards);
    setOpenNoteViewer(saved.openNoteViewer);
    setCardTemplates(saved.cardTemplates);
  }, []);

  const handleTemplatesChange = useCallback((value: string) => {
    setCardTemplates(value);
    updateAnkiConnectionPreferences({ cardTemplates: value });
  }, []);

  const handleTemplatesReset = useCallback(() => {
    setCardTemplates(DEFAULT_CARD_TEMPLATES);
    updateAnkiConnectionPreferences({ cardTemplates: DEFAULT_CARD_TEMPLATES });
  }, []);

  /* Keep the line-number gutter aligned with the textarea's scroll position. */
  const handleTextareaScroll = useCallback(() => {
    if (gutterRef.current !== null && textareaRef.current !== null) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const lineCount = cardTemplates.split('\n').length;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1);

  return (
    <section className="entei-settings-section-card entei-anki-card-managements-card">
      <h3 className="entei-settings-label">
        <LayersPlus size={16} aria-hidden="true" />
        <span>{dict.title}</span>
      </h3>

      {/* Row 1 — Check for card duplicates */}
      <div className="entei-module-field entei-module-field--switch">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.checkDuplicatesLabel}
          </span>
          <p className="entei-module-field-description">
            {dict.checkDuplicatesDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <Switch
            checked={checkForDuplicates}
            onCheckedChange={(checked) => {
              setCheckForDuplicates(checked);
              updateAnkiConnectionPreferences({ checkForDuplicates: checked });
            }}
            aria-label={dict.checkDuplicatesLabel}
          />
        </div>
      </div>

      {/* Row 2 — Check for duplicates across all models */}
      <div className="entei-module-field entei-module-field--switch">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.checkAllModelsLabel}
          </span>
          <p className="entei-module-field-description">
            {dict.checkAllModelsDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <Switch
            checked={checkAllModels}
            onCheckedChange={(checked) => {
              setCheckAllModels(checked);
              updateAnkiConnectionPreferences({ checkAllModels: checked });
            }}
            aria-label={dict.checkAllModelsLabel}
          />
        </div>
      </div>

      {/* Row 3 — Duplicate card scope */}
      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.duplicateScopeLabel}
          </span>
          <p className="entei-module-field-description">
            {dict.duplicateScopeDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <Select
            value={duplicateScope}
            onValueChange={(next) => {
              setDuplicateScope(next as DuplicateScope);
              updateAnkiConnectionPreferences({
                duplicateScope: next as DuplicateScope,
              });
            }}
          >
            <SelectTrigger
              size="sm"
              className="entei-module-select"
              aria-label={dict.duplicateScopeLabel}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DUPLICATE_SCOPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Row 4 — When a duplicate is detected */}
      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.duplicateBehaviorLabel}
          </span>
        </div>
        <div className="entei-module-field-control">
          <Select
            value={duplicateBehavior}
            onValueChange={(next) => {
              setDuplicateBehavior(next as DuplicateBehavior);
              updateAnkiConnectionPreferences({
                duplicateBehavior: next as DuplicateBehavior,
              });
            }}
          >
            <SelectTrigger
              size="sm"
              className="entei-module-select"
              aria-label={dict.duplicateBehaviorLabel}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DUPLICATE_BEHAVIOR_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Row 5 — Suspend new cards */}
      <div className="entei-module-field entei-module-field--switch">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.suspendNewCardsLabel}
          </span>
          <p className="entei-module-field-description">
            {dict.suspendNewCardsDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <Switch
            checked={suspendNewCards}
            onCheckedChange={(checked) => {
              setSuspendNewCards(checked);
              updateAnkiConnectionPreferences({ suspendNewCards: checked });
            }}
            aria-label={dict.suspendNewCardsLabel}
          />
        </div>
      </div>

      {/* Row 6 — Open note viewer window */}
      <div className="entei-module-field">
        <div className="entei-module-field-text">
          <span className="entei-module-field-label">
            {dict.openNoteViewerLabel}
          </span>
          <p className="entei-module-field-description">
            {dict.openNoteViewerDescription}
          </p>
        </div>
        <div className="entei-module-field-control">
          <Select
            value={openNoteViewer}
            onValueChange={(next) => {
              setOpenNoteViewer(next as OpenNoteViewer);
              updateAnkiConnectionPreferences({
                openNoteViewer: next as OpenNoteViewer,
              });
            }}
          >
            <SelectTrigger
              size="sm"
              className="entei-module-select"
              aria-label={dict.openNoteViewerLabel}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPEN_NOTE_VIEWER_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Divider between behavior rows and the template editor */}
      <hr className="entei-settings-divider" />

      {/* Anki Card Templates sub-section */}
      <div className="entei-anki-card-templates">
        <div className="entei-module-field entei-anki-card-templates-field">
          <div className="entei-module-field-text">
            <span className="entei-module-field-label" role="heading" aria-level={4}>{dict.templatesHeading}</span>
            <span className="entei-module-field-description">{dict.templatesDescription}</span>
          </div>
        </div>

        <div className="entei-anki-code-editor">
          <div className="entei-anki-code-gutter" ref={gutterRef} aria-hidden="true">
            {lineNumbers.map((n) => (
              <span className="entei-anki-code-line-number" key={n}>
                {n}
              </span>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            className="entei-anki-code-textarea"
            value={cardTemplates}
            spellCheck={false}
            wrap="off"
            aria-label={dict.templatesHeading}
            onChange={(event) => handleTemplatesChange(event.target.value)}
            onScroll={handleTextareaScroll}
          />
        </div>

        <div className="entei-anki-card-templates-footer">
          <button
            type="button"
            className="entei-action-btn entei-anki-connect-btn entei-action-btn--full"
            onClick={handleTemplatesReset}
          >
            {dict.resetTemplatesLabel}
          </button>
        </div>
      </div>
    </section>
  );
}
