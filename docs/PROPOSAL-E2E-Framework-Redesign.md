# Proposal: E2E Testing Framework Redesign

> **Author:** Staff Engineer Review  
> **Date:** December 29, 2025  
> **Status:** Proposal for Review

---

## Table of Contents

1. [Current State Summary](#current-state-summary)
2. [Proposed Architecture](#proposed-architecture)
3. [Detailed Design Decisions](#detailed-design-decisions)
4. [Migration Path](#migration-path)
5. [Comparison Table](#comparison-table)
6. [Implementation Priorities](#implementation-priorities)
7. [Trade-offs Analysis](#trade-offs-analysis)
8. [Appendix: Code Examples](#appendix-code-examples)

---

## Current State Summary

### What Exists Today

The Mosaic E2E test suite is built on **Playwright** with **TypeScript** and has evolved organically to include:

```
tests/e2e/
├── fixtures.ts              # Legacy fixtures + LogCollector
├── fixtures-enhanced.ts     # Parallel-safe fixtures (newer)
├── framework/
│   ├── test-context.ts      # TestContext class for isolation
│   ├── test-data-factory.ts # API helpers + image generation
│   └── wait-utils.ts        # Condition-based waits
├── page-objects/
│   └── index.ts             # Monolithic 743-line file with all POMs
└── tests/                   # 19 spec files
```

**Quantitative Assessment:**

| Metric | Current State |
|--------|---------------|
| Total test files | 19 |
| Page object classes | 12 (in single file) |
| Lines in page-objects/index.ts | 743 |
| Fixture files | 2 (split legacy/enhanced) |
| Test patterns | Mixed (legacy + parallel-safe) |
| Cleanup strategy | Per-test with TestContext |

### Strengths

1. **Parallel-safe isolation** — `TestContext` provides worker-indexed unique IDs
2. **Auto-cleanup** — Resources tracked and cleaned via `cleanup()` 
3. **API shortcuts** — `createAlbumViaAPI()` for fast test setup
4. **Wait utilities** — Condition-based waits (`waitForCondition`, `waitForStable`)
5. **Log capture** — `LogCollector` for debugging console/network

### Weaknesses

1. **Monolithic page objects** — 743-line single file is unmaintainable
2. **Dual fixture systems** — `fixtures.ts` vs `fixtures-enhanced.ts` confusion
3. **Inconsistent patterns** — Some tests use `loggedInPage`, others `testContext`
4. **No component objects** — Everything is page-level, missing reusable components
5. **No test tagging** — Tests organized by feature file, not by priority/suite
6. **Missing patterns** — No visual regression, limited a11y (no axe-core)
7. **Page objects return void** — No fluent chaining for readability
8. **Mixed API usage** — Some tests seed via API, others via UI (inconsistent)

---

## Proposed Architecture

### High-Level Structure

```
tests/e2e/
├── playwright.config.ts          # Single config with project variants
├── global-setup.ts               # Health checks + environment prep
├── global-teardown.ts            # Optional: global cleanup
│
├── core/                         # Framework foundation
│   ├── fixtures.ts               # Single unified fixture file
│   ├── test-context.ts           # Isolation context
│   ├── api-client.ts             # Typed API client
│   └── waits.ts                  # Wait utilities
│
├── components/                   # Component Object Model
│   ├── base.ts                   # BaseComponent class
│   ├── dialogs/
│   │   ├── create-album.ts
│   │   ├── delete-confirm.ts
│   │   └── invite-member.ts
│   ├── panels/
│   │   ├── members-panel.ts
│   │   └── settings-panel.ts
│   └── shared/
│       ├── photo-thumbnail.ts
│       ├── album-card.ts
│       └── toast.ts
│
├── pages/                        # Page objects (thin, compose components)
│   ├── base.ts                   # BasePage class
│   ├── login.page.ts
│   ├── home.page.ts
│   ├── gallery.page.ts
│   ├── lightbox.page.ts
│   └── admin.page.ts
│
├── actions/                      # App Actions (high-level workflows)
│   ├── auth.actions.ts           # loginAs(), logout()
│   ├── album.actions.ts          # createAlbum(), deleteAlbum()
│   ├── photo.actions.ts          # uploadPhoto(), downloadPhoto()
│   └── sharing.actions.ts        # inviteMember(), removeMember()
│
├── data/                         # Test data management
│   ├── factories/
│   │   ├── user.factory.ts
│   │   ├── album.factory.ts
│   │   └── photo.factory.ts
│   └── builders/
│       └── test-scenario.builder.ts
│
├── utils/                        # Shared utilities
│   ├── image-generator.ts
│   ├── assertions.ts             # Custom matchers
│   └── reporters/
│       └── slack-reporter.ts
│
└── tests/                        # Test specs
    ├── smoke/                    # @smoke tag - CI gate
    │   └── critical-paths.spec.ts
    ├── features/
    │   ├── auth/
    │   │   ├── login.spec.ts
    │   │   └── session.spec.ts
    │   ├── albums/
    │   │   ├── crud.spec.ts
    │   │   └── deletion.spec.ts
    │   ├── photos/
    │   │   ├── upload.spec.ts
    │   │   └── download.spec.ts
    │   ├── sharing/
    │   │   └── collaboration.spec.ts
    │   └── settings/
    │       └── preferences.spec.ts
    ├── accessibility/
    │   └── wcag.spec.ts
    └── visual/
        └── snapshots.spec.ts
```

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Test Spec Files                            │
│  (tests/smoke/*.spec.ts, tests/features/**/*.spec.ts)               │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         App Actions Layer                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ auth.actions │ │album.actions │ │photo.actions │  ...           │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
│                                                                     │
│  High-level workflows: loginAs(user, password), uploadPhoto(path)  │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           Pages Layer                               │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐       │
│  │ LoginPage  │ │ HomePage   │ │GalleryPage │ │ AdminPage  │       │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘       │
│                                                                     │
│  Thin orchestrators that compose components                         │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Components Layer                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ CreateAlbumDialog│  │   MembersPanel   │  │  PhotoThumbnail  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │    AlbumCard     │  │      Toast       │  │    Lightbox      │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                     │
│  Reusable UI components with encapsulated selectors                 │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Core Layer                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │
│  │  Fixtures   │  │ TestContext │  │  ApiClient  │  │   Waits   │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘  │
│                                                                     │
│  Foundation: fixtures, isolation, direct API, wait utilities        │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Playwright + Browser                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Design Decisions

### 1. Fixture Architecture

**Decision: Playwright Built-in Fixtures with Custom Extensions**

```typescript
// core/fixtures.ts
import { test as base } from '@playwright/test';

export const test = base.extend<{
  // Per-test context with auto-cleanup
  ctx: TestContext;
  
  // Pre-authenticated user (logs in during fixture setup)
  authedUser: AuthenticatedUser;
  
  // Two-user collaboration context  
  collab: CollaborationContext;
  
  // API client with auth headers
  api: ApiClient;
}>({
  ctx: async ({ browser }, use, testInfo) => {
    const ctx = new TestContext(browser, testInfo.parallelIndex);
    await use(ctx);
    await ctx.cleanup();
  },
  
  authedUser: async ({ ctx }, use) => {
    const user = await ctx.createAndLoginUser('main');
    await use(user);
  },
  
  collab: async ({ browser }, use, testInfo) => {
    const collab = new CollaborationContext(browser, testInfo.parallelIndex);
    await collab.setupAliceAndBob();
    await use(collab);
    await collab.cleanup();
  },
  
  api: async ({ ctx }, use) => {
    const api = new ApiClient(ctx.testId);
    await use(api);
  },
});
```

**Rationale:**
- Playwright's fixture system handles lifecycle management
- Auto-cleanup in fixture teardown (not `afterEach`)
- Parallel-safe via `testInfo.parallelIndex`
- Type-safe with generics

**Test Data Strategy:**

| Strategy | Use Case | Implementation |
|----------|----------|----------------|
| **Factories** | Simple objects (user, album metadata) | Pure functions returning typed objects |
| **Builders** | Complex scenarios (album with photos + members) | Fluent builder pattern |
| **Fixtures** | Runtime resources (browser context, API client) | Playwright fixtures |

```typescript
// data/factories/album.factory.ts
export function createAlbumData(overrides?: Partial<AlbumData>): AlbumData {
  return {
    name: `Test Album ${Date.now()}`,
    description: '',
    ...overrides,
  };
}

// data/builders/test-scenario.builder.ts
export class TestScenarioBuilder {
  private users: string[] = [];
  private albums: AlbumConfig[] = [];
  
  withUser(name: string): this { 
    this.users.push(name);
    return this;
  }
  
  withAlbum(config: AlbumConfig): this {
    this.albums.push(config);
    return this;
  }
  
  async build(ctx: TestContext): Promise<TestScenario> {
    // Create all resources via API
  }
}
```

**Cleanup Strategy:**

```typescript
// Automatic via TestContext
class TestContext {
  private cleanupQueue: CleanupTask[] = [];
  
  trackResource(type: string, id: string, cleanup: () => Promise<void>): void {
    this.cleanupQueue.push({ type, id, cleanup });
  }
  
  async cleanup(): Promise<void> {
    // Reverse order (LIFO) for dependency safety
    for (const task of this.cleanupQueue.reverse()) {
      try {
        await task.cleanup();
      } catch (e) {
        console.warn(`Cleanup failed for ${task.type}:${task.id}`, e);
      }
    }
  }
}
```

---

### 2. Page Object Evolution

**Decision: Component Object Model with Thin Pages**

Instead of monolithic page objects, use:
1. **Components** — Reusable UI elements (dialogs, cards, panels)
2. **Pages** — Thin orchestrators that compose components
3. **Actions** — High-level workflows for tests

```typescript
// components/base.ts
export abstract class BaseComponent {
  constructor(protected page: Page, protected root: Locator) {}
  
  async isVisible(): Promise<boolean> {
    return this.root.isVisible();
  }
  
  async waitForVisible(timeout = 10000): Promise<this> {
    await expect(this.root).toBeVisible({ timeout });
    return this;
  }
}

// components/dialogs/create-album.ts
export class CreateAlbumDialog extends BaseComponent {
  private nameInput = this.root.getByTestId('album-name-input');
  private createBtn = this.root.getByTestId('create-button');
  private cancelBtn = this.root.getByTestId('cancel-button');
  
  constructor(page: Page) {
    super(page, page.getByTestId('create-album-dialog'));
  }
  
  async fillName(name: string): Promise<this> {
    await this.nameInput.fill(name);
    return this;
  }
  
  async submit(): Promise<void> {
    await this.createBtn.click();
  }
  
  async cancel(): Promise<void> {
    await this.cancelBtn.click();
  }
  
  // Fluent composition
  async createAlbum(name: string): Promise<void> {
    await this.waitForVisible();
    await this.fillName(name);
    await this.submit();
    await this.waitForHidden();
  }
}

// pages/home.page.ts
export class HomePage extends BasePage {
  readonly createAlbumDialog = new CreateAlbumDialog(this.page);
  readonly albumCards = this.page.getByTestId('album-card');
  
  async openCreateDialog(): Promise<CreateAlbumDialog> {
    await this.page.getByRole('button', { name: /create/i }).click();
    return this.createAlbumDialog.waitForVisible();
  }
  
  async getAlbumByName(name: string): Promise<AlbumCard> {
    const card = this.albumCards.filter({ hasText: name });
    return new AlbumCard(this.page, card);
  }
}
```

**Fluent vs Void Return:**

| Pattern | When to Use |
|---------|-------------|
| `return this` | Chaining state setup (fill → fill → check) |
| `return void` | Terminal actions (submit, navigate away) |
| `return Component` | Navigating to new context (click → dialog opens) |

```typescript
// Fluent chaining example
await createDialog
  .waitForVisible()
  .then(d => d.fillName('Vacation'))
  .then(d => d.fillDescription('2025 photos'));
  
// Or with await chains  
const dialog = await homePage.openCreateDialog();
await dialog.fillName('Vacation');
await dialog.submit();
```

**Handling Dynamic/WASM Content:**

```typescript
// utils/waits.ts
export async function waitForCryptoReady(page: Page, timeout = 30000): Promise<void> {
  await page.waitForFunction(
    () => {
      // Check for crypto worker initialization signals
      const appReady = document.querySelector('[data-crypto-ready="true"]');
      const noSpinner = !document.querySelector('[data-loading="crypto"]');
      return appReady && noSpinner;
    },
    { timeout }
  );
}

// Or use network idle + custom condition
export async function waitForAppReady(page: Page): Promise<void> {
  await Promise.all([
    page.waitForLoadState('networkidle'),
    waitForCryptoReady(page),
  ]);
}
```

---

### 3. Test Organization

**Decision: Feature-Based with Priority Tags**

```
tests/
├── smoke/                    # @smoke - CI gate (< 5 min)
├── features/                 # @feature - full regression
│   ├── auth/
│   ├── albums/
│   ├── photos/
│   └── sharing/
├── accessibility/            # @a11y
└── visual/                   # @visual (skipped by default)
```

**Tagging Strategy:**

```typescript
// tests/features/albums/crud.spec.ts
import { test } from '@e2e/core/fixtures';

test.describe('Album CRUD', () => {
  test('create album with valid name @smoke @p0', async ({ authedUser }) => {
    // P0 priority, included in smoke suite
  });
  
  test('create album shows error for empty name @p1', async ({ authedUser }) => {
    // P1 priority, full regression only
  });
});
```

**Running by tag:**

```bash
# CI smoke gate (must pass before merge)
npx playwright test --grep "@smoke"

# Full P0+P1 regression
npx playwright test --grep "@p0|@p1"

# Feature-specific
npx playwright test tests/features/albums/

# Exclude slow visual tests
npx playwright test --grep-invert "@visual"
```

**Suite Configuration:**

```typescript
// playwright.config.ts
export default defineConfig({
  projects: [
    // Fast smoke suite - Chromium only
    {
      name: 'smoke',
      testMatch: '**/smoke/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
      retries: 0,
    },
    // Full regression - all browsers
    {
      name: 'chromium',
      testMatch: '**/features/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testMatch: '**/features/**/*.spec.ts',
      use: { ...devices['Desktop Firefox'] },
    },
    // Mobile
    {
      name: 'mobile',
      testMatch: '**/features/**/*.spec.ts',
      use: { ...devices['Pixel 5'] },
    },
    // Accessibility
    {
      name: 'a11y',
      testMatch: '**/accessibility/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

---

### 4. API Integration

**Decision: Hybrid Approach with Clear Guidelines**

| Scenario | Approach | Rationale |
|----------|----------|-----------|
| **Test setup** (create album for photo test) | API | Speed, reliability |
| **Testing the feature itself** | UI | What we're verifying |
| **Cleanup** | API | No UI needed |
| **State verification** | API | More reliable than UI |

```typescript
// core/api-client.ts
export class ApiClient {
  constructor(
    private baseUrl = process.env.API_URL ?? 'http://localhost:8080',
    private userEmail: string
  ) {}
  
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Remote-User': this.userEmail,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    
    if (!response.ok) {
      throw new ApiError(response.status, await response.text());
    }
    
    return response.json();
  }
  
  // Album operations
  async createAlbum(name: string): Promise<Album> {
    return this.request('POST', '/api/albums', { name });
  }
  
  async getAlbums(): Promise<Album[]> {
    return this.request('GET', '/api/albums');
  }
  
  async deleteAlbum(id: string): Promise<void> {
    await this.request('DELETE', `/api/albums/${id}`);
  }
  
  // Verification helpers
  async verifyAlbumExists(id: string): Promise<boolean> {
    try {
      await this.request('GET', `/api/albums/${id}`);
      return true;
    } catch {
      return false;
    }
  }
}
```

**Usage in Tests:**

```typescript
test('delete album removes it from backend @p0', async ({ authedUser, api }) => {
  // Setup via API (fast)
  const album = await api.createAlbum('To Delete');
  
  // Test via UI (what we're verifying)
  const gallery = await homePage.navigateToAlbum(album.name);
  await gallery.deleteAlbum();
  
  // Verify via API (reliable)
  expect(await api.verifyAlbumExists(album.id)).toBe(false);
});
```

---

### 5. Advanced Patterns

#### Visual Regression Testing

```typescript
// tests/visual/snapshots.spec.ts
import { test, expect } from '@e2e/core/fixtures';

test.describe('Visual Regression @visual', () => {
  test('login page matches snapshot', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    await expect(page).toHaveScreenshot('login-page.png', {
      maxDiffPixels: 100,
    });
  });
  
  test('gallery grid matches snapshot', async ({ authedUser }) => {
    // Setup: create album with 6 test photos via API
    // ...
    
    await expect(authedUser.page).toHaveScreenshot('gallery-6-photos.png', {
      mask: [authedUser.page.getByTestId('timestamp')], // Mask dynamic content
    });
  });
});
```

**Config for visual tests:**

```typescript
// playwright.config.ts
export default defineConfig({
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    },
  },
  projects: [
    {
      name: 'visual-chromium',
      testMatch: '**/visual/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        // Consistent viewport for snapshots
        viewport: { width: 1280, height: 720 },
        colorScheme: 'light',
      },
    },
  ],
});
```

#### Accessibility Testing (axe-core)

```typescript
// tests/accessibility/wcag.spec.ts
import { test, expect } from '@e2e/core/fixtures';
import AxeBuilder from '@axe-core/playwright';

test.describe('WCAG Compliance @a11y', () => {
  test('login page has no a11y violations', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    
    expect(results.violations).toEqual([]);
  });
  
  test('gallery page has no critical violations', async ({ authedUser }) => {
    await authedUser.page.goto('/albums/test');
    
    const results = await new AxeBuilder({ page: authedUser.page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast']) // Known issue, tracked separately
      .analyze();
    
    const critical = results.violations.filter(v => v.impact === 'critical');
    expect(critical).toEqual([]);
  });
});
```

#### Performance Budgets

```typescript
// tests/smoke/performance.spec.ts
test.describe('Performance Budgets @smoke', () => {
  test('initial load under 3 seconds', async ({ page }) => {
    const startTime = Date.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const loadTime = Date.now() - startTime;
    
    expect(loadTime).toBeLessThan(3000);
  });
  
  test('gallery renders 100 photos under 1 second', async ({ authedUser, api }) => {
    // Setup: create album with 100 photos
    const album = await api.createAlbumWithPhotos(100);
    
    const startTime = Date.now();
    await authedUser.page.goto(`/albums/${album.id}`);
    await authedUser.page.waitForSelector('[data-testid="photo-thumbnail"]');
    const renderTime = Date.now() - startTime;
    
    expect(renderTime).toBeLessThan(1000);
  });
  
  test('bundle size under budget', async ({ page }) => {
    const resources: number[] = [];
    
    page.on('response', response => {
      if (response.url().includes('.js')) {
        resources.push(response.headers()['content-length'] ?? 0);
      }
    });
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const totalJS = resources.reduce((a, b) => a + Number(b), 0);
    expect(totalJS).toBeLessThan(500 * 1024); // 500KB budget
  });
});
```

---

### 6. Developer Workflow

#### VS Code Integration

**.vscode/extensions.json:**
```json
{
  "recommendations": [
    "ms-playwright.playwright"
  ]
}
```

**.vscode/launch.json:**
```json
{
  "configurations": [
    {
      "name": "Debug Current Test",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["playwright", "test", "--debug", "${file}"],
      "cwd": "${workspaceFolder}/tests/e2e"
    }
  ]
}
```

**.vscode/snippets/playwright.code-snippets:**
```json
{
  "Playwright Test": {
    "prefix": "ptest",
    "body": [
      "test('$1 @$2', async ({ ${3:authedUser} }) => {",
      "  $0",
      "});"
    ]
  },
  "Playwright Describe": {
    "prefix": "pdesc",
    "body": [
      "test.describe('$1', () => {",
      "  $0",
      "});"
    ]
  }
}
```

#### Test Generation

```typescript
// scripts/generate-test.ts
// CLI tool to scaffold new test files

// Usage: npx tsx scripts/generate-test.ts --feature albums --name deletion
// Generates: tests/features/albums/deletion.spec.ts with template
```

#### Reporting

```typescript
// playwright.config.ts
reporter: [
  ['html', { open: 'never', outputFolder: 'reports/html' }],
  ['junit', { outputFile: 'reports/junit.xml' }],
  ['json', { outputFile: 'reports/results.json' }],
  // Custom Slack reporter for CI failures
  ['./utils/reporters/slack-reporter.ts'],
  // GitHub annotations
  ...(process.env.CI ? [['github']] : []),
],
```

---

## Migration Path

### Phase 1: Foundation (Week 1-2)

**Goal:** Set up new structure without breaking existing tests

1. Create new directory structure (`core/`, `components/`, `pages/`, `actions/`)
2. Extract `BaseComponent` and `BasePage` classes
3. Create unified `core/fixtures.ts` that re-exports enhanced fixtures
4. Add `@legacy` tag to all existing tests

**Deliverables:**
- [ ] New folder structure in place
- [ ] Base classes implemented
- [ ] Single fixture entry point
- [ ] All tests still passing

### Phase 2: Component Extraction (Week 3-4)

**Goal:** Break up monolithic page-objects/index.ts

1. Extract each class to its own file under `components/` or `pages/`
2. Update imports incrementally (old path → new path)
3. Add fluent return types to component methods
4. Delete `page-objects/index.ts` when empty

**Order of extraction:**
1. Dialogs (self-contained, low coupling)
2. Shared components (AlbumCard, PhotoThumbnail)
3. Panels (MembersPanel, SettingsPanel)
4. Pages (compose extracted components)

### Phase 3: Actions Layer (Week 5)

**Goal:** High-level actions for cleaner tests

1. Create `actions/auth.actions.ts` with `loginAs()`, `logout()`
2. Create `actions/album.actions.ts` with `createAlbum()`, `deleteAlbum()`
3. Refactor smoke tests to use actions
4. Document action vs page object usage

### Phase 4: Test Reorganization (Week 6)

**Goal:** Feature-based organization with tagging

1. Create `tests/smoke/` with critical path tests
2. Move tests to `tests/features/{domain}/`
3. Add `@p0`, `@p1`, `@p2` tags
4. Remove `@legacy` tags
5. Update CI to run smoke suite first

### Phase 5: Advanced Features (Week 7-8)

**Goal:** Add visual regression, a11y, performance

1. Install `@axe-core/playwright`
2. Create baseline visual snapshots
3. Add performance budget tests
4. Set up Slack/Teams failure notifications

---

## Comparison Table

| Aspect | Current State | Proposed State |
|--------|---------------|----------------|
| **File Organization** | Flat: fixtures.ts, page-objects/index.ts | Layered: core/, components/, pages/, actions/ |
| **Page Objects** | Monolithic 743-line file | Split: ~20 files, <100 lines each |
| **Fixtures** | Two files (legacy + enhanced) | Single unified fixtures.ts |
| **Test Structure** | By behavior (auth.spec, albums.spec) | By feature + priority (features/albums/crud.spec @p0) |
| **Component Reuse** | Limited (everything page-level) | High (dialogs, cards, panels reusable) |
| **Return Types** | Mostly void | Fluent (return this) for chaining |
| **API Integration** | ApiHelper class with methods | Typed ApiClient with generic request |
| **Cleanup** | TestContext.cleanup() | Same, but in fixture teardown |
| **Tagging** | None | @smoke, @p0-@p3, @a11y, @visual |
| **Smoke Suite** | Implicit (critical-flows.spec) | Explicit (tests/smoke/*.spec) |
| **Accessibility** | Manual checks | axe-core automated |
| **Visual Regression** | None | Playwright screenshot comparison |
| **Performance** | None | Budget tests in smoke suite |

---

## Implementation Priorities

### Immediate (Sprint 1)

1. **Unified fixtures file** — Eliminate dual-system confusion
2. **Extract CreateAlbumDialog** — Prove component extraction pattern
3. **Add smoke suite** — Explicit CI gate

### Short-term (Sprint 2-3)

4. **Complete component extraction** — All dialogs and panels
5. **Create actions layer** — `loginAs()`, `createAlbum()`
6. **Add test tagging** — @p0, @p1, @smoke

### Medium-term (Sprint 4-5)

7. **Feature-based reorganization** — Move all tests
8. **axe-core integration** — Automated a11y
9. **Visual regression baseline** — Key pages

### Long-term (Sprint 6+)

10. **Performance budgets** — Load time, bundle size
11. **Custom reporters** — Slack/Teams notifications
12. **Test generation CLI** — Developer productivity

---

## Trade-offs Analysis

### 1. Component Object Model vs Pure Page Objects

| Gain | Lose |
|------|------|
| Reusable components across pages | More files to navigate |
| Smaller, focused classes | Initial learning curve |
| Easier to test components in isolation | More imports per test file |
| Better matches React component structure | Slight indirection |

**Verdict:** Gain outweighs loss for a component-based UI like React.

### 2. Actions Layer vs Direct Page Objects

| Gain | Lose |
|------|------|
| Tests read like user stories | Another abstraction layer |
| Hides implementation details | Harder to debug (more layers) |
| Easier for non-QA to write tests | May hide page-level assertions |
| Single place to update workflows | |

**Verdict:** Use actions for setup/teardown, page objects for assertions.

### 3. API-First Setup vs UI-First

| Gain | Lose |
|------|------|
| 10x faster test setup | Less UI coverage during setup |
| More reliable (no UI flakiness) | May miss setup bugs |
| Parallel-friendly | Requires API maintenance |

**Verdict:** API for setup, UI for the feature under test. Hybrid wins.

### 4. Smoke Suite vs Monolithic CI

| Gain | Lose |
|------|------|
| Fast feedback (<5 min) | Delayed full coverage feedback |
| CI cost savings | Must maintain suite curation |
| Encourages test prioritization | Risk of smoke-only mentality |

**Verdict:** Smoke gates PR merge, full regression runs nightly.

### 5. axe-core vs Manual a11y Checks

| Gain | Lose |
|------|------|
| Automated, consistent | Can't catch all a11y issues |
| Runs on every PR | False positives sometimes |
| WCAG documentation | Requires baseline configuration |

**Verdict:** Automated catches 50%+ of issues. Supplement with manual audit.

---

## Appendix: Code Examples

### Example: Complete Test with New Architecture

```typescript
// tests/features/albums/creation.spec.ts
import { test, expect } from '@e2e/core/fixtures';
import { HomePage } from '@e2e/pages/home.page';

test.describe('Album Creation @feature', () => {
  test('create album via dialog @smoke @p0', async ({ authedUser }) => {
    const homePage = new HomePage(authedUser.page);
    await homePage.navigateTo();
    
    // Open dialog and create album
    const dialog = await homePage.openCreateDialog();
    await dialog.fillName('Vacation 2025');
    await dialog.submit();
    
    // Verify album appears
    await expect(homePage.getAlbumCard('Vacation 2025')).toBeVisible();
  });
  
  test('empty name shows validation error @p1', async ({ authedUser }) => {
    const homePage = new HomePage(authedUser.page);
    await homePage.navigateTo();
    
    const dialog = await homePage.openCreateDialog();
    await dialog.fillName('');
    await dialog.submit();
    
    await expect(dialog.errorMessage).toBeVisible();
    await expect(dialog.root).toBeVisible(); // Dialog stays open
  });
});
```

### Example: API + UI Hybrid Test

```typescript
// tests/features/photos/upload.spec.ts
import { test, expect } from '@e2e/core/fixtures';
import { GalleryPage } from '@e2e/pages/gallery.page';
import { generateTestImage } from '@e2e/utils/image-generator';

test.describe('Photo Upload @feature', () => {
  test('upload shows in gallery @smoke @p0', async ({ authedUser, api }) => {
    // Setup via API (fast)
    const album = await api.createAlbum('Upload Test');
    
    // Test via UI (what we're verifying)
    const gallery = new GalleryPage(authedUser.page);
    await gallery.navigateTo(album.id);
    
    await gallery.uploadPhoto(generateTestImage('small'), 'vacation.jpg');
    
    // Assert via UI
    await expect(gallery.photoCount).toBe(1);
    await expect(gallery.getPhoto(0)).toBeVisible();
    
    // Verify via API (ensure backend state)
    const photos = await api.getPhotos(album.id);
    expect(photos).toHaveLength(1);
  });
});
```

### Example: Accessibility Test

```typescript
// tests/accessibility/wcag.spec.ts
import { test, expect } from '@e2e/core/fixtures';
import AxeBuilder from '@axe-core/playwright';

test.describe('WCAG 2.1 AA Compliance @a11y', () => {
  test('login page passes automated checks', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const results = await new AxeBuilder({ page })
      .withTags(['wcag21aa'])
      .analyze();
    
    // Log violations for debugging
    if (results.violations.length > 0) {
      console.log('Violations:', JSON.stringify(results.violations, null, 2));
    }
    
    expect(results.violations).toEqual([]);
  });
});
```

---

## Conclusion

This proposal recommends evolving the E2E framework through:

1. **Component Object Model** — Breaking the monolithic page-objects file
2. **Unified fixtures** — Single entry point with auto-cleanup
3. **Actions layer** — High-level workflows for readable tests
4. **Feature-based organization** — With priority tagging
5. **Hybrid API/UI approach** — Speed + coverage balance
6. **Advanced patterns** — Visual regression, a11y, performance

The 8-week migration path allows incremental adoption without disrupting existing test suites. The immediate priority is consolidating fixtures and extracting the first component to prove the pattern.

**Estimated Effort:** 6-8 weeks for full migration  
**Risk Level:** Low (incremental, backwards-compatible)  
**Expected Benefit:** 40% reduction in test maintenance, 60% faster test authoring
