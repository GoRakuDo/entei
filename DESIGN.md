# Entei Design System

> Version: 1.0.0
> Last updated: 2026-08-11
> Status: Design specification only.
> Scope: Entei only. `D:\GoRakuDo\DESIGN.md` is a reference, not a runtime dependency.

---

## 0. Purpose

This document is the visual source of truth for Entei.

Entei is a local-first Japanese immersion workspace. It should feel like a quiet game hub built for long study sessions, not an article site, generic admin dashboard, or loud neon arcade.

The design must remain clear during real tasks:

- watching local and YouTube media
- reading subtitles
- mining cards
- changing playback and subtitle settings
- reviewing local immersion history
- using the interface on Android and desktop

When this document and implementation disagree, record the drift before changing code. Code migration is outside the scope of this document-only task.

---

## 1. Baseline

```text
DESIGN_VARIANCE:  5
MOTION_INTENSITY: 3
VISUAL_DENSITY:   5
```

### Rationale

- Variance 5 allows the home hub and player to feel game-like without becoming chaotic.
- Motion 3 keeps interaction feedback visible while protecting media focus and Android performance.
- Density 5 supports settings, subtitles, and mining tools without turning the interface into a cramped cockpit.

---

## 2. Design Direction

### 2.1 Identity

Entei is a dark, immersive learning base.

- Tone: focused, calm, technical, slightly playful
- Aesthetic: midnight surfaces, royal purple accents, restrained gold status details
- Shape language: rounded cards, pill navigation, compact icon controls
- Visual metaphor: a game menu for choosing and using study tools
- Priority: the current learning task always wins over decoration

### 2.2 Core Principles

1. Content first
   - Video, subtitles, mining material, and learning history are the main content.
   - Chrome must not compete with media.

2. Local-first confidence
   - The interface should feel dependable and private.
   - Avoid cloud-dashboard styling and unnecessary account language.

3. Quiet hierarchy
   - Use surface lightness, spacing, type weight, and placement before using borders or shadows.

4. Progressive disclosure
   - Advanced settings stay inside dialogs and tabs.
   - The primary screen should expose only the controls needed for the current task.

5. Consistency over novelty
   - Reuse existing Entei tokens, shadcn primitives, Lucide icons, and established component patterns.

6. Android remains first-class
   - Effects must remain light.
   - Avoid rendering choices that increase GPU or memory pressure without clear user value.

7. Accessibility is structural
   - Native semantics, keyboard access, focus visibility, reflow, reduced motion, and 44px touch targets are mandatory.

---

## 3. Color System

### 3.1 Absolute Color Rules

- Pure black is forbidden.
- Pure white is forbidden.
- Alpha-transparent neutral black and white are permitted only for structural shadows, borders, and overlays where no semantic token provides the required neutral effect.
- HEX, RGB, RGBA, HSL, HSLA, and named colors are forbidden in shipping Entei source.
- Colors must use existing semantic tokens or OKLCH values.
- New raw OKLCH values require a semantic role. Do not add a color only because it looks attractive in one component.
- Broad white surfaces are forbidden.
- Neon outer glows and rainbow gradients are forbidden.
- Neutral transparent borders may use OKLCH alpha values.

### 3.1.1 Background Texture

- `public/brand/entei-background.webp` is the shared page background, applied
  to `body` in `global.css` (Home, Player, Tracker, and every other page).
- `--entei-bg` remains the fallback color while the image is not yet loaded
  or fails to load.
- Foreground surfaces (dialogs, cards, media, controls) keep their existing
  colors so readability on top of the texture is maintained.
- Do not add further decorative background images or background animation;
  the installed tile is the only background asset.
- When replacing the texture, verify the new image stays dark / low contrast
  so text and surfaces remain legible.

### 3.2 Implemented Palette

The current implemented palette lives in `apps/web/src/styles/tokens.css`.

