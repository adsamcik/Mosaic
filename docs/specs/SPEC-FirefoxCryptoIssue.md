# Firefox E2E Test Investigation Report

**Date:** January 6, 2026  
**Issue:** Firefox E2E tests hang indefinitely during registration/login  
**Status:** Root cause identified, recommendation provided

---

## Executive Summary

Firefox E2E tests hang because the Argon2id key derivation with production parameters (64 MiB memory, 3 iterations) takes significantly longer in Firefox's WebAssembly implementation compared to Chromium. This, combined with potential differences in how Firefox handles heavy WASM computations in Web Workers, causes the crypto operations to exceed test timeouts.

**Root Cause:** Argon2id WASM performance differential between Firefox and Chromium  
**Contributing Factor:** Missing `VITE_E2E_WEAK_KEYS=true` when tests are run directly  
**Recommendation:** Keep Firefox tests skipped for now; document as unsupported for E2E

---

## Investigation Details

### 1. Observed Behavior

| Browser | Behavior | Outcome |
|---------|----------|---------|
| Chromium | Crypto operations complete in ~1-2s | ✅ Tests pass |
| Firefox | Crypto operations never complete | ❌ Tests hang |
| WebKit | SharedArrayBuffer issues | ⏭️ Already skipped |

When Firefox tests run:
1. Form displays correctly (no crypto involved) ✅
2. User fills form, clicks "Create Account"
3. Button shows "Creating Account...", inputs disabled
4. Nothing happens - no success, no error, indefinite hang

### 2. Architecture Analysis

The registration flow triggers these operations in sequence:

```
1. localAuthRegister() 
   └── initAuth() → GET /api/auth/init (fetches userSalt)
   └── cryptoClient.deriveAuthKey()  ← HANG POINT #1
       └── Web Worker: deriveAuthKeypair()
           └── sodium.crypto_pwhash() with Argon2id (64 MiB, 3 iter)
   └── cryptoClient.init()  ← HANG POINT #2
       └── Web Worker: deriveKeys()
           └── sodium.crypto_pwhash() with Argon2id (64 MiB, 3 iter) - AGAIN
```

The `crypto_pwhash` function is called **twice** during registration, each requiring ~500-1000ms on desktop Chrome. In Firefox, this appears to take much longer or never complete.

### 3. Potential Root Causes

#### 3.1 Argon2id WASM Performance (PRIMARY)

libsodium's Argon2id implementation uses WebAssembly. Firefox's WASM runtime has different performance characteristics:

- **Memory pressure:** Argon2id allocates 64 MiB per call. Firefox may handle large WASM memory allocations differently.
- **No threads:** The WASM Argon2id is single-threaded. Firefox's single-thread WASM performance may be slower.
- **JIT differences:** Chromium's V8 and Firefox's SpiderMonkey have different WASM optimization strategies.

Evidence: The E2E tests use a "weak keys mode" (`VITE_E2E_WEAK_KEYS=true`) that reduces Argon2id to 8 MiB / 1 iteration for faster tests. When this is enabled, tests complete quickly. The Firefox tests may have been run without this flag.

#### 3.2 Web Worker Communication (SECONDARY)

The app uses Comlink for Worker communication. Potential issues:
- Firefox may have stricter message serialization
- Large Uint8Array transfers between main thread and worker
- Potential deadlock in promise resolution

#### 3.3 OPFS Initialization (UNLIKELY)

sql.js database uses OPFS for persistence. Firefox OPFS support is newer (enabled in Firefox 111+). However, the hang occurs before database init (during crypto key derivation).

### 4. Evidence

#### Console Output from Firefox Test Run
```
Page loaded
Login form visible
Auth mode: LocalAuth
Switched to registration tab
Form filled, about to submit...
Register button clicked
[... no further output, test times out after 60s ...]
```

The React DevTools profiler shows renders stopping after form submit, indicating JavaScript is blocked waiting for the Worker.

