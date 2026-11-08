/**
 * JimakuSearchDialog — JIMAKU.CC manual search modal (mockup redesign).
 * ---------------------------------------------------------------------------
 * One title query searches anime and drama catalogs in parallel, dedupes by
 * entry id, sorts by name A-Z, and shows one mixed list with 「ア」/「ド」
 * badges. Selecting an entry opens its subtitle files; a file row only
 * selects, and the bottom Load action downloads it. The API key and its
 * inline entry form stay memory/localStorage only — never logged.
 * --------------------------------------------------------------------------- */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  KeyRound,
  Search,
  Subtitles,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/player/ui/dialog';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Input } from '@/components/player/ui/input';
import {
  searchJimakuEntries,
  getJimakuEntryFiles,
  downloadJimakuSubtitle,
  type JimakuEntry,
  type JimakuFile,
  type JimakuResult,
  type JimakuSearchError,
} from '@/features/player/jimaku-client';
import type { JimakuAutoLoadMatch } from '@/features/player/use-jimaku-auto-load';
import {
  readJimakuPreferences,
  setJimakuApiKey,
} from '@/features/player/jimaku-preferences';
import {
  isNonJapanese,
  isUncompressed,
} from '@/features/player/use-jimaku-auto-load';
import {
  dispatchJimakuKeyChanged,
  listenForJimakuKeyChanged,
} from '@/features/player/settings-bridge';

export interface JimakuSearchDialogDict {
  jimakuSearchButton: string;
  jimakuSearchResultsEmpty: string;
  jimakuSearchFilesEmpty: string;
  jimakuSearchFilesLabel: string;
  jimakuSearchSelectEntry: string;
  jimakuSearchNoKey: string;
  jimakuApiKeyPlaceholder: string;
  contextKeySave: string;
  jimakuSearchBack: string;
  dialogClose: string;
}

type JimakuKind = 'anime' | 'drama';

interface JimakuCatalogEntry {
  entry: JimakuEntry;
  kind: JimakuKind;
}

export interface MergedJimakuEntries {
  entries: JimakuCatalogEntry[];
  errors: JimakuSearchError[];
}

type JimakuSearchStatus =
  | 'idle'
  | 'searching'
  | 'results'
  | 'loading-files'
  | 'files'
  | 'loading-file';

interface JimakuSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled title (current media name or parsed title from auto-load). */
  initialTitle: string;
  /** Receives the downloaded subtitle text; the parent applies + closes. */
  onSubtitleLoaded: (text: string) => void;
  /** Pass the selected jimaku catalog IDs to the record-time owner. */
  onMatchResolved?: (match: JimakuAutoLoadMatch) => void;
  /** Localized toast (rate-limit / auth / key-missing). */
  onToast: (kind: 'rate-limit' | 'auth' | 'key-missing') => void;
  dict: JimakuSearchDialogDict;
}

const ENTRY_COLLATOR = new Intl.Collator('en', {
  sensitivity: 'base',
  numeric: true,
});

/** Shimmer bone widths, staggered so the wait state reads as a file list. */
const SKELETON_ROW_WIDTHS = ['62%', '48%', '71%', '55%', '66%'];

/** A long name needs the hover marquee only when it actually overflows. */
export function shouldMarquee(
  scrollWidth: number,
  clientWidth: number,
): boolean {
  return scrollWidth > clientWidth;
}

/** Ref callback: mark only overflowing name spans for the CSS marquee. */
function applyMarqueeOverflow(node: HTMLSpanElement | null): void {
  if (!node) return;
  node.classList.toggle(
    'entei-jimaku-row-text--marquee',
    shouldMarquee(node.scrollWidth, node.clientWidth),
  );
}