| Token | Value | Role |
|---|---|---|
| `--entei-white-base` | `oklch(95% 0.005 285deg)` | strongest text and emphasis, never a large filled surface |
| `--entei-black-950` | `oklch(5% 0.005 270deg)` | page background |
| `--entei-surface` | `oklch(17.8% 0.058 275.81deg)` | standard panels, dialogs, navigation |
| `--entei-surface-2` | `oklch(30.96% 0.15 271.29deg)` | selected and elevated surfaces |
| `--entei-purple-500` | `oklch(68% 0.21 273.85deg)` | primary accent, focus, active states |
| `--entei-purple-400` | `oklch(76% 0.22 273.85deg)` | accent hover |
| `--entei-gold-base` | `oklch(85% 0.15 85deg)` | rare status and system emphasis |
| `--entei-muted` | `oklch(85.99% 0.071 282.16deg)` | secondary text |
| `--entei-text-global-muted` | `oklch(70% 0.01 270deg)` | supplementary text |

### 3.3 Semantic Roles

```css
--entei-bg: var(--entei-black-950);
--entei-text: var(--entei-white-base);
--entei-text-secondary: var(--entei-muted);
--entei-text-muted: var(--entei-text-global-muted);
--entei-accent: var(--entei-purple-500);
--entei-accent-hover: var(--entei-purple-400);
--entei-status-locked: var(--entei-gold-base);
--entei-focus-ring: var(--entei-purple-500);
```

### 3.4 Color Usage

- Fill only the strongest action with an accent surface.
- Secondary actions stay neutral or outlined.
- Accent purple means interaction, selection, or focus. Do not use it as unrelated decoration.
- Gold means rare, locked, special, or system-level status. It must not compete with the main action.
- Muted text must remain readable. Do not lower opacity until labels look disabled.
- Use color with text or an icon for state communication.
- Borders should communicate structure, focus, selection, or containment. Do not brighten borders on hover unless that border change conveys state.
- Elevation comes primarily from tonal surface separation. Shadows are secondary.

### 3.5 Contrast Verification

- Body text must meet WCAG 2.2 AA at 4.5:1 or better.
- Large text and UI boundaries must meet 3:1 or better.
- Focus indicators must meet 3:1 against all adjacent colors they cross.
- Token lightness differences are not proof of contrast. Measure rendered foreground and background pairs.
- Verify normal, hover, active, selected, disabled, forced-colors, and high-contrast states.

---

## 4. Typography

### 4.1 Font Roles

| Role | Font | Usage |
|---|---|---|
| Body and UI | Gen Interface JP | paragraphs, controls, tabs, forms, subtitles |
| Display | Gen Interface JP Display | major headings and destination titles |
| System and game accent | Pixelify Sans | Entei wordmark, short labels, status, settings title |
| Serif accent | Noto Serif JP | fixed Japanese hub identity only |

All fonts are self-hosted through project packages. Remote font requests are forbidden.

### 4.2 Typography Rules

- Use no more than the four established font roles.
- Pixelify Sans is for short labels and compact identity text. Do not use it for paragraphs or dense settings copy.
- Noto Serif JP is not a general heading font. It remains an identity accent.
- Body copy starts near 16px with a unitless line-height near 1.5 to 1.6.
- UI labels may use 14px. Captions may use 13px. Avoid text below 12px.
- Inputs must remain at least 16px on mobile to prevent iOS zoom.
- Weight below 400 is forbidden for UI text below 18px.
- Headings use `text-wrap: balance` when short.
- Descriptions use `text-wrap: pretty`.
- Long text uses a measure near 60 to 75 characters.
- Dynamic numbers such as timestamps and counters use tabular numerals.
- Store copy in natural case. Use CSS for uppercase presentation.
- Preserve text selection except on a proven drag or gesture surface.

### 4.3 Hierarchy

1. Page or dialog title
2. Tab or section title
3. Control label
4. Helper or status text

Each level must differ through at least two signals such as size, weight, spacing, color, or placement. Do not create hierarchy from low contrast alone.

