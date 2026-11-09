/**
 * native-surface — the rectangle contract between the page and the native
 * mpv surface.
 * ---------------------------------------------------------------------------
 * libmpv paints the picture into its own child HWND that lives BEHIND the
 * WebView2 (the webview is created with `transparent: true`). Two rectangles
 * therefore have to agree, pixel for pixel:
 *
 *  - the native surface rectangle the plugin is given (`mpv_set_bounds`),
 *    in physical pixels relative to the window client area, and
 *  - the hole the wallpaper carries so the picture can come through
 *    (`--entei-native-hole`), in CSS pixels relative to the viewport.
 *
 * Both are derived from the same `getBoundingClientRect()` measurement, so
 * they cannot drift apart. The helpers stay pure so the contract is unit
 * testable without a browser.
 * ---------------------------------------------------------------------------
 */

/** A CSS-pixel rectangle, as reported by `getBoundingClientRect()`. */
export interface SurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The physical-pixel rectangle the native plugin expects. */
export interface PhysicalSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The CSS custom property that carries the wallpaper hole.
 *
 * PlayerApp writes it on `<html>`; `player.css` reads it on the wallpaper
 * layer (`clip-path`). It lives here so the writer and the reader cannot
 * disagree about the name.
 */
export const NATIVE_HOLE_PROPERTY = '--entei-native-hole';

/**
 * The outer edge of the hole path.
 *
 * The path needs an outer rectangle that covers the whole wallpaper layer;
 * it never has to match the viewport exactly, so it is generously larger
 * than any display.
 */
const HOLE_OUTER_EDGE = 99999;

/**
 * Convert a CSS-pixel media frame into the physical-pixel rectangle the
 * plugin expects.
 *
 * The DOM measures in CSS pixels, the Win32 child window in device pixels,
 * so the rectangle is scaled by the device pixel ratio. Fractional values
 * are rounded: the IPC deserializer rejects them and the surface would then
 * silently stay where it was.
 *
 * `null` means "no frame": a rectangle without area is a hide request, not
 * a position.
 */
export function toPhysicalSurfaceBounds(
  rect: SurfaceRect,
  devicePixelRatio: number,
): PhysicalSurfaceBounds | null {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return null;
  }
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(rect.left * dpr),
    y: Math.round(rect.top * dpr),
    width: Math.round(rect.width * dpr),
    height: Math.round(rect.height * dpr),
  };
}

/**
 * The rectangle the native picture really covers inside the surface.
 *
 * libmpv letterboxes the video inside the surface rectangle exactly like the
 * page's `object-fit: contain` (see the plugin's `mpv_set_bounds` contract),
 * so the wallpaper hole has to be the *letterboxed* rectangle. A hole that is
 * bigger than the picture shows the desktop through the transparent Tauri
 * window — the hole is a hole in the wallpaper, not a window into the video.
 *
 * A square-pixel file (every normal MKV) fills a 16:9 surface exactly, so the
 * frame is returned unchanged in the common case. When the media size is not
 * known yet the frame is the only safe answer.
 */
export function computeNativePictureRect(
  frame: SurfaceRect,
  mediaWidth: number | null,
  mediaHeight: number | null,
): SurfaceRect {
  if (
    !mediaWidth ||
    !mediaHeight ||
    !Number.isFinite(mediaWidth) ||
    !Number.isFinite(mediaHeight) ||
    mediaWidth <= 0 ||
    mediaHeight <= 0
  ) {
    return frame;
  }
  const scale = Math.min(frame.width / mediaWidth, frame.height / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    left: frame.left + (frame.width - width) / 2,
    top: frame.top + (frame.height - height) / 2,
    width,
    height,
  };
}

/**
 * Build the `clip-path` that punches the native picture's hole into the
 * wallpaper.
 *
 * `path(evenodd, …)` with an outer rectangle and the media frame as an
 * inner sub-path: the even-odd rule turns the inner rectangle into a hole,
 * so the wallpaper is not painted there and the native picture behind the
 * webview shows through. The outer rectangle only has to cover the
 * wallpaper layer.
 */
export function buildNativePictureHole(rect: SurfaceRect): string {
  const left = Math.round(rect.left);
  const top = Math.round(rect.top);
  const right = Math.round(rect.left + rect.width);
  const bottom = Math.round(rect.top + rect.height);
  return (
    `path(evenodd, "M0 0H${HOLE_OUTER_EDGE}V${HOLE_OUTER_EDGE}H0Z` +
    ` M${left} ${top}H${right}V${bottom}H${left}Z")`
  );
}

/**
 * One native surface update, ordered so the desktop can never show through.
 *
 * The wallpaper hole (a CSS clip-path inside the webview) and the native
 * picture (a child HWND behind it) are two different surfaces that are
 * updated by two different mechanisms: the hole is written synchronously
 * into a custom property, the picture moves through an asynchronous IPC.
 *
 * A hole that is bigger than the picture exposes the desktop through the
 * transparent Tauri window. That is exactly what happened when the right
 * panel was toggled: the hole followed the new (full-width) layout while the
 * picture was still the old, narrower one.
 *
 * The plan therefore:
 *  - moves the picture FIRST and opens the hole only after the move is
 *    confirmed, and
 *  - closes the hole before the picture shrinks, because the old (bigger)
 *    hole would outlive the old picture.
 */
export interface NativeSurfaceUpdate {
  /** The rectangle the plugin has to be given; null when it already matches. */
  movePicture: PhysicalSurfaceBounds | null;
  /** The hole to open once the picture sits in the new rectangle. */
  hole: string;
  /** True when the hole has to be closed before the picture moves. */
  closeHoleFirst: boolean;
}

/**
 * Plan the next native surface update.
 *
 * `current` is the rectangle the picture is known to be in (null when there
 * is no picture on screen), `next` the rectangle the media frame asks for and
 * `hole` the wallpaper hole that belongs to `next`.
 */
export function planNativeSurfaceUpdate(
  current: PhysicalSurfaceBounds | null,
  next: PhysicalSurfaceBounds,
  hole: string,
): NativeSurfaceUpdate {
  const same =
    current !== null &&
    current.x === next.x &&
    current.y === next.y &&
    current.width === next.width &&
    current.height === next.height;
  if (same) {
    // The picture already sits in this rectangle: the hole may follow
    // immediately, there is nothing to wait for.
    return { movePicture: null, hole, closeHoleFirst: false };
  }
  const shrinking =
    current !== null &&
    (next.width < current.width || next.height < current.height);
  return { movePicture: next, hole, closeHoleFirst: shrinking };
}
