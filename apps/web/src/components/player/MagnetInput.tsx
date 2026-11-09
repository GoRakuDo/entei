'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/player/ui/dialog';
import { Button } from '@/components/player/ui/button';
import { ButtonGroup } from '@/components/player/ui/button-group';
import { Checkbox } from '@/components/player/ui/checkbox';
import { Input } from '@/components/player/ui/input';
import { Magnet, Clapperboard, Captions, FileText, Folder } from 'lucide-react';
import { TypewriterLoading } from '@/components/player/TypewriterLoading';
import { isFirefox } from '@/features/player/browser-detect';
import {
  notifyPlayerInputError,
  notifyFirefoxUnsupported,
} from '@/features/player/eizouden-toast';
import { trace, traceError } from '@/features/trace/trace-logger';
import {
  addTorrentDirect,
  cancelTorrentDirect,
  getTorrentStatusDirect,
  selectTorrentFilesDirect,
  type DirectTorrentFile,
} from '@/features/player/tauri-bridge';

function UsersCollaboration({ size = 16 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lucide lucide-users-collaboration"
      aria-hidden="true"
    >
      <path d="M12.925 3.047a9 9 0 017.616 6.11" />
      <path d="M13 22a2 2 0 012-2h4a2 2 0 012 2" />
      <path d="M3 12a2 2 0 012-2h4a2 2 0 012 2" />
      <path d="M3.889 15.9a9 9 0 005.247 4.632" />
      <circle cx="17" cy="14" r="2" />
      <circle cx="7" cy="4" r="2" />
    </svg>
  );
}

export type { DirectTorrentFile } from '@/features/player/tauri-bridge';

const DIRECT_POLL_INTERVAL_MS = 5000;
const DIRECT_METADATA_MAX_POLLS = 24;
const SKELETON_ROW_WIDTHS = ['62%', '48%', '71%', '55%', '66%'];

type ErrorKind = 'invalid' | 'generic' | 'novideo' | 'metadataTimeout' | null;

type Phase = 'input' | 'creating' | 'checking' | 'selecting' | 'submitting' | 'settling';

export interface FileEntry {
  id?: string;
  basename: string;
  extension?: string;
  byteSize?: number;
  kind: 'video' | 'audio' | 'subtitle' | 'other' | 'folder';
  relativePath?: string;
}

export interface MagnetInputDict {
  magnetInputLabel: string;
  magnetInputPlaceholder: string;
  magnetInputLabelTitle: string;
  magnetErrorInvalid: string;
  magnetInputSubmit: string;
  magnetInputErrorGeneric: string;
  magnetInputErrorMetadataTimeout: string;
  magnetCheckMetadata: string;
  magnetNoVideoError: string;
  magnetSelectSubmit: string;
  magnetCancel: string;
  dialogClose: string;
  magnetTableFileName: string;
  magnetTableSize: string;
  magnetFileKindVideo: string;
  magnetFileKindSubtitle: string;
  magnetFileKindFolder: string;
  magnetFileKindOther: string;
  magnetTableNavUp: string;
  magnetNoVideosInFolder: string;
  magnetBreadcrumbLabel: string;
  magnetBreadcrumbRoot: string;
  firefoxUnsupported: string;
}

interface MagnetInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJobAccepted: (
    torrentId: string,
    selectedVideoName: string,
    _subtitleFileId: string,
    direct: DirectTorrentHandoff,
  ) => void;
  dict: MagnetInputDict;
}

export interface DirectTorrentHandoff {
  videoUrl: string;
  subtitleUrl: string | null;
  selectedAudioTrack?: number | null;
  selectedSubtitleTrack?: number | null;
}