---

## 5. Spacing System

### 5.1 Token Scale

Entei uses the implemented token scale.

```css
--entei-space-2: 2px;
--entei-space-4: 4px;
--entei-space-8: 8px;
--entei-space-12: 12px;
--entei-space-16: 16px;
--entei-space-24: 24px;
--entei-space-32: 32px;
--entei-space-48: 48px;
--entei-space-64: 64px;
--entei-space-96: 96px;
--entei-space-128: 128px;
```

Do not reference an undefined spacing token. Undefined custom properties invalidate the complete declaration.

### 5.2 Layout Tokens

```css
--entei-gutter: clamp(1rem, 4vw, 1.5rem);
--entei-touch-min: 44px;
--entei-content-max: 72rem;
--entei-topbar-height: 64px;
--entei-z-skip-link: 1000;
--entei-z-topbar: 100;
--entei-z-content: 1;
```

`tokens.css` remains the complete source for implemented values. This document explains their intended roles.

### 5.3 Spacing Rules

- Use token values only.
- Inside a group, start with 8px or 12px.
- Between related groups, use at least twice the internal gap.
- Major dialog and card padding starts at 24px on desktop.
- Mobile containers normally start at 16px inline padding.
- Compact desktop controls may use 4px vertical padding only when a 44px minimum height controls the final hit area.
- General desktop buttons and fields should start near 8px vertical and 16px horizontal padding.
- Horizontal and vertical padding do not need to be equal. They must create optical balance around the actual icon and text.
- Icon-only buttons use a fixed square hit area. Do not create their shape from asymmetric padding.
- Full-width actions remain inside content margins.
- Use logical properties such as `padding-inline` and `margin-inline-start` when direction matters.

### 5.4 Grouping

- Use space first, background surfaces second, separators last.
- Do not add a border between every settings group.
- If space alone communicates the section boundary, remove the separator.
- Align labels, inputs, preview surfaces, and actions to shared edges.
- Keep primary actions reachable without placing them at a clip-prone bottom edge.

---

## 6. Radius, Borders, and Elevation

### 6.1 Radius Tokens

| Token | Value | Usage |
|---|---|---|
| `--entei-radius-sm` | 4px | compact badges and inner details |
| `--entei-radius-md` | 8px | inputs and compact controls |
| `--entei-radius-lg` | 12px | dialogs and larger controls |
| `--entei-radius-card` | 20px | cards and major surfaces |
| `--entei-radius-pill` | 999px | navigation pills, chips, status pills |

### 6.2 Radius Rules

- Nested surfaces must use concentric radii.
- Outer radius should approximately equal inner radius plus the visible padding.
- Major container and inner control must not use identical radii when they sit closely together.
- Pill radius is reserved for navigation, tags, status, and genuinely pill-shaped controls.
- Icon-only circular buttons require equal width and height plus pill radius.

### 6.3 Borders

- Borders exist for structure or state.
- A decorative border must remain subtle.
- Follow the border-hover rule in section 3.4.
- Focus rings are separate from borders and must remain visible.
- Repeated separators are discouraged when spacing already defines grouping.

### 6.4 Elevation

- Base page uses `--entei-bg`.
- Standard surface uses `--entei-surface`.
- Selected or elevated surface may use `--entei-surface-2`.
- Use small layered OKLCH shadows only for floating chrome, dialogs, and overlays.
- Heavy glossy shadows and untinted gray shadows are forbidden.
- Backdrop blur is limited to fixed or sticky chrome and overlays. Do not use it on scrolling content panes.

---

## 7. Layout and Responsive Rules

### 7.1 Layout Principles

- Mobile-first structure.
- Breakpoints respond to content failure, while current implementation begins its tablet and desktop navigation at 768px.
- Use `100dvh` rather than `100vh` for viewport-bound layouts.
- Prevent horizontal scrolling at supported widths.
- Use safe-area tokens for mobile chrome.
- Maintain DOM order when visual layouts change.
- Do not use fixed dimensions on text containers that need localization growth.
- Use `min-height` instead of fixed height when text may wrap.

