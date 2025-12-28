# SPEC: Parallel-Safe E2E Test Framework

> **Status:** Draft
> **Author:** Copilot
> **Date:** 2025-12-28

## 1. Overview

Design a reliable, reusable E2E test framework for Mosaic that enables:
- Running tests in parallel on a single backend instance and database
- Complete test isolation (no cross-test contamination)
- UI-first testing with minimal API seeding
- Easy cleanup regardless of test success/failure

## 2. Current State Analysis

### Existing Infrastructure
- Playwright with 3 browser projects (chromium, firefox, mobile-chrome)
- Basic fixtures: `authenticatedPage`, `testUser`, `twoUserContext`
- Page objects: `LoginPage`, `AppShell`, `GalleryPage`, `CreateAlbumDialogPage`
- `ApiHelper` for direct API calls
- `LogCollector` for debugging

### Problems with Current Approach
1. **Non-deterministic user IDs**: `e2e-${Date.now()}-random` can collide in high-frequency parallel tests
2. **No cleanup hooks**: Test data accumulates in the database
3. **Shared state risks**: Tests that modify global settings can affect others
4. **Inconsistent wait patterns**: Some tests use arbitrary timeouts

## 3. Parallel Test Isolation Strategy

### 3.1 Unique Test Identifiers

Each test gets a globally unique identifier combining:
- Worker index (Playwright's `test.info().parallelIndex`)
- Test file hash
- Timestamp with nanoseconds
- Random suffix

```typescript
function generateTestId(): string {
  const workerIndex = test.info().parallelIndex;
  const timestamp = performance.now().toString().replace('.', '');
  const random = crypto.randomUUID().slice(0, 8);
  return `w${workerIndex}-${timestamp}-${random}`;
}
```

### 3.2 User Isolation Pattern

Each test creates users with the test ID embedded:
```
test-{testId}-alice@e2e.local
test-{testId}-bob@e2e.local
```

This ensures:
- No user collisions between parallel tests
- Easy identification of test-generated users for cleanup
- Traceable back to specific test runs

### 3.3 Album/Photo Naming Convention

All test-created resources include the test ID:
```
Album: "Test Album {testId}"
Photo: "photo-{testId}-001.png"
```

### 3.4 Test Cleanup Strategy

**Option A: Self-Cleaning Tests (Preferred)**
Each test cleans up its own resources in `afterEach`:
- Delete albums created during test
- User records can be left (they don't affect other tests)

**Option B: Global Cleanup Job**
A database cleanup script runs periodically:
```sql
DELETE FROM albums WHERE name LIKE 'Test Album w%';
DELETE FROM users WHERE auth_sub LIKE 'test-%@e2e.local';
```

**Implementation**: Use both - immediate cleanup for reliability, global cleanup as fallback.

## 4. Framework Architecture

```
tests/e2e/
├── framework/
│   ├── test-context.ts        # TestContext class with isolation
│   ├── test-data-factory.ts   # Factory for creating test data
│   ├── database-helper.ts     # Direct DB seeding/cleanup
│   ├── wait-utils.ts          # Reliable wait patterns
│   └── index.ts               # Barrel export
├── page-objects/
│   ├── login-page.ts
│   ├── app-shell.ts
│   ├── gallery-page.ts
│   ├── members-panel.ts
│   ├── settings-page.ts
│   ├── lightbox.ts
│   └── admin-page.ts
├── fixtures.ts                 # Enhanced fixtures using framework
├── playwright.config.ts
└── tests/
    └── ... (test files)
```

## 5. Core Components

### 5.1 TestContext

Central orchestrator for test isolation:

```typescript
interface TestContext {
  testId: string;
  workerIndex: number;
  
  // User management
  createUser(name: string): Promise<TestUser>;
  getUser(name: string): TestUser;
  
  // Resource tracking
  trackAlbum(id: string): void;
  trackResource(type: string, id: string): void;
  
  // Cleanup
  cleanup(): Promise<void>;
}
```

### 5.2 TestDataFactory

High-level factory for common test scenarios:

```typescript
interface TestDataFactory {
  // Create a user, log them in, and return their page
  createAuthenticatedUser(name: string): Promise<AuthenticatedUser>;
  
  // Create an album via UI (not API)
  createAlbumViaUI(page: Page, name: string): Promise<string>;
  
  // Create an album via API (faster for setup)
  createAlbumViaAPI(user: TestUser): Promise<string>;
  
  // Upload a photo via UI
  uploadPhotoViaUI(page: Page, albumId: string): Promise<string>;
  
  // Generate test image
  generateTestImage(size?: 'tiny' | 'small' | 'medium'): Buffer;
}
```

### 5.3 Wait Utilities

Reliable, condition-based waits:

```typescript
// Wait for condition with polling
async waitForCondition(
  condition: () => Promise<boolean>,
  options?: { timeout: number; interval: number; message: string }
): Promise<void>;

// Wait for element to stabilize (no layout shifts)
async waitForStable(locator: Locator): Promise<void>;

// Wait for all network requests to complete
async waitForNetworkIdle(page: Page): Promise<void>;

// Wait for crypto worker to initialize
async waitForCryptoReady(page: Page): Promise<void>;
```

## 6. Enhanced Fixtures

### 6.1 `isolatedTest` Fixture

Replaces `authenticatedPage` with full isolation:

```typescript
test('example', async ({ isolatedTest }) => {
  const { testId, createUser, cleanup } = isolatedTest;
  
  const alice = await createUser('alice');
  await alice.page.goto('/');
  // ... test code
  
  // cleanup() is called automatically in afterEach
});
```

### 6.2 `collaborationTest` Fixture

For two-user scenarios with proper isolation:

```typescript
test('sharing works', async ({ collaborationTest }) => {
  const { alice, bob, testId } = collaborationTest;
  
  // Both users are already logged in
  await alice.page.goto('/albums');
  await bob.page.goto('/');
  // ... test sharing between users
});
```

## 7. Page Object Enhancements

### 7.1 MembersPanel

```typescript
class MembersPanel {
  async open(): Promise<void>;
  async inviteMember(userId: string, role: 'viewer' | 'editor'): Promise<void>;
  async removeMember(userId: string): Promise<void>;
  async getMemberList(): Promise<Member[]>;
  async close(): Promise<void>;
}
```

### 7.2 LightboxPage

```typescript
class LightboxPage {
  async waitForImage(): Promise<void>;
  async goToNext(): Promise<void>;
  async goToPrevious(): Promise<void>;
  async getPhotoMetadata(): Promise<PhotoMetadata>;
  async close(): Promise<void>;
  async deleteCurrentPhoto(): Promise<void>;
}
```

### 7.3 SettingsPage

```typescript
class SettingsPage {
  async open(): Promise<void>;
  async setTheme(theme: 'light' | 'dark' | 'system'): Promise<void>;
  async setAutoSync(enabled: boolean): Promise<void>;
  async setKeyCacheDuration(minutes: number): Promise<void>;
  async getSettingValue(name: string): Promise<string>;
}
```

## 8. Configuration Updates

### 8.1 Playwright Config for Parallel Execution

```typescript
export default defineConfig({
  // Enable full parallelism
  fullyParallel: true,
  
  // Worker count: 4 for local, 2 for CI
  workers: process.env.CI ? 2 : 4,
  
  // Retry failed tests
  retries: process.env.CI ? 2 : 1,
  
  // Global setup for database/backend readiness
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  
  // Timeouts
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  
  // Project isolation
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
```

### 8.2 Global Setup

```typescript
// global-setup.ts
export default async function globalSetup() {
  // 1. Wait for backend to be healthy
  await waitForBackendHealth();
  
  // 2. Run database cleanup for stale test data
  await cleanupStaleTestData();
  
  // 3. Verify critical endpoints
  await verifyApiEndpoints();
}
```

## 9. Verification Plan

### 9.1 Framework Tests

| Test | Description |
|------|-------------|
| isolation-001 | Two parallel tests don't share users |
| isolation-002 | Album created in test A not visible in test B |
| cleanup-001 | Resources deleted after test completes |
| cleanup-002 | Failed test still triggers cleanup |

### 9.2 New E2E Tests to Write

| Priority | Test | Description |
|----------|------|-------------|
| P0 | full-upload-flow | Upload → encrypt → sync → view → download |
| P0 | session-restore | Key cache restores session after reload |
| P1 | album-rename | Rename album via UI |
| P1 | album-delete | Delete album with confirmation |
| P1 | photo-delete | Delete photo with confirmation |
| P1 | member-invite-viewer | Invite member with viewer role |
| P1 | member-invite-editor | Invite member with editor role |
| P1 | member-remove | Remove member from album |
| P1 | settings-theme | Change theme setting |
| P1 | settings-cache | Change key cache duration |
| P2 | search-photos | Search photos by name |
| P2 | keyboard-navigation | Navigate gallery with keyboard |
| P2 | lightbox-navigation | Navigate photos in lightbox |
| P2 | drag-drop-upload | Upload via drag and drop |
| P2 | multi-photo-upload | Upload multiple photos at once |

## 10. ZK Invariants

- **Test users**: Use unique `Remote-User` headers per test
- **No plaintext exposure**: Even test photos go through full encryption
- **Key isolation**: Each test user has independent key hierarchy
- **No server inspection**: API helper never examines encrypted content

## 11. Implementation Phases

### Phase 1: Core Framework (This PR)
- TestContext and TestDataFactory
- Enhanced fixtures
- Updated playwright.config.ts
- 5 new P0/P1 tests

### Phase 2: Full Page Objects
- All page object implementations
- AdminPage for admin tests

### Phase 3: Comprehensive Tests
- Complete P1 coverage
- P2 accessibility and keyboard tests
