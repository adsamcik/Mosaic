# E2E Testing Framework: Expert Architecture Review

> **Date:** December 29, 2025  
> **Status:** Recommendations for Implementation  
> **Review Method:** 6 specialized AI agents analyzed the framework from different perspectives

## Executive Summary

The Mosaic E2E testing framework has a **solid foundation** with modern patterns for test isolation, wait strategies, and environment awareness. However, several architectural issues reduce maintainability and increase flakiness risk.

| Dimension | Score | Key Issue |
|-----------|-------|-----------|
| Design | 7.5/10 | Duplicate code across fixture files |
| Usability | 7/10 | Two fixture systems confuse developers |
| Architecture | 7/10 | Missing global teardown, scattered constants |
| Reliability | 7/10 | Race conditions in wait utilities |
| Security | 6/10 | Silent cleanup failures, no input validation |

**Overall Score: 7/10** → **Target: 9/10** with recommended fixes

---

## Critical Issues (P0 - Fix Immediately)

### 1. Race Condition in Test ID Generation

**Location:** `tests/e2e/framework/test-context.ts`

**Problem:** `Date.now()` can return same value for parallel workers started within 1ms.

**Current:**
```typescript
export function generateTestId(workerIndex: number): string {
  const timestamp = Date.now().toString(36);
  const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `w${workerIndex}-${timestamp}-${uuid}`;
}
```

**Fix:**
```typescript
export function generateTestId(workerIndex: number): string {
  // Use full UUID for maximum entropy - no timestamp needed
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `w${workerIndex}-${uuid}`;
}
```

### 2. Cleanup Timeout Silently Swallows Failures

**Location:** `tests/e2e/framework/test-context.ts`

**Problem:** When cleanup times out, albums are never deleted. Orphan data accumulates.

**Fix:** Track failed cleanups and optionally persist to file for batch retry:
```typescript
private failedCleanups: TrackedResource[] = [];

async cleanup(): Promise<void> {
  // ... existing cleanup ...
  if (this.failedCleanups.length > 0) {
    console.error(`[TestContext] ${this.failedCleanups.length} resources not cleaned up`);
    // Write to file for later batch cleanup
    const fs = await import('fs/promises');
    await fs.appendFile(
      '.cleanup-failures.json', 
      JSON.stringify(this.failedCleanups) + '\n'
    ).catch(() => {});
  }
}
```

### 3. Global Setup Has No Rollback on Partial Failure

**Location:** `tests/e2e/global-setup.ts`

**Problem:** If verification fails after backend check passed, environment is in inconsistent state.

**Fix:** Add step tracking:
```typescript
async function globalSetup(): Promise<void> {
  const steps = [
    { name: 'waitForBackend', run: waitForBackend },
    { name: 'verifyEndpoints', run: verifyEndpoints },
    { name: 'verifyCOOPCOEPHeaders', run: verifyCOOPCOEPHeaders },
  ];
  
  const completed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
      completed.push(step.name);
    } catch (error) {
      console.error(`Global setup failed after: ${completed.join(' → ')}`);
      throw error;
    }
  }
}
```

---

## High Priority Issues (P1 - Fix This Week)

### 4. Duplicate Code Between Fixture Files

**Problem:** `fixtures.ts` and `fixtures-enhanced.ts` have overlapping implementations of:
- `testUser`, `authenticatedPage`, `loggedInPage`
- Page objects (AppShell, LoginPage, etc.)
- ApiHelper, LogCollector

**Solution:** Create unified structure:
```
tests/e2e/
├── fixtures/
│   └── index.ts        # Single entry point, re-exports everything
├── framework/          # Utilities only
├── page-objects/       # Single POM location (no duplicates)
└── tests/              # All tests import from fixtures/
```

**Migration Steps:**
1. Create `fixtures/index.ts` that consolidates all exports
2. Update all tests to import from `../fixtures`
3. Delete legacy `fixtures.ts` and inline `fixtures-enhanced.ts` content
4. Remove duplicate POMs from old files

### 5. Browser Context Leak in Fixtures

**Problem:** If test throws before fixture completes, contexts are never closed.

**Current (vulnerable):**
```typescript
twoUserContext: async ({ browser }, use) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  await use({ alice, bob });
  // If test throws, these never run!
  await aliceContext.close();
  await bobContext.close();
}
```