### 7.2 Supported Verification Widths

Minimum visual checks:

- 320 by 568
- 360 by 800
- 390 by 844
- 768 by 1024
- 1024 by 768
- 1280 by 800
- 1440 by 900
- short mobile landscape near 955 by 400

### 7.3 Desktop Navigation

- Desktop Home and Tracker use a centered pill that scrolls with normal document flow.
- Desktop Player keeps the pill hidden until top-edge pointer dwell or keyboard focus.
- Pointer dwell is 750ms.
- Keyboard focus reveals the pill immediately.
- The current destination uses `aria-current="page"`.
- Navigation links keep a 44px minimum hit area.
- Settings is an icon-only desktop control with an accessible name and title.
- The settings control uses an exact square hit area before pill radius is applied.
- Language selection stays outside the centered pill and aligns to the viewport trailing edge.
- Do not add a full-width black desktop navigation band.

### 7.4 Mobile Navigation

- Home and Tracker retain the compact TopBar and language selector.
- Player omits the mobile TopBar.
- The bottom dock order is Home, Tracker, Settings.
- The dock respects bottom safe-area inset.
- Short-height Player landscape and fullscreen hide the dock and other non-media chrome.
- Mobile navigation labels remain visible. Do not convert the whole dock to unlabeled icons.

### 7.5 Dialogs and Panels

- Mobile settings dialogs may use the full viewport.
- Desktop settings dialogs use bounded width and height with internal scrolling.
- Dialog header, tabs, scrollable panel, and actions remain distinct regions.
- Desktop header padding uses 16px block and 24px inline as the current baseline.
- Reserve trailing space for the close control without collapsing title padding.
- Long panels scroll internally. Critical actions remain reachable.
- Preview content should appear before fine-grained controls when it helps users understand adjustments.

---

## 8. Component Patterns

### 8.1 Buttons

- Native button semantics for actions.
- Minimum hit area is 44px on touch surfaces and at least 40px on dense desktop surfaces.
- Primary action uses the strongest fill.
- Secondary action uses a neutral or accent outline.
- Ghost action stays transparent until hover.
- Active press may use `scale(0.96)` when it matches the existing interaction language.
- Hover feedback uses color or surface change. Do not combine several strong changes at once.
- Follow the border-hover rule in section 3.4.
- Disabled state remains readable and does not rely only on reduced opacity.
- Full-width reset or destructive actions must be visibly separate from content and keep clear wording.

### 8.2 Icon-Only Buttons

- Use Lucide icons already established by the project.
- Use one SVG with `currentColor` for all states.
- Decorative SVG is `aria-hidden="true"`.
- The button receives a descriptive `aria-label`.
- Width and height must be equal before circular radius is applied.
- Default icon size is near 18px inside a 44px target unless the surrounding density establishes another verified size.
- Adjust optical alignment when the icon looks off-center despite geometric centering.

### 8.3 Navigation Pills

- Navigation pill is a grouped route surface, not a generic button row.
- Use a shared vertical center and consistent 44px item height.
- Brand may use Pixelify Sans at stronger weight.
- Route links use Gen Interface JP.
- Current, hover, focus, and idle states must remain visually distinct.
- The outer pill uses `--entei-radius-pill`.
- Inner route backgrounds may also become pill-shaped on hover or selection when spacing remains concentric.

### 8.4 Cards and Destination Tiles

- Cards must represent a real content or action group.
- Avoid card nesting.
- Primary and unavailable destinations need different semantics, not only different colors.
- Use tonal surfaces, border strength, and content hierarchy together.
- Locked content keeps readable text and explicit status.
- Cards do not need equal heights when content differs.

### 8.5 Forms and Settings

