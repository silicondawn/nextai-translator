// CSS class & data attributes used by the vocabulary highlighter.
// Kept centralised so styles/queries stay in sync if names change.
export const HIGHLIGHT_CLASS = 'nextai-vocab-hl'
export const STYLE_ELEMENT_ID = 'nextai-vocab-hl-styles'
export const DATA_ATTR_ORIGINAL = 'data-nextai-vocab'

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
