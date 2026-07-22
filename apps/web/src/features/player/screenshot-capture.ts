/**
 * Screenshot Capture — AM-2 browser utility for video frame → JPEG Blob.
 * ---------------------------------------------------------------------------
 * Typed, testable, and canvas-injectable for JSDOM environments.
 * Fixed policy: MAX_CAPTURE_DIMENSION = 1920, JPEG_QUALITY = 0.9.
 * Never upscales; preserves aspect ratio.
 * --------------------------------------------------------------------------- */

export const MAX_CAPTURE_DIMENSION = 1920;
export const JPEG_QUALITY = 0.9;
export const JPEG_MIME_TYPE = 'image/jpeg';

export type ScreenshotErrorCode =
  | 'ZERO_DIMENSIONS'
  | 'CANVAS_CREATE_FAILED'
  | 'CONTEXT_NULL'
  | 'DRAW_IMAGE_FAILED'
  | 'BLOB_NULL'
  | 'BLOB_ENCODE_FAILED';

export interface ScreenshotError {
  code: ScreenshotErrorCode;
  message: string;
}

export type ScreenshotResult =
  { ok: true; blob: Blob } | { ok: false; error: ScreenshotError };

/** Dependency bag for testability. JSDOM lacks real canvas backing. */
export interface CanvasFactory {
  createCanvas(width: number, height: number): HTMLCanvasElement;
}

const defaultCanvasFactory: CanvasFactory = {
  createCanvas(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
};

/**
 * Compute output dimensions that respect MAX_CAPTURE_DIMENSION while
 * preserving aspect ratio and never upscaling.
 */
export function computeCaptureDimensions(
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const maxDim = Math.max(sourceWidth, sourceHeight);
  if (maxDim <= MAX_CAPTURE_DIMENSION) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const scale = MAX_CAPTURE_DIMENSION / maxDim;
  return {
    width: Math.round(sourceWidth * scale),
    height: Math.round(sourceHeight * scale),
  };
}

/**
 * Capture the current frame of a video element as a JPEG Blob.
 *
 * @param video - The HTMLVideoElement to capture from.
 * @param factory - Optional canvas factory for testing (JSDOM).
 * @returns Promise resolving to a ScreenshotResult.
 */
export function captureVideoFrame(
  video: HTMLVideoElement,
  factory: CanvasFactory = defaultCanvasFactory,
): Promise<ScreenshotResult> {
  return new Promise((resolve) => {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;

    if (sourceWidth === 0 || sourceHeight === 0) {
      resolve({
        ok: false,
        error: {
          code: 'ZERO_DIMENSIONS',
          message: 'Video metadata is not ready (zero dimensions).',
        },
      });
      return;
    }

    const { width, height } = computeCaptureDimensions(
      sourceWidth,
      sourceHeight,
    );

    let canvas: HTMLCanvasElement;
    try {
      canvas = factory.createCanvas(width, height);
    } catch (e) {
      resolve({
        ok: false,
        error: {
          code: 'CANVAS_CREATE_FAILED',
          message:
            e instanceof Error ? e.message : 'Failed to create canvas element.',
        },
      });
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      resolve({
        ok: false,
        error: {
          code: 'CONTEXT_NULL',
          message: 'Could not obtain 2D rendering context from canvas.',
        },
      });
      return;
    }

    try {
      ctx.drawImage(video, 0, 0, width, height);
    } catch (e) {
      resolve({
        ok: false,
        error: {
          code: 'DRAW_IMAGE_FAILED',
          message:
            e instanceof Error ? e.message : 'drawImage threw an exception.',
        },
      });
      return;
    }

    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve({
              ok: false,
              error: {
                code: 'BLOB_NULL',
                message: 'canvas.toBlob returned null.',
              },
            });
            return;
          }
          resolve({ ok: true, blob });
        },
        JPEG_MIME_TYPE,
        JPEG_QUALITY,
      );
    } catch (e) {
      resolve({
        ok: false,
        error: {
          code: 'BLOB_ENCODE_FAILED',
          message:
            e instanceof Error
              ? e.message
              : 'canvas.toBlob threw an exception.',
        },
      });
    }
  });
}