/** List-loading placeholder; the shimmer sweep is shared with MagnetInput. */
function JimakuListSkeleton() {
  return (
    <div className="entei-jimaku-skeleton" role="status">
      <span className="entei-sr-only">Loading...</span>
      <div className="entei-jimaku-skeleton-list" aria-hidden="true">
        {SKELETON_ROW_WIDTHS.map((width, index) => (
          <div className="entei-jimaku-skeleton-row" key={index}>
            <span className="entei-jimaku-skeleton-icon" />
            <span
              className="entei-jimaku-skeleton-name"
              style={{ width }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Merge both catalog searches into one deduped, A-Z sorted list. */
export function mergeJimakuEntries(
  anime: JimakuResult<JimakuEntry[]>,
  drama: JimakuResult<JimakuEntry[]>,
): MergedJimakuEntries {
  const byId = new Map<number, JimakuCatalogEntry>();
  const errors: JimakuSearchError[] = [];
  const add = (result: JimakuResult<JimakuEntry[]>) => {
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    for (const entry of result.data) {
      if (byId.has(entry.id)) continue;
      byId.set(entry.id, {
        entry,
        kind: entry.flags.anime ? 'anime' : 'drama',
      });
    }
  };
  add(anime);
  add(drama);
  return {
    entries: Array.from(byId.values()).sort((a, b) =>
      ENTRY_COLLATOR.compare(a.entry.name, b.entry.name),
    ),
    errors,
  };
}

export function JimakuSearchDialog({
  open,
  onOpenChange,
  initialTitle,
  onSubtitleLoaded,
  onMatchResolved,
  onToast,
  dict,
}: JimakuSearchDialogProps) {
  const [status, setStatus] = useState<JimakuSearchStatus>('idle');
  const [title, setTitle] = useState('');
  const [entries, setEntries] = useState<JimakuCatalogEntry[]>([]);
  const [selectedEntry, setSelectedEntry] =
    useState<JimakuCatalogEntry | null>(null);
  const [entryFiles, setEntryFiles] = useState<JimakuFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<JimakuFile | null>(null);
  const [noKey, setNoKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);

  const isBusy =
    status === 'searching' ||
    status === 'loading-files' ||
    status === 'loading-file';

  useEffect(() => {
    if (!open) return;
    const cleanup = listenForJimakuKeyChanged((hasKey) => {
      setNoKey(!hasKey);
    });
    return cleanup;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    setTitle(initialTitle);
    setEntries([]);
    setSelectedEntry(null);
    setEntryFiles([]);
    setSelectedFile(null);
    setNoKey(!readJimakuPreferences().apiKey);
    setKeyDraft('');
  }, [open, initialTitle]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (status === 'files' || status === 'loading-files') {
      backButtonRef.current?.focus();
    }
  }, [status]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        epochRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const handleKeySave = useCallback(() => {
    const trimmed = keyDraft.trim();
    if (trimmed.length === 0) return;
    setJimakuApiKey(trimmed);
    dispatchJimakuKeyChanged(true);
    setKeyDraft('');
    setNoKey(false);
  }, [keyDraft]);

  const handleSearch = useCallback(async () => {
    const prefs = readJimakuPreferences();
    if (!prefs.apiKey) {
      setNoKey(true);
      onToast('key-missing');
      return;
    }
    const query = title.trim();
    if (!query || isBusy) return;
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setNoKey(false);
    setSelectedEntry(null);
    setEntryFiles([]);
    setSelectedFile(null);
    setStatus('searching');

    let animeResult: JimakuResult<JimakuEntry[]>;
    let dramaResult: JimakuResult<JimakuEntry[]>;
    try {
      [animeResult, dramaResult] = await Promise.all([
        searchJimakuEntries(prefs.apiKey, query, true, controller.signal),
        searchJimakuEntries(prefs.apiKey, query, false, controller.signal),
      ]);
    } catch {
      if (epoch !== epochRef.current) return;
      setEntries([]);
      setStatus('results');
      return;
    }
    if (epoch !== epochRef.current) return;
    const merged = mergeJimakuEntries(animeResult, dramaResult);
    for (const error of new Set(merged.errors)) {
      if (error === 'rate-limit' || error === 'auth') onToast(error);
    }
    setEntries(merged.entries);
    setStatus('results');
  }, [title, isBusy, onToast]);

  const loadFiles = useCallback(
    async (item: JimakuCatalogEntry) => {
      const prefs = readJimakuPreferences();
      if (!prefs.apiKey) return;
      const epoch = epochRef.current + 1;
      epochRef.current = epoch;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setSelectedEntry(item);
      setEntryFiles([]);
      setSelectedFile(null);
      setStatus('loading-files');
      const result = await getJimakuEntryFiles(
        prefs.apiKey,
        item.entry.id,
        undefined,
        controller.signal,
      );
      if (epoch !== epochRef.current) return;
      if (!result.ok) {
        if (result.error === 'rate-limit') onToast('rate-limit');
        else if (result.error === 'auth') onToast('auth');
        setEntryFiles([]);
      } else {
        setEntryFiles(result.data);
      }
      setStatus('files');
    },
    [onToast],
  );

  const handleEntrySelect = useCallback(
    (item: JimakuCatalogEntry) => {
      void loadFiles(item);
    },
    [loadFiles],
  );

  const handleFileSelect = useCallback((file: JimakuFile) => {
    setSelectedFile(file);
  }, []);

  const handleBack = useCallback(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setEntryFiles([]);
    setSelectedFile(null);
    setStatus('results');
  }, []);

  const handleLoad = useCallback(async () => {
    if (!selectedFile || isBusy) return;
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('loading-file');
    const result = await downloadJimakuSubtitle(
      selectedFile.url,
      controller.signal,
    );
    if (epoch !== epochRef.current) return;
    if (!result.ok) {
      if (result.error === 'rate-limit') onToast('rate-limit');
      setStatus('files');
      return;
    }
    onMatchResolved?.({
      anilistId:
        typeof selectedEntry?.entry.anilist_id === 'number'
          ? selectedEntry.entry.anilist_id
          : null,
      tmdbId:
        typeof selectedEntry?.entry.tmdb_id === 'string'
          ? selectedEntry.entry.tmdb_id
          : null,
      titleNative:
        typeof selectedEntry?.entry.japanese_name === 'string' &&
        selectedEntry.entry.japanese_name.trim().length > 0
          ? selectedEntry.entry.japanese_name.trim()
          : null,
    });
    onSubtitleLoaded(result.data);
    handleOpenChange(false);
  }, [
    selectedFile,
    isBusy,
    onToast,
    onMatchResolved,
    onSubtitleLoaded,
    handleOpenChange,
    selectedEntry,
  ]);

  const handleCancel = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  const visibleFiles = useMemo(() => {
    const japanese = entryFiles.filter(
      (file) => isUncompressed(file.name) && !isNonJapanese(file.name),
    );
    return japanese.length > 0
      ? japanese
      : entryFiles.filter((file) => isUncompressed(file.name));
  }, [entryFiles]);

  const showResults = !noKey && (status === 'searching' || status === 'results');
  const showFiles =
    !noKey &&
    (status === 'loading-files' ||
      status === 'files' ||
      status === 'loading-file');
  const canLoad =
    !noKey && status === 'files' && selectedFile !== null && !isBusy;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="entei-jimaku-search-dialog"
        closeLabel={dict.dialogClose}
        hideClose
      >
        <div className="entei-jimaku-form" aria-busy={isBusy}>
          <DialogTitle className="entei-jimaku-dialog-title">
            <Subtitles size={16} aria-hidden="true" />
            <span>JIMAKU.CC</span>
          </DialogTitle>

          {!noKey && (
            <div className="entei-jimaku-search-field">
              <label
                htmlFor="jimaku-search-title"
                className="entei-jimaku-field-label"
              >
                Judul Anime / Drama:
              </label>
              <ButtonGroup className="entei-jimaku-input-group">
                <Input
                  id="jimaku-search-title"
                  className="entei-jimaku-title-input"
                  type="text"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleSearch();
                    }
                  }}
                  disabled={isBusy}
                  autoComplete="off"
                  autoFocus
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="entei-jimaku-search-btn"
                  onClick={() => void handleSearch()}
                  disabled={isBusy || title.trim() === ''}
                  aria-label={dict.jimakuSearchButton}
                  title={dict.jimakuSearchButton}
                >
                  <Search size={16} aria-hidden="true" />
                </Button>
              </ButtonGroup>
            </div>
          )}

          {noKey ? (
            <div className="entei-jimaku-no-key">
              <KeyRound
                size={48}
                aria-hidden="true"
                className="entei-jimaku-no-key-icon"
              />
              <p className="entei-jimaku-no-key-text">
                {dict.jimakuSearchNoKey}
              </p>
              <form
                className="entei-jimaku-key-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleKeySave();
                }}
              >
                <ButtonGroup className="entei-jimaku-key-group">
                  <Input
                    type="password"
                    autoFocus
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder={dict.jimakuApiKeyPlaceholder}
                    aria-label={dict.jimakuApiKeyPlaceholder}
                    autoComplete="off"
                  />
                  <Button
                    type="submit"
                    size="icon"
                    variant="outline"
                    disabled={keyDraft.trim().length === 0}
                    aria-label={dict.contextKeySave}
                    title={dict.contextKeySave}
                  >
                    <KeyRound size={16} aria-hidden="true" />
                  </Button>
                </ButtonGroup>
              </form>
            </div>
          ) : (
            <>
              {showResults && (
                <div className="entei-jimaku-list-section">
                  {status === 'searching' ? (
                    <JimakuListSkeleton />
                  ) : (
                    <div
                      className="entei-jimaku-list-scroll"
                      role="list"
                      aria-label={dict.jimakuSearchSelectEntry}
                    >
                      {entries.length === 0 ? (
                        <p className="entei-jimaku-empty">
                          {dict.jimakuSearchResultsEmpty}
                        </p>
                      ) : (
                        entries.map((item) => (
                          <div role="listitem" key={item.entry.id}>
                            <button
                              type="button"
                              className="entei-jimaku-row"
                              onClick={() => handleEntrySelect(item)}
                              aria-label={
                                item.entry.name +
                                (item.kind === 'anime'
                                  ? ' (Anime)'
                                  : ' (Drama)')
                              }
                              aria-current={
                                selectedEntry?.entry.id === item.entry.id
                                  ? 'true'
                                  : undefined
                              }
                            >
                              <span
                                className="entei-jimaku-badge"
                                aria-hidden="true"
                              >
                                {item.kind === 'anime' ? 'ア' : 'ド'}
                              </span>
                              <span
                                className="entei-jimaku-row-text"
                                title={item.entry.name}
                                ref={applyMarqueeOverflow}
                              >
                                <span
                                  className="entei-jimaku-marquee-track"
                                  data-title={item.entry.name}
                                >
                                  <span className="entei-jimaku-marquee-copy">
                                    {item.entry.name}
                                  </span>
                                </span>
                              </span>
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              {showFiles && (
                <div className="entei-jimaku-list-section">
                  <nav
                    className="entei-jimaku-breadcrumb"
                    aria-label={dict.jimakuSearchFilesLabel}
                  >
                    <button
                      ref={backButtonRef}
                      type="button"
                      className="entei-jimaku-crumb-back"
                      onClick={handleBack}
                      disabled={status === 'loading-file'}
                    >
                      <ChevronLeft size={16} aria-hidden="true" />
                      <span>{dict.jimakuSearchBack}</span>
                    </button>
                    <span
                      className="entei-jimaku-crumb-separator"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                    <span
                      className="entei-jimaku-crumb-current"
                      aria-current="page"
                      title={selectedEntry?.entry.name}
                    >
                      {selectedEntry?.entry.name}
                    </span>
                  </nav>
                  {status === 'loading-files' ? (
                    <JimakuListSkeleton />
                  ) : (
                    <div
                      className="entei-jimaku-list-scroll"
                      role="list"
                      aria-label={dict.jimakuSearchFilesLabel}
                    >
                      {visibleFiles.length === 0 ? (
                        <p className="entei-jimaku-empty">
                          {dict.jimakuSearchFilesEmpty}
                        </p>
                      ) : (
                        visibleFiles.map((file) => (
                          <div role="listitem" key={file.url}>
                            <button
                              type="button"
                              className="entei-jimaku-row"
                              onClick={() => handleFileSelect(file)}
                              disabled={isBusy}
                              aria-label={file.name}
                              aria-pressed={selectedFile?.url === file.url}
                            >
                              <span className="entei-jimaku-file-icon">
                                <Subtitles size={16} aria-hidden="true" />
                              </span>
                              <span
                                className="entei-jimaku-row-text"
                                title={file.name}
                                ref={applyMarqueeOverflow}
                              >
                                <span
                                  className="entei-jimaku-marquee-track"
                                  data-title={file.name}
                                >
                                  <span className="entei-jimaku-marquee-copy">
                                    {file.name}
                                  </span>
                                </span>
                              </span>
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <ButtonGroup className="entei-jimaku-actions">
            <Button
              type="button"
              variant="outline"
              className="entei-jimaku-load"
              onClick={() => void handleLoad()}
              disabled={!canLoad}
              aria-busy={status === 'loading-file'}
            >
              {status === 'loading-file' ? 'Loading...' : 'Load'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="entei-jimaku-cancel"
              onClick={handleCancel}
            >
              Cancel
            </Button>
          </ButtonGroup>
        </div>
      </DialogContent>
    </Dialog>
  );
}