**Fix:** Use try/finally pattern:
```typescript
twoUserContext: async ({ browser }, use) => {
  const contexts: BrowserContext[] = [];
  try {
    const aliceContext = await browser.newContext();
    contexts.push(aliceContext);
    const bobContext = await browser.newContext();
    contexts.push(bobContext);
    // ...
    await use({ alice, bob });
  } finally {
    await Promise.allSettled(contexts.map(c => c.close()));
  }
}
```

### 6. No Retry Logic on API Helpers

**Location:** `tests/e2e/framework/test-data-factory.ts`

**Problem:** Network hiccups cause immediate test failures.

**Fix:**
```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (response.status === 429) {
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        continue;
      }
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`Failed after ${retries} retries`);
}
```

---

## Medium Priority Issues (P2 - Fix This Sprint)

### 7. Inconsistent Timeout Values

**Problem:** Timeouts scattered across files (10s, 30s, 60s) without explanation.

**Fix:** Create centralized constants:
```typescript
// framework/constants.ts
export const TIMEOUTS = {
  /** UI interactions, button clicks */
  ACTION: 15_000,
  
  /** Page loads, navigation */
  PAGE_LOAD: 30_000,
  
  /** Login form display (includes WASM init) */
  LOGIN_FORM: 60_000,
  
  /** Crypto operations (key derivation, encryption) */
  CRYPTO: 60_000,
  
  /** File uploads */
  UPLOAD: 90_000,
  
  /** Network idle detection */
  NETWORK: 30_000,
} as const;
```

### 8. Race Condition in waitForNetworkIdle

**Problem:** Can pass immediately if no requests are in flight at start.

**Fix:** Add minimum wait time:
```typescript
export async function waitForNetworkIdle(
  page: Page,
  options: WaitOptions & { minWaitMs?: number } = {}
): Promise<void> {
  const { minWaitMs = 100 } = options;
  let lastActivity = Date.now();
  
  // Track activity timestamp in handlers
  const requestHandler = () => { lastActivity = Date.now(); pendingRequests++; };
  
  await waitForCondition(
    () => pendingRequests === 0 && (Date.now() - lastActivity >= minWaitMs),
    { timeout, message: 'Network requests did not complete' }
  );
}
```

### 9. Missing Input Validation in Page Objects

**Problem:** No validation allows null, undefined, or excessively long strings.

**Fix:** Add guards to all action methods:
```typescript
async createAlbum(name: string): Promise<void> {
  if (typeof name !== 'string') {
    throw new Error(`Album name must be string, got ${typeof name}`);
  }
  if (name.length > 1000) {
    throw new Error(`Album name too long: ${name.length} chars`);
  }
  // ... rest of method
}
```

### 10. Unbounded Log Collection

**Problem:** LogCollector can cause OOM with console spam.

**Fix:** Implement ring buffer:
```typescript
private readonly MAX_LOGS = 10000;

private attachListeners() {
  this.page.on('console', (msg) => {
    if (this.logs.length >= this.MAX_LOGS) {
      this.logs.shift(); // Remove oldest
    }
    this.logs.push({ /* ... */ });
  });
}
```

---

## Quick Wins (Low Effort, High Impact)

### 11. Add Missing NPM Scripts

```json
{
  "scripts": {
    "test": "playwright test",
    "test:chromium": "playwright test --project=chromium",
    "test:p0": "playwright test --grep P0",
    "test:p1": "playwright test --grep P1",
    "test:failed": "playwright test --last-failed",
    "test:headed": "playwright test --headed",
    "test:ui": "playwright test --ui",
    "test:debug": "playwright test --debug",
    "report": "playwright show-report"
  }
}
```

### 12. Add .env.example

```env
# Frontend URL (Vite dev server)
BASE_URL=http://localhost:5173

# Backend API URL  
API_URL=http://localhost:8080

# Test password (change in CI)
E2E_TEST_PASSWORD=test-password-e2e-2024

# Set to "true" in CI pipelines
CI=
```

### 13. Add Quick-Start to README

Add at the very top, before existing content:

````markdown
## 🚀 Quick Start (5 Minutes)

```typescript
// tests/my-feature.spec.ts
import { test, expect, LoginPage, AppShell } from '../fixtures-enhanced';
import { TEST_PASSWORD } from '../framework';

test('my feature works', async ({ authenticatedPage }) => {
  await authenticatedPage.goto('/');
  
  const loginPage = new LoginPage(authenticatedPage);
  await loginPage.waitForForm();
  await loginPage.login(TEST_PASSWORD);
  await loginPage.expectLoginSuccess();
  
  const appShell = new AppShell(authenticatedPage);
  await expect(appShell.albumList).toBeVisible();
});
```

**Run it:**
```bash
npx playwright test my-feature --project=chromium
```
````

