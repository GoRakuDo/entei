/**
 * tauri-bridge — `plugin:subtitles` wrappers (desktop native parser)
 * ---------------------------------------------------------------------------
 * The desktop build parses subtitles, media file names and the LazySync
 * offset in Rust (`plugins/tauri-plugin-subtitles`) instead of on the
 * browser main thread. These tests pin the contracts the Player depends on:
 *
 * 1. the exact command id and argument shape of every wrapper (a typo here
 *    fails silently in production, because a rejection falls back to the
 *    TypeScript parser);
 * 2. the unit of the LazySync offset — the plugin answers in SECONDS, the
 *    web layer works in MILLISECONDS;
 * 3. the fail-soft contract: outside Tauri, on a rejection and on a
 *    malformed reply, the TypeScript implementation takes over.
 *
 * No real Tauri runtime, Rust plugin or media file is involved.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect, vi, afterEach } from 'bun:test';
import {
  estimateLazySyncOffsetDirect,
  parseMediaFilenameDirect,
  parseSubtitleDirect,
} from '@/features/player/tauri-bridge';
import { parseSubtitle, type SubtitleCue } from '@/features/player/subtitle-reader';
import { parseMediaFileName } from '@/features/player/filename-parser';
import { estimateMedianOffset } from '@/features/player/lazy-sync';

type InvokeCall = { cmd: string; args: Record<string, unknown> | undefined };

interface InternalsWindow {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

function internals(): InternalsWindow {
  return globalThis as unknown as InternalsWindow;
}

/** Install a fake Tauri IPC bridge and record every call it receives. */
function installTauri(
  impl: (cmd: string, args?: Record<string, unknown>) => unknown = () => null,
): InvokeCall[] {
  const calls: InvokeCall[] = [];
  internals().__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return impl(cmd, args);
    }),
  };
  return calls;
}

function uninstallTauri(): void {
  delete internals().__TAURI_INTERNALS__;
}

afterEach(() => {
  uninstallTauri();
});

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:02,500',
  'Hello',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,000',
  'World',
  '',
].join('\n');

/** Five drift cues; the reference track is the same list two seconds later. */
function buildCues(offsetSeconds: number): SubtitleCue[] {
  return [0, 1, 2, 3, 4].map((index) => ({
    id: index,
    start: index + offsetSeconds,
    end: index + offsetSeconds + 1,
    text: `line ${index}`,
  }));
}

describe('tauri-bridge subtitles wrappers — outside Tauri', () => {
  it('parses with the TypeScript parser and never touches the IPC bridge', async () => {
    const result = await parseSubtitleDirect(SRT);

    expect(result).toEqual(parseSubtitle(SRT));
    expect(result.format).toBe('srt');
    expect(result.cues.length).toBe(2);
    expect(internals().__TAURI_INTERNALS__).toBeUndefined();
  });

  it('keeps ASS parsing available through the TypeScript fallback', async () => {
    const ass = [
      '[Script Info]',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\b1}Hello\\Nworld{\\b0}',
    ].join('\n');

    await expect(parseSubtitleDirect(ass)).resolves.toMatchObject({
      format: 'ass',
      errors: [],
      cues: [{ start: 1, end: 4, text: 'Hello world' }],
    });
    expect(internals().__TAURI_INTERNALS__).toBeUndefined();
  });

  it('parses the media file name with the TypeScript parser', async () => {
    const parsed = await parseMediaFilenameDirect(
      'Meitantei no Mama de Ite [1080p][B5CC76C9].mkv',
    );

    expect(parsed).toEqual(
      parseMediaFileName(
        'Meitantei no Mama de Ite [1080p][B5CC76C9].mkv',
      ),
    );
    expect(parsed.title).toBe('Meitantei no Mama de Ite');
    expect(parsed.episode).toBeNull();
  });

  it('estimates the LazySync offset with the TypeScript estimator', async () => {
    const drift = buildCues(0);
    const ref = buildCues(2);

    const offsetMs = await estimateLazySyncOffsetDirect(ref, drift);

    expect(offsetMs).toBe(estimateMedianOffset(drift, ref)?.offsetMs);
    expect(offsetMs).toBe(2000);
  });
});

