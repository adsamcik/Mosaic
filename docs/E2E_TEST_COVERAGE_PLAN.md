# Mosaic E2E Test Coverage Plan

## Executive Summary

This document provides a comprehensive end-to-end test coverage plan for Mosaic, a zero-knowledge encrypted photo gallery. The plan covers frontend user flows, backend API scenarios, cryptographic operations, and identifies gaps in current test coverage.

---

## Table of Contents

1. [Current Coverage Analysis](#current-coverage-analysis)
2. [Test Priority Matrix](#test-priority-matrix)
3. [Frontend User Flows](#frontend-user-flows)
4. [Backend API Scenarios](#backend-api-scenarios)
5. [Cryptographic E2E Scenarios](#cryptographic-e2e-scenarios)
6. [Cross-Cutting Concerns](#cross-cutting-concerns)
7. [Test Infrastructure Requirements](#test-infrastructure-requirements)
8. [Implementation Roadmap](#implementation-roadmap)

---

## Current Coverage Analysis

### Existing Test Files

| Test File | Coverage |
|-----------|----------|
| `app-load.spec.ts` | App loading, security headers (COOP/COEP), static assets, mobile responsiveness |
| `auth.spec.ts` | Login form display, password input, empty password validation |
| `albums.spec.ts` | Album list display, empty state, album creation |
| `gallery.spec.ts` | Photo grid display, upload button, keyboard navigation |
| `upload.spec.ts` | File picker, image acceptance, progress indicator |
| `accessibility.spec.ts` | Headings, alt text, button names, form labels, focus, contrast |

### Existing Infrastructure

| Component | Status |
|-----------|--------|
| `authenticatedPage` fixture | ✅ Injects Remote-User header |
| `testUser` fixture | ✅ Generates unique test users |
| `LoginPage` POM | ✅ Basic login interactions |
| `AppShellPage` POM | ✅ Album list, create/upload buttons |
| `GalleryPage` POM | ✅ Photo grid, photo selection |
| API test helpers | ✅ Create album, upload shard |

### Critical Gaps

| Gap | Impact | Priority |
|-----|--------|----------|
| **No complete login flow** | Can't test actual authentication | P0 |
| **No logout/session tests** | Security vulnerability untested | P0 |
| **No photo round-trip test** | Core feature unverified | P0 |
| **No sharing flow tests** | Collaboration untested | P0 |
| **No error scenario tests** | Failure modes unknown | P1 |
| **Soft assertions hiding failures** | False positives | P1 |

---

## Test Priority Matrix

### P0 - Critical Path (Must Have)

| ID | Test Scenario | Components | Est. Effort |
|----|---------------|------------|-------------|
| P0-1 | Complete password login → app access | Auth, Crypto Worker, Session | Medium |
| P0-2 | Logout with key wiping verification | Session, Crypto Worker | Low |
| P0-3 | Photo upload → sync → view round-trip | Upload, Crypto, Sync, Gallery | High |
| P0-4 | Album sharing between two users | Sharing, Epoch Keys, Sealed Boxes | High |
| P0-5 | Wrong password rejection | Auth, Error Handling | Low |
| P0-6 | Session idle timeout | Session Management | Medium |

### P1 - Core Features (Should Have)

| ID | Test Scenario | Components | Est. Effort |
|----|---------------|------------|-------------|
| P1-1 | Album CRUD (create, view, delete) | Albums API, AlbumList | Medium |
| P1-2 | Member management (add/remove) | Members API, Sharing | Medium |
| P1-3 | Epoch key rotation after member removal | Epochs, Crypto | High |
| P1-4 | Delta sync with version tracking | Sync Engine | Medium |
| P1-5 | Network failure during upload | Tus, Error Handling | Medium |
| P1-6 | Quota exceeded handling | Quotas, Error UI | Low |
| P1-7 | API error responses (401, 403, 404) | All Controllers | Medium |

### P2 - Extended Coverage (Nice to Have)

| ID | Test Scenario | Components | Est. Effort |
|----|---------------|------------|-------------|
| P2-1 | Large file chunking (>6MB) | Upload, Shards | Low |
| P2-2 | Upload resume after page reload | IndexedDB, Tus | Medium |
| P2-3 | Virtualized scroll performance | TanStack Virtual | Low |
| P2-4 | Offline photo viewing | OPFS, SQLite | Medium |
| P2-5 | Keyboard navigation flow | Accessibility | Low |
| P2-6 | axe-core WCAG compliance | Accessibility | Medium |
| P2-7 | Cross-tab session sync | BroadcastChannel | Medium |

### P3 - Future Features

| ID | Test Scenario | Components | Est. Effort |
|----|---------------|------------|-------------|
| P3-1 | Map view with geo clustering | MapView, Geo Worker | Medium |
| P3-2 | Photo search with FTS5 | DB Worker, Search UI | Medium |
| P3-3 | Photo lightbox/full view | PhotoViewer | Medium |
| P3-4 | Password change flow | Keychain, Key Migration | High |

---

## Frontend User Flows

### 1. Authentication Flows

#### 1.1 Complete Login Flow
```gherkin
Feature: User Authentication
  
  Scenario: Successful login with password
    Given user navigates to application root
    And user has an account with stored salt
    When user enters correct password
    And clicks "Unlock" button
    Then login form disappears
    And app shell with album list is displayed
    And crypto worker derives keys successfully
    And session is established
    
  Scenario: Failed login with wrong password
    Given user navigates to application root
    When user enters incorrect password
    And clicks "Unlock" button
    Then error message "Unable to decrypt" is displayed
    And user remains on login form
    And no session is established

  Scenario: Session idle timeout
    Given user is logged in
    When user is idle for 30 minutes
    Then user is automatically logged out
    And redirected to login form
    And session keys are wiped
```

**Test Implementation Notes:**
- Use `page.clock` for idle timeout testing
- Verify crypto worker initialization via observable UI state changes
- Check `sessionStorage` is cleared after logout

#### 1.2 Logout Flow
```gherkin
Scenario: Manual logout clears session
  Given user is logged in
  And user has viewed some photos
  When user clicks "Lock" button
  Then user is redirected to login form
  And attempting to navigate to /albums redirects to login
  And workers are terminated
```

### 2. Album Management Flows

#### 2.1 Album List
```gherkin
Scenario: View album list
  Given user is logged in
  And user has 3 albums
  When app shell loads
  Then album list displays 3 album cards
  And each card shows album name and photo count

Scenario: Empty album list
  Given user is logged in
  And user has no albums
  When app shell loads
  Then empty state message "No albums yet" is displayed
  And "Create album" prompt is visible
```

#### 2.2 Album CRUD
```gherkin
Scenario: Create new album
  Given user is logged in
  When user clicks create album button
  And enters album name "Vacation 2025"
  And confirms creation
  Then new album appears in list
  And album has epoch key generated

Scenario: Delete album
  Given user is logged in
  And user owns album "Old Photos"
  When user deletes album "Old Photos"
  Then album is removed from list
  And associated shards are marked for garbage collection

Scenario: Navigate to album gallery
  Given user is logged in
  And user has album "Family"
  When user clicks on "Family" album card
  Then gallery view displays
  And back button "← Albums" is visible
```

### 3. Photo Upload Flows

#### 3.1 Upload Process
```gherkin
Scenario: Upload single photo
  Given user is in album gallery
  When user clicks upload button
  And selects a 2MB JPEG file
  Then upload progress indicator appears
  And file is chunked and encrypted
  And shards are uploaded via Tus
  And manifest is created
  And photo appears in gallery after sync

Scenario: Upload large file (multi-shard)
  Given user is in album gallery
  When user selects a 15MB photo
  Then file is split into 3 shards
  And each shard is encrypted separately
  And all shards upload successfully
  And photo displays correctly after sync

Scenario: Upload with network failure
  Given user is in album gallery
  And network is unstable
  When user uploads a photo
  And network fails mid-upload
  Then upload retries automatically
  And eventually completes or shows error
  And partial uploads are resumable

Scenario: Upload exceeds quota
  Given user has 1MB remaining quota
  When user tries to upload 5MB photo
  Then quota exceeded error is displayed
  And upload is rejected
```

### 4. Gallery Interactions

#### 4.1 Photo Grid
```gherkin
Scenario: View photo grid
  Given user is in album with 100 photos
  Then photo grid displays with virtualization
  And only visible rows are rendered in DOM
  And scrolling loads additional photos smoothly

Scenario: Empty gallery
  Given user is in album with no photos
  Then empty state "No photos yet" is displayed
  And upload button is prominently visible
```

### 5. Album Sharing Flows

#### 5.1 Share with Another User
```gherkin
Scenario: Owner shares album with viewer
  Given Alice owns album "Shared Album"
  And Bob has identity pubkey set
  When Alice invites Bob with role "viewer"
  Then epoch key bundle is sealed for Bob
  And Bob can see "Shared Album" in their album list
  And Bob can view photos in album
  And Bob cannot upload to album

Scenario: Remove member and rotate keys
  Given album has members: Alice (owner), Bob (editor), Carol (viewer)
  When Alice removes Carol
  And Alice rotates epoch keys
  Then new epoch is created
  And new keys distributed to Alice and Bob only
  And Carol no longer sees album in list
  And Carol cannot decrypt new photos
```

---

## Backend API Scenarios

### 1. Authentication & Authorization

| Scenario | Method | Endpoint | Expected | Status |
|----------|--------|----------|----------|--------|
| Valid Remote-User creates user | GET | /api/users/me | 200 + user object | ⬜ |
| Missing Remote-User header | GET | /api/users/me | 401 Unauthorized | ⬜ |
| Untrusted IP rejected | GET | /api/users/me | 401 Unauthorized | ⬜ |
| Invalid Remote-User format | GET | /api/users/me | 400 Bad Request | ⬜ |

### 2. Album Operations

| Scenario | Method | Endpoint | Expected | Status |
|----------|--------|----------|----------|--------|
| Create album | POST | /api/albums | 201 + album | ⬜ |
| List user's albums | GET | /api/albums | 200 + array | ⬜ |
| Get album details | GET | /api/albums/{id} | 200 + album | ⬜ |
| Get album (not member) | GET | /api/albums/{id} | 403 Forbidden | ⬜ |
| Delete album (owner) | DELETE | /api/albums/{id} | 204 | ⬜ |
| Delete album (not owner) | DELETE | /api/albums/{id} | 403 Forbidden | ⬜ |
| Sync from version 0 | GET | /api/albums/{id}/sync?since=0 | 200 + manifests | ⬜ |
| Incremental sync | GET | /api/albums/{id}/sync?since=5 | 200 + delta | ⬜ |

### 3. Member Management

| Scenario | Method | Endpoint | Expected | Status |
|----------|--------|----------|----------|--------|
| List members | GET | /api/albums/{id}/members | 200 + array | ⬜ |
| Invite member (owner) | POST | /api/albums/{id}/members | 201 + member | ⬜ |
| Invite member (editor) | POST | /api/albums/{id}/members | 201 (allowed) | ⬜ |
| Invite member (viewer) | POST | /api/albums/{id}/members | 403 Forbidden | ⬜ |
| Invite non-existent user | POST | /api/albums/{id}/members | 404 Not Found | ⬜ |
| Invite duplicate member | POST | /api/albums/{id}/members | 409 Conflict | ⬜ |
| Remove member | DELETE | /api/albums/{id}/members/{userId} | 204 | ⬜ |
| Remove owner | DELETE | /api/albums/{id}/members/{ownerId} | 400 Bad Request | ⬜ |

### 4. Epoch Keys

| Scenario | Method | Endpoint | Expected | Status |
|----------|--------|----------|----------|--------|
| Get epoch keys | GET | /api/albums/{id}/keys | 200 + array | ⬜ |
| Create epoch key | POST | /api/albums/{id}/keys | 201 | ⬜ |
| Duplicate key | POST | /api/albums/{id}/keys | 409 Conflict | ⬜ |
| Rotate epoch | POST | /api/albums/{id}/epochs/{n}/rotate | 200 | ⬜ |
| Rotate to lower epoch | POST | /api/albums/{id}/epochs/{n}/rotate | 400 Bad Request | ⬜ |

### 5. Manifests & Shards

| Scenario | Method | Endpoint | Expected | Status |
|----------|--------|----------|----------|--------|
| Create manifest | POST | /api/manifests | 201 + manifest | ⬜ |
| Create manifest (viewer) | POST | /api/manifests | 403 Forbidden | ⬜ |
| Get manifest | GET | /api/manifests/{id} | 200 + manifest | ⬜ |
| Delete manifest | DELETE | /api/manifests/{id} | 204 | ⬜ |
| Download shard | GET | /api/shards/{id} | 200 + binary | ⬜ |
| Download shard (no access) | GET | /api/shards/{id} | 403 Forbidden | ⬜ |

### 6. Tus Upload

| Scenario | Method | Endpoint | Expected | Status |
|----------|--------|----------|----------|--------|
| Create upload | POST | /api/files | 201 + Location | ⬜ |
| Upload chunk | PATCH | /api/files/{id} | 204 | ⬜ |
| Complete upload | PATCH | /api/files/{id} | 204 + shard created | ⬜ |
| Upload exceeds quota | POST | /api/files | Quota error | ⬜ |
| Upload exceeds 6MB | POST | /api/files | 413 Too Large | ⬜ |

---

## Cryptographic E2E Scenarios

### Verification Strategy

Since E2E tests should treat the app as a black box, verify crypto correctness through **observable behavior**:

| Crypto Property | Observable Behavior |
|-----------------|---------------------|
| Encryption works | Uploaded photo displays correctly after sync |
| Decryption works | Downloaded photo matches original |
| Integrity works | Corrupted data shows error, not garbage |
| Signing works | Synced data appears; tampered data rejected |
| Key derivation works | Same password = same access across devices |
| Key wiping works | After logout, can't access data without password |

### Test Scenarios

#### 1. Password-Based Key Derivation
```gherkin
Scenario: Same password unlocks data
  Given user logged in on Device A
  And uploaded photo "test.jpg"
  When user logs in on Device B (incognito) with same password
  Then user sees "test.jpg" in album

Scenario: Wrong password cannot access data
  Given user has encrypted data
  When user enters wrong password
  Then decryption fails gracefully
  And error message displayed
  And no data exposed
```

#### 2. Photo Encryption Round-Trip
```gherkin
Scenario: Photo encrypts and decrypts correctly
  Given user uploads known test image (1x1 red pixel)
  When photo syncs and displays in gallery
  Then displayed photo matches original exactly
  And network traffic shows encrypted (not JPEG magic bytes)

Scenario: Large photo chunks correctly
  Given user uploads 15MB photo
  Then photo is split into 3 shards (6MB max)
  And each shard encrypted with same epoch key
  And photo reassembles correctly on view
```

#### 3. Sharing & Sealed Boxes
```gherkin
Scenario: Shared album accessible to recipient
  Given Alice shares album with Bob
  When Bob logs in
  Then Bob sees shared album in list
  And Bob can view Alice's photos

Scenario: Revoked member loses access
  Given Carol was member of shared album
  When owner removes Carol
  And owner rotates epoch keys
  Then Carol no longer sees album
  And Carol cannot decrypt new photos
```

#### 4. Key Wiping
```gherkin
Scenario: Logout clears all keys
  Given user is logged in with data
  When user clicks logout
  Then attempting to access data fails
  And must re-enter password to access

Scenario: Idle timeout wipes keys
  Given user is logged in
  When idle for 30+ minutes
  Then automatic logout occurs
  And keys are wiped from memory
```

---

## Cross-Cutting Concerns

### Accessibility Testing

| Test | axe-core Rule | Status |
|------|---------------|--------|
| Heading hierarchy | heading-order | ⬜ |
| Image alt text | image-alt | ⬜ |
| Button accessible names | button-name | ⬜ |
| Form label associations | label | ⬜ |
| Color contrast (4.5:1) | color-contrast | ⬜ |
| Focus indicators | focus-visible | ⬜ |
| Keyboard navigation | keyboard | ⬜ |
| ARIA live regions | aria-live | ⬜ |

### Performance Testing

| Metric | Target | Test Approach |
|--------|--------|---------------|
| Time to Interactive | < 3s | Measure on slow 3G |
| First Contentful Paint | < 1.5s | Lighthouse CI |
| Virtualized scroll FPS | 60fps | Performance API |
| 10K photos load | < 2s | Synthetic data test |
| Upload throughput | > 5MB/s | Large file upload |

### Security Testing

| Test | Description | Status |
|------|-------------|--------|
| COOP/COEP headers | Required for SharedArrayBuffer | ✅ |
| CSP header validation | Prevent XSS | ⬜ |
| No secrets in DOM | Keys not in document | ⬜ |
| No secrets in console | Keys not logged | ⬜ |
| Session fixation | New session on login | ⬜ |
| CSRF protection | Token validation | ⬜ |

### Error Handling

| Error Type | Expected Behavior | Status |
|------------|-------------------|--------|
| Network timeout | Retry with backoff, show error | ⬜ |
| 401 Unauthorized | Redirect to login | ⬜ |
| 403 Forbidden | Show access denied message | ⬜ |
| 404 Not Found | Show not found page | ⬜ |
| 500 Server Error | Show generic error, allow retry | ⬜ |
| Crypto failure | Show specific error, no data corruption | ⬜ |
| OPFS quota exceeded | Show storage full message | ⬜ |

---

## Test Infrastructure Requirements

### New Page Objects Needed

```typescript
// AlbumDetailPage - album view with photo management
class AlbumDetailPage {
  async waitForLoad(): Promise<void>
  async getPhotoCount(): Promise<number>
  async uploadPhoto(filePath: string): Promise<void>
  async deletePhoto(index: number): Promise<void>
  async openMemberManagement(): Promise<void>
}

// MemberManagementModal - sharing UI
class MemberManagementModal {
  async inviteMember(userId: string, role: 'viewer' | 'editor'): Promise<void>
  async removeMember(userId: string): Promise<void>
  async getMembers(): Promise<Member[]>
}

// PhotoViewerPage - lightbox/full view
class PhotoViewerPage {
  async waitForLoad(): Promise<void>
  async getImageDimensions(): Promise<{width: number, height: number}>
  async navigateNext(): Promise<void>
  async navigatePrevious(): Promise<void>
  async close(): Promise<void>
}
```

### New Fixtures Needed

```typescript
// Logged-in user with complete crypto initialization
const loggedInPage = test.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginWithPassword(page, 'testpassword');
    await use(page);
  }
});

// Pre-populated album with test photos
const albumWithPhotos = test.extend<{ albumId: string }>({
  albumId: async ({ authenticatedPage }, use) => {
    const albumId = await createAlbumWithPhotos(authenticatedPage, 5);
    await use(albumId);
  }
});

// Two authenticated users for sharing tests
const twoUserContext = test.extend<{ alice: Page, bob: Page }>({
  alice: async ({ browser }, use) => { /* ... */ },
  bob: async ({ browser }, use) => { /* ... */ }
});
```

### Test Utilities Needed

```typescript
// Generate test images of various sizes
function generateTestImage(
  width: number, 
  height: number, 
  format: 'png' | 'jpeg'
): Buffer

// Wait for crypto worker to complete operation
async function waitForCryptoReady(page: Page): Promise<void>

// Wait for sync engine to stabilize
async function waitForSync(page: Page): Promise<void>

// Inject network conditions
async function setNetworkConditions(
  page: Page, 
  conditions: 'offline' | 'slow-3g' | 'fast-3g'
): Promise<void>

// Run axe-core accessibility scan
async function checkAccessibility(page: Page): Promise<AxeResults>

// Mock specific API failures
async function mockApiError(
  page: Page, 
  endpoint: string, 
  status: number
): Promise<void>
```

### Mock Requirements

| Mock | Purpose | Implementation |
|------|---------|----------------|
| Fast Crypto Worker | Skip slow Argon2id for most tests | Reduce iterations to 1 |
| OPFS Mock | Tests without real filesystem | Memory-based implementation |
| Tus Mock | Predictable upload behavior | Immediate success/failure |
| Network Conditions | Offline/slow testing | Playwright route interception |
| Time Mock | Idle timeout testing | `page.clock` API |

---

## Implementation Roadmap

### Phase 1: Critical Path (Week 1-2)

1. **Fix existing test issues**
   - Remove soft assertions (`|| true` patterns)
   - Add proper waits and assertions
   - Fix flaky tests

2. **Implement P0 tests**
   - Complete login/logout flow
   - Photo upload → view round-trip
   - Wrong password rejection

3. **Create core fixtures**
   - `loggedInPage` with crypto initialization
   - `albumWithPhotos` with test data

### Phase 2: Core Features (Week 3-4)

1. **Implement P1 tests**
   - Album CRUD operations
   - Member management
   - Error handling scenarios

2. **Add sharing tests**
   - Two-user context fixture
   - Share/revoke flows

3. **API error coverage**
   - 401, 403, 404 scenarios
   - Network failure handling

### Phase 3: Extended Coverage (Week 5-6)

1. **Implement P2 tests**
   - Large file handling
   - Performance benchmarks
   - Accessibility with axe-core

2. **Add remaining page objects**
   - PhotoViewerPage
   - MemberManagementModal

3. **Security testing**
   - CSP validation
   - Secret exposure checks

### Phase 4: Polish & CI Integration (Week 7-8)

1. **CI pipeline improvements**
   - Parallel test execution
   - Test sharding
   - Failure screenshots/videos

2. **Documentation**
   - Test writing guide
   - Fixture documentation
   - Troubleshooting guide

3. **Monitoring**
   - Test flakiness tracking
   - Coverage reporting
   - Performance trends

---

## Appendix: Test Data Requirements

### Test Images

| File | Size | Purpose |
|------|------|---------|
| `1x1-red.png` | ~70B | Minimal valid image |
| `100x100-gradient.jpg` | ~2KB | Small JPEG |
| `1920x1080-photo.jpg` | ~500KB | Typical photo |
| `6MB-exactly.jpg` | 6MB | Max shard size |
| `15MB-large.jpg` | 15MB | Multi-shard test |

### Test Users

| User | Role | Purpose |
|------|------|---------|
| `alice@test` | Owner | Primary test user |
| `bob@test` | Editor | Sharing recipient |
| `carol@test` | Viewer | Read-only member |
| `dave@test` | Stranger | Unauthorized access tests |

### Test Albums

| Album | Contents | Purpose |
|-------|----------|---------|
| `empty-album` | 0 photos | Empty state testing |
| `small-album` | 5 photos | Basic functionality |
| `large-album` | 1000 photos | Virtualization testing |
| `shared-album` | 10 photos | Sharing flow testing |

---

## Checklist Summary

### P0 - Must Have Before Release
- [ ] Complete login flow with crypto initialization
- [ ] Logout with key wiping
- [ ] Photo upload → gallery round-trip
- [ ] Album sharing between users
- [ ] Wrong password rejection
- [ ] Session idle timeout

### P1 - Should Have
- [ ] Album CRUD operations
- [ ] Member add/remove
- [ ] Epoch key rotation
- [ ] Delta sync
- [ ] Network error handling
- [ ] Quota enforcement
- [ ] API error responses

### P2 - Nice to Have
- [ ] Large file chunking
- [ ] Upload resume
- [ ] Virtualization performance
- [ ] Offline viewing
- [ ] Full accessibility compliance
- [ ] Cross-tab sync

---

*Document generated: 2024-12-27*
*Based on analysis of: frontend components, backend API, crypto library, existing E2E tests*