### 14. Add Global Teardown

```typescript
// global-teardown.ts
async function globalTeardown(): Promise<void> {
  if (!process.env.CI) return; // Only in CI
  
  // Clean up test users/albums created with specific prefix
  const API_URL = process.env.API_URL || 'http://localhost:8080';
  await fetch(`${API_URL}/api/admin/cleanup-test-data`, {
    method: 'POST',
    headers: { 'X-Admin-Key': process.env.E2E_ADMIN_KEY || '' },
  }).catch(() => {});
}

export default globalTeardown;
```

---

## Architecture Improvements (P3 - Plan for Next Quarter)

### 15. Component Object Model

Split the 743-line page-objects file into focused components:

```
page-objects/
├── components/
│   ├── dialogs/
│   │   ├── create-album-dialog.ts
│   │   ├── invite-member-dialog.ts
│   │   └── delete-confirmation-dialog.ts
│   ├── panels/
│   │   ├── members-panel.ts
│   │   └── settings-panel.ts
│   └── shared/
│       ├── photo-grid.ts
│       └── album-card.ts
├── pages/
│   ├── login-page.ts
│   ├── gallery-page.ts
│   └── admin-page.ts
└── index.ts  # Barrel exports
```

### 16. Actions Layer

Add high-level workflow helpers:

```typescript
// actions/album-actions.ts
export class AlbumActions {
  constructor(private page: Page, private api: ApiHelper) {}
  
  async createAlbumWithPhotos(
    name: string, 
    photoCount: number
  ): Promise<{ albumId: string }> {
    // Uses API for speed when appropriate
    // Uses UI for the actual test flow
  }
}
```

### 17. Visual Regression Testing

Add @playwright/test snapshots for critical UI:

```typescript
test('album grid layout matches snapshot', async ({ page }) => {
  // ... setup ...
  await expect(page.getByTestId('album-grid')).toHaveScreenshot('album-grid.png', {
    maxDiffPixelRatio: 0.01,
  });
});
```

### 18. Accessibility Testing with axe-core

```typescript
import { checkA11y } from '@axe-core/playwright';

test('login page is accessible', async ({ page }) => {
  await page.goto('/');
  const results = await checkA11y(page);
  expect(results.violations).toHaveLength(0);
});
```

---

## Implementation Roadmap

| Phase | Duration | Focus | Deliverables |
|-------|----------|-------|--------------|
| **P0** | Week 1 | Critical fixes | Fix ID generation, cleanup tracking, global setup |
| **P1** | Week 2 | Consolidation | Unify fixtures, fix context leaks, add retry logic |
| **P2** | Week 3 | Reliability | Centralize timeouts, fix wait utilities, add validation |
| **Quick** | Week 3 | DX | npm scripts, .env.example, README quick-start |
| **P3** | Month 2+ | Architecture | Component model, actions layer, visual/a11y testing |

---

## Stress Tests to Add

Based on adversarial analysis, add these tests:

```typescript
// tests/stress/parallel-isolation.spec.ts
test.describe.parallel('Parallel Isolation', () => {
  for (let i = 0; i < 20; i++) {
    test(`worker-${i}: unique IDs`, async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('stress');
      // Verify no collision with other parallel tests
    });
  }
});

// tests/stress/cleanup-resilience.spec.ts  
test('cleanup survives partial failure', async ({ testContext }) => {
  // Create resources, then simulate backend outage during cleanup
});

// tests/stress/unicode-edge-cases.spec.ts
test('handles unicode album names', async ({ authenticatedPage }) => {
  const names = ['🎭 Emoji', '中文', '\u202E RLO'];
  for (const name of names) {
    // Should succeed or show validation, not crash
  }
});
```

---

## Definition of Done

A fix is complete when:
- [ ] Code change implemented
- [ ] Unit test added (if applicable)
- [ ] E2E test validates fix
- [ ] No regressions in existing tests
- [ ] Documentation updated
- [ ] PR reviewed and merged

---

## Appendix: Agent Reports

The following specialized agents contributed to this review:

1. **Design Agent** - Code organization, patterns, API design
2. **Usability Agent** - Developer experience, documentation
3. **Architecture Agent** - Layering, scalability, technical debt  
4. **Reliability Agent** - Flakiness risks, wait strategies, timeouts
5. **Adversarial Agent** - Attack vectors, edge cases, stress tests
6. **Redesign Agent** - Ideal architecture, migration path

Each agent analyzed the full `tests/e2e/` directory and provided independent recommendations that were synthesized into this unified plan.
