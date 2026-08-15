/**
 * JimakuSearchDialog — P4 manual search modal (design: docs/JIMAKU_SUBS.md §2.3).
 * ---------------------------------------------------------------------------
 * Manual subtitle search flow: title + episode inputs (title pre-filled from
 * the current media name), anime/drama Switch (persisted via
 * jimaku-preferences), entry list → file list, and file selection downloads
 * the subtitle body back to the parent. Episode changes re-fetch the file
 * list (§2.3-5). Files are filtered to uncompressed + Japanese-only (§2.3-3/4),
 * falling back to all uncompressed files when no Japanese ones exist.
 *
 * Privacy (§9): the API key is only used inside jimaku-client — it never
 * appears in this dialog's UI, logs, or error text. Errors are localized and
 * generic (rate-limit / auth toasts, silent network).
 * --------------------------------------------------------------------------- */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, KeyRound, Search, Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/player/ui/dialog';
import { Button } from '@/components/player/ui/button';
import { Input } from '@/components/player/ui/input';
import { Switch } from '@/components/player/ui/switch';
import {
  searchJimakuEntries,
  getJimakuEntryFiles,
  downloadJimakuSubtitle,
  type JimakuEntry,
  type JimakuFile,
} from '@/features/player/jimaku-client';
import {
  readJimakuPreferences,
  setJimakuSearchAnime,
} from '@/features/player/jimaku-preferences';
import { isNonJapanese, isUncompressed } from '@/features/player/use-jimaku-auto-load';

export interface JimakuSearchDialogDict {
  jimakuSearchTitle: string;
  jimakuSearchEpisode: string;
  jimakuSearchButton: string;
  jimakuSearchAnimeToggle: string;
  jimakuSearchDramaToggle: string;
  jimakuSearchResultsEmpty: string;
  jimakuSearchFilesEmpty: string;
  jimakuSearchFilesLabel: string;
  jimakuSearchSelectEntry: string;
  jimakuSearchOpenButton: string;
  jimakuSearchNoKey: string;
  jimakuOpenSettings: string;
  jimakuSearchBack: string;
  jimakuRateLimit: string;
  jimakuAuthError: string;
  dialogClose: string;
}

type JimakuSearchStatus =
  | 'idle' // inputs ready, nothing searched yet
  | 'searching' // entry search in flight
  | 'results' // entry list shown
  | 'files' // file list shown for a selected entry
  | 'loading-file'; // subtitle download in flight

interface JimakuSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled title (current media name or parsed title from auto-load). */
  initialTitle: string;
  /** Initial anime/drama state; falls back to persisted preferences. */
  initialAnime?: boolean;
  /** Receives the downloaded subtitle text; the parent applies + closes. */
  onSubtitleLoaded: (text: string) => void;
  /** Localized toast (rate-limit / auth / key-missing), design §2.2-7. */
  onToast: (kind: 'rate-limit' | 'auth' | 'key-missing') => void;
  /** Opens the settings modal (where the API key is managed). */
  onOpenSettings: () => void;
  dict: JimakuSearchDialogDict;
}

