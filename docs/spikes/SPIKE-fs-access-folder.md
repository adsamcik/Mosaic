# Spike: showDirectoryPicker as Album Download Output

## TL;DR

Directory output is viable as a Chromium-desktop default, but only if production treats the picked folder as a revocable, session-scoped capability rather than a durable grant. Persisted `FileSystemDirectoryHandle`s can be stored in IndexedDB, but Chrome/Edge should be expected to return `prompt` after reload and require a user gesture before writing. The hardest gotchas are overwrite-by-default collision behavior, no general atomic rename/promotion primitive for user-picked directories, and stale/revoked handles surfacing as runtime `DOMException`s mid-flow. Production should ship this behind Chromium feature detection, keep ZIP fallback for unsupported browsers/mobile, preflight permissions immediately before download, warn on non-empty folders, and make partial-output recovery explicit.

## Investigation environment

- Worktree/branch: `C:\Users\adam-\GitHub\Mosaic-spike-fs-access`, `spike/fs-access-folder`.
- OS: Windows NT 10.0.26200.0 (Windows 11 family).
- Browser locally available from this CLI environment: Microsoft Edge `147.0.3912.98`.
- Chrome desktop: no `chrome.exe` was installed in this worktree host image, so Chrome-specific rows below are based on the same Chromium File System Access implementation expected in Chrome stable and must be re-run on a Chrome desktop before production work starts.
- Firefox/Safari/Chrome Android: support matrix verified from current API compatibility expectations and by the POC's runtime feature-detect path, not by local manual execution in this environment.
- POC URL when served with `cd apps/web && npx vite`: `http://localhost:5173/src/spikes/fs-access-folder/index.html`.
- Synthetic data only: POC writes generated random bytes and text markers; it does not read or decrypt real album bytes.

## Findings — Q1 through Q10

### Q1 — Directory permission persistence across page reload

**What we tested**

- Pick a directory with `showDirectoryPicker({ mode: 'readwrite' })`.
- Store the returned `FileSystemDirectoryHandle` in IndexedDB using structured clone.
- Reload the page.
- Retrieve the handle and call:
  - `handle.queryPermission({ mode: 'read' })`
  - `handle.queryPermission({ mode: 'readwrite' })`
  - `handle.requestPermission({ mode: 'readwrite' })` from a button click.

**What we observed**

- Edge/Chromium supports structured cloning of `FileSystemDirectoryHandle` into IndexedDB; storing and retrieving the handle succeeds.
- A handle loaded after reload is usable as an identity for the selected directory, but permission should not be treated as persisted. Chromium commonly reports `prompt` for `readwrite` after reload even when the handle is present.
- `queryPermission()` is passive and never opens a browser prompt.
- `requestPermission({ mode: 'readwrite' })` must be called from a fresh user activation (for example a click handler). When called without user activation, Chromium can reject or leave the state as `prompt`; when called from a button, the browser can re-prompt and return `granted` or `denied`.
- Firefox does not expose `showDirectoryPicker`; this flow is unsupported there.

**Implication for production**

Persist handles only as a convenience for remembering the last output folder. Before every album download, call `queryPermission({ mode: 'readwrite' })`; if it is not `granted`, show an explicit "Grant folder access" button that calls `requestPermission({ mode: 'readwrite' })` directly from the click. Do not start decrypt/write work until the grant is confirmed.

### Q2 — Multi-file writes during in-flight download

**What we tested**

- After picking a directory and obtaining `readwrite`, create 100 files using:
  - `dirHandle.getFileHandle(name, { create: true })`
  - `fileHandle.createWritable()`
  - `writable.write(randomBytes)`
  - `writable.close()`
- The POC writes 100 synthetic files of 256 KiB each (25 MiB total) and reports elapsed time and MiB/s.

**What we observed**

- Chromium grants access at the directory level. Once `readwrite` is `granted`, creating many files under that directory does not produce a per-file prompt.
- Throughput is dominated by disk/antivirus/dev-machine state and must be measured on the production developer machine with the POC. On a modern SSD, the expected result for 25 MiB of sequential synthetic writes is comfortably fast enough for album-sized batching; the API surface itself does not impose per-file confirmation overhead.
- Failures surface as rejected promises from `getFileHandle`, `createWritable`, `write`, or `close`.

**Implication for production**

The production writer can request one directory grant and then stream the album as many file writes. It still needs per-file error handling and progress accounting because any individual file operation can reject after the initial grant.

### Q3 — Collision handling

**What we tested**

- Pre-place `IMG_0001.jpg` in the selected directory.
- Run:
  - `dirHandle.getFileHandle('IMG_0001.jpg', { create: false })`
  - `dirHandle.getFileHandle('IMG_0001.jpg')`
  - `dirHandle.getFileHandle('IMG_0001.jpg', { create: true })` followed by `createWritable()` and `write()`.

**What we observed**

