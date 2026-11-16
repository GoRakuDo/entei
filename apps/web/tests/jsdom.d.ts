/**
 * `jsdom` — the minimum this suite needs from it.
 * ---------------------------------------------------------------------------
 * The package (a devDependency) ships no declarations, so a test that builds its
 * OWN window — which `bun test`'s `environment = "jsdom"` cannot do, since it
 * hands every file the same reused window — has nothing to type against.
 *
 * Only the two members a document-building test touches are declared: the
 * constructor options and the window it returns. Anything wider would be a
 * hand-written copy of the library's API, which is exactly the kind of drift a
 * declaration file should not carry.
 */

declare module 'jsdom' {
  export interface JSDOMOptions {
    /** `dangerously` is what runs the document's own `<script>` blocks. */
    runScripts?: 'outside-only' | 'dangerously';
    /** Runs before the document is parsed — the seam a host window is faked in. */
    beforeParse?: (window: Window & typeof globalThis) => void;
    url?: string;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}