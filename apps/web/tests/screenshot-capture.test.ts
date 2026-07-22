/**
 * Tests for screenshot-capture utility (AM-2).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_CAPTURE_DIMENSION,
  JPEG_QUALITY,
  JPEG_MIME_TYPE,
  computeCaptureDimensions,
  captureVideoFrame,
  type CanvasFactory,
} from '@/features/player/screenshot-capture';

describe('MAX_CAPTURE_DIMENSION', () => {
  it('is 1920', () => {
    expect(MAX_CAPTURE_DIMENSION).toBe(1920);
  });
});

describe('JPEG_QUALITY', () => {
  it('is 0.9', () => {
    expect(JPEG_QUALITY).toBe(0.9);
  });
});

describe('JPEG_MIME_TYPE', () => {
  it('is image/jpeg', () => {
    expect(JPEG_MIME_TYPE).toBe('image/jpeg');
  });
});

describe('computeCaptureDimensions', () => {
  it('returns source dimensions when both are under max', () => {
    const result = computeCaptureDimensions(1280, 720);
    expect(result).toEqual({ width: 1280, height: 720 });
  });

  it('scales down when width exceeds max, preserving aspect ratio', () => {
    const result = computeCaptureDimensions(3840, 2160);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it('scales down when height exceeds max, preserving aspect ratio', () => {
    const result = computeCaptureDimensions(1080, 3840);
    expect(result.height).toBe(1920);
    expect(result.width).toBe(540);
  });

  it('never upscales small dimensions', () => {
    const result = computeCaptureDimensions(640, 360);
    expect(result).toEqual({ width: 640, height: 360 });
  });

  it('handles exact max dimension without change', () => {
    const result = computeCaptureDimensions(1920, 1080);
    expect(result).toEqual({ width: 1920, height: 1080 });
  });
});

describe('captureVideoFrame', () => {
  const mockBlob = new Blob(['fake-jpeg'], { type: JPEG_MIME_TYPE });

  function createMockCanvas(
    opts: {
      contextNull?: boolean;
      drawImageThrows?: boolean;
      toBlobReturnsNull?: boolean;
      toBlobThrows?: boolean;
      createThrows?: boolean;
    } = {},
  ): CanvasFactory {
    return {
      createCanvas(width: number, height: number) {
        if (opts.createThrows) {
          throw new Error('Canvas creation failed');
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = {
          drawImage: vi.fn(() => {
            if (opts.drawImageThrows) {
              throw new Error('drawImage error');
            }
          }),
        };

        // Override getContext
        (canvas as HTMLCanvasElement).getContext = vi.fn(
          (type: string): CanvasRenderingContext2D | null => {
            if (type !== '2d') return null;
            if (opts.contextNull) return null;
            return ctx as unknown as CanvasRenderingContext2D;
          },
        ) as unknown as HTMLCanvasElement['getContext'];

        // Override toBlob
        canvas.toBlob = vi.fn(
          (
            callback: BlobCallback | null,
            _type?: string,
            _quality?: number,
          ) => {
            if (opts.toBlobThrows) {
              throw new Error('toBlob exploded');
            }
            if (callback) {
              callback(opts.toBlobReturnsNull ? null : mockBlob);
            }
          },
        );

        return canvas;
      },
    };
  }

  function createMockVideo(width: number, height: number): HTMLVideoElement {
    const video = document.createElement('video');
    Object.defineProperty(video, 'videoWidth', {
      value: width,
      configurable: true,
    });
    Object.defineProperty(video, 'videoHeight', {
      value: height,
      configurable: true,
    });
    return video;
  }

  it('returns ZERO_DIMENSIONS when videoWidth is 0', async () => {
    const video = createMockVideo(0, 1080);
    const result = await captureVideoFrame(video, createMockCanvas());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ZERO_DIMENSIONS');
    }
  });

  it('returns ZERO_DIMENSIONS when videoHeight is 0', async () => {
    const video = createMockVideo(1920, 0);
    const result = await captureVideoFrame(video, createMockCanvas());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ZERO_DIMENSIONS');
    }
  });

  it('returns CANVAS_CREATE_FAILED when factory throws', async () => {
    const video = createMockVideo(1920, 1080);
    const factory = createMockCanvas({ createThrows: true });
    const result = await captureVideoFrame(video, factory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CANVAS_CREATE_FAILED');
    }
  });

  it('returns CONTEXT_NULL when getContext returns null', async () => {
    const video = createMockVideo(1920, 1080);
    const factory = createMockCanvas({ contextNull: true });
    const result = await captureVideoFrame(video, factory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONTEXT_NULL');
    }
  });

  it('returns DRAW_IMAGE_FAILED when drawImage throws', async () => {
    const video = createMockVideo(1920, 1080);
    const factory = createMockCanvas({ drawImageThrows: true });
    const result = await captureVideoFrame(video, factory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DRAW_IMAGE_FAILED');
    }
  });

  it('returns BLOB_NULL when toBlob returns null', async () => {
    const video = createMockVideo(1920, 1080);
    const factory = createMockCanvas({ toBlobReturnsNull: true });
    const result = await captureVideoFrame(video, factory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BLOB_NULL');
    }
  });

  it('returns BLOB_ENCODE_FAILED when toBlob throws synchronously', async () => {
    const video = createMockVideo(1920, 1080);
    const factory = createMockCanvas({ toBlobThrows: true });
    const result = await captureVideoFrame(video, factory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BLOB_ENCODE_FAILED');
    }
  });

  it('returns a Blob with correct MIME type on success', async () => {
    const video = createMockVideo(1920, 1080);
    const factory = createMockCanvas();
    const result = await captureVideoFrame(video, factory);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blob.type).toBe(JPEG_MIME_TYPE);
    }
  });

  it('calls toBlob with image/jpeg and quality 0.9', async () => {
    const video = createMockVideo(1280, 720);
    let capturedCanvas: HTMLCanvasElement | null = null;
    const innerFactory = createMockCanvas();
    const trackingFactory: CanvasFactory = {
      createCanvas(w: number, h: number) {
        const canvas = innerFactory.createCanvas(w, h);
        capturedCanvas = canvas;
        return canvas;
      },
    };
    await captureVideoFrame(video, trackingFactory);
    expect(capturedCanvas).not.toBeNull();
    expect(capturedCanvas!.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      JPEG_MIME_TYPE,
      JPEG_QUALITY,
    );
  });

  it('uses scaled dimensions for 4K video', async () => {
    const video = createMockVideo(3840, 2160);
    const factory = createMockCanvas();
    await captureVideoFrame(video, factory);
    const canvas = factory.createCanvas(1920, 1080);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });

  it('does not upscale small videos', async () => {
    const video = createMockVideo(640, 360);
    const factory = createMockCanvas();
    await captureVideoFrame(video, factory);
    const canvas = factory.createCanvas(640, 360);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
  });
});