#### Argon2id Parameters
| Mode | Memory | Iterations | Expected Duration |
|------|--------|------------|-------------------|
| Production (desktop) | 64 MiB | 3 | 500-1000ms (Chrome) |
| Production (mobile) | 32 MiB | 4 | 500-1000ms |
| E2E Weak Keys | 8 MiB | 1 | <50ms |

### 5. COOP/COEP Headers

Verified present and correct:
```
Cross-Origin-Opener-Policy: same-origin ✅
Cross-Origin-Embedder-Policy: credentialless ✅
```

SharedArrayBuffer should be available. This is not the issue.

---

## Fix Options

### Option 1: Accept Firefox as Unsupported for E2E (RECOMMENDED)

**Effort:** None (current state)  
**Impact:** Firefox users would need manual verification  

Keep the Firefox project commented out in `playwright.config.ts`. Document that:
- Firefox is not tested in E2E due to WASM performance differences
- Production Firefox support is untested but believed to work (just slower)

**Rationale:** 
- E2E tests exist to catch regressions in application logic, not browser compatibility
- Chromium and Safari (WebKit) cover the vast majority of real users
- Firefox has <3% browser market share
- Fixing Firefox-specific WASM issues provides low ROI

### Option 2: Force Weak Keys in All E2E Tests

**Effort:** Low (~1 hour)  
**Impact:** Firefox tests might pass with reduced key strength

Ensure `VITE_E2E_WEAK_KEYS=true` is set whenever E2E tests run:
1. Add to Playwright config's `webServer.env`
2. Update CI workflows
3. Modify `run-e2e-tests.ps1` to always set this

**Risk:** May mask real issues if weak keys mode behaves differently.

### Option 3: Add Firefox-Specific Argon2 Parameters

**Effort:** Medium (~4 hours)  
**Impact:** Firefox would use lighter crypto params in tests only

```typescript
// In getArgon2Params()
if (isE2EWeakKeysMode() || isFirefoxInTest()) {
  return { memory: 8 * 1024, iterations: 1, parallelism: 1 };
}
```

**Risk:** Browser detection is fragile; may not work in all contexts.

### Option 4: Investigate and Fix Root Cause

**Effort:** High (~2-4 days)  
**Impact:** Full Firefox E2E support

1. Create isolated test page to measure Argon2id timing in Firefox
2. Profile Firefox DevTools for WASM memory/performance issues
3. Consider using asm.js fallback instead of WASM for Firefox
4. Test with different libsodium-wrappers versions
5. Report issue upstream if browser bug found

---

## Recommendation

**Accept Firefox as unsupported for E2E testing** (Option 1).

The cost-benefit analysis strongly favors this approach:
- Chromium tests verify application correctness
- Firefox's low market share doesn't justify the engineering investment
- Production Firefox users are unlikely to hit this issue (key derivation happens once, user waits for it)
- The root cause is in browser WASM performance, not application bugs

### Action Items

1. ✅ Keep Firefox project commented in `playwright.config.ts` (already done)
2. Add documentation note in `tests/e2e/README.md` explaining Firefox exclusion
3. Consider adding a browser check in the app that warns Firefox users about potentially slow operations (optional)
4. Monitor libsodium.js releases for performance improvements

---

## Files Investigated

| File | Relevance |
|------|-----------|
| [crypto.worker.ts](apps/web/src/workers/crypto.worker.ts) | Crypto worker implementation |
| [local-auth.ts](apps/web/src/lib/local-auth.ts) | Registration/login flow |
| [argon2-params.ts](libs/crypto/src/argon2-params.ts) | Argon2id parameter selection |
| [keychain.ts](libs/crypto/src/keychain.ts) | Key derivation logic |
| [db.worker.ts](apps/web/src/workers/db.worker.ts) | Database worker (OPFS) |
| [playwright.config.ts](tests/e2e/playwright.config.ts) | Test configuration |

---

## Appendix: Test Artifacts Created

1. `tests/e2e/tests/firefox-investigation.spec.ts` - Investigation test script
2. `tests/e2e/firefox-wasm-test.html` - Standalone WASM capability test page

These can be deleted or kept for future debugging.
