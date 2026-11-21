/**
 * audio-controller — the speaker buttons on `/search/`, bound to play audio.
 * ---------------------------------------------------------------------------
 * WHAT THIS IS. The behaviour Yomitan's own `display-audio.js` gives its speaker
 * buttons, reduced to what the search page needs and rebuilt as a TS controller
 * over the cards the generator drew. A speaker button plays the word; a
 * right-click (or Shift+click) opens the audio-source menu — the SAME
 * `audio-button-popup-menu-template` the extension renders, styled by the SAME
 * vendored sheets — and Alt+P plays the current entry.
 *
 * WHY A CONTROLLER, NOT THE UPSTREAM CLASS. `display-audio.js` is welded to the
 * WebExtension `Display` (options events, direct-message handlers, a hotkey
 * handler, the frame-visibility lifecycle). The search page has none of that
 * plumbing — it draws cards with the generator and owns a container — so this is
 * the playback + menu half alone, reading the sources and volume the page hands
 * it. The positioning math is upstream's `PopupMenu._setPosition`, ported so the
 * menu lands where the extension puts it (clamped, honouring the button's
 * `data-menu-position`).
 *
 * THE MENU IS REAL. It instantiates upstream's own templates into a `#popup-menus`
 * container, labels each item with the source's friendly name, and closes on an
 * item, an outside press, Escape or a resize — the full behaviour, not a lookalike.
 * Choosing a source plays THAT source (and a working one is remembered as the
 * entry's primary, so a plain click replays it). Sources this client cannot
 * resolve (the scraping ones — see `audio-resolver`) still appear, but resolve to
 * the fallback click, which is the honest signal that they are configured but not
 * yet playable here.
 * ---------------------------------------------------------------------------
 */

import {
  playUrl,
  resolveAudioUrl,
} from '@/modules/yomitan/audio/audio-resolver';
import type { AudioSourceInfo } from '@/modules/yomitan/audio/audio-sources';
import { audioSourceLabel } from '@/modules/yomitan/audio/audio-sources';

/** The tooltip the speaker buttons carry, upstream's default hotkey spelled out. */
const PLAY_AUDIO_TITLE = 'Play audio (Alt + P)';

/** Sources the current speaker press resolved successfully, keyed by headword. */
interface ResolvedPrimary {
  index: number;
  url: string;
}

/** What the controller needs from the page that hosts it. */
export interface AudioControllerOptions {
  /** The configured playback sources (`audio.sources`), already shaped. */
  sources: readonly AudioSourceInfo[];
  /** Stored volume, 0–100 (Yomitan stores a percentage). */
  volume: number;
  /**
   * The `#popup-menus` container the menu is drawn into. The page provides it;
   * without it the menu has nowhere to land and is skipped.
   */
  menuContainer: HTMLElement;
}

/**
 * One speaker button's word, resolved from the card DOM.
 *
 * A card has a button on the entry (the first headword) and one per headword;
 * both are `.action-button[data-action=play-audio]`, so the word comes from the
 * CLOSEST `.headword` — the entry-level button sits outside any, and falls back to
 * the first headword on the card. The term is the headword's base text (a ruby
 * base without its `<rt>`), the reading its `.headword-reading`.
 */
interface HeadwordAudioTarget {
  term: string;
  reading: string;
  /** The card this button belongs to (`data-index`), for the entry-level lookup. */
  entryIndex: number;
  /** Buttons to update together (entry-level + this headword's). */
  buttons: HTMLButtonElement[];
}

/**
 * Bind the speaker buttons in `container` to play audio and open the source menu.
 *
 * Callers hand the container the cards were appended to; the controller finds the
 * buttons, wires the pointer + keyboard behaviour, and returns a dispose that
 * unwinds it all (the page re-binds after every redraw). Nothing here touches
 * React state: the cards are the generator's own DOM.
 */
