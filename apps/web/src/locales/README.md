# `apps/web/src/locales/` — Translation files

This directory holds the JSON translation files consumed by `i18next`. v1
ships two locales:

- `en.json` — English (source of truth; keys are added here first).
- `cs.json` — Czech (Čeština).

The i18next configuration lives at `apps/web/src/lib/i18n.ts`.

## Key-naming conventions

Keys are dot-separated, scoped by feature:

```text
auth.login.submit          → string
auth.login.errors.invalid  → string
gallery.photo.deleteConfirm.title → string
```

Lower camelCase for leaf segments; PascalCase only inside template
placeholders that mirror a TypeScript identifier.

## Plural fallback (the "bare-base-as `_one`" pattern) — DOCUMENTED

`i18next` resolves plurals by looking up `<key>_<plural-category>` (e.g.
`<key>_one`, `<key>_other`, `<key>_zero` for locales with a `zero` form). The
**bare base key** (no suffix) is also a valid lookup; i18next falls back to
the bare key whenever a specific plural-suffix lookup does not resolve.

Mosaic relies on this fallback intentionally: for keys whose value is the
**same string** in all plural categories, we **only** add the bare key and
omit the `_one` / `_other` suffixed entries. The bare key is then treated as
`_one` by the i18next resolver and re-used by every other plural category
through the fallback.

### Example (intentional fallback shape)

```json
{
  "gallery.photo.uploaded": "Uploaded",
  "gallery.photo.count_one": "{{count}} photo",
  "gallery.photo.count_other": "{{count}} photos"
}
```

`gallery.photo.uploaded` is the same word in every plural category, so a
single bare entry is sufficient — i18next will return it for any count.
`gallery.photo.count` differs by category, so explicit `_one` / `_other`
entries are required and the bare key is **not** present.

### When you must add explicit suffixes

- The translation differs by category (English `1 photo` / `2 photos`;
  Czech has the `_few` form for 2–4: `1 fotka` / `2 fotky` / `5 fotek`).
- The CLDR plural rule set for any supported locale assigns more than one
  category to counts the UI realistically hits. **Czech** has `one`, `few`,
  `many`, `other`; treat each as required unless the value is genuinely
  identical across all four (rare).
- A future translator review flags an i18next missing-key warning at
  runtime — that means the fallback is being exercised in a category where
  it should not be.

### When the bare-key fallback is correct

- A label that is grammatically count-invariant in every supported locale
  (English: `"Uploaded"`; Czech: `"Nahráno"`).
- Translator has reviewed the key in every locale and confirmed identical
  output.

### Rule of thumb

**Add the bare key.** If a translator later flags a category-specific
variant, add the `_one` / `_few` / `_many` / `_other` entries alongside the
bare key — do *not* remove the bare key. It continues to act as the
ultimate fallback and as the entry the developer added first.

## RTL preparation (deferred to v1.1)

Both shipped locales (`en`, `cs`) are LTR. The boot path in
`apps/web/src/lib/i18n.ts` synchronises `document.documentElement.lang` on
language change; v1.0.2 also synchronises `document.documentElement.dir` so
that adding a future RTL locale (`ar`, `he`, …) requires only the
translation file plus a one-line entry in the `supportedLanguages` array —
no boot-path change. The actual RTL UI sweep (mirror flexbox, mirror
icons, mirror map controls) is **deferred to v1.1**.

See `docs/I18N.md` for a higher-level overview of the i18n architecture.

## Adding a new key

1. Add the key to `en.json` (source of truth).
2. Add the same key to every other locale file; use the English value as a
   placeholder if the translation is pending. The build does **not** fail
   on missing translations — it falls back to `en` at runtime — but the
   placeholder makes the missing translation visible to reviewers.
3. Decide if the key needs plural suffixes (see above). Default to **bare
   key only**; add suffixes when grammar requires.
4. Verify with `cd apps/web ; npm run test:run` — the i18n-keys parity test
   asserts every locale has the same key set as `en.json`.

## Adding a new locale

1. Create `<code>.json` mirroring the `en.json` key set.
2. Add `{ code, name, nativeName }` to `supportedLanguages` in
   `apps/web/src/lib/i18n.ts`.
3. If the locale is RTL, see "RTL preparation" above — v1.0.2 boot path
   already syncs `<html dir>`, but the UI sweep is a v1.1 task.
4. Add the locale to the language picker translations.