function isValidMagnetUri(value: string): boolean {
  const trimmed = value.trim();
  if (!/^magnet:\?/i.test(trimmed)) return false;
  const hash = trimmed.match(/[?&]xt=urn:btih:([^&]+)/i)?.[1];
  return Boolean(hash && (/^[0-9a-f]{40}$/i.test(hash) || /^[a-z2-7]{32}$/i.test(hash)));
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function magnetDisplayName(uri: string): string {
  const match = uri.match(/[?&]dn=([^&]*)/i);
  if (!match?.[1]) return '';
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
  } catch {
    return '';
  }
}

export interface MagnetCrumb {
  label: string;
  path: string;
  current: boolean;
  ellipsis?: boolean;
}

export function buildBreadcrumb(
  rootName: string,
  folderPath: string,
  maxVisible = 3,
): MagnetCrumb[] {
  const parts = folderPath.split('/').filter(Boolean);
  const all: Array<{ label: string; path: string }> = [];
  if (rootName) all.push({ label: rootName, path: '' });
  parts.forEach((part, index) => {
    all.push({ label: part, path: parts.slice(0, index + 1).join('/') });
  });
  if (all.length === 0) return [];
  const asCrumb = (segment: { label: string; path: string }): MagnetCrumb => ({
    ...segment,
    current: segment.path === folderPath,
  });
  if (all.length <= maxVisible) return all.map(asCrumb);
  const first = all[0];
  const last = all[all.length - 1];
  if (!first || !last) return all.map(asCrumb);
  return [
    asCrumb(first),
    { label: '', path: '', current: false, ellipsis: true },
    asCrumb(last),
  ];
}

function isMobileLayout(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767px)').matches
  );
}

const errorMessages: Record<Exclude<ErrorKind, null>, (dict: MagnetInputDict) => string> = {
  invalid: (dict) => dict.magnetErrorInvalid,
  generic: (dict) => dict.magnetInputErrorGeneric,
  novideo: (dict) => dict.magnetNoVideoError,
  metadataTimeout: (dict) => dict.magnetInputErrorMetadataTimeout,
};

function kindIcon(kind: FileEntry['kind'], size: number) {
  switch (kind) {
    case 'video': return <Clapperboard size={size} aria-hidden="true" />;
    case 'subtitle': return <Captions size={size} aria-hidden="true" />;
    case 'folder': return <Folder size={size} aria-hidden="true" />;
    default: return <FileText size={size} aria-hidden="true" />;
  }
}

function kindLabel(entry: FileEntry, dict: MagnetInputDict): string {
  switch (entry.kind) {
    case 'video': return dict.magnetFileKindVideo;
    case 'subtitle': return dict.magnetFileKindSubtitle;
    case 'folder': return dict.magnetFileKindFolder;
    default: return dict.magnetFileKindOther;
  }
}

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'ts', 'm2ts', 'ogv', 'wmv', 'flv', 'mpg', 'mpeg',
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav']);
const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub', 'idx', 'ttml', 'dfxp']);

function pathExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function kindForPath(path: string): FileEntry['kind'] {
  const extension = pathExtension(path);
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (SUBTITLE_EXTENSIONS.has(extension)) return 'subtitle';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return 'other';
}

/** Synthesize one level of a flat plugin torrent file list for folder browsing. */
export function synthesizeEntries(files: DirectTorrentFile[], parentPath: string): FileEntry[] {
  const prefix = parentPath ? `${parentPath.replace(/\/$/, '')}/` : '';
  const folders: FileEntry[] = [];
  const seenFolders = new Set<string>();
  const rows: FileEntry[] = [];
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (prefix && !normalized.startsWith(prefix)) continue;
    const relative = normalized.slice(prefix.length);
    if (!relative) continue;
    const slash = relative.indexOf('/');
    if (slash === -1) {
      rows.push({
        id: `f${file.index}`,
        basename: relative,
        extension: pathExtension(relative),
        byteSize: file.length,
        kind: kindForPath(relative),
        relativePath: normalized,
      });
      continue;
    }
    const folderName = relative.slice(0, slash);
    if (!folderName || seenFolders.has(folderName)) continue;
    seenFolders.add(folderName);
    folders.push({ basename: folderName, kind: 'folder', relativePath: `${prefix}${folderName}` });
  }
  return [...folders, ...rows];
}

