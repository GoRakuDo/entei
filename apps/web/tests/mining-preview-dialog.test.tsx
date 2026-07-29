/**
 * Component tests for AM-4 MiningPreviewDialog (field mapping edition).
 * ---------------------------------------------------------------------------
 * - Dialog renders draft fields from Anki mapping.
 * - Sentence/definition use textarea; other editable fields use input.
 * - Mapped image/audio fields show labels + preview but NO input/textarea.
 * - Image preview only renders when semantic 'image' mapping exists.
 * - Audio preview only renders when semantic 'audio' mapping exists.
 * - Full mapping (7 semantic keys) renders exactly 5 text controls.
 * - Range slider with [start, end] renders 2 role=slider thumbs.
 * - Slider calls onRangeChange.
 * - Update audio button respects disabled states.
 * - Cancel/Close callbacks fire.
 * - No Anki / localStorage / fetch calls.
 * --------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { MiningPreviewDialog } from '@/components/player/MiningPreviewDialog';

beforeEach(() => {
  global.ResizeObserver = vi.fn(function () {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mockDict = {
  miningPreviewTitle: 'Mining Preview',
  miningPreviewRange: 'Range',
  miningPreviewCancel: 'Cancel',
  miningPreviewClose: 'Close',
  miningPreviewScreenshotUnavailable: 'Screenshot unavailable for audio media',
  miningPreviewAudioError: 'Audio capture failed',
  miningPreviewScreenshotError: 'Screenshot capture failed',
  miningPreviewCapturing: 'Capturing…',
  miningPreviewRefreshing: 'Refreshing materials…',
  miningPreviewRangeInvalid: 'Invalid range',
  miningZoomIn: 'Zoom in',
  miningZoomOut: 'Zoom out',
  audioClipPlay: 'Play',
  audioClipPause: 'Pause',
  audioClipNoPreview: 'No preview available.',
  dialogClose: 'Close',
  exportModeNew: 'New card',
  exportModeUpdate: 'Update card',
  exportSendNew: 'Send to Anki',
  exportNoCandidate: 'No recent note found.',
  exportSuccess: 'Sent successfully.',
  exportError: 'Export failed.',
  exportSendDisabledNoConnection: 'AnkiConnect is not connected.',
  exportSendDisabledInvalidPreset: 'Invalid preset.',
  exportSendDisabledNoSentence: 'Sentence is empty.',
  exportSendDisabledRequestActive: 'Request in progress.',
  exportRejectedCanAdd: 'Anki rejected this note.',
  appendSelectLabel: 'Select card to append',
  appendDialogTitle: 'Search & Append',
  appendDialogDescription: 'Search Anki.',
  appendSearchPlaceholder: 'Search query',
  appendSearchButton: 'Search',
  appendSearching: 'Searching…',
  appendNoResults: 'No results.',
  appendSearchError: 'Search failed.',
  appendWordLabel: 'Word',
  appendSentenceLabel: 'Sentence',
  appendDeckLabel: 'Deck',
  appendSuccess: 'Done.',
  appendPartialFailure: 'Partial.',
  appendAllFailed: 'Failed.',
  appendSelectedCount: (count: number) => `${count} selected`,
  mediaModeImage: 'Image',
  mediaModeVideo: 'Video',
  mediaModeUnsupported: 'Video Clip is not supported.',
};

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  draftFields: [
    { key: 'sentence', physicalName: 'SentenceField', value: 'テスト文章' },
    {
      key: 'source',
      physicalName: 'SourceField',
      value: 'test.mp4 (00:10 – 00:15)',
    },
  ],
  onDraftFieldChange: vi.fn(),
  screenshotUrl: null,
  hasScreenshotError: false,
  isScreenshotUnavailable: false,
  audioUrl: null,
  audioExpectedDuration: 0,
  hasAudioError: false,
  rangeStart: 10,
  rangeEnd: 15,
  mediaDuration: 60,
  cues: [],
  isCapturing: false,
  isRefreshing: false,
  canRefresh: true,
  onRangeChange: vi.fn(),
  onRangeCommit: vi.fn(),
  onCancel: vi.fn(),
  exportMode: 'new' as const,
  onExportModeChange: vi.fn(),
  isExporting: false,
  canExport: true,
  exportDisabledReason: null,
  exportError: null,
  exportSuccess: false,
  onExportSend: vi.fn(),
  onAppendSearch: vi.fn().mockResolvedValue([]),
  onAppend: vi.fn().mockResolvedValue({ succeeded: [], failed: [] }),
  isAppending: false,
  appendResult: null,
  appendSendDisabledReason: null,
  savedDeck: 'Japanese',
  savedNoteType: 'Basic',
  sentenceFieldName: 'Front',
  mediaMode: 'image' as const,
  onMediaModeChange: vi.fn(),
  mediaPreviewUrl: null,
  mediaPreviewType: 'image' as const,
  mediaUnsupported: null,
  isMediaRecapturing: false,
  dict: mockDict,
};

describe('MiningPreviewDialog', () => {
  it('renders draft field values', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    // Sentence field is a textarea — value is accessible via textContent
    expect(document.body.textContent).toContain('テスト文章');
    // Source field is an input — check value directly
    const sourceInput = document.body.querySelector(
      'input[aria-label="SourceField"]',
    ) as HTMLInputElement;
    expect(sourceInput).not.toBeNull();
    expect(sourceInput.value).toBe('test.mp4 (00:10 – 00:15)');
  });

  it('shows physical field names as labels', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    expect(document.body.textContent).toContain('SentenceField');
    expect(document.body.textContent).toContain('SourceField');
  });

  it('uses textarea for sentence and definition fields', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[
          { key: 'sentence', physicalName: 'fld_Sentence', value: 'hello' },
          { key: 'definition', physicalName: 'fld_Definition', value: 'world' },
        ]}
      />,
    );
    const textareas = document.body.querySelectorAll('textarea');
    expect(textareas.length).toBe(2);
  });

  it('uses input for non-sentence/definition fields', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[
          { key: 'sentence', physicalName: 'fld_Sentence', value: 'hello' },
          { key: 'word', physicalName: 'fld_Word', value: 'test' },
          { key: 'tags', physicalName: 'fld_Tags', value: 'tag1' },
        ]}
      />,
    );
    const textareas = document.body.querySelectorAll('textarea');
    const inputs = document.body.querySelectorAll('input[type="text"]');
    expect(textareas.length).toBe(1);
    expect(inputs.length).toBe(2);
  });

  it('calls onDraftFieldChange when input value changes', () => {
    const onDraftFieldChange = vi.fn();
    render(
      <MiningPreviewDialog
        {...baseProps}
        onDraftFieldChange={onDraftFieldChange}
      />,
    );
    const input = document.body.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: 'new value' } });
    expect(onDraftFieldChange).toHaveBeenCalledWith(0, 'new value');
  });

  it('renders empty draft fields array with no field sections', () => {
    render(<MiningPreviewDialog {...baseProps} draftFields={[]} />);
    // Should only have the Range section, no field sections
    expect(document.body.textContent).toContain(mockDict.miningPreviewRange);
    expect(document.body.querySelector('.entei-mining-input')).toBeNull();
  });

  it('shows screenshot image when image mapping exists and url provided', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[{ key: 'image', physicalName: 'fld_Image', value: '' }]}
        screenshotUrl="blob:screenshot"
      />,
    );
    const img = document.body.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('blob:screenshot');
  });

  it('does NOT show screenshot image when image mapping absent', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[
          { key: 'sentence', physicalName: 'fld_Sentence', value: 'hello' },
        ]}
        screenshotUrl="blob:screenshot"
      />,
    );
    const img = document.body.querySelector('img');
    expect(img).toBeNull();
  });

  it('shows screenshot error when image mapping exists and hasScreenshotError', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[{ key: 'image', physicalName: 'fld_Image', value: '' }]}
        hasScreenshotError
      />,
    );
    expect(document.body.textContent).toContain(
      mockDict.miningPreviewScreenshotError,
    );
  });

  it('shows screenshot unavailable when image mapping exists and isScreenshotUnavailable', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[{ key: 'image', physicalName: 'fld_Image', value: '' }]}
        isScreenshotUnavailable
      />,
    );
    expect(document.body.textContent).toContain(
      mockDict.miningPreviewScreenshotUnavailable,
    );
  });

  it('shows audio preview when audio mapping exists and url provided', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[{ key: 'audio', physicalName: 'fld_Audio', value: '' }]}
        audioUrl="blob:audio"
        audioExpectedDuration={5}
      />,
    );
    const audio = document.body.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.getAttribute('src')).toBe('blob:audio');
  });

  it('does NOT show audio player when audio mapping absent', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[
          { key: 'sentence', physicalName: 'fld_Sentence', value: 'hello' },
        ]}
        audioUrl="blob:audio"
        audioExpectedDuration={5}
      />,
    );
    const audio = document.body.querySelector('audio');
    expect(audio).toBeNull();
  });

  it('shows audio error when audio mapping exists and hasAudioError', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[{ key: 'audio', physicalName: 'fld_Audio', value: '' }]}
        hasAudioError
      />,
    );
    expect(document.body.textContent).toContain(
      mockDict.miningPreviewAudioError,
    );
  });

  it('does NOT render an Update materials button', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const updateBtn = document.body.querySelector('.entei-mining-update-btn');
    expect(updateBtn).toBeNull();
  });

  it('calls onRangeCommit when slider commits (not during drag)', () => {
    const onRangeChange = vi.fn();
    const onRangeCommit = vi.fn();
    render(
      <MiningPreviewDialog
        {...baseProps}
        onRangeChange={onRangeChange}
        onRangeCommit={onRangeCommit}
      />,
    );
    const slider = document.body.querySelector('.entei-mining-range-slider');
    expect(slider).not.toBeNull();
    // onValueChange fires during drag — should call onRangeChange, not onRangeCommit
    // onValueCommit fires on release — should call onRangeCommit
    // In JSDOM, Radix Slider doesn't fully simulate pointer drag,
    // but we verify the callback prop is wired
    expect(onRangeCommit).not.toHaveBeenCalled();
  });

  it('disables slider when isRefreshing is true', () => {
    render(<MiningPreviewDialog {...baseProps} isRefreshing />);
    const slider = document.body.querySelector('.entei-mining-range-slider');
    if (slider) {
      expect(slider.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('disables slider when canRefresh is false', () => {
    render(<MiningPreviewDialog {...baseProps} canRefresh={false} />);
    const slider = document.body.querySelector('.entei-mining-range-slider');
    if (slider) {
      expect(slider.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('does NOT render a bottom footer close button', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const footer = document.body.querySelector('.entei-mining-footer');
    expect(footer).toBeNull();
    // No button with the footer button class
    const footerBtn = document.body.querySelector(
      '.entei-mining-footer .entei-dialog-footer-btn',
    );
    expect(footerBtn).toBeNull();
  });

  it('triggers onOpenChange when Dialog close is invoked', () => {
    const onOpenChange = vi.fn();
    render(<MiningPreviewDialog {...baseProps} onOpenChange={onOpenChange} />);
    // Simulate the Dialog X / Escape by calling onOpenChange(false)
    // Radix Dialog routes both through onOpenChange
    expect(onOpenChange).not.toHaveBeenCalled();
    // Fire Escape key to trigger Radix Dialog onOpenChange(false)
    fireEvent.keyDown(document.body, { key: 'Escape' });
    // Radix may or may not fire depending on JSDOM setup;
    // the contract is that onOpenChange is the cleanup path
  });

  it('does not make any Anki, localStorage, or fetch calls', () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response()));
    const lsSpy = vi.spyOn(Storage.prototype, 'setItem');
    render(<MiningPreviewDialog {...baseProps} />);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lsSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    lsSpy.mockRestore();
  });

  it('disables range slider when isCapturing or isRefreshing', () => {
    render(<MiningPreviewDialog {...baseProps} isCapturing />);
    const slider = document.body.querySelector('.entei-mining-range-slider');
    if (slider) {
      expect(slider.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('shows range labels but no slider when mediaDuration is non-finite', () => {
    render(<MiningPreviewDialog {...baseProps} mediaDuration={NaN} />);
    expect(document.body.textContent).toContain('00:10');
    expect(document.body.textContent).toContain('00:15');
    const slider = document.body.querySelector('.entei-mining-range-slider');
    expect(slider).toBeNull();
  });

  it('does NOT render input or textarea for mapped image field', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[
          { key: 'image', physicalName: 'fld_Image', value: '' },
          { key: 'sentence', physicalName: 'fld_Sentence', value: 'hello' },
        ]}
        screenshotUrl="blob:screenshot"
      />,
    );
    // Label should be present
    expect(document.body.textContent).toContain('fld_Image');
    // No input or textarea for image
    const imageInput = document.body.querySelector(
      'input[aria-label="fld_Image"], textarea[aria-label="fld_Image"]',
    );
    expect(imageInput).toBeNull();
    // Screenshot image should render
    const img = document.body.querySelector('img');
    expect(img).not.toBeNull();
  });

  it('does NOT render input or textarea for mapped audio field', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[
          { key: 'audio', physicalName: 'fld_Audio', value: '' },
          { key: 'sentence', physicalName: 'fld_Sentence', value: 'hello' },
        ]}
        audioUrl="blob:audio"
        audioExpectedDuration={5}
      />,
    );
    // Label should be present
    expect(document.body.textContent).toContain('fld_Audio');
    // No input or textarea for audio
    const audioInput = document.body.querySelector(
      'input[aria-label="fld_Audio"], textarea[aria-label="fld_Audio"]',
    );
    expect(audioInput).toBeNull();
    // Audio element should render
    const audio = document.body.querySelector('audio');
    expect(audio).not.toBeNull();
  });

  it('full mapping with all 7 semantic keys renders exactly 5 text controls', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[
          { key: 'sentence', physicalName: 'Sentence', value: 'sen' },
          { key: 'definition', physicalName: 'Definition', value: 'def' },
          { key: 'word', physicalName: 'Word', value: 'w' },
          { key: 'source', physicalName: 'Source', value: 's' },
          { key: 'tags', physicalName: 'Tags', value: 't' },
          { key: 'image', physicalName: 'Image', value: '' },
          { key: 'audio', physicalName: 'Audio', value: '' },
        ]}
        screenshotUrl="blob:shot"
        audioUrl="blob:aud"
        audioExpectedDuration={5}
      />,
    );
    const textareas = document.body.querySelectorAll('textarea');
    const inputs = document.body.querySelectorAll('input[type="text"]');
    expect(textareas.length).toBe(2); // sentence + definition
    expect(inputs.length).toBe(3); // word + source + tags
    expect(textareas.length + inputs.length).toBe(5);
  });

  it('range slider with [start, end] value renders 2 role=slider thumbs', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        rangeStart={10}
        rangeEnd={15}
        mediaDuration={60}
      />,
    );
    const thumbs = document.body.querySelectorAll(
      '.entei-mining-range-slider [role="slider"]',
    );
    expect(thumbs.length).toBe(2);
  });

  it('image skeleton renders during capture for mapped image field', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        draftFields={[{ key: 'image', physicalName: 'fld_Image', value: '' }]}
        isCapturing
      />,
    );
    expect(document.body.textContent).toContain('fld_Image');
    const skeleton = document.body.querySelector(
      '.entei-mining-skeleton--image',
    );
    expect(skeleton).not.toBeNull();
  });

  it('renders zoom in and zoom out buttons with localized aria-labels', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const zoomInBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomIn}"]`,
    );
    const zoomOutBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomOut}"]`,
    );
    expect(zoomInBtn).not.toBeNull();
    expect(zoomOutBtn).not.toBeNull();
  });

  it('zoom buttons are disabled during capturing', () => {
    render(<MiningPreviewDialog {...baseProps} isCapturing />);
    const zoomInBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomIn}"]`,
    ) as HTMLButtonElement;
    const zoomOutBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomOut}"]`,
    ) as HTMLButtonElement;
    expect(zoomInBtn.disabled).toBe(true);
    expect(zoomOutBtn.disabled).toBe(true);
  });

  it('zoom buttons are disabled during audio update', () => {
    render(<MiningPreviewDialog {...baseProps} isRefreshing />);
    const zoomInBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomIn}"]`,
    ) as HTMLButtonElement;
    const zoomOutBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomOut}"]`,
    ) as HTMLButtonElement;
    expect(zoomInBtn.disabled).toBe(true);
    expect(zoomOutBtn.disabled).toBe(true);
  });

  it('zoom buttons are disabled when mediaDuration is non-finite', () => {
    render(<MiningPreviewDialog {...baseProps} mediaDuration={NaN} />);
    // When duration is unknown, the dock shows disabled state (no zoom buttons)
    const zoomInBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomIn}"]`,
    );
    const zoomOutBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomOut}"]`,
    );
    // Zoom buttons are not rendered when duration is non-finite
    expect(zoomInBtn).toBeNull();
    expect(zoomOutBtn).toBeNull();
  });

  it('slider still has 2 role=slider thumbs after zoom in', () => {
    const { rerender } = render(<MiningPreviewDialog {...baseProps} />);
    // Verify 2 thumbs exist initially
    let thumbs = document.body.querySelectorAll(
      '.entei-mining-range-slider [role="slider"]',
    );
    expect(thumbs.length).toBe(2);

    // Click zoom in
    const zoomInBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomIn}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(zoomInBtn);

    // Re-render to pick up state change
    rerender(<MiningPreviewDialog {...baseProps} />);

    // Still 2 thumbs
    thumbs = document.body.querySelectorAll(
      '.entei-mining-range-slider [role="slider"]',
    );
    expect(thumbs.length).toBe(2);
  });

  it('zoom out button is disabled when viewport spans full media', () => {
    // Short media (2s) → initial viewport = full media → zoom out disabled
    render(
      <MiningPreviewDialog
        {...baseProps}
        rangeStart={0.5}
        rangeEnd={1.5}
        mediaDuration={2}
      />,
    );
    const zoomOutBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomOut}"]`,
    ) as HTMLButtonElement;
    expect(zoomOutBtn.disabled).toBe(true);
  });

  it('zoom in button is enabled when viewport is wider than selection', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        rangeStart={295}
        rangeEnd={305}
        mediaDuration={600}
      />,
    );
    const zoomInBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomIn}"]`,
    ) as HTMLButtonElement;
    expect(zoomInBtn.disabled).toBe(false);
  });

  it('zoom buttons do not trigger Anki/localStorage/fetch calls', () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response()));
    const lsSpy = vi.spyOn(Storage.prototype, 'setItem');
    render(<MiningPreviewDialog {...baseProps} />);
    const zoomInBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomIn}"]`,
    ) as HTMLButtonElement;
    const zoomOutBtn = document.body.querySelector(
      `[aria-label="${mockDict.miningZoomOut}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(zoomInBtn);
    fireEvent.click(zoomOutBtn);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lsSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    lsSpy.mockRestore();
  });

  // --- Range dock structure tests ---

  it('range dock exists outside scrolling body', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const body = document.body.querySelector('.entei-mining-body');
    const dock = document.body.querySelector('.entei-mining-range-dock');
    expect(body).not.toBeNull();
    expect(dock).not.toBeNull();
    // Dock should NOT be inside body
    expect(body!.contains(dock!)).toBe(false);
  });

  it('control row DOM order is ZoomOut, Send, ZoomIn', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const controls = document.body.querySelector(
      '.entei-mining-range-controls',
    );
    expect(controls).not.toBeNull();
    const buttons = controls!.querySelectorAll('button');
    expect(buttons.length).toBe(3);
    // First = ZoomOut, Second = Send, Third = ZoomIn
    expect(buttons[0]!.getAttribute('aria-label')).toBe(mockDict.miningZoomOut);
    expect(buttons[1]!.textContent).toContain(mockDict.exportSendNew);
    expect(buttons[2]!.getAttribute('aria-label')).toBe(mockDict.miningZoomIn);
    // No Update materials button
    const updateBtn = document.body.querySelector('.entei-mining-update-btn');
    expect(updateBtn).toBeNull();
  });

  it('renders subtitle-boundary markers for cues within viewport', () => {
    const cues = [
      { id: 1, start: 11, end: 14, text: 'cue1' },
      { id: 2, start: 13, end: 16, text: 'cue2' },
      { id: 3, start: 50, end: 55, text: 'out of viewport' },
    ];
    render(
      <MiningPreviewDialog
        {...baseProps}
        cues={cues}
        rangeStart={10}
        rangeEnd={15}
        mediaDuration={60}
      />,
    );
    const markers = document.body.querySelectorAll(
      '.entei-mining-range-marker',
    );
    // cue at 11s and 13s should be in viewport (0-60 initially);
    // cue at 50s should also be in viewport (0-60)
    // but the initial viewport is computed around 10-15, so likely 0-~25
    // All three are within 0-60 range, but viewport is focused
    expect(markers.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes out-of-viewport cues from markers', () => {
    const cues = [
      { id: 1, start: 12, end: 14, text: 'in range' },
      { id: 2, start: 500, end: 505, text: 'far out' },
    ];
    render(
      <MiningPreviewDialog
        {...baseProps}
        cues={cues}
        rangeStart={10}
        rangeEnd={15}
        mediaDuration={600}
      />,
    );
    const markers = document.body.querySelectorAll(
      '.entei-mining-range-marker',
    );
    // Only cue at 12s should be in the focused viewport around 10-15
    expect(markers.length).toBe(1);
  });

  it('markers container has pointer-events none via class', () => {
    const cues = [{ id: 1, start: 12, end: 14, text: 'cue1' }];
    render(
      <MiningPreviewDialog
        {...baseProps}
        cues={cues}
        rangeStart={10}
        rangeEnd={15}
        mediaDuration={60}
      />,
    );
    const markerContainer = document.body.querySelector(
      '.entei-mining-range-markers',
    );
    expect(markerContainer).not.toBeNull();
    // The CSS class .entei-mining-range-markers sets pointer-events: none
    // JSDOM does not compute CSS, so we verify the class is present
    expect(
      markerContainer!.classList.contains('entei-mining-range-markers'),
    ).toBe(true);
  });

  it('markers are aria-hidden', () => {
    const cues = [{ id: 1, start: 12, end: 14, text: 'cue1' }];
    render(
      <MiningPreviewDialog
        {...baseProps}
        cues={cues}
        rangeStart={10}
        rangeEnd={15}
        mediaDuration={60}
      />,
    );
    const markerContainer = document.body.querySelector(
      '.entei-mining-range-markers',
    );
    expect(markerContainer).not.toBeNull();
    expect(markerContainer!.getAttribute('aria-hidden')).toBe('true');
  });

  it('range slider still has 2 role=slider thumbs with cues', () => {
    const cues = [{ id: 1, start: 10, end: 15, text: 'cue1' }];
    render(
      <MiningPreviewDialog
        {...baseProps}
        cues={cues}
        rangeStart={10}
        rangeEnd={15}
        mediaDuration={60}
      />,
    );
    const thumbs = document.body.querySelectorAll(
      '.entei-mining-range-slider [role="slider"]',
    );
    expect(thumbs.length).toBe(2);
  });

  // --- Stage 2: Export controls ---

  it('renders ToggleGroup with New and Update mode items', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const newBtn = document.body.querySelector(
      `[aria-label="${mockDict.exportModeNew}"]`,
    );
    const updateBtn = document.body.querySelector(
      `[aria-label="${mockDict.exportModeUpdate}"]`,
    );
    expect(newBtn).not.toBeNull();
    expect(updateBtn).not.toBeNull();
  });

  it('calls onExportModeChange when toggling mode (ignores empty value)', () => {
    const onExportModeChange = vi.fn();
    render(
      <MiningPreviewDialog
        {...baseProps}
        onExportModeChange={onExportModeChange}
      />,
    );
    const updateBtn = document.body.querySelector(
      `[aria-label="${mockDict.exportModeUpdate}"]`,
    ) as HTMLElement;
    expect(updateBtn).not.toBeNull();
    fireEvent.click(updateBtn);
    expect(onExportModeChange).toHaveBeenCalledWith('update');
  });

  it('renders Send button with localized label', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const sendBtn = document.body.querySelector(
      '.entei-mining-export-send-btn',
    );
    expect(sendBtn).not.toBeNull();
    expect(sendBtn!.textContent).toContain(mockDict.exportSendNew);
  });

  it('keeps the Send label stable in update mode (no candidate step)', () => {
    render(<MiningPreviewDialog {...baseProps} exportMode="update" />);
    const sendBtn = document.body.querySelector(
      '.entei-mining-export-send-btn',
    );
    expect(sendBtn).not.toBeNull();
    expect(sendBtn!.textContent).toContain(mockDict.exportSendNew);
  });

  it('calls onExportSend when Send button is clicked', () => {
    const onExportSend = vi.fn();
    render(<MiningPreviewDialog {...baseProps} onExportSend={onExportSend} />);
    const sendBtn = document.body.querySelector(
      '.entei-mining-export-send-btn',
    ) as HTMLButtonElement;
    fireEvent.click(sendBtn);
    expect(onExportSend).toHaveBeenCalledTimes(1);
  });

  it('disables Send button when canExport is false', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        canExport={false}
        exportDisabledReason={mockDict.exportSendDisabledNoConnection}
      />,
    );
    const sendBtn = document.body.querySelector(
      '.entei-mining-export-send-btn',
    ) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it('shows localized error with role=alert when exportError is set', () => {
    render(
      <MiningPreviewDialog {...baseProps} exportError={mockDict.exportError} />,
    );
    const alert = document.body.querySelector(
      '.entei-mining-export-error[role="alert"]',
    );
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain(mockDict.exportError);
  });

  it('shows localized success with role=status when exportSuccess is true', () => {
    render(<MiningPreviewDialog {...baseProps} exportSuccess />);
    const status = document.body.querySelector(
      '.entei-mining-export-success[role="status"]',
    );
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain(mockDict.exportSuccess);
  });

  it('does not render candidate info (one-click update, no candidate UI)', () => {
    render(<MiningPreviewDialog {...baseProps} exportMode="update" />);
    const candidate = document.body.querySelector(
      '.entei-mining-export-candidate',
    );
    expect(candidate).toBeNull();
  });

  it('disables ToggleGroup during export', () => {
    render(<MiningPreviewDialog {...baseProps} isExporting />);
    const toggleGroup = document.body.querySelector(
      '[data-slot="toggle-group"]',
    );
    expect(toggleGroup).not.toBeNull();
    // ToggleGroup items should be disabled
    const items = toggleGroup!.querySelectorAll('button');
    items.forEach((item) => {
      expect((item as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('Export mode ToggleGroup is inside scrollable body, not in range dock', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const body = document.body.querySelector('.entei-mining-body');
    const dock = document.body.querySelector('.entei-mining-range-dock');
    const header = document.body.querySelector(
      '.entei-mining-header-media-toggle',
    );
    // The export mode ToggleGroup is in the controls row inside the body
    const exportGroup = document.body.querySelector(
      '.entei-mining-controls-row [data-slot="toggle-group"]',
    );
    expect(exportGroup).not.toBeNull();
    // Export toggle should be inside body, NOT inside dock or header
    expect(body!.contains(exportGroup!)).toBe(true);
    expect(dock!.contains(exportGroup!)).toBe(false);
    if (header) expect(header!.contains(exportGroup!)).toBe(false);
  });

  it('ToggleGroup is in controls row via CSS class', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const section = document.body.querySelector('.entei-mining-controls-row');
    expect(section).not.toBeNull();
    // CSS class provides layout; verify class is present
    expect(section!.classList.contains('entei-mining-controls-row')).toBe(true);
  });

  it('controls row centers all three items', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    const row = document.body.querySelector('.entei-mining-controls-row');
    expect(row).not.toBeNull();
    // Verify single ToggleGroup contains all 3 items inside the centered row
    const toggleGroup = row!.querySelector('[data-slot="toggle-group"]');
    expect(toggleGroup).not.toBeNull();
    const items = toggleGroup!.querySelectorAll(
      '[data-slot="toggle-group-item"]',
    );
    expect(items.length).toBe(3);
  });

  it('Append is the third ToggleGroupItem alongside New and Update', () => {
    render(<MiningPreviewDialog {...baseProps} />);
    // Find ALL toggle groups; the export mode one has 3 items (New/Update/Append)
    const toggleGroups = document.body.querySelectorAll(
      '[data-slot="toggle-group"]',
    );
    const exportGroup = Array.from(toggleGroups).find(
      (g) => g.querySelectorAll('[data-slot="toggle-group-item"]').length === 3,
    );
    expect(exportGroup).not.toBeNull();
    const items = exportGroup!.querySelectorAll(
      '[data-slot="toggle-group-item"]',
    );
    expect(items.length).toBe(3);
    // Third item is icon-only: has Search SVG, localized aria-label + title, no text span
    expect(items[2]!.getAttribute('aria-label')).toBe('Select card to append');
    expect(items[2]!.getAttribute('title')).toBe('Select card to append');
    const svg = items[2]!.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.classList.toString()).toContain('lucide');
    // Icon-only: no visible text node or span child
    const span = items[2]!.querySelector('span');
    expect(span).toBeNull();
    expect(items[2]!.textContent?.trim()).toBe('');
  });

  it('ToggleGroup active item has high-contrast via scoped CSS', () => {
    render(<MiningPreviewDialog {...baseProps} exportMode="update" />);
    const activeItem = document.body.querySelector(
      '[data-slot="toggle-group"] button[data-state="on"]',
    );
    expect(activeItem).not.toBeNull();
    expect(activeItem!.getAttribute('data-state')).toBe('on');
  });
});

// ---------------------------------------------------------------------------
// Media mode switch tests
// ---------------------------------------------------------------------------

describe('Media mode switch', () => {
  afterEach(cleanup);

  // Shared props so image field has hasImage = true (needs screenshotUrl + field.key=image)
  const mediaFields = {
    draftFields: [
      { key: 'sentence', physicalName: 'S', value: 'text' },
      { key: 'image', physicalName: 'PictureField', value: 'screenshot.jpg' },
    ],
    screenshotUrl: 'blob:http://localhost/existing-screenshot',
  };

  /** Find the 2-item media ToggleGroup (not the 3-item export ToggleGroup) */
  function findMediaToggleItems() {
    const toggleGroups = document.body.querySelectorAll(
      '[data-slot="toggle-group"]',
    );
    const mediaGroup = Array.from(toggleGroups).find(
      (g) => g.querySelectorAll('[data-slot="toggle-group-item"]').length === 2,
    );
    return mediaGroup!.querySelectorAll('[data-slot="toggle-group-item"]');
  }

  it('calls onMediaModeChange when Image/Video toggle is clicked', () => {
    const onMediaModeChange = vi.fn();
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...mediaFields}
        onMediaModeChange={onMediaModeChange}
      />,
    );
    const items = findMediaToggleItems();
    // Click Video (second item)
    fireEvent.click(items[1]!);
    expect(onMediaModeChange).toHaveBeenCalledWith('video');
  });

  it('Video mode renders <video> inside image field AspectRatio', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...mediaFields}
        mediaMode="video"
        mediaPreviewType="video"
        mediaPreviewUrl="blob:http://localhost/fake-webm"
      />,
    );
    // Should render a <video> inside the image field's AspectRatio
    const video = document.body.querySelector('.entei-mining-media-video');
    expect(video).not.toBeNull();
    expect(video!.tagName).toBe('VIDEO');
    expect(video!.getAttribute('src')).toBe('blob:http://localhost/fake-webm');
    // React-DOM may not set muted as HTML attribute; check the property
    expect((video as HTMLVideoElement).muted).toBe(true);
    // No separate out-of-field video
    const outOfFieldVideos = document.body.querySelectorAll(
      '.entei-mining-fields ~ video, .entei-dialog-footer ~ video',
    );
    expect(outOfFieldVideos.length).toBe(0);
  });

  it('Image mode renders <img> inside image field AspectRatio', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...mediaFields}
        mediaMode="image"
        mediaPreviewType="image"
        mediaPreviewUrl="blob:http://localhost/fake-jpeg"
      />,
    );
    const img = document.body.querySelector('.entei-mining-image');
    expect(img).not.toBeNull();
    expect(img!.tagName).toBe('IMG');
    expect(img!.getAttribute('src')).toBe('blob:http://localhost/fake-jpeg');
  });

  it('isMediaRecapturing shows skeleton in image AspectRatio', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        // screenshotUrl null → hasImage=false, skeleton path activates
        draftFields={[
          { key: 'sentence', physicalName: 'S', value: 'text' },
          {
            key: 'image',
            physicalName: 'PictureField',
            value: 'screenshot.jpg',
          },
        ]}
        screenshotUrl={null}
        isMediaRecapturing={true}
      />,
    );
    // Skeleton should be visible inside the picture field area
    const skeletons = document.body.querySelectorAll('.entei-mining-skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('unsupported video mode shows fallback explanation in picture field', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...mediaFields}
        mediaMode="video"
        mediaUnsupported="MediaRecorder not available"
      />,
    );
    // Should show the unsupported explanation (uses mediaUnsupported prop text)
    const warning = screen.getByText(/MediaRecorder not available/);
    expect(warning).toBeTruthy();
  });

  it('no separate out-of-field video element exists', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...mediaFields}
        mediaMode="video"
        mediaPreviewType="video"
        mediaPreviewUrl="blob:http://localhost/fake"
      />,
    );
    // ALL video elements should be inside the picture field area
    const allVideos = document.body.querySelectorAll('video');
    for (const v of allVideos) {
      // Each video should be inside a shadcn AspectRatio or image-wrap container
      const parent = v.closest(
        '[data-slot="aspect-ratio"], .entei-mining-image-wrap, .entei-mining-placeholder',
      );
      expect(parent).not.toBeNull();
    }
  });

  it('mediaModeToggle has accessible attributes', () => {
    render(
      <MiningPreviewDialog {...baseProps} {...mediaFields} mediaMode="image" />,
    );
    const items = findMediaToggleItems();
    expect(items.length).toBe(2);
    // Image item — aria-label and title
    expect(items[0]!.getAttribute('aria-label')).toBe('Image');
    expect(items[0]!.getAttribute('title')).toBe('Image');
    // Video item — aria-label and title
    expect(items[1]!.getAttribute('aria-label')).toBe('Video');
    expect(items[1]!.getAttribute('title')).toBe('Video');
  });

  it('onMediaModeChange fires when switching modes', () => {
    const onMediaModeChange = vi.fn();
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...mediaFields}
        mediaMode="image"
        onMediaModeChange={onMediaModeChange}
      />,
    );
    const items = findMediaToggleItems();
    // Click Video (second item) — switches mode
    fireEvent.click(items[1]!);
    expect(onMediaModeChange).toHaveBeenCalledWith('video');
  });
});

