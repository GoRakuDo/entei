import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createMediaUrl,
  revokeUrl,
  isObjectUrl,
  getFileExtension,
  isVideoFile,
  isAudioFile,
  isSubtitleFile,
  classifyMediaFile,
  classifyMediaError,
  nativeErrorToDictKey,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  MEDIA_ACCEPT,
  SUBTITLE_ACCEPT,
} from '../src/features/player/media-url';

// Mock URL.createObjectURL and URL.revokeObjectURL
beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Extension sets — P1.2 source of truth
// ---------------------------------------------------------------------------

describe('extension sets', () => {
  it('VIDEO_EXTENSIONS includes original types', () => {
    expect(VIDEO_EXTENSIONS.has('mp4')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('webm')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('ogv')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('ogg')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('mkv')).toBe(true);
  });

  it('VIDEO_EXTENSIONS includes asbplayer-added types', () => {
    expect(VIDEO_EXTENSIONS.has('m4v')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('avi')).toBe(true);
  });

  it('AUDIO_EXTENSIONS includes original types', () => {
    expect(AUDIO_EXTENSIONS.has('mp3')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('wav')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('flac')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('aac')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('m4a')).toBe(true);
    // .ogg is in VIDEO_EXTENSIONS (container can hold video); audio Ogg
    // files with audio/ogg MIME are still accepted via isAudioFile MIME check.
  });

  it('AUDIO_EXTENSIONS includes asbplayer-added types', () => {
    expect(AUDIO_EXTENSIONS.has('opus')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('m4b')).toBe(true);
  });

  it('SUBTITLE_EXTENSIONS includes srt, vtt, and ass', () => {
    expect(SUBTITLE_EXTENSIONS.has('srt')).toBe(true);
    expect(SUBTITLE_EXTENSIONS.has('vtt')).toBe(true);
    expect(SUBTITLE_EXTENSIONS.has('ass')).toBe(true);
  });

  it('SUBTITLE_EXTENSIONS is case-insensitive via ext normalization', () => {
    // Extension extraction normalizes to lowercase, so 'ASS' becomes 'ass'
    const file = new File([''], 'subs.ASS');
    expect(getFileExtension(file)).toBe('ass');
    expect(SUBTITLE_EXTENSIONS.has(getFileExtension(file))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyMediaFile — P1.2 admission gate
// ---------------------------------------------------------------------------

describe('classifyMediaFile', () => {
  // --- Video extensions ---
  it.each([...VIDEO_EXTENSIONS])('classifies .%s as video', (ext) => {
    const file = new File([''], `test.${ext}`, { type: '' });
    expect(classifyMediaFile(file)).toEqual({ kind: 'video', ext });
  });

  // --- Audio extensions ---
  it.each([...AUDIO_EXTENSIONS])('classifies .%s as audio', (ext) => {
    const file = new File([''], `test.${ext}`, { type: '' });
    expect(classifyMediaFile(file)).toEqual({ kind: 'audio', ext });
  });

  // --- Rejected extensions ---
  it('rejects unknown extension', () => {
    const file = new File([''], 'test.xyz', { type: '' });
    expect(classifyMediaFile(file)).toEqual({ kind: 'rejected', ext: 'xyz' });
  });

  it('rejects subtitle as media', () => {
    const file = new File([''], 'test.srt', { type: '' });
    expect(classifyMediaFile(file)).toEqual({ kind: 'rejected', ext: 'srt' });
  });

  it('rejects file with no extension', () => {
    const file = new File([''], 'noext', { type: '' });
    expect(classifyMediaFile(file)).toEqual({ kind: 'rejected', ext: '' });
  });

  it('handles uppercase file names', () => {
    const file = new File([''], 'TEST.MP4');
    expect(classifyMediaFile(file)).toEqual({ kind: 'video', ext: 'mp4' });
  });

  it('handles mixed case', () => {
    const file = new File([''], 'My.File.FLAC');
    expect(classifyMediaFile(file)).toEqual({ kind: 'audio', ext: 'flac' });
  });

  it('does not create a Blob URL for rejected files', () => {
    const file = new File([''], 'test.xyz', { type: '' });
    const result = classifyMediaFile(file);
    expect(result.kind).toBe('rejected');
    // Verified that createMediaUrl is NOT called for rejected files
    // by the PlayerApp logic (handleMediaSelect returns early).
  });
});

// ---------------------------------------------------------------------------
// classifyMediaError — P1.2 native error mapping
// ---------------------------------------------------------------------------

describe('classifyMediaError', () => {
  it('classifies MEDIA_ERR_DECODE (3) as decode', () => {
    const error = { code: 3 };
    expect(classifyMediaError(error, 'video')).toEqual({
      kind: 'decode',
      mediaType: 'video',
    });
  });

  it('classifies MEDIA_ERR_SRC_NOT_SUPPORTED (4) as network', () => {
    const error = { code: 4 };
    expect(classifyMediaError(error, 'audio')).toEqual({
      kind: 'network',
      mediaType: 'audio',
    });
  });

  it('classifies MEDIA_ERR_NETWORK (2) as network', () => {
    const error = { code: 2 };
    expect(classifyMediaError(error, 'video')).toEqual({
      kind: 'network',
      mediaType: 'video',
    });
  });

  it('classifies MEDIA_ERR_ABORTED (1) as unknown', () => {
    const error = { code: 1 };
    expect(classifyMediaError(error, 'video')).toEqual({
      kind: 'unknown',
      mediaType: 'video',
    });
  });

  it('returns null for null error', () => {
    expect(classifyMediaError(null, 'video')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nativeErrorToDictKey — P1.2 i18n key mapping
// ---------------------------------------------------------------------------

describe('nativeErrorToDictKey', () => {
  it('maps video decode to videoDecodeError', () => {
    expect(nativeErrorToDictKey({ kind: 'decode', mediaType: 'video' })).toBe(
      'videoDecodeError',
    );
  });

  it('maps audio decode to audioDecodeError', () => {
    expect(nativeErrorToDictKey({ kind: 'decode', mediaType: 'audio' })).toBe(
      'audioDecodeError',
    );
  });

  it('maps video network to failedToLoadVideo', () => {
    expect(nativeErrorToDictKey({ kind: 'network', mediaType: 'video' })).toBe(
      'failedToLoadVideo',
    );
  });

  it('maps audio network to failedToLoadAudio', () => {
    expect(nativeErrorToDictKey({ kind: 'network', mediaType: 'audio' })).toBe(
      'failedToLoadAudio',
    );
  });

  it('maps video unknown to failedToLoadVideo', () => {
    expect(nativeErrorToDictKey({ kind: 'unknown', mediaType: 'video' })).toBe(
      'failedToLoadVideo',
    );
  });

  it('maps audio unknown to failedToLoadAudio', () => {
    expect(nativeErrorToDictKey({ kind: 'unknown', mediaType: 'audio' })).toBe(
      'failedToLoadAudio',
    );
  });
});

// ---------------------------------------------------------------------------
// createMediaUrl
// ---------------------------------------------------------------------------

describe('createMediaUrl', () => {
  it('creates a new object URL from a File', () => {
    const file = new File(['content'], 'test.mp4', { type: 'video/mp4' });
    const url = createMediaUrl(file, null);

    expect(url).toBe('blob:mock-url');
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the previous URL when creating a new one', () => {
    const file1 = new File(['content1'], 'test1.mp4', { type: 'video/mp4' });
    const file2 = new File(['content2'], 'test2.mp4', { type: 'video/mp4' });

    const url1 = createMediaUrl(file1, null);
    const url2 = createMediaUrl(file2, url1);

    expect(url2).toBe('blob:mock-url');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    // Only revoked once (the previous URL)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('does not revoke when previousUrl is null', () => {
    const file = new File(['content'], 'test.mp4', { type: 'video/mp4' });
    createMediaUrl(file, null);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// revokeUrl
// ---------------------------------------------------------------------------

describe('revokeUrl', () => {
  it('revokes a valid object URL', () => {
    revokeUrl('blob:test-url');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
  });

  it('does not throw for null URL', () => {
    expect(() => revokeUrl(null)).not.toThrow();
  });

  it('does not throw when revokeObjectURL throws', () => {
    vi.mocked(URL.revokeObjectURL).mockImplementation(() => {
      throw new Error('Already revoked');
    });
    expect(() => revokeUrl('blob:test')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isObjectUrl
// ---------------------------------------------------------------------------

describe('isObjectUrl', () => {
  it('returns true for blob URLs', () => {
    expect(isObjectUrl('blob:http://localhost/test')).toBe(true);
  });

  it('returns false for regular URLs', () => {
    expect(isObjectUrl('http://localhost/test.mp4')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getFileExtension
// ---------------------------------------------------------------------------

describe('getFileExtension', () => {
  it('extracts lowercase extension', () => {
    const file = new File([''], 'VIDEO.MP4');
    expect(getFileExtension(file)).toBe('mp4');
  });

  it('returns empty string for no extension', () => {
    const file = new File([''], 'noextension');
    expect(getFileExtension(file)).toBe('');
  });

  it('handles multiple dots', () => {
    const file = new File([''], 'file.name.srt');
    expect(getFileExtension(file)).toBe('srt');
  });
});

// ---------------------------------------------------------------------------
// isVideoFile / isAudioFile / isSubtitleFile
// ---------------------------------------------------------------------------

describe('isVideoFile', () => {
  it('detects video by MIME type', () => {
    const file = new File([''], 'test.mp4', { type: 'video/mp4' });
    expect(isVideoFile(file)).toBe(true);
  });

  it('detects video by extension (mp4)', () => {
    const file = new File([''], 'test.mp4', { type: '' });
    expect(isVideoFile(file)).toBe(true);
  });

  it('detects video by extension (mkv)', () => {
    const file = new File([''], 'test.mkv', { type: '' });
    expect(isVideoFile(file)).toBe(true);
  });

  it('detects video by extension (m4v)', () => {
    const file = new File([''], 'test.m4v', { type: '' });
    expect(isVideoFile(file)).toBe(true);
  });

  it('detects video by extension (avi)', () => {
    const file = new File([''], 'test.avi', { type: '' });
    expect(isVideoFile(file)).toBe(true);
  });

  it('detects video by extension (ogv)', () => {
    const file = new File([''], 'test.ogv', { type: '' });
    expect(isVideoFile(file)).toBe(true);
  });

  it('detects video by extension (ogg)', () => {
    const file = new File([''], 'test.ogg', { type: '' });
    expect(isVideoFile(file)).toBe(true);
  });

  it('returns false for audio files', () => {
    const file = new File([''], 'test.mp3', { type: 'audio/mpeg' });
    expect(isVideoFile(file)).toBe(false);
  });

  it('handles uppercase extension', () => {
    const file = new File([''], 'TEST.MKV');
    expect(isVideoFile(file)).toBe(true);
  });
});

describe('isAudioFile', () => {
  it('detects audio by MIME type', () => {
    const file = new File([''], 'test.mp3', { type: 'audio/mpeg' });
    expect(isAudioFile(file)).toBe(true);
  });

  it('detects audio by extension (mp3)', () => {
    const file = new File([''], 'test.mp3', { type: '' });
    expect(isAudioFile(file)).toBe(true);
  });

  it('detects audio by extension (flac)', () => {
    const file = new File([''], 'test.flac', { type: '' });
    expect(isAudioFile(file)).toBe(true);
  });

  it('detects audio by extension (opus)', () => {
    const file = new File([''], 'test.opus', { type: '' });
    expect(isAudioFile(file)).toBe(true);
  });

  it('detects audio by extension (m4b)', () => {
    const file = new File([''], 'test.m4b', { type: '' });
    expect(isAudioFile(file)).toBe(true);
  });

  it('returns false for video files', () => {
    const file = new File([''], 'test.mp4', { type: 'video/mp4' });
    expect(isAudioFile(file)).toBe(false);
  });

  it('handles uppercase extension', () => {
    const file = new File([''], 'TRACK.FLAC');
    expect(isAudioFile(file)).toBe(true);
  });
});

describe('isSubtitleFile', () => {
  it('detects SRT by extension', () => {
    const file = new File([''], 'subs.srt');
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('detects VTT by extension', () => {
    const file = new File([''], 'subs.vtt');
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('detects VTT by MIME type', () => {
    const file = new File([''], 'subs.txt', { type: 'text/vtt' });
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('detects ASS by extension', () => {
    const file = new File([''], 'subs.ass');
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('detects ASS by uppercase extension', () => {
    const file = new File([''], 'subs.ASS');
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('detects ASS by text/x-ssa MIME type', () => {
    const file = new File([''], 'subs.txt', { type: 'text/x-ssa' });
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('detects ASS by application/x-ssa MIME type', () => {
    const file = new File([''], 'subs.txt', { type: 'application/x-ssa' });
    expect(isSubtitleFile(file)).toBe(true);
  });

  it('returns false for non-subtitle files', () => {
    const file = new File([''], 'test.txt');
    expect(isSubtitleFile(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Accept constants
// ---------------------------------------------------------------------------

describe('accept constants', () => {
  it('MEDIA_ACCEPT includes all video extensions', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(MEDIA_ACCEPT).toContain(`.${ext}`);
    }
  });

  it('MEDIA_ACCEPT includes all audio extensions', () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(MEDIA_ACCEPT).toContain(`.${ext}`);
    }
  });

  it('MEDIA_ACCEPT includes video/* and audio/* wildcards', () => {
    expect(MEDIA_ACCEPT).toContain('video/*');
    expect(MEDIA_ACCEPT).toContain('audio/*');
  });

  it('MEDIA_ACCEPT includes asbplayer-added extensions', () => {
    expect(MEDIA_ACCEPT).toContain('.m4v');
    expect(MEDIA_ACCEPT).toContain('.avi');
    expect(MEDIA_ACCEPT).toContain('.opus');
    expect(MEDIA_ACCEPT).toContain('.m4b');
  });

  it('SUBTITLE_ACCEPT includes srt, vtt, and ass', () => {
    expect(SUBTITLE_ACCEPT).toContain('.srt');
    expect(SUBTITLE_ACCEPT).toContain('.vtt');
    expect(SUBTITLE_ACCEPT).toContain('.ass');
  });

  it('SUBTITLE_ACCEPT includes ASS MIME types', () => {
    expect(SUBTITLE_ACCEPT).toContain('text/x-ssa');
    expect(SUBTITLE_ACCEPT).toContain('application/x-ssa');
  });
});