export function JimakuSearchDialog({
  open,
  onOpenChange,
  initialTitle,
  initialAnime,
  onSubtitleLoaded,
  onToast,
  onOpenSettings,
  dict,
}: JimakuSearchDialogProps) {
  const [status, setStatus] = useState<JimakuSearchStatus>('idle');
  const [title, setTitle] = useState('');
  const [episode, setEpisode] = useState('');
  const [anime, setAnime] = useState(true);
  const [entries, setEntries] = useState<JimakuEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<JimakuEntry | null>(null);
  const [entryFiles, setEntryFiles] = useState<JimakuFile[]>([]);
  const [noKey, setNoKey] = useState(false);
  // Guards stale responses after close / a newer request; in-flight requests
  // are aborted so an older search or file fetch can never win.
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Keep the no-key error in sync with the stored API key: the user may set
  // the key in the settings modal while this dialog stays open, and the
  // stale "set your key" message must not linger.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      setNoKey(!readJimakuPreferences().apiKey);
    }, 1000);
    return () => clearInterval(id);
  }, [open]);

  // Reset to a fresh form every time the dialog opens, with the caller's
  // pre-fill (current media name) and the persisted/derived anime state.
  useEffect(() => {
    if (!open) return;
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    setTitle(initialTitle);
    setEpisode('');
    setAnime(initialAnime ?? readJimakuPreferences().searchAnime);
    setEntries([]);
    setSelectedEntry(null);
    setEntryFiles([]);
    setNoKey(!readJimakuPreferences().apiKey);
  }, [open, initialTitle, initialAnime]);

  // Unmount cleanup: abort any in-flight request.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

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

  const handleAnimeToggle = useCallback((next: boolean) => {
    setAnime(next);
    setJimakuSearchAnime(next);
  }, []);

  const handleSearch = useCallback(async () => {
    const prefs = readJimakuPreferences();
    if (!prefs.apiKey) {
      setNoKey(true);
      onToast('key-missing');
      return;
    }
    const query = title.trim();
    if (!query || status === 'searching') return;
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setNoKey(false);
    setStatus('searching');
    const result = await searchJimakuEntries(
      prefs.apiKey,
      query,
      anime,
      controller.signal,
    );
    if (epoch !== epochRef.current) return; // stale (closed / newer search)
    if (!result.ok) {
      if (result.error === 'rate-limit') onToast('rate-limit');
      else if (result.error === 'auth') onToast('auth');
      // network / not-found / empty: stay quiet, show the empty state
      setEntries([]);
      setStatus('results');
      return;
    }
    setEntries(result.data);
    setStatus('results');
  }, [title, anime, status, onToast]);

  const loadFiles = useCallback(
    async (entry: JimakuEntry, episodeText: string) => {
      const prefs = readJimakuPreferences();
      if (!prefs.apiKey) return;
      const epoch = epochRef.current + 1;
      epochRef.current = epoch;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setSelectedEntry(entry);
      setEntryFiles([]);
      setStatus('files');
      const parsedEpisode = episodeText.trim() === '' ? undefined : Number(episodeText);
      const result = await getJimakuEntryFiles(
        prefs.apiKey,
        entry.id,
        Number.isFinite(parsedEpisode) ? parsedEpisode : undefined,
        controller.signal,
      );
      if (epoch !== epochRef.current) return; // stale (episode changed / closed)
      if (!result.ok) {
        if (result.error === 'rate-limit') onToast('rate-limit');
        else if (result.error === 'auth') onToast('auth');
        setEntryFiles([]);
        return;
      }
      setEntryFiles(result.data);
    },
    [onToast],
  );

  const handleEntrySelect = useCallback(
    (entry: JimakuEntry) => {
      void loadFiles(entry, episode);
    },
    [loadFiles, episode],
  );

  const handleEpisodeChange = useCallback(
    (value: string) => {
      setEpisode(value);
      // §2.3-5: an episode change on a selected entry re-fetches the file list.
      if (selectedEntry) void loadFiles(selectedEntry, value);
    },
    [selectedEntry, loadFiles],
  );

  const handleFileSelect = useCallback(
    async (file: JimakuFile) => {
      const epoch = epochRef.current + 1;
      epochRef.current = epoch;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('loading-file');
      const result = await downloadJimakuSubtitle(file.url, controller.signal);
      if (epoch !== epochRef.current) return; // stale (closed / newer action)
      if (!result.ok) {
        if (result.error === 'rate-limit') onToast('rate-limit');
        // network / not-found: stay silent — return to the file list
        setStatus('files');
        return;
      }
      onSubtitleLoaded(result.data);
      handleOpenChange(false);
    },
    [onSubtitleLoaded, onToast, handleOpenChange],
  );

  const visibleFiles = useMemo(() => {
    const japanese = entryFiles.filter(
      (f) => isUncompressed(f.name) && !isNonJapanese(f.name),
    );
    // §2.3-3: zero Japanese files → include the non-Japanese ones too.
    return japanese.length > 0
      ? japanese
      : entryFiles.filter((f) => isUncompressed(f.name));
  }, [entryFiles]);

  const isBusy = status === 'searching' || status === 'loading-file';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="entei-jimaku-search-dialog"
        closeLabel={dict.dialogClose}
      >
        <DialogHeader>
          <DialogTitle className="entei-jimaku-search-title">
            {dict.jimakuSearchOpenButton}
          </DialogTitle>
        </DialogHeader>
        <div className="entei-jimaku-search-body">
          {noKey ? (
            /* No API key — the whole form is replaced by a centered empty
               state; the user sets the key in the settings modal first. */
            <div className="entei-jimaku-search-empty-state">
              <KeyRound
                size={48}
                aria-hidden="true"
                className="entei-jimaku-search-empty-icon"
              />
              <p className="entei-jimaku-search-empty-title">
                {dict.jimakuSearchNoKey}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onOpenSettings}
                className="entei-jimaku-search-settings-btn"
              >
                <Settings size={14} aria-hidden="true" />
                <span>{dict.jimakuOpenSettings}</span>
              </Button>
            </div>
          ) : (
            <>
          {/* Title input (§2.3-1) */}
          <div className="entei-jimaku-search-field">
            <label htmlFor="jimaku-search-title" className="entei-jimaku-search-label">
              {dict.jimakuSearchTitle}
            </label>
            <Input
              id="jimaku-search-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={dict.jimakuSearchTitle}
              disabled={isBusy}
            />
          </div>

          {/* Episode input (§2.3-1): empty → all files */}
          <div className="entei-jimaku-search-field">
            <label htmlFor="jimaku-search-episode" className="entei-jimaku-search-label">
              {dict.jimakuSearchEpisode}
            </label>
            <Input
              id="jimaku-search-episode"
              type="number"
              min={1}
              step={1}
              value={episode}
              onChange={(e) => handleEpisodeChange(e.target.value)}
              placeholder={dict.jimakuSearchEpisode}
              disabled={isBusy}
            />
          </div>

          {/* Anime/drama toggle (§2.3-2) — persisted via jimaku-preferences */}
          <div
            className="entei-jimaku-search-toggle-row"
            role="group"
            aria-label={`${dict.jimakuSearchAnimeToggle} / ${dict.jimakuSearchDramaToggle}`}
          >
            <span
              className={
                anime
                  ? 'entei-jimaku-search-toggle-state entei-jimaku-search-toggle-state--on'
                  : 'entei-jimaku-search-toggle-state'
              }
            >
              {dict.jimakuSearchAnimeToggle}
            </span>
            <Switch
              checked={anime}
              onCheckedChange={handleAnimeToggle}
              aria-label={`${dict.jimakuSearchAnimeToggle} / ${dict.jimakuSearchDramaToggle}`}
              disabled={isBusy}
            />
            <span
              className={
                !anime
                  ? 'entei-jimaku-search-toggle-state entei-jimaku-search-toggle-state--on'
                  : 'entei-jimaku-search-toggle-state'
              }
            >
              {dict.jimakuSearchDramaToggle}
            </span>
          </div>

          {/* Search button */}
          <Button
            type="button"
            variant="default"
            className="entei-jimaku-search-submit"
            onClick={() => void handleSearch()}
            disabled={isBusy || title.trim() === ''}
          >
            <Search size={16} aria-hidden="true" />
            <span>{dict.jimakuSearchButton}</span>
          </Button>

          {/* Entry list (results stage) */}
          {status === 'results' && (
            <div className="entei-jimaku-search-section">
              <p className="entei-jimaku-search-hint">{dict.jimakuSearchSelectEntry}</p>
              <div className="entei-jimaku-search-scroll" role="listbox" aria-label={dict.jimakuSearchSelectEntry}>
                {entries.length === 0 ? (
                  <p className="entei-jimaku-search-empty">{dict.jimakuSearchResultsEmpty}</p>
                ) : (
                  entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="entei-jimaku-search-item"
                      onClick={() => handleEntrySelect(entry)}
                    >
                      <span className="entei-jimaku-search-item-name">{entry.name}</span>
                      {entry.japanese_name && (
                        <span className="entei-jimaku-search-item-sub">
                          {entry.japanese_name}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {/* File list (files stage) */}
          {status === 'files' && (
            <div className="entei-jimaku-search-section">
              <button
                type="button"
                className="entei-jimaku-search-back"
                onClick={() => setStatus('results')}
                disabled={isBusy}
              >
                <ChevronLeft size={16} aria-hidden="true" />
                <span>{dict.jimakuSearchBack}</span>
              </button>
              <div className="entei-jimaku-search-scroll" role="listbox" aria-label={dict.jimakuSearchFilesLabel}>
                {visibleFiles.length === 0 ? (
                  <p className="entei-jimaku-search-empty">{dict.jimakuSearchFilesEmpty}</p>
                ) : (
                  visibleFiles.map((file) => (
                    <button
                      key={file.url}
                      type="button"
                      className="entei-jimaku-search-item"
                      onClick={() => void handleFileSelect(file)}
                      disabled={isBusy}
                    >
                      <span className="entei-jimaku-search-item-name">{file.name}</span>
                      <span className="entei-jimaku-search-item-size">
                        {(file.size / 1024).toFixed(0)} KB
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