function directIndexFromId(id: string): number | null {
  if (!/^f\d+$/.test(id)) return null;
  const index = Number.parseInt(id.slice(1), 10);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function mapDirectError(error: unknown): ErrorKind {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /invalid magnet/i.test(message) ? 'invalid' : 'generic';
}

export function MagnetInput({ open, onOpenChange, onJobAccepted, dict }: MagnetInputProps) {
  const [magnet, setMagnet] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [jobId, setJobId] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [videoId, setVideoId] = useState('');
  const [subtitleId, setSubtitleId] = useState('');
  const [error, setError] = useState<ErrorKind>(null);
  const [torrentName, setTorrentName] = useState('');
  const [isMobile, setIsMobile] = useState(isMobileLayout);
  const [folderPath, setFolderPath] = useState('');
  const dictRef = useRef(dict);
  dictRef.current = dict;
  useEffect(() => {
    if (error === null) return;
    notifyPlayerInputError(errorMessages[error](dictRef.current), 'magnet-input-error');
  }, [error]);

  const directFilesRef = useRef<DirectTorrentFile[]>([]);
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const jobIdRef = useRef<string | null>(null);
  const epochRef = useRef(0);
  const settleRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const abandonedId = jobIdRef.current;
      jobIdRef.current = null;
      if (abandonedId) void cancelTorrentDirect(abandonedId).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    openRef.current = open;
    if (!open && !settleRef.current) setPhase('input');
  }, [open]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      if (settleRef.current) await settleRef.current.catch(() => undefined);
      if (!active) return;
      epochRef.current += 1;
      jobIdRef.current = null;
      settleRef.current = null;
      directFilesRef.current = [];
      setMagnet('');
      setPhase('input');
      setJobId('');
      setEntries([]);
      setVideoId('');
      setSubtitleId('');
      setError(null);
      setFolderPath('');
      setTorrentName('');
    })();
    return () => { active = false; };
  }, [open]);

  const runCancel = useCallback((): Promise<void> => {
    const id = jobIdRef.current;
    if (!id) return Promise.resolve();
    epochRef.current += 1;
    const attempt = epochRef.current;
    jobIdRef.current = null;
    setJobId('');
    setEntries([]);
    setVideoId('');
    setSubtitleId('');
    setError(null);
    setPhase('settling');
    setFolderPath('');
    setTorrentName('');
    const settle = cancelTorrentDirect(id).catch(() => undefined).finally(() => {
      if (attempt === epochRef.current && mountedRef.current) {
        settleRef.current = null;
        setPhase('input');
      }
    });
    settleRef.current = settle;
    return settle;
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    trace('player', 'magnet_dialog', { open: nextOpen });
    if (!nextOpen) {
      epochRef.current += 1;
      void runCancel();
    }
    onOpenChange(nextOpen);
  }, [runCancel, onOpenChange]);

  const handleCancel = useCallback(() => {
    void runCancel();
    onOpenChange(false);
  }, [runCancel, onOpenChange]);

  const handleCreate = useCallback(async () => {
    if (settleRef.current) return;
    if (!isValidMagnetUri(magnet)) {
      setError('invalid');
      trace('player', 'magnet_submit', { valid: false, mode: 'tauri' });
      return;
    }
    trace('player', 'magnet_submit', {
      valid: true,
      mode: 'tauri',
      length: magnet.trim().length,
      hasTrackers: magnet.includes('tr='),
    });

    const existingJobId = jobIdRef.current;
    if (existingJobId) {
      void cancelTorrentDirect(existingJobId).catch(() => undefined);
      jobIdRef.current = null;
      setJobId('');
      setEntries([]);
      setVideoId('');
      setSubtitleId('');
      setFolderPath('');
      setTorrentName('');
    }

    epochRef.current += 1;
    const attempt = epochRef.current;
    directFilesRef.current = [];
    setPhase('creating');
    setError(null);
    try {
      const added = await addTorrentDirect(magnet.trim());
      if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) {
        if (added.id) void cancelTorrentDirect(added.id).catch(() => undefined);
        return;
      }
      if (!added.id) {
        setError('generic');
        setPhase('input');
        return;
      }
      jobIdRef.current = added.id;
      setJobId(added.id);
      setTorrentName(added.name);
      directFilesRef.current = added.files;
      if (added.files.length === 0) {
        setPhase('checking');
        return;
      }
      const list = synthesizeEntries(added.files, '');
      if (!list.some((entry) => entry.kind === 'video') && !list.some((entry) => entry.kind === 'folder')) {
        setError('novideo');
        setPhase('input');
        return;
      }
      setEntries(list);
      setFolderPath('');
      setPhase('selecting');
    } catch (err) {
      if (attempt !== epochRef.current || !mountedRef.current) return;
      traceError('player', 'magnet_add_failed', err, { mode: 'tauri' });
      setError(mapDirectError(err));
      setPhase('input');
    }
  }, [magnet]);

  useEffect(() => {
    if (phase !== 'checking' || !jobId) return;
    const attempt = epochRef.current;
    let cancelled = false;
    let polls = 0;
    const safe = () => !cancelled && attempt === epochRef.current && mountedRef.current && openRef.current;
    const timer = window.setInterval(async () => {
      if (!safe()) return;
      polls += 1;
      if (polls > DIRECT_METADATA_MAX_POLLS) {
        setError('metadataTimeout');
        setPhase('input');
        return;
      }
      try {
        const status = await getTorrentStatusDirect(jobId);
        if (!safe()) return;
        if (status.state === 'error') {
          setError(/metadata resolution timed out/i.test(status.error ?? '') ? 'metadataTimeout' : 'generic');
          setPhase('input');
          return;
        }
        if (status.files.length === 0) return;
        directFilesRef.current = status.files;
        setTorrentName(status.name);
        const list = synthesizeEntries(status.files, '');
        if (!list.some((entry) => entry.kind === 'video') && !list.some((entry) => entry.kind === 'folder')) {
          setError('novideo');
          setPhase('input');
          return;
        }
        setEntries(list);
        setFolderPath('');
        setPhase('selecting');
      } catch {
        if (!safe()) return;
        setError('generic');
        setPhase('input');
      }
    }, DIRECT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, jobId]);

  const fetchFolderContents = useCallback((targetPath: string) => {
    setError(null);
    setEntries(synthesizeEntries(directFilesRef.current, targetPath));
    setFolderPath(targetPath);
  }, []);

  const handleFolderForward = useCallback((targetPath: string) => {
    fetchFolderContents(targetPath);
  }, [fetchFolderContents]);

  const handleSelect = useCallback(async () => {
    if (!jobId || !videoId) return;
    if (!entries.some((file) => file.id === videoId && file.kind === 'video')) {
      setError('generic');
      return;
    }
    if (subtitleId && !entries.some((file) => file.id === subtitleId && file.kind === 'subtitle')) {
      setError('generic');
      return;
    }
    if (isFirefox()) {
      notifyFirefoxUnsupported(dict.firefoxUnsupported);
      return;
    }

    setPhase('submitting');
    setError(null);
    trace('player', 'magnet_play_click', { videoId, hasSubtitle: subtitleId !== '', mode: 'tauri' });
    const attempt = epochRef.current;
    const videoIndex = directIndexFromId(videoId);
    const subtitleIndex = subtitleId ? directIndexFromId(subtitleId) : null;
    if (videoIndex === null || (subtitleId && subtitleIndex === null)) {
      setError('generic');
      setPhase('selecting');
      return;
    }
    try {
      const selection = await selectTorrentFilesDirect(jobId, videoIndex, subtitleIndex);
      if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
      const selected = entries.find((file) => file.id === videoId);
      jobIdRef.current = null;
      directFilesRef.current = [];
      setPhase('input');
      setMagnet('');
      setFolderPath('');
      onJobAccepted(jobId, selection.video_name || selected?.basename || '', '', {
        videoUrl: selection.video_url,
        subtitleUrl: selection.subtitle_url,
        ...(selection.selected_audio_track !== null ? { selectedAudioTrack: selection.selected_audio_track } : {}),
        ...(selection.selected_subtitle_track !== null ? { selectedSubtitleTrack: selection.selected_subtitle_track } : {}),
      });
    } catch (err) {
      if (attempt !== epochRef.current || !mountedRef.current || !openRef.current) return;
      setError(mapDirectError(err));
      setPhase('selecting');
    }
  }, [dict.firefoxUnsupported, entries, jobId, onJobAccepted, subtitleId, videoId]);

  const handleCheckboxChange = useCallback((entry: FileEntry, checked: boolean) => {
    if (entry.kind === 'video') setVideoId(checked && entry.id ? entry.id : '');
    else if (entry.kind === 'subtitle') setSubtitleId(checked && entry.id ? entry.id : '');
  }, []);

  const busy = phase === 'creating' || phase === 'submitting' || phase === 'settling';
  const canCreate = !busy && isValidMagnetUri(magnet);
  const hasVideoSelected = videoId !== '';
  const showTable = phase === 'selecting' || phase === 'submitting';
  const showLoading = phase === 'creating' || phase === 'checking';
  const showFiles = showTable || showLoading;
  const crumbs = buildBreadcrumb(torrentName || dict.magnetBreadcrumbRoot, folderPath);
  const orientation = isMobile ? 'vertical' : 'horizontal';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="entei-magnet-dialog" closeLabel={dict.dialogClose} hideClose>
        <div className="entei-magnet-form">
          <DialogTitle className="entei-magnet-dialog-title">
            <UsersCollaboration size={16} />
            {dict.magnetInputLabelTitle}
          </DialogTitle>
          <label className="entei-magnet-form-label" htmlFor="entei-magnet-input">
            {dict.magnetInputLabel}
          </label>
          <ButtonGroup orientation={orientation} className="entei-magnet-input-row">
            <Input
              id="entei-magnet-input"
              className="entei-magnet-input"
              placeholder={dict.magnetInputPlaceholder}
              aria-invalid={error === 'invalid'}
              value={magnet}
              onChange={(event) => {
                setMagnet(event.target.value);
                if (error) setError(null);
              }}
              spellCheck={false}
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canCreate) {
                  event.preventDefault();
                  void handleCreate();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="entei-magnet-add-btn"
              onClick={() => void handleCreate()}
              disabled={!canCreate}
              aria-label={dict.magnetInputSubmit}
              title={dict.magnetInputSubmit}
            >
              <Magnet size={16} aria-hidden="true" />
            </Button>
          </ButtonGroup>
          {showFiles && (
            <div className="entei-magnet-list">
              {showLoading ? (
                <nav className="entei-magnet-breadcrumb entei-magnet-breadcrumb--skeleton" aria-label={dict.magnetBreadcrumbLabel}>
                  <span className="entei-magnet-skeleton-crumb" aria-hidden="true" />
                </nav>
              ) : crumbs.length > 0 && (
                <nav className="entei-magnet-breadcrumb" aria-label={dict.magnetBreadcrumbLabel}>
                  {crumbs.map((crumb, index) => (
                    <span key={`${crumb.ellipsis ? 'ellipsis' : crumb.path || 'root'}-${index}`} className="entei-magnet-crumb-slot">
                      {index > 0 && <span className="entei-magnet-crumb-sep" aria-hidden="true">›</span>}
                      {crumb.ellipsis ? (
                        <span className="entei-magnet-crumb-ellipsis" aria-hidden="true">…</span>
                      ) : crumb.current ? (
                        <span className="entei-magnet-crumb entei-magnet-crumb--current" aria-current="location" title={crumb.label}>{crumb.label}</span>
                      ) : (
                        <button type="button" className="entei-magnet-crumb" onClick={() => handleFolderForward(crumb.path)} disabled={busy} aria-label={`${dict.magnetTableNavUp}: ${crumb.label}`} title={crumb.label}>{crumb.label}</button>
                      )}
                    </span>
                  ))}
                </nav>
              )}
              {showTable ? (
                entries.length === 0 ? (
                  <div className="entei-magnet-empty"><span className="entei-magnet-empty-title">{dict.magnetNoVideosInFolder}</span></div>
                ) : entries.map((entry) => {
                  const isFolder = entry.kind === 'folder';
                  const isVideo = entry.kind === 'video';
                  const isSubtitle = entry.kind === 'subtitle';
                  const selectable = isVideo || isSubtitle;
                  const isSelected = (isVideo && videoId === entry.id) || (isSubtitle && subtitleId === entry.id);
                  const itemClass = `entei-magnet-item${isFolder ? ' entei-magnet-item--folder' : ''}${isSelected ? ' entei-magnet-item--selected' : ''}`;
                  const iconClass = `entei-magnet-item-icon${isSelected ? ' entei-magnet-item-selected-icon' : ''}`;
                  const nameClass = `entei-magnet-item-name${isSelected ? ' entei-magnet-item-selected-name' : ''}`;
                  const key = entry.id ?? entry.relativePath ?? entry.basename;
                  const rowBody = (
                    <>
                      <span className={iconClass} aria-hidden="true">{kindIcon(entry.kind, 18)}</span>
                      <span className="entei-magnet-item-text">
                        <span className={nameClass}>{entry.basename}</span>
                        {!isFolder && entry.byteSize != null && <span className="entei-magnet-item-size">{formatBytes(entry.byteSize)}</span>}
                      </span>
                    </>
                  );
                  if (isFolder) {
                    return <button key={key} type="button" className={itemClass} onClick={() => handleFolderForward(entry.relativePath ?? entry.basename)} disabled={busy}>{rowBody}</button>;
                  }
                  return (
                    <div key={key} className={itemClass}>
                      {rowBody}
                      {selectable && (
                        <Checkbox className="entei-magnet-item-check" checked={isSelected} onCheckedChange={(checked) => handleCheckboxChange(entry, checked === true)} disabled={busy} aria-label={`${kindLabel(entry, dict)}: ${entry.basename}`} />
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="entei-magnet-checking" role="status">
                  <span className="entei-sr-only">{dict.magnetCheckMetadata}</span>
                  <div className="entei-magnet-skeleton-list" aria-hidden="true">
                    {SKELETON_ROW_WIDTHS.map((width, index) => (
                      <div className="entei-magnet-skeleton-row" key={index}>
                        <span className="entei-magnet-skeleton-icon" />
                        <span className="entei-magnet-skeleton-name" style={{ width }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <ButtonGroup orientation={orientation} className="entei-magnet-actions">
            <Button type="button" className="entei-magnet-select-play" onClick={() => void handleSelect()} disabled={busy || !showTable || !hasVideoSelected} aria-label={dict.magnetSelectSubmit}>
              {phase === 'submitting' ? <TypewriterLoading aria-hidden="true" className="entei-typewriter--btn" /> : dict.magnetSelectSubmit}
            </Button>
            <Button type="button" variant="outline" className="entei-magnet-cancel" onClick={handleCancel} aria-label={dict.magnetCancel}>
              {phase === 'settling' ? <TypewriterLoading aria-hidden="true" className="entei-typewriter--btn" /> : dict.magnetCancel}
            </Button>
          </ButtonGroup>
        </div>
      </DialogContent>
    </Dialog>
  );
}