- Every control has a visible label.
- Labels and controls share a clear alignment edge.
- Helper text follows the related field.
- Inputs use semantic types and support paste.
- Settings sections use spacing before separator lines.
- Tabs use the Radix or shadcn pattern already present.
- Subtitle preview appears before detailed appearance controls.
- Reset actions use clear separation and full-width presentation where established.

### 8.6 Toasts

- Use the existing Sonner integration.
- Toasts use Entei surface tokens, Pixelify-compatible short text, Lucide icons, and centered icon-text grouping where established.
- Error toast uses an error icon and structural emphasis without turning the entire toast into a red slab.
- Repeated identical errors should not stack endlessly.
- Important actions and errors must remain long enough to read or dismiss.

### 8.7 Media and Subtitle UI

- Media stays visually dominant.
- Loading overlays remain visible until usable media or the first rendered video frame appears.
- Overlays must not block essential playback controls.
- Subtitle text remains readable across media luminance changes.
- Subtitle settings show a live preview before the adjustment controls.
- Temporary parsing warnings must not consume large permanent screen areas when the malformed cue can be safely skipped.

---

## 9. Icons and Assets

- Use Lucide Astro or Lucide React from the installed project packages.
- Do not mix icon libraries on the same surface.
- Hand-written SVG is allowed only for a unique brand asset that Lucide cannot represent.
- Emoji is not a primary interface icon.
- Outline icons are the default.
- Fill may indicate an active state.
- Icon color follows `currentColor`.
- Match icon stroke weight to adjacent text weight.
- Raster assets require explicit dimensions to prevent layout shift.
- Remote stock images and remote icon URLs are forbidden.

---

## 10. Motion and Interaction

### 10.1 Implemented Tokens

```css
--entei-duration-fast: 150ms;
--entei-duration-normal: 200ms;
--entei-duration-entrance: 400ms;
--entei-entrance-stagger: 80ms;
--entei-ease-productive: cubic-bezier(0.2, 0, 0.38, 0.9);
--entei-ease-expressive: cubic-bezier(0.4, 0.14, 0.3, 1);
```

### 10.2 Motion Rules

- Never use `transition: all`.
- Transition only color, background-color, border-color, opacity, transform, or filter when needed.
- Avoid layout animation through top, left, width, or height.
- High-frequency interactions use instant feedback or transitions no longer than 150ms.
- Dialog and panel transitions should finish near 200ms to 350ms.
- Entrance animation happens once and remains restrained.
- Exit motion is quieter than entrance motion.
- Routine hover does not use custom keyframe animation.
- Use `will-change` only after measuring a real first-frame problem.
- `prefers-reduced-motion` must remove nonessential translation, scale, smooth scrolling, and repeated animation.
- Motion is never the sole state indicator.

---

## 11. Accessibility Baseline

- Target WCAG 2.2 AA.
- Use native buttons, links, inputs, and landmarks first.
- Every icon-only control has an accessible name.
- Decorative icons remain hidden from assistive technology.
- Use `:focus-visible`. Never remove focus without an equivalent replacement.
- Dialogs trap focus and restore it to the trigger.
- Escape closes overlays where expected.
- Tabs, menus, selects, and sliders follow their standard keyboard patterns.
- Do not use positive tabindex.
- Do not rely on color alone.
- Reflow must work at 320px equivalent width and 400 percent zoom.
- Pinch zoom must remain enabled.
- Interactive controls remain at least 24px by WCAG baseline and normally 44px in Entei.
- Forced-colors and high-contrast modes must keep focus, current route, and selected states visible.
- Reduced motion is respected.
- Dynamic status uses an appropriate stable live region.

---

## 12. Localization and Content Growth

- Supported interface languages are Indonesian, Japanese, and English.
- One typed dictionary defines the complete key set.
- Do not compose translated sentences from fragments.
- Do not shrink one language to make it fit a fixed container.
- Buttons and tabs may wrap only when the component contract allows it.
- Critical labels must not truncate without access to the full value.
- Use logical CSS properties for direction-sensitive spacing and positioning.
- Natural DOM order remains the reading and keyboard order.
- Test representative long Indonesian and English strings alongside Japanese.

