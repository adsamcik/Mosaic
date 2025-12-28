# Mosaic E2E Tests

End-to-end tests for the Mosaic zero-knowledge encrypted photo gallery using [Playwright](https://playwright.dev/).

## Quick Start

```bash
# Install dependencies
npm install

# Install browsers (downloads ~500MB of bundled browsers)
npx playwright install

# Run all tests
npm test

# Run tests with UI
npm run test:ui
```

## Browser Configuration

Tests run on **3 browser configurations** defined in `playwright.config.ts`:

| Project | Browser | Description |
|---------|---------|-------------|
| `chromium` | Chromium | Desktop Chrome-like browser |
| `firefox` | Firefox | Desktop Firefox |
| `mobile-chrome` | Chromium | Mobile emulation (Pixel 5 viewport) |

### How Browser Testing Works

Playwright downloads its **own bundled browsers** - you don't need Chrome or Firefox installed locally. The `npx playwright install` command downloads:
- Chromium (~170MB)
- Firefox (~200MB)  
- WebKit (~120MB)

These are stored in a cache folder (usually `~/.cache/ms-playwright` on Linux/Mac or `%LOCALAPPDATA%\ms-playwright` on Windows).

### Mobile Emulation

The `mobile-chrome` project is **NOT actual mobile Chrome**. It's Chromium configured to emulate a Pixel 5:

```typescript
{
  viewport: { width: 393, height: 851 },
  userAgent: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) ...',
  deviceScaleFactor: 2.75,
  isMobile: true,
  hasTouch: true,
}
```

This tests responsive design and touch interactions but is not equivalent to testing on a real Android device.

### Running Specific Browsers

```bash
# Run only on Chromium (fastest)
npx playwright test --project=chromium

# Run only on Firefox
npx playwright test --project=firefox

# Run only mobile tests
npx playwright test --project=mobile-chrome

# Run on multiple specific browsers
npx playwright test --project=chromium --project=firefox
```

## Test Structure

```
tests/e2e/
├── fixtures.ts              # Test fixtures, page objects, API helpers
├── playwright.config.ts     # Playwright configuration
├── package.json
└── tests/
    ├── critical-flows.spec.ts   # P0 priority: auth, upload, sharing
    ├── photo-workflow.spec.ts   # Photo lifecycle: upload, view, delete
    ├── sharing-workflow.spec.ts # Two-user collaboration tests
    ├── sync-workflow.spec.ts    # Multi-session sync, offline
    ├── security-errors.spec.ts  # Auth validation, error handling
    ├── auth.spec.ts             # Authentication tests
    ├── albums.spec.ts           # Album management tests
    ├── gallery.spec.ts          # Gallery view tests
    ├── upload.spec.ts           # Upload functionality tests
    ├── app-load.spec.ts         # App loading, security headers
    └── accessibility.spec.ts    # Accessibility compliance
```

## Test Categories

### P0 - Critical Path (Must Pass)

| Test | Description |
|------|-------------|
| P0-1 | Complete password login initializes crypto |
| P0-2 | Logout clears session and wipes keys |
| P0-3 | Photo upload → sync → view round-trip |
| P0-4 | Album sharing between two users |
| P0-5 | Wrong password rejection |

### P1 - Core Features

- Album CRUD operations
- Member management (add/remove)
- Error handling (network, validation)
- Delta sync

### P2 - Extended Coverage

- Offline resilience
- Keyboard navigation
- Accessibility compliance

## Fixtures

### `authenticatedPage`

A page with API authentication headers injected:

```typescript
test('example', async ({ authenticatedPage, testUser }) => {
  await authenticatedPage.goto('/');
  // API calls will include Remote-User header
});
```

### `testUser`

A unique user ID generated for each test:

```typescript
test('example', async ({ testUser }) => {
  // testUser = "e2e-1703789123456-abc123@test.local"
});
```

### `twoUserContext`

Two authenticated browser contexts for sharing tests:

```typescript
test('sharing', async ({ twoUserContext }) => {
  const { alice, bob, aliceUser, bobUser } = twoUserContext;
  // alice and bob are separate Page instances
});
```

## Parallel-Safe Test Framework (NEW)

The E2E test suite now includes a parallel-safe framework for running tests reliably on a single backend instance.

### Framework Features

- **Complete Test Isolation**: Each test gets unique users and resources
- **Automatic Cleanup**: Resources are cleaned up after each test
- **Collision-Free IDs**: Test IDs include worker index, timestamp, and random suffix
- **Enhanced Page Objects**: Full coverage of all UI components
- **Wait Utilities**: Reliable, condition-based waits

### New Fixtures

#### `testContext`

Parallel-safe test context with automatic cleanup:

```typescript
test('example', async ({ testContext }) => {
  const user = await testContext.createAuthenticatedUser('alice');
  const albumName = testContext.generateAlbumName('My Album');
  
  await loginUser(user, TEST_PASSWORD);
  // ... test code
  
  // cleanup() is called automatically after test
});
```

#### `collaboration`

Two-user context for sharing tests:

```typescript
test('sharing', async ({ collaboration }) => {
  const { alice, bob, trackAlbum, generateAlbumName } = collaboration;
  
  await loginUser(alice, TEST_PASSWORD);
  await loginUser(bob, TEST_PASSWORD);
  
  // Both users have isolated contexts
});
```

### Enhanced Helpers

```typescript
import {
  loginUser,           // Full login flow
  createAlbumViaUI,    // Create album through UI
  uploadPhoto,         // Upload photo to current album
  navigateToAlbum,     // Navigate to album by name or index
} from '../fixtures-enhanced';
```

## Page Objects

### `LoginPage`

```typescript
const loginPage = new LoginPage(page);
await loginPage.waitForForm();
await loginPage.login('password');
await loginPage.expectLoginSuccess();
```

### `AppShell`

```typescript
const appShell = new AppShell(page);
await appShell.waitForLoad();
await appShell.createAlbum();
await appShell.logout();
```

### `GalleryPage`

```typescript
const gallery = new GalleryPage(page);
await gallery.waitForLoad();
await gallery.uploadPhoto(imageBuffer, 'photo.png');
await gallery.expectPhotoCount(5);
```

### `ApiHelper`

Direct API calls for test setup:

```typescript
const api = new ApiHelper();
const album = await api.createAlbum(testUser);
await api.deleteAlbum(testUser, album.id);
```

## Running Tests

### All Tests

```bash
npm test                    # Run all tests headlessly
npm run test:headed         # Run with browser visible
npm run test:ui             # Open interactive UI mode
npm run test:debug          # Debug mode with inspector
```

### Specific Tests

```bash
# Run a specific test file
npx playwright test critical-flows.spec.ts

# Run tests matching a pattern
npx playwright test -g "upload"

# Run a specific test by line number
npx playwright test critical-flows.spec.ts:25
```

### Debug Mode

```bash
# Debug with Playwright Inspector
npx playwright test --debug

# Debug a specific test
npx playwright test critical-flows.spec.ts:25 --debug

# Run with headed browser and slow motion
npx playwright test --headed --slowmo=500
```

## Test Reports

After running tests:

```bash
# View HTML report
npm run report

# Reports are saved to:
# - playwright-report/   (HTML report)
# - results/junit.xml    (JUnit XML for CI)
```

## CI Configuration

Tests are configured for CI with:

```typescript
// playwright.config.ts
{
  forbidOnly: !!process.env.CI,  // Fail if test.only left in code
  retries: process.env.CI ? 2 : 0, // Retry failed tests in CI
  workers: process.env.CI ? 2 : undefined, // Limit parallelism in CI
}
```

### Required Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BASE_URL` | Frontend URL | `http://localhost:5173` |
| `API_URL` | Backend API URL | `http://localhost:8080` |
| `CI` | CI mode flag | - |

## Writing New Tests

### Test Template

```typescript
import { expect, test, LoginPage, AppShell, GalleryPage, ApiHelper, TEST_CONSTANTS, generateTestImage } from '../fixtures';

test.describe('Feature Name', () => {
  const apiHelper = new ApiHelper();

  test('should do something', async ({ authenticatedPage, testUser }) => {
    // Setup via API
    const album = await apiHelper.createAlbum(testUser);

    // Navigate and login
    await authenticatedPage.goto('/');
    const loginPage = new LoginPage(authenticatedPage);
    await loginPage.waitForForm();
    await loginPage.login(TEST_CONSTANTS.PASSWORD);
    await loginPage.expectLoginSuccess();

    // Test the feature
    const appShell = new AppShell(authenticatedPage);
    await appShell.waitForLoad();
    
    // Assertions
    await expect(authenticatedPage.getByTestId('album-card')).toBeVisible();
  });
});
```

### Best Practices

1. **Use fixtures** - Don't create raw browser contexts
2. **Wait for elements** - Use `expect().toBeVisible()` not `waitForSelector()`
3. **Retry assertions** - Use `expect.toPass()` for eventual consistency
4. **Handle missing UI** - Check if elements exist before interacting
5. **Clean up** - Tests should be independent, don't rely on prior state

## Troubleshooting

### Browsers Not Installed

```
Error: browserType.launch: Executable doesn't exist
```

Run `npx playwright install` to download browsers.

### Tests Timeout

- Increase timeout in config: `timeout: 60000`
- Check if backend is running
- Check if frontend is running

### SharedArrayBuffer Errors

The app requires specific security headers. Ensure the dev server sends:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Flaky Tests

1. Add `test.slow()` for inherently slow tests
2. Use `expect().toPass({ timeout })` for retries
3. Check for race conditions in test setup