export class YomitanAudioController {
  private readonly sources: readonly AudioSourceInfo[];
  private readonly volume: number;
  private readonly menuContainer: HTMLElement;
  private readonly container: HTMLElement;
  private readonly disposers: Array<() => void> = [];
  /** The element currently playing, stopped before the next plays. */
  private current: HTMLAudioElement | null = null;
  /** The source that worked per headword key, so a plain click replays it. */
  private readonly primary = new Map<string, ResolvedPrimary>();
  /** The user's explicit "Use as audio for Anki card" choice per headword key.
      Separate from `primary` so the playback auto-primary and the Anki
      card-audio pin stay independent (the popup keeps the same split). */
  private readonly ankiPrimary = new Map<string, number>();
  /** The one open menu, closed before another opens. */
  private openMenu: { container: HTMLElement; source: HTMLElement } | null = null;

  constructor(container: HTMLElement, options: AudioControllerOptions) {
    this.container = container;
    this.sources = options.sources;
    this.volume = options.volume;
    this.menuContainer = options.menuContainer;
  }

  /** Wire every speaker button, the Alt+P hotkey and the outside-press close. */
  bind(): void {
    const buttons = this.container.querySelectorAll<HTMLButtonElement>(
      '.action-button[data-action="play-audio"]',
    );
    for (const button of buttons) {
      button.title = PLAY_AUDIO_TITLE;
      const onClick = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          this.openAudioMenu(button);
        } else {
          void this.playFromButton(button, null);
        }
      };
      const onContextMenu = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        this.openAudioMenu(button);
      };
      button.addEventListener('click', onClick, false);
      button.addEventListener('contextmenu', onContextMenu, false);
      this.disposers.push(() => {
        button.removeEventListener('click', onClick, false);
        button.removeEventListener('contextmenu', onContextMenu, false);
      });
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyP') {
        event.preventDefault();
        void this.playCurrent();
      }
      if (event.key === 'Escape') {
        this.closeMenu();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const onPointerDown = (event: PointerEvent): void => {
      if (this.openMenu === null) return;
      const target = event.target;
      if (
        target instanceof Node &&
        this.openMenu.container.contains(target)
      ) {
        return;
      }
      this.closeMenu();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    const onResize = (): void => this.closeMenu();
    window.addEventListener('resize', onResize, false);
    this.disposers.push(() => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize, false);
    });
  }

  /** Unwind every listener this controller added. */
  dispose(): void {
    this.closeMenu();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    if (this.current !== null) {
      this.current.pause();
      this.current = null;
    }
  }

  /** Play the current entry (`.entry-current`), or the first card. Alt+P's target. */
  private async playCurrent(): Promise<void> {
    const entry =
      this.container.querySelector<HTMLElement>('.entry-current') ??
      this.container.querySelector<HTMLElement>('.entry[data-index]');
    if (entry === null) return;
    const button = entry.querySelector<HTMLButtonElement>(
      '.action-button[data-action="play-audio"]',
    );
    if (button === null) return;
    await this.playFromButton(button, null);
  }

  /**
   * Resolve the button's word and play it.
   *
   * `preferredIndex` pins a specific source (a menu choice); `null` means "the
   * source that worked before, else the first configured one". Falls back to the
   * click when nothing resolves — the honest "no audio here" signal.
   */
  private async playFromButton(
    button: HTMLButtonElement,
    preferredIndex: number | null,
  ): Promise<void> {
    const target = this.headwordTarget(button);
    if (target === null) return;
    const key = `${target.term}\u0000${target.reading}`;
    const source =
      (preferredIndex !== null ? this.sources[preferredIndex] : undefined) ??
      this.sources[this.primary.get(key)?.index ?? 0] ??
      this.sources[0];
    if (source === undefined) {
      this.markButtons(target, 'Could not find audio');
      return;
    }
    const url = await resolveAudioUrl(source, target.term, target.reading);
    if (url === null) {
      this.markButtons(target, `Could not find audio (${audioSourceLabel(source)})`);
      return;
    }
    const played = await playUrl(url, this.volume, this.current);
    if (played === null) {
      this.markButtons(target, `Could not find audio (${audioSourceLabel(source)})`);
      return;
    }
    this.current = played;
    this.primary.set(key, { index: source.index, url });
    this.markButtons(target, `From ${audioSourceLabel(source)}`);
  }

  /** The word a speaker button plays, read off the card DOM. */
  private headwordTarget(button: HTMLButtonElement): HeadwordAudioTarget | null {
    const entry = button.closest<HTMLElement>('.entry[data-index]');
    if (entry === null) return null;
    const entryIndex = Number.parseInt(entry.dataset.index ?? '', 10);
    const headword = button.closest<HTMLElement>('.headword');
    const scope = headword ?? entry.querySelector<HTMLElement>('.headword');
    if (scope === null) return null;
    const term = headwordBaseText(scope);
    const readingNode = scope.querySelector<HTMLElement>('.headword-reading');
    const reading = (readingNode?.textContent ?? '').trim();
    if (term === '') return null;
    const buttons: HTMLButtonElement[] = [button];
    const entryButton = entry.querySelector<HTMLButtonElement>(
      '.action-button[data-action="play-audio"]',
    );
    if (entryButton !== null && entryButton !== button) buttons.push(entryButton);
    return {
      term,
      reading,
      entryIndex: Number.isFinite(entryIndex) ? entryIndex : 0,
      buttons,
    };
  }

  /** Put the resolution result on every button for this word (upstream's title). */
  private markButtons(target: HeadwordAudioTarget, status: string): void {
    for (const button of target.buttons) {
      button.title = `${PLAY_AUDIO_TITLE}\n${status}`;
    }
  }

  /** Open the audio-source menu for `button`, replacing any open one. */
  private openAudioMenu(button: HTMLButtonElement): void {
    this.closeMenu();
    if (this.sources.length === 0) return;
    const template = document.getElementById('audio-button-popup-menu-template');
    const itemTemplate = document.getElementById(
      'audio-button-popup-menu-item-template',
    );
    if (
      template === null ||
      itemTemplate === null ||
      !(template instanceof HTMLTemplateElement) ||
      !(itemTemplate instanceof HTMLTemplateElement)
    ) {
      return;
    }
    const target = this.headwordTarget(button);
    const primaryKey =
      target !== null ? `${target.term}\u0000${target.reading}` : null;
    const ankiPrimaryIndex =
      primaryKey !== null ? this.ankiPrimary.get(primaryKey) : undefined;

    const menuContainer = (
      template.content.firstElementChild as HTMLElement
    ).cloneNode(true) as HTMLElement;
    const body = menuContainer.querySelector<HTMLElement>('.popup-menu-body');
    if (body === null) return;
    for (const source of this.sources) {
      const item = (
        itemTemplate.content.firstElementChild as HTMLElement
      ).cloneNode(true) as HTMLElement;
      const label = item.querySelector<HTMLElement>('.popup-menu-item-label');
      if (label !== null) label.textContent = audioSourceLabel(source);

      // "Use as audio for Anki card" button: shown alongside each source so the
      // user can pin it as the card-audio primary (upstream's setPrimaryAudio).
      const setPrimary = item.querySelector<HTMLButtonElement>(
        '.popup-menu-item-set-primary-audio-button',
      );
      if (setPrimary !== null) {
        if (ankiPrimaryIndex === source.index) {
          item.setAttribute('data-is-primary-card-audio', 'true');
        }
        setPrimary.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
          if (primaryKey !== null) {
            this.ankiPrimary.set(primaryKey, source.index);
          }
          this.closeMenu();
        }, false);
      }

      item.dataset.index = `${source.index}`;
      if (!source.clientPlayable) {
        // Configured but not client-resolvable: still listed, marked so the
        // choice is honest about what will happen.
        item.dataset.clientPlayable = 'false';
      }
      body.appendChild(item);
    }
    this.menuContainer.appendChild(menuContainer);
    this.openMenu = { container: menuContainer, source: button };
    this.positionMenu(menuContainer, button);
    for (const audioButton of body.querySelectorAll<HTMLElement>('.popup-menu-item-audio-button')) {
      audioButton.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        this.closeMenu();
        const group = audioButton.closest<HTMLElement>('.popup-menu-item-group');
        const index = Number.parseInt(group?.dataset.index ?? '', 10);
        if (Number.isFinite(index)) {
          void this.playFromButton(button, index);
        }
      }, false);
    }
    menuContainer.addEventListener('click', (event) => {
      // A press on the backdrop rather than an item: upstream closes on it.
      if (event.currentTarget !== event.target) return;
      this.closeMenu();
      event.stopPropagation();
      event.preventDefault();
    }, false);
  }

  /** Close the open menu, if any. */
  private closeMenu(): void {
    if (this.openMenu === null) return;
    const { container } = this.openMenu;
    this.openMenu = null;
    container.parentNode?.removeChild(container);
  }

  /**
   * Upstream's `PopupMenu._setPosition`, ported.
   *
   * The flags come off the BUTTON (`data-menu-position`: `left below h-cover
   * v-cover`), and the result is clamped inside the container so a menu near the
   * edge cannot hang outside it.
   */
  private positionMenu(menuContainer: HTMLElement, source: HTMLElement): void {
    const menu = menuContainer.querySelector<HTMLElement>('.popup-menu');
    const body = menuContainer.querySelector<HTMLElement>('.popup-menu-body');
    if (menu === null || body === null) return;
    let horizontal = 1;
    let vertical = 1;
    let horizontalCover = 1;
    let verticalCover = 1;
    const positionInfo = source.dataset.menuPosition;
    if (typeof positionInfo === 'string') {
      const flags = new Set(positionInfo.split(' '));
      if (flags.has('left')) horizontal = -1;
      else if (flags.has('right')) horizontal = 1;
      else if (flags.has('h-center')) horizontal = 0;
      if (flags.has('above')) vertical = -1;
      else if (flags.has('below')) vertical = 1;
      else if (flags.has('v-center')) vertical = 0;
      if (flags.has('cover')) { horizontalCover = 1; verticalCover = 1; }
      else if (flags.has('no-cover')) { horizontalCover = -1; verticalCover = -1; }
      if (flags.has('h-cover')) horizontalCover = 1;
      else if (flags.has('no-h-cover')) horizontalCover = -1;
      if (flags.has('v-cover')) verticalCover = 1;
      else if (flags.has('no-v-cover')) verticalCover = -1;
    }
    const containerRect = this.menuContainer.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = menuRect.top;
    let bottom = menuRect.bottom;
    if (verticalCover === 1) {
      const bodyRect = body.getBoundingClientRect();
      top = bodyRect.top;
      bottom = bodyRect.bottom;
    }
    let x =
      sourceRect.left +
      sourceRect.width * ((-horizontal * horizontalCover + 1) * 0.5) +
      menuRect.width * ((-horizontal + 1) * -0.5);
    let y =
      sourceRect.top +
      (menuRect.top - top) +
      sourceRect.height * ((-vertical * verticalCover + 1) * 0.5) +
      (bottom - top) * ((-vertical + 1) * -0.5);
    x = Math.max(0, Math.min(containerRect.width - menuRect.width, x));
    y = Math.max(0, Math.min(containerRect.height - menuRect.height, y));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }
}

/**
 * A headword's base term: its text with the furigana `<rt>` readings removed.
 *
 * `.headword-term` carries the kanji with `<rt>` readings over it; the term is the
 * ruby BASE text only (the readings live in `<rt>` and in `.headword-reading`).
 */
function headwordBaseText(headword: HTMLElement): string {
  const termNode = headword.querySelector<HTMLElement>('.headword-term');
  if (termNode === null) return '';
  const clone = termNode.cloneNode(true) as HTMLElement;
  for (const rt of clone.querySelectorAll('rt')) rt.remove();
  return (clone.textContent ?? '').trim();
}
