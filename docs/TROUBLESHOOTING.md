# Mosaic Troubleshooting Guide

This document captures solutions to common development issues, test failures, and debugging insights.

---

## Table of Contents

1. [Frontend Unit Testing](#frontend-unit-testing)
2. [E2E Testing](#e2e-testing)
3. [Crypto Operations](#crypto-operations)
4. [Build Issues](#build-issues)

---

## Frontend Unit Testing

### happy-dom + requestAnimationFrame + React 19 = Heap Exhaustion

**Problem:** Tests that render components using `requestAnimationFrame` cause JavaScript heap out of memory errors when running with happy-dom.

**Symptoms:**
- Tests hang for 800-1300+ seconds before crashing
- `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`
- `An update to Root inside a test was not wrapped in act(...)` warnings appear repeatedly
- 4GB+ memory usage before crash

**Root Cause:**

The combination of:
1. **happy-dom's `requestAnimationFrame` polyfill** - Continues firing callbacks indefinitely
2. **React 19's concurrent rendering** - Effects run asynchronously  
3. **Component useEffect with RAF** - Creates a feedback loop

When a React component uses `requestAnimationFrame` inside a `useEffect`, the happy-dom environment creates an infinite loop:
1. RAF callback fires
2. Triggers React state update (`setState`)
3. React effect re-runs
4. Schedules another RAF
5. Memory grows until heap exhaustion

Even with `skipAnimation: true` props, the component's useEffect still runs `setState` calls during the effect phase, which happens outside the test's `act()` wrapper.

**Affected Component:** `AnimatedTile` (`apps/web/src/components/Gallery/AnimatedTile.tsx`)

**Solutions:**

1. **Unit Tests (Recommended):** Don't render components with RAF directly
   - Test hooks separately (`usePrefersReducedMotion`)
   - Test pure functions (animation class logic)
   - Document expected CSS classes without rendering
   - See: `apps/web/tests/animated-tile.test.tsx`

2. **E2E Tests (Recommended):** Use Playwright for animation testing
   - Real browser environment handles RAF correctly
   - Visual verification of animation behavior
   - See: `tests/e2e/tests/gallery-animations.spec.ts`

3. **Alternative DOM Environment:** Use jsdom instead of happy-dom
   ```typescript
   /**
    * @vitest-environment jsdom
    */
   ```
   Note: Requires installing jsdom: `npm install --save-dev jsdom`

4. **Mock RAF Globally:** Replace before imports (not recommended - complex)
   ```typescript
   globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
   ```

**What Doesn't Work:**
- Excluding RAF from fake timers (`toFake: ['setTimeout', ...]`) - happy-dom has internal RAF
- Mocking `globalThis.requestAnimationFrame` after component import - module already loaded
- Using `skipAnimation: true` prop alone - useEffect still runs setState

**File Changes:**
- `apps/web/tests/animated-tile.test.tsx` - Restructured to avoid rendering AnimatedTile
- `tests/e2e/tests/gallery-animations.spec.ts` - E2E tests for animation behavior

**References:**
- [Vitest issue #2834](https://github.com/vitest-dev/vitest/issues/2834) - happy-dom RAF issues
- [React 19 Testing](https://react.dev/blog/2024/04/25/react-19#improvements-to-act) - act() improvements

---

### act() Warnings in React 19

**Problem:** `An update to Root inside a test was not wrapped in act(...)` warnings appear even when code is wrapped in act().

**Cause:** Effects scheduled by components run asynchronously in React 19. When an effect calls `setState`, it happens after the synchronous `act()` block completes.

**Solution:**
```typescript
// Use async act()
await act(async () => {
  root.render(element);
});

// Or flush all effects
act(() => {
  root.render(element);
});
// Additional act() to flush effects
act(() => {});
```

**Note:** Warnings don't necessarily indicate test failure. If tests pass and behavior is correct, warnings can be acceptable.

---

## E2E Testing

### Playwright Test Flakiness

**Problem:** E2E tests fail intermittently due to timing issues.

**Common Causes:**
1. **Race conditions** - Data not synced before assertion
2. **Animation timing** - Element not settled
3. **Network delays** - API responses slow

**Solutions:**

1. **Use proper waits:**
   ```typescript
   // Wait for specific condition, not arbitrary timeout
   await expect(element).toBeVisible({ timeout: 10000 });
   await expect(gallery.getPhotos()).toHaveCount(5, { timeout: 30000 });
   ```

2. **Wait for network idle:**
   ```typescript
   await page.waitForLoadState('networkidle');
   ```

3. **Wait for animations:**
   ```typescript
   // Use animation timeout from framework
   import { UI_TIMEOUTS } from '../framework/timeouts';
   await page.waitForTimeout(UI_TIMEOUTS.ANIMATION);
   ```

4. **Verify settled state:**
   ```typescript
   // Wait for animation-settled class
   await expect(tile).toHaveClass(/animation-settled/);
   ```

---

## Crypto Operations

### Key Derivation Hangs in Tests

**Problem:** Argon2id key derivation takes too long in tests.

**Solution:** Enable weak keys for testing:
```bash
# In test environment
VITE_E2E_WEAK_KEYS=true
```

This is already configured in `vitest.config.ts`:
```typescript
env: {
  VITE_E2E_WEAK_KEYS: 'true',
},
```

---

## Build Issues

### Crypto Library Not Found

**Problem:** `Cannot find module '@mosaic/crypto'`

**Solution:** Build crypto library first:
```bash
cd libs/crypto
npm install
npm run build
```

The frontend has an alias configured in `vite.config.ts` pointing to the built output.

---

## Adding to This Document

When you encounter and solve a new issue:

1. Add a new section under the appropriate category
2. Include:
   - **Problem:** Clear description of symptoms
   - **Cause:** Root cause analysis
   - **Solution:** Step-by-step fix
   - **File Changes:** (if applicable)
   - **References:** Links to issues, docs

3. Update the Table of Contents
