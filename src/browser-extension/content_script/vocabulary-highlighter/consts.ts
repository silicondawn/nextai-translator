// CSS Custom Highlight registration name + style sheet id.
// We render via `CSS.highlights.set(HIGHLIGHT_NAME, ...)` and `::highlight()`
// pseudo styling, so there are no inserted DOM nodes at all — zero impact
// on the host page's layout, font metrics, or framework reconciliation.
export const HIGHLIGHT_NAME = 'nextai-vocab-hl'
export const STYLE_ELEMENT_ID = 'nextai-vocab-hl-styles'

// Words shorter than this are ignored — too noisy to highlight (`a`, `an`, `is`).
export const MIN_WORD_LENGTH = 3

// Bail out completely on extremely large pages to protect browser perf.
// (Twitter feeds & long PDFs render fine; this is for pathological cases.)
export const MAX_TEXT_NODES = 20000

// Idle-callback scan budget per slice.
export const SCAN_CHUNK_SIZE = 200

// MutationObserver debounce window.
export const MUTATION_DEBOUNCE_MS = 300

// Settings key in chrome.storage.local.
export const SETTINGS_KEY_ENABLED = 'vocabHighlightEnabled'

// Matches ASCII letters with optional internal apostrophes/hyphens.
// Intentionally narrow — CJK & accented chars are out of MVP scope.
export const WORD_REGEX = /[A-Za-z][A-Za-z'-]*/g

// Hover tooltip DOM ids & timings.
export const TOOLTIP_ELEMENT_ID = 'nextai-vocab-hl-tooltip'
export const TOOLTIP_STYLE_ELEMENT_ID = 'nextai-vocab-hl-tooltip-styles'
// Delay before showing on hover — long enough to ignore cursor flyovers,
// short enough that a deliberate dwell feels instant.
export const HOVER_SHOW_DELAY_MS = 150
// Grace window after the cursor leaves the highlight (or the tooltip). Long
// enough that the cursor can travel from the word into the tooltip without
// the popup vanishing mid-flight; short enough that walking away still
// dismisses snappily.
export const HOVER_HIDE_DELAY_MS = 200
// Throttle for the document-level mousemove that drives Highlight-API hit
// testing. ~32ms ≈ 30Hz: smooth enough that hover transitions feel instant
// without burning CPU on every pixel of movement.
export const MOUSEMOVE_THROTTLE_MS = 32
// Distance between the anchor word and the tooltip's nearest edge.
export const TOOLTIP_GAP_PX = 6
// Minimum gap between tooltip and the viewport edge.
export const TOOLTIP_VIEWPORT_PADDING_PX = 8