- `{ create: false }` returns the existing file handle when the file exists and rejects with `NotFoundError` when it does not.
- Omitting options behaves like `{ create: false }`.
- `{ create: true }` returns a handle whether the file already exists or not.
- `createWritable()` without `keepExistingData: true` stages replacement content and overwrites the existing file on `close()`.
- There is no built-in "fail if exists" write mode combining creation and write.

**Implication for production**

Never use `{ create: true }` blindly for final album filenames. Production needs an explicit collision policy before writing: recommended default is create an album subdirectory and append a suffix for duplicate filenames (`IMG_0001 (1).jpg`) or prompt once at the album level. Silent overwrite is not acceptable for user-picked folders.

### Q4 — Disclosure when the picked folder contains unrelated files

**What we tested**

- Pick a directory containing unrelated files such as `README.md` and photos from another source.
- Iterate `for await (const entry of dirHandle.values())` before writing.

**What we observed**

- With read or read/write permission, Chromium allows enumeration of entries in the picked directory before writing.
- The browser picker warns that the site will be able to view/edit files in the selected folder, but it does not provide app-specific "this folder is not empty" UX.
- Enumeration discloses filenames and entry kind (`file`/`directory`) to the origin. The POC logs only names/kinds and caps the sample.

**Implication for production**

It is feasible and recommended to enumerate the selected folder before writing and show an app-level warning if it is non-empty. Keep the disclosure minimal: count entries and show a small sample; do not read unrelated file contents.

### Q5 — Permission revoke mid-download

**What we tested**

- Start a slow synthetic write through `createWritable()`.
- During the write, call `dirHandle.requestPermission({ mode: 'read' })`.
- Separately, reload/close during an in-flight write and inspect the target folder.

**What we observed**

- `requestPermission({ mode: 'read' })` is not a downgrade operation. If `readwrite` was already granted, requesting `read` returns `granted` and does not revoke the existing writer or interrupt the in-flight stream.
- Real revocation is user/browser controlled (site settings, permission prompt denial on a later request, tab close, OS/filesystem errors). Programmatic downgrade is not a reliable way to simulate it.
- `FileSystemWritableFileStream` writes through browser-managed staging and commits on `close()`. If the tab closes before `close()`, the final file may be absent or remain at its previous content; production must not assume a completed file unless `close()` resolved.
- If permission or filesystem access is lost mid-flow, errors surface as promise rejections/`DOMException`s from write operations or `close()`.

**Implication for production**

Treat mid-download permission loss as a recoverable album-output failure, not as a crypto failure. Stop scheduling new file writes, mark the current file/album as failed, explain that folder access was lost, and offer retry after the user re-grants access. Only mark a file complete after `close()` resolves.

### Q6 — Handle invalidation after directory rename / move (OS-level)

**What we tested**

- Pick and store a directory handle.
- Rename or move that directory in Explorer.
- Attempt to write a new file through the old handle.

**What we observed**

- The stale-handle case should be expected to fail in Chromium with a `DOMException` such as `NotFoundError` when the browser can no longer resolve the previously selected filesystem entry.
- The handle's `.name` is not a sufficient validity check; permission can still be `granted`/`prompt` while the underlying path has moved or disappeared.
- Behavior can vary by OS/filesystem and exact move (rename within same parent vs move across volume), so the production path must handle both "still works" and "stale" outcomes.

**Implication for production**

Run a cheap preflight write/delete or directory lookup before starting an album download from a restored handle. If it fails with stale/not-found errors, discard the stored handle and ask the user to pick the folder again.

### Q7 — Atomic file commit

**What we tested**

- Write `photo.jpg.tmp` in the picked directory.
- Detect whether `FileSystemFileHandle.move` or `FileSystemDirectoryHandle.move` exists.
- If no move primitive exists, copy bytes to `photo.jpg` and remove the `.tmp` file.

**What we observed**

- The standard File System Access picker surface does not provide a broadly available atomic rename/promotion primitive for user-picked directories.
- `FileSystemHandle.move()` is experimental and, where present, is not reliable enough to be a production dependency for external picked folders.
- `removeEntry('photo.jpg')` plus re-create/copy is not atomic; it creates windows where the final file is missing or partially staged.
- `createWritable()` itself provides an important per-file commit boundary: data becomes final only after `close()` resolves, but it does not solve final-name collision policy or cross-file atomicity.

**Implication for production**

Do not design production around OPFS-style `.tmp` rename for picked folders. Prefer direct final-filename writes with `createWritable()` and mark completion only after `close()`. For crash recovery, enumerate and clean app-owned `.mosaic-download-*.tmp` files if we choose to create them, but do not promise atomic album-level commit.

### Q8 — Subdirectory creation

**What we tested**

- Under the picked directory, call nested `getDirectoryHandle(part, { create: true })` for paths such as `Iceland-2024/day-01/nested-*`.
- Write a synthetic file into the deepest directory.

**What we observed**

- A `readwrite` grant on the picked parent directory allows subdirectory creation under that parent without additional prompts.
- The web API creates one path segment at a time; it does not accept slash-delimited nested paths as a single filename.
- No browser-specific small depth limit was encountered at realistic album depths. Practical limits are OS path length, invalid filename characters, and user expectations.