---

## 13. Performance and Android Rules

- Home stays static-first.
- React islands are used only where interaction requires them.
- Avoid new animation libraries for isolated effects.
- Avoid backdrop blur on scrolling containers.
- Avoid persistent canvas, WebGL, particles, and decorative video.
- Media loading and subtitle indexing must not block the main thread.
- Large lists use bounded scrolling or virtualization when measured need appears.
- Images use modern formats and explicit dimensions.
- Third-party scripts require a product-level reason and privacy review.
- Test CPU, memory, GPU, and interaction latency on Android before approving heavy visual effects.

---

## 14. Forbidden Patterns

- Pure black or pure white
- Non-OKLCH color notation in shipping source
- Undefined design tokens
- Remote fonts
- Generic stock imagery
- Emoji as primary controls
- Neon outer glow
- Rainbow gradient
- Heavy glassmorphism
- Nested cards without a structural reason
- Separator lines where spacing already groups content
- `transition: all`
- Linear animation for product interaction
- Continuous decorative animation
- Fixed text containers that break localization
- Positive tabindex
- Hidden focus rings
- Hover-only information
- Color-only status
- Fake disabled buttons that remain interactive
- Input text below 16px on mobile
- `100vh` for mobile viewport shells
- Blocked browser zoom
- Desktop changes copied blindly into mobile rules

---

## 15. Verification Matrix

### Visual

- Check all supported viewport sizes.
- Check Indonesian, Japanese, and English.
- Check idle, hover, focus, active, selected, disabled, loading, empty, and error states.
- Check nested radii and shared alignment edges.
- Check spacing in grayscale to ensure hierarchy does not depend only on color.

### Accessibility

- Keyboard-only completion of every primary flow
- Accessible names for icon controls
- Dialog focus trap and restoration
- 200 percent zoom
- 400 percent reflow
- Reduced motion
- Forced colors
- Screen-reader reading order
- Contrast measurements for rendered pairs

### Performance

- Android mobile verification
- Desktop Chromium verification
- No horizontal overflow
- No meaningful layout shift after font load
- No sustained decorative GPU load
- No scroll-container blur performance regression

### Code Quality

- Use existing tokens and component primitives.
- Keep mirrored CSS rules synchronized until the mirror is removed by a separate refactor.
- Run unit tests, Astro check, production build, and `git diff --check` after implementation changes.
- Run independent code review before commit and push.

---

## 16. Implementation Boundary

This document defines the intended Entei design language. It does not claim the current code already conforms everywhere.

Future design migration should follow this order:

1. Audit current implementation against this document.
2. Record concrete drift by file and selector.
3. Fix one visual system at a time.
4. Verify mobile and desktop separately.
5. Review accessibility and performance impact.
6. Update this document only when the design decision changes, not merely when code catches up.

No code adjustment is included in the creation of this document.
---

## Appendix A. Canonical Files

| File | Role |
|---|---|
| `DESIGN.md` | Entei design rules and intended direction |
| `apps/web/src/styles/tokens.css` | implemented token values |
| `apps/web/src/styles/fonts.css` | implemented local font imports |
| `docs/PHASE0.md` | home foundation and early product decisions |
| `docs/NAVIGATION_BAR.md` | navigation behavior and accessibility contract |
| `apps/web/src/styles/player.css` | Player-specific visual implementation |
| `apps/web/src/styles/eizouden-settings.css` | shared settings presentation |

---

## Appendix B. Decision Precedence

When design sources disagree, resolve them in this order:

1. Latest explicit user decision
2. Entei `DESIGN.md`
3. Feature-specific Entei documentation
4. Implemented Entei tokens
5. Existing nearby Entei component patterns
6. `D:\GoRakuDo\DESIGN.md` as external reference only

Implementation does not silently override a documented decision. Documented intent does not silently claim implementation parity.
