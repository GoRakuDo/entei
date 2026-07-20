import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createMediaUrl,
  revokeUrl,
  isObjectUrl,
  getFileExtension,
  isVideoFile,
  isAudioFile,
  isSubtitleFile,
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

  it('detects video by extension', () => {
    const file = new File([''], 'test.webm', { type: '' });
    expect(isVideoFile(file)).toBe(true);
  });

  it('returns false for audio files', () => {
    const file = new File([''], 'test.mp3', { type: 'audio/mpeg' });
    expect(isVideoFile(file)).toBe(false);
  });
});

describe('isAudioFile', () => {
  it('detects audio by MIME type', () => {
    const file = new File([''], 'test.mp3', { type: 'audio/mpeg' });
    expect(isAudioFile(file)).toBe(true);
  });

  it('detects audio by extension', () => {
    const file = new File([''], 'test.flac', { type: '' });
    expect(isAudioFile(file)).toBe(true);
  });

  it('returns false for video files', () => {
    const file = new File([''], 'test.mp4', { type: 'video/mp4' });
    expect(isAudioFile(file)).toBe(false);
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

  it('returns false for non-subtitle files', () => {
    const file = new File([''], 'test.txt');
    expect(isSubtitleFile(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Accept constants
// ---------------------------------------------------------------------------

describe('accept constants', () => {
  it('MEDIA_ACCEPT includes video and audio formats', () => {
    expect(MEDIA_ACCEPT).toContain('video/*');
    expect(MEDIA_ACCEPT).toContain('audio/*');
    expect(MEDIA_ACCEPT).toContain('.mp4');
    expect(MEDIA_ACCEPT).toContain('.mp3');
  });

  it('SUBTITLE_ACCEPT includes srt and vtt', () => {
    expect(SUBTITLE_ACCEPT).toContain('.srt');
    expect(SUBTITLE_ACCEPT).toContain('.vtt');
  });
});