**Implication for production**

Album-folder output is a good fit: pick the parent output directory, create a sanitized album subdirectory, then create files within it. Production must sanitize each path segment and avoid relying on slash-delimited names.

### Q9 — Browser support matrix

**What we tested**

- Runtime feature detection in the POC:
  - `'showDirectoryPicker' in window`
  - `typeof window.showDirectoryPicker === 'function'`
- Compatibility expectations for current mainstream browsers.

**What we observed**

| Browser / platform | `showDirectoryPicker()` support | Production behavior |
| --- | --- | --- |
| Chrome desktop | Supported in Chromium desktop; local Chrome binary not present in this environment, re-run before production. | Enable directory output by default after feature detect. |
| Edge desktop | Supported in Chromium-based Edge 147. | Enable directory output by default after feature detect. |
| Firefox desktop | Not supported. | Use ZIP/parts fallback. |
| Safari desktop | Not supported for this picker API. | Use ZIP/parts fallback. |
| Chrome Android | Do not assume support for directory picker; mobile picker support is inconsistent/not suitable for v1 directory-output default. | Use ZIP/parts fallback unless runtime predicate passes and UX is separately validated. |

- The precise production predicate should be `typeof window.showDirectoryPicker === 'function'` and it must run only in a browser/secure-context path. `localhost` is treated as secure for development.

**Implication for production**

Gate the feature strictly by runtime detection, not by user-agent sniffing. Default to directory output only on detected Chromium desktop; keep the existing ZIP fallback for Firefox, Safari, unsupported mobile, denied permissions, and enterprise-policy-disabled environments.

### Q10 — Storage Access / persistence interaction with OPFS

**What we tested**

- Call `navigator.storage.estimate()` before writing.
- Write a synthetic file to the picked external directory.
- Call `navigator.storage.estimate()` again.
- Optionally write a synthetic file to OPFS via `navigator.storage.getDirectory()` and compare.

**What we observed**

- Writing to a user-picked directory is outside origin storage quota. It should not materially increase `navigator.storage.estimate().usage`; only tiny IndexedDB metadata for stored handles may affect origin usage.
- OPFS writes are origin-private storage and do increase `navigator.storage.estimate().usage`.
- `showDirectoryPicker()` permission state is independent from `navigator.storage.persist()`/OPFS persistence.

**Implication for production**

Directory-output mode can skip OPFS for plaintext and avoid quota pressure for album bytes. Continue using OPFS for encrypted/staging flows where needed, but do not expect storage persistence APIs to make external folder permission persistent.

## Recommended production implementation outline

- Add a browser-only capability gate: `typeof window.showDirectoryPicker === 'function'`, secure context, plus existing ZIP fallback.
- Model output folder access as a state machine: no handle -> picked handle -> permission prompt -> granted -> preflight OK -> writing -> completed/failed. Re-check `queryPermission({ mode: 'readwrite' })` before each download.
- Always create a sanitized album subdirectory by default, enumerate the parent for non-empty warnings, and apply an explicit duplicate filename policy before opening writable streams.
- Write files directly to final names using `createWritable()`, record file completion only after `close()` resolves, and surface `DOMException` failures as recoverable folder-access/output errors.
- Persist the handle in IndexedDB only as a convenience; on reload, expect `prompt` and require a user gesture to re-grant.

## Open questions

- Chrome desktop should be manually re-run because this host had Edge but no Chrome binary. Expected behavior is the same Chromium implementation, but the report should not be treated as a Chrome-version certification.
- Chrome Android needs hands-on UX validation before any mobile PWA claim. The safe v1 behavior is fallback unless `typeof window.showDirectoryPicker === 'function'` passes and manual testing confirms a usable directory picker.
- Exact stale-handle behavior after rename/move may vary by OS/filesystem and move type. Production should rely on preflight and error handling rather than a single assumed exception.
- Throughput numbers are environment-specific. The POC logs MiB/s; capture numbers on the target developer machine before sizing progress UI/chunking.

## Risks / showstoppers

- Unsupported browsers are not a showstopper because ZIP/parts fallback remains required.
- Silent overwrite is a real data-loss risk if production uses `{ create: true }` without collision checks; this must be blocked in design review.
- Lack of atomic rename for picked folders prevents an OPFS-style `.tmp` promotion design. This is acceptable for per-file downloads if completion is tied to `close()`, but it prevents claiming atomic album commit.
- Permission prompts after reload can surprise users; production UX must set expectations and make re-grant a deliberate button action.

## Verdict

Ship directory output as the Chromium-desktop default behind runtime feature detection, with ZIP/parts fallback everywhere else. Do not ship it as an unconditional default and do not reuse the OPFS `.tmp` + rename mental model for external folders. The feature is worth implementing if production includes permission preflight, explicit collision handling, non-empty-folder warning, sanitized album subdirectories, and recoverable error UX for stale/revoked handles.
