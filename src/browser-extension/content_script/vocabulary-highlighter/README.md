# Vocabulary Highlighter

Highlight words from the user's vocabulary book directly on every web page, like a
yellow highlighter pen. Reuses the translator extension's existing vocabulary store —
zero new permissions, zero new schema.

## Status: MVP

This is a scaffold. It works end-to-end (loads vocab → builds stem index → walks DOM →
wraps matches in `<span>`), but the UX layer (hover tooltip, click-to-translate, in-page
add/remove flow) is intentionally not wired up. The point of v0 is to validate the
visual effect and surface any perf cliffs.

## Module layout

```
vocabulary-highlighter/
├── index.ts          // bootstrap + teardown — the only public surface
├── stemmer.ts        // Porter Stemmer (1980), pure functions, no deps
├── vocabStore.ts     // pulls vocab via @/common/services/vocabulary, builds stem index
├── scanner.ts        // TreeWalker + idle-callback scheduler + MutationObserver
├── highlighter.ts    // span wrapping + style injection
├── consts.ts         // class names, regex, tunables
└── __tests__/
    └── stemmer.spec.ts
```

## How it plugs in

One line in `src/browser-extension/content_script/index.tsx` at the bottom of `main()`:

```ts
import { bootstrapVocabularyHighlighter } from './vocabulary-highlighter'

// ...inside main(), after the existing hotkey binding:
bootstrapVocabularyHighlighter()
```

That's it. Failures are swallowed and `console.warn`-ed — a broken highlight pass will
never interfere with the existing selection-translation flow.

## Why span-wrapping (and not the CSS Custom Highlight API)

The CSS Custom Highlight API (`CSS.highlights.set('...', new Highlight())`) is
beautiful: zero DOM mutation, native rendering speed, immune to React/Vue diffs. The
catch is hover interaction — you have to derive the hovered word from
`document.caretPositionFromPoint()` on every `mousemove`, which complicates the
eventual tooltip wiring.

For MVP we picked the boring path (span wrap). It's slightly more invasive but:

- highlights survive copy-paste as plain text
- hover handlers attach directly to the span
- works on every Chrome version, every site, no exceptions

When the tooltip UX is solid, swapping `highlighter.ts` for a Highlight-API renderer
is a contained change. The rest of the module doesn't care.

## Why Porter Stemmer (and not a proper lemmatizer)

If the user saves `run`, we want to highlight `running`, `runs`, `ran` too. Two
options:

| Approach | Size | Quality | Notes |
|---|---|---|---|
| Porter Stemmer (this module) | ~3KB inline | ~90% | `studies → studi`, but both sides stem to the same key, so equivalence is preserved |
| `compromise` / `wink-lemmatizer` | 100–300KB | ~98% | True lemmas; better for ESL UX |
| LLM generates inflections at save time | 0 client cost | Best | Requires API call when collecting a word; needs schema field |

We start with Porter. The upgrade path is to populate
`VocabularyItem.description` (or a new `inflections: string[]`) at save time via the
already-running LLM call, then have `vocabStore.ts` merge those into the index.

### Known Porter (1980) gaps

The bundled stemmer is the original Porter algorithm — fast, small, but with a
documented blind spot around `-ily` adverbs. Notably **`happy` and `happily` do
not collapse to the same stem**. The test suite asserts these gaps explicitly so
they don't drift silently. Fix path: Porter2/Snowball (~6KB), wink-lemmatizer
(~150KB), or LLM-generated inflections at save time.

## Performance

- Initial scan: chunked through `requestIdleCallback` with a 4ms-remaining budget per
  slice, 200 nodes per chunk, hard cap at 20k text nodes.
- Mutation observer: childList+subtree, debounced 300ms. Sites like Twitter that emit
  hundreds of mutations per scroll coalesce into one incremental pass.
- A clean-page rescan only happens on bootstrap. Adding a word mid-session does NOT
  trigger a rescan in v0 — that needs a vocab-changed event channel (see roadmap).

## What's NOT in MVP

- [ ] **Hover tooltip** — clicking/hovering a highlighted span should open the
      existing translator popup pointed at that word. Stub: span has
      `data-nextai-vocab` attribute carrying the original surface form.
- [ ] **Reactive refresh on vocab changes** — currently you must reload the page
      after adding a word. Fix: broadcast from background when `vocabularyService.putItem`
      / `deleteItem` is called; content script does an incremental rescan.
- [ ] **Settings UI** — gated on `chrome.storage.local.vocabHighlightEnabled` (default
      true). Needs a toggle in the options page.
- [ ] **Per-site allow/block list**.
- [ ] **Color customisation**.
- [ ] **iframe support** — currently top-frame only.

## Trying it out

After `pnpm dev-chromium`, the highlighter runs automatically on every page provided
your vocabulary book has at least one word. To force-disable from devtools:

```js
chrome.storage.local.set({ vocabHighlightEnabled: false })
```

## Testing

```bash
pnpm test -- vocabulary-highlighter
```

The stemmer is the only piece with deterministic unit tests; DOM/observer behaviour
is better verified via the Playwright e2e suite (TODO).