describe('tauri-bridge subtitles wrappers — inside Tauri', () => {
  it('parses through the native plugin with { content, format }', async () => {
    const calls = installTauri(() => ({
      cues: [{ id: 0, start: 1, end: 2, text: 'native' }],
      errors: [],
      format: 'srt',
    }));

    const result = await parseSubtitleDirect(SRT);

    expect(calls).toEqual([
      {
        cmd: 'plugin:subtitles|subtitles_parse',
        args: { content: SRT, format: null },
      },
    ]);
    // The native reply is used as-is — the TypeScript parser is not run.
    expect(result.cues).toEqual([{ id: 0, start: 1, end: 2, text: 'native' }]);
    expect(result.format).toBe('srt');
  });

  it('forwards an explicit format hint', async () => {
    const calls = installTauri(() => ({ cues: [], errors: [], format: 'vtt' }));

    await parseSubtitleDirect('WEBVTT\n', 'vtt');

    expect(calls[0]?.args).toEqual({ content: 'WEBVTT\n', format: 'vtt' });
  });

  it('parses the media file name through the native plugin with { name }', async () => {
    const calls = installTauri(() => ({ title: 'Native Title', episode: 7 }));

    const parsed = await parseMediaFilenameDirect('Show 07.mkv');

    expect(calls).toEqual([
      {
        cmd: 'plugin:subtitles|subtitles_parse_filename',
        args: { name: 'Show 07.mkv' },
      },
    ]);
    expect(parsed).toEqual({ title: 'Native Title', episode: 7 });
  });

  it('estimates the LazySync offset through the native plugin and converts seconds to milliseconds', async () => {
    const drift = buildCues(0);
    const ref = buildCues(2);
    const calls = installTauri(() => 1.5);

    const offsetMs = await estimateLazySyncOffsetDirect(ref, drift);

    expect(calls).toEqual([
      {
        cmd: 'plugin:subtitles|subtitles_estimate_lazy_sync',
        args: {
          refCues: ref,
          driftCues: drift,
        },
      },
    ]);
    // The plugin answers in seconds; the web layer works in milliseconds.
    expect(offsetMs).toBe(1500);
  });

  it('sends only the four cue fields the plugin deserializes', async () => {
    const calls = installTauri(() => 0);
    const drift = [{ id: 0, start: 0, end: 1, text: 'a', extra: 'x' }];

    await estimateLazySyncOffsetDirect(drift, drift);

    expect(calls[0]?.args).toEqual({
      refCues: [{ id: 0, start: 0, end: 1, text: 'a' }],
      driftCues: [{ id: 0, start: 0, end: 1, text: 'a' }],
    });
  });
});

describe('tauri-bridge subtitles wrappers — fail-soft', () => {
  it('falls back to the TypeScript parser when the plugin rejects', async () => {
    installTauri(() => {
      throw new Error('plugin missing');
    });

    const result = await parseSubtitleDirect(SRT);
    expect(result).toEqual(parseSubtitle(SRT));

    const parsed = await parseMediaFilenameDirect('Show 07.mkv');
    expect(parsed).toEqual(parseMediaFileName('Show 07.mkv'));
  });

  it('falls back to the TypeScript parser when the reply is malformed', async () => {
    installTauri(() => ({ cues: 'not-an-array', errors: [], format: 'srt' }));

    const result = await parseSubtitleDirect(SRT);
    expect(result).toEqual(parseSubtitle(SRT));
  });

  it('falls back to the TypeScript parser when a cue field has the wrong type', async () => {
    installTauri(() => ({
      cues: [{ id: 0, start: '1', end: 2, text: 'broken' }],
      errors: [],
      format: 'srt',
    }));

    const result = await parseSubtitleDirect(SRT);
    expect(result).toEqual(parseSubtitle(SRT));
  });

  it('falls back to the TypeScript estimator when the plugin rejects', async () => {
    installTauri(() => {
      throw new Error('plugin missing');
    });

    const drift = buildCues(0);
    const ref = buildCues(2);

    await expect(estimateLazySyncOffsetDirect(ref, drift)).resolves.toBe(2000);
  });

  it('keeps the plugin fail-closed answer (null) instead of re-estimating', async () => {
    installTauri(() => null);

    const drift = buildCues(0);
    const ref = buildCues(2);

    await expect(estimateLazySyncOffsetDirect(ref, drift)).resolves.toBeNull();
  });
});
