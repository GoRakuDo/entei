# Entei

Entei is an open-source, static, and local-first media player designed for Japanese language learning. It is built with **Astro + React** for GitHub Pages / [entei.gorakudo.org](https://entei.gorakudo.org) (deployment is currently pending; the site is not yet live).

Entei has **no server-side application backend**. Everything runs entirely inside your web browser.

---

## How It Works

Entei runs local media files and subtitles in your web browser. Your user data, media captures, and learning settings stay completely local on your machine.

_Note: While your data stays on your machine, Entei is not strictly offline-only. The optional WebTorrent feature connects to external WebRTC peers, which involves standard network communication._

For details on the project phases, see the [PLAYER_PHASES.md](./docs/PLAYER_PHASES.md) design document.

---

## Features

Here is what is currently implemented in Entei:

### 1. Local Media & Custom Playback Controls

- **Media Formats:** Plays local video and audio formats supported natively by your browser.
- **Custom Control Bar:** Custom HTML5 controls including play/pause, timeline seek, volume/mute slider, and fullscreen.
- **Layout Controls:** Resizable split panels to adjust the video and subtitle sidebar sizes on desktop.

### 2. Subtitles & Overlay

- **Formats:** Parses SRT, VTT, and ASS subtitles. Dialogue timing and plain selectable text are extracted using `ass-compiler`, while ASS override/visual styling tags are stripped.
- **Yomitan Integration:** Renders text-selectable subtitle lines directly on top of the media, allowing you to scan words using browser extensions like Yomitan.
- **Subtitle Sidebar:** A scrollable list of all subtitle cues for quick reference and navigation. Clicking any line seeks the video to that exact timestamp.
- **Style Preferences:** A subtitle settings panel where you can adjust font size (16–48px), text color, background color, background opacity (0–100%), padding (0–32px), and vertical offset (0–200px) with instant live preview.

### 3. Playback Modes for Learning

Entei includes smart playback modes to speed up your learning:

- **Normal:** Plays the media at your selected speed.
- **Condensed:** Automatically skips silent gaps between subtitles that are longer than 1000 milliseconds.
- **Fast-Forward:** Plays at 1x speed during subtitle lines (plus a 600ms boundary), and speeds up to 3x during silent gaps.

### 4. Local Mining & Anki Export

You can capture material from your media and export it to your flashcards:

- **Pickaxe Mine Button:** Clicking the mine button pauses playback and captures the current subtitle range.
- **Mining Preview:** A dialog that lets you adjust the start/end times (with 0.1-second precision) and automatically updates the media artifacts.
- **Browser-Native Capture:** Generates JPEG screenshots, silent WebM video clips (automatically selecting VP8/VP9/AV1 based on browser support, with a 45-second limit), and Opus audio clips on the fly.
- **AnkiConnect Export:** Exports cards directly to your local desktop Anki app (communicating via loopback on port 8765). Supports creating new notes, updating the last added card, or appending scenes to existing cards via an inline search table.
- **DenChou Note Type Support:** If you select the `DenChou` note type, Entei automatically wraps the sentence and source fields in `<span class="group">...</span>` tags to keep layouts clean and prevent double-spacing.

For more details on mining and Anki integration, check out the [ANKI_MINER.md](./docs/ANKI_MINER.md) and [VIDEO_CLIP.md](./docs/VIDEO_CLIP.md) specs.

### 5. WebTorrent Streaming (Optional)

- **P2P Playback:** Stream video and audio directly in the browser by pasting a magnet URI.
- **Connection Gate:** Requires at least one active WebRTC peer to start. Entei uses a 30-second peer search timer before falling back.

Read more in the [WEBTORRENT_STREAMING.md](./docs/WEBTORRENT_STREAMING.md) specification.

---

## Privacy & Data Safety

Entei is designed around user privacy:

- **No Server Storage:** We do not host server-side proxies, cache servers, or search indexes. Your media files are never uploaded to any remote server.
- **Local Anki Connect:** Card creation requests are sent directly to `localhost:8765` on your own machine. Your API keys are kept in session memory and are never saved to local storage, URLs, or external logs.
- **WebTorrent Network Exposure:** When streaming via WebTorrent, you join a public peer-to-peer network. This means your public IP address will be visible to WebSocket trackers and WebRTC peers.
- **No External Partnerships:** Integration with external tools or platforms like Nadeshiko is not implemented, and no partnerships exist.

---

## System Architecture

The diagram below shows how Entei isolates features locally and communicates with local or peer-to-peer systems:

```mermaid
graph TD
    subgraph Browser ["Browser (entei.gorakudo.org)"]
        Astro[Astro Shell - Static Pages]
        subgraph PlayerApp ["React Client-Only Island (/player/)"]
            UI[React UI Component]
            Controls[Custom Controls & Subtitle Appearance]
            Parser[Subtitle Parser - SRT/VTT/ASS]
            Capture[Media Capture - JPEG/Silent WebM/Opus]
            WT[WebTorrent Client - WebRTC-only]
            Prefs[Local Storage - Preferences & Panel Layouts]
        end
    end

    subgraph LocalSystem ["User's Local Machine"]
        LocalMedia[Local Media Files - MP4/MP3/etc.] -->|File Picker / Drag & Drop| UI
        LocalSubs[Local Subtitles - SRT/VTT/ASS] -->|File Picker / Drag & Drop| Parser
        Anki[Anki Desktop Application] <-->|AnkiConnect localhost:8765| UI
    end

    subgraph ExternalNetwork ["External Network"]
         WebRTCPeers[WebTorrent WebRTC Peers] <-->|Direct P2P Data Sharing - Exposes IP| WT
         Trackers[WebSocket Trackers] <-->|Peer Discovery| WT
    end

    subgraph FutureConnections ["Future Extensions (Not Connected)"]
        FC[External Subtitle/Dictionary Connectors]
    end

    UI --> Prefs
    Capture -->|User-Approved Export| Anki
    Parser -.-> FC
```

---

## Local Development

Entei is a static site built using Astro. You can run and test it locally using the following commands:

### Setup

Install all project dependencies from the repository root:

```bash
npm install
```

### Development

Start the local development server (defaults to `http://localhost:4321`):

```bash
npm run dev
```

### Production Build & Preview

Build the static website files to `apps/web/dist`:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

### Verification & Testing

Before submitting changes, run these verification checks:

```bash
# Check code formatting (Prettier)
npm run format:check

# Run TypeScript and Astro type checks
npm run check

# Run Vitest unit and integration tests
npm run test
```

You can automatically format your files with Prettier by running:

```bash
npm run format
```

---

## Project Status & Roadmap

Entei is currently in the **Testing & Refinement** phase. The core features for the local-first player, playback modes, and Anki mining (Phases 0, 1, and 2) are code-complete and awaiting final manual browser QA.

### What is Deferred or Out of Scope

- **Deferred Subtitle Formats (P1.3b / P1.4):** Support for image-based subtitles (like PGS/SUP) and platform-specific XML subtitles are deferred. PGS image cues are not text-selectable or scannable by dictionary extensions like Yomitan, so they are not prioritized.
- **Streaming-Site Integration:** Direct integration with subscription streaming sites (like Netflix or YouTube overlays) is permanently out of scope. Entei does not use browser extensions or request browser permissions to inject UI overlay elements into third-party sites.

---

## Lineage & Inspiration

Entei's local playback modes and media extraction capabilities are inspired by the standalone local-media features of [asbplayer](https://github.com/giahung2201/asbplayer) (MIT License). While Entei borrows logic patterns for precise subtitle timing and range capture, it operates independently of asbplayer, features no shared package dependencies, and implements a completely custom React and shadcn/ui interface.

---

## License

This project is licensed under the [Mozilla Public License 2.0 (MPL-2.0)](./LICENSE).