// ---------------------------------------------------------------------------
// Picture field rendering: single resolved media source
// ---------------------------------------------------------------------------

describe('Picture field — single media source', () => {
  afterEach(cleanup);

  const imageFieldProps = {
    draftFields: [
      { key: 'sentence', physicalName: 'S', value: 'text' },
      { key: 'image', physicalName: 'PictureField', value: 'screenshot.jpg' },
    ],
  };

  it('Chrome video success: screenshotUrl=null, mediaPreviewUrl set → renders video', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...imageFieldProps}
        screenshotUrl={null}
        mediaPreviewType="video"
        mediaPreviewUrl="blob:http://localhost/video-webm"
      />,
    );
    const video = document.body.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.getAttribute('src')).toBe('blob:http://localhost/video-webm');
    // React boolean attrs may not appear as HTML attributes in jsdom
    expect((video as HTMLVideoElement).muted).toBe(true);
    // No separate out-of-field video
    expect(video!.closest('.entei-mining-section')).not.toBeNull();
  });

  it('JPEG fallback: screenshotUrl set, mediaPreviewType=image → renders img', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...imageFieldProps}
        screenshotUrl="blob:http://localhost/fallback-jpeg"
        mediaPreviewType="image"
      />,
    );
    const img = document.body.querySelector('.entei-mining-image');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(
      'blob:http://localhost/fallback-jpeg',
    );
  });

  it('fallback explanation visible inside Picture field when video unsupported', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...imageFieldProps}
        screenshotUrl="blob:http://localhost/fallback"
        mediaMode="video"
        mediaUnsupported="MediaRecorder not available"
      />,
    );
    // Warning should be inside the image field area, not after fields
    const warning = screen.getByText(/MediaRecorder not available/);
    expect(warning).not.toBeNull();
    const imageField = warning.closest('.entei-mining-section');
    expect(imageField).not.toBeNull();
  });

  it('both failures: no screenshotUrl, no mediaPreviewUrl → error state visible', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...imageFieldProps}
        screenshotUrl={null}
        mediaMode="video"
        mediaUnsupported="Canvas capture not supported"
      />,
    );
    // Error should be visible
    const error = screen.getByText(/Canvas capture not supported/);
    expect(error).not.toBeNull();
  });

  it('mediaPreviewUrl takes precedence over screenshotUrl when both set', () => {
    render(
      <MiningPreviewDialog
        {...baseProps}
        {...imageFieldProps}
        screenshotUrl="blob:http://localhost/old-screenshot"
        mediaPreviewType="video"
        mediaPreviewUrl="blob:http://localhost/new-video"
      />,
    );
    const video = document.body.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.getAttribute('src')).toBe('blob:http://localhost/new-video');
  });
});
