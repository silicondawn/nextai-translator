/**
 * Suppress the `Could not find "window.__TAURI_METADATA__"` console warning
 * emitted by `@tauri-apps/api`'s top-level `appWindow` initialization.
 *
 * Background: `common/universal-fetch.ts` statically imports
 * `polyfills/tauri.ts`, which imports `@tauri-apps/plugin-http`, which
 * pulls in `@tauri-apps/api/window`. That module runs an immediate
 * `__TAURI_METADATA__ in window ? … : console.warn(…)` check at import
 * time. In a browser-extension context the check obviously fails and the
 * warning fires every content-script load.
 *
 * The warning itself says it's benign ("not an issue if running this
 * frontend on a browser instead of a Tauri window"), so we just stub the
 * metadata object before any Tauri module loads. `isTauri()` looks at a
 * different global (`window.__TAURI__`), so stubbing this one does NOT
 * make `isDesktopApp()` return true — runtime branches still take the
 * browser path.
 *
 * The constructed `appWindow` is created with `{ skip: true }`, which
 * suppresses the IPC `createWebview` call inside the WebviewWindow
 * constructor. The resulting object only carries an empty listener
 * registry, never reached by any code under our `isDesktopApp()` gates.
 *
 * Must be the first side-effect import in the content script entry so it
 * runs before the Tauri module's top-level code executes.
 */

if (typeof window !== 'undefined' && !('__TAURI_METADATA__' in window)) {
    Object.defineProperty(window, '__TAURI_METADATA__', {
        value: {
            __currentWindow: { label: 'main' },
            __windows: [{ label: 'main' }],
        },
        writable: true,
        configurable: true,
    })
}

export {}
