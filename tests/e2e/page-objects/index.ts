/**
 * Page Objects for E2E Tests
 *
 * Page Object Model implementations for all major UI components.
 * These encapsulate UI interactions and provide a clean API for tests.
 */

import { type Page, type Locator, expect } from '@playwright/test';

/**
 * Default test password
 */
const TEST_PASSWORD = 'test-password-e2e-2024';

/**
 * Login Page Object
 *
 * Supports both LocalAuth and ProxyAuth modes:
 * - LocalAuth: username/password with registration option
 * - ProxyAuth: password-only (user identity from Remote-User header)
 */
export class LoginPage {
  readonly page: Page;
  readonly form: Locator;
  readonly passwordInput: Locator;
  readonly usernameInput: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;
  readonly confirmPasswordInput: Locator;
  readonly createAccountButton: Locator;
  readonly modeToggleButton: Locator;
  readonly loginForm: Locator;

  constructor(page: Page) {
    this.page = page;
    this.form = page.getByTestId('login-form');
    this.loginForm = page.getByTestId('login-form');
    // Support both English and Czech labels
    this.passwordInput = page.getByLabel(/^(Password|Heslo)$/i);
    this.usernameInput = page.getByLabel(/username|uživatelské jméno/i);
    this.loginButton = page.getByRole('button', { name: /unlock|sign in|přihlásit se|odemknout/i });
    this.errorMessage = page.getByRole('alert');
    this.confirmPasswordInput = page.getByLabel(/confirm password|potvrzení hesla/i);
    this.createAccountButton = page.getByRole('button', { name: /create account|vytvořit účet/i }).first();
    this.modeToggleButton = page.getByRole('button', {
      name: /don't have an account|already have an account|nemáte účet|máte účet/i,
    });
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  async waitForForm(timeout = 30000): Promise<void> {
    // Wait for the form container to be visible
    await expect(this.form).toBeVisible({ timeout });
    
    // Wait for the form to finish loading (checkingAuthMode = false)
    // The password input only appears after auth mode is determined
    await expect(this.passwordInput).toBeVisible({ timeout });
  }

  /**
   * Login with password only (for ProxyAuth mode).
   * If LocalAuth mode is detected (username field visible), this will fail.
   * Use loginWithUsername() or the register() method for LocalAuth mode.
   */
  async login(password: string = TEST_PASSWORD): Promise<void> {
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  /**
   * Login with username and password (for LocalAuth mode).
   * If username field is not visible (ProxyAuth mode), only password is entered.
   */
  async loginWithUsername(username: string, password: string = TEST_PASSWORD): Promise<void> {
    // For LocalAuth mode with username field
    if (await this.usernameInput.isVisible().catch(() => false)) {
      await this.usernameInput.clear();
      await this.usernameInput.fill(username);
    }
    await this.passwordInput.clear();
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  /**
   * Login with auto-detection of auth mode.
   * If LocalAuth (username field visible) and username provided, fills username.
   * Otherwise just fills password.
   */
  async loginAuto(password: string = TEST_PASSWORD, username?: string): Promise<void> {
    // Check if LocalAuth mode (username field visible)
    const isLocalAuth = await this.usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    
    if (isLocalAuth && username) {
      await this.usernameInput.fill(username);
    }
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  async expectLoginSuccess(timeout = 60000): Promise<void> {
    await expect(this.page.getByTestId('app-shell')).toBeVisible({ timeout });
  }

  async expectError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 10000 });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }

  async expectFormVisible(): Promise<void> {
    await expect(this.form).toBeVisible({ timeout: 30000 });
  }

  /**
   * Alias for expectFormVisible for backward compatibility
   */
  async expectLoginFormVisible(): Promise<void> {
    await this.expectFormVisible();
  }

  /**
   * Alias for expectError for backward compatibility
   */
  async expectErrorMessage(text?: string | RegExp): Promise<void> {
    await this.expectError(text);
  }

  /**
   * Switch to registration mode (LocalAuth only)
   * Only switches if not already in register mode.
   */
  async switchToRegisterMode(): Promise<void> {
    // Check if we're already in register mode by checking if confirm password field is visible
    const isAlreadyInRegisterMode = await this.confirmPasswordInput.isVisible().catch(() => false);
    if (isAlreadyInRegisterMode) {
      console.log('[LoginPage] Already in register mode, skipping switch');
      return;
    }
    
    const toggleBtn = this.page.getByRole('button', { name: /don't have an account|nemáte účet/i });
    // Wait for the toggle button to be visible with timeout
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });
    await toggleBtn.click();
    // Wait for registration form to appear
    await expect(this.confirmPasswordInput).toBeVisible({ timeout: 15000 });
  }

  /**
   * Switch to login mode (LocalAuth only)
   * Only switches if not already in login mode.
   */
  async switchToLoginMode(): Promise<void> {
    // Check if we're already in login mode by checking if confirm password field is hidden
    const isAlreadyInLoginMode = !(await this.confirmPasswordInput.isVisible().catch(() => false));
    if (isAlreadyInLoginMode) {
      console.log('[LoginPage] Already in login mode, skipping switch');
      return;
    }
    
    const toggleBtn = this.page.getByRole('button', { name: /already have an account|máte účet/i });
    // Wait for the toggle button to be visible with timeout
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });
    await toggleBtn.click();
    // Wait for the form to switch - confirm password field should disappear
    await expect(this.confirmPasswordInput).toBeHidden({ timeout: 5000 });
  }

  /**
   * Register a new user (LocalAuth mode)
   */
  async register(username: string, password: string): Promise<void> {
    await this.switchToRegisterMode();

    // Wait for and fill username field
    await expect(this.usernameInput).toBeVisible({ timeout: 5000 });
    await this.usernameInput.clear();
    await this.usernameInput.fill(username);

    // Fill password fields
    await this.passwordInput.fill(password);
    await this.confirmPasswordInput.fill(password);
    
    // Click create account button
    await expect(this.createAccountButton).toBeVisible({ timeout: 5000 });
    await this.createAccountButton.click();
  }
}

/**
 * App Shell Page Object
 */
export class AppShell {
  readonly page: Page;
  readonly shell: Locator;
  readonly albumList: Locator;
  readonly createAlbumButton: Locator;
  readonly logoutButton: Locator;
  readonly settingsButton: Locator;
  readonly adminButton: Locator;
  readonly backButton: Locator;
  readonly searchInput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.shell = page.getByTestId('app-shell');
    this.albumList = page.getByTestId('album-list');
    // EN: "Create Album" / CS: "Vytvořit album"
    this.createAlbumButton = page.getByRole('button', { name: /create album|new album|vytvořit album|\+/i });
    // Use class selector to avoid matching photo elements with similar text
    this.logoutButton = page.locator('button.logout-button');
    this.settingsButton = page.getByTestId('settings-nav-button');
    // EN: "Admin" / CS: "Administrace" (but icon-based via testid would be more reliable)
    this.adminButton = page.getByRole('button', { name: /admin|shield|administrace/i });
    // EN: "Back" / CS: "Zpět"
    this.backButton = page.getByRole('button', { name: /back|albums|zpět|alba/i });
    this.searchInput = page.getByTestId('search-input');
  }

  async waitForLoad(timeout = 30000): Promise<void> {
    await expect(this.shell).toBeVisible({ timeout });
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
  }

  async openCreateAlbumDialog(): Promise<void> {
    await this.createAlbumButton.click();
  }

  async openSettings(): Promise<void> {
    await this.settingsButton.click();
  }

  async openAdmin(): Promise<void> {
    await this.adminButton.click();
  }

  async goBack(): Promise<void> {
    await this.backButton.click();
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query);
  }

  async getAlbumCards(): Promise<Locator[]> {
    return this.page.getByTestId('album-card').all();
  }

  async clickAlbum(index: number): Promise<void> {
    const cards = await this.getAlbumCards();
    if (cards[index]) {
      await cards[index].click();
    } else {
      throw new Error(`Album at index ${index} not found`);
    }
  }

  async clickAlbumByName(name: string): Promise<void> {
    await this.page.getByTestId('album-card').filter({ hasText: name }).click();
  }

  async expectAlbumCount(count: number): Promise<void> {
    await expect(this.page.getByTestId('album-card')).toHaveCount(count, { timeout: 10000 });
  }

  async expectEmptyState(): Promise<void> {
    const emptyMessage = this.page.getByText(/no albums|create.*album|get started/i);
    await expect(emptyMessage.first()).toBeVisible({ timeout: 10000 });
  }
}

/**
 * Create Album Dialog Page Object
 */
export class CreateAlbumDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly nameInput: Locator;
  readonly createButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('create-album-dialog');
    this.nameInput = page.getByTestId('album-name-input');
    this.createButton = page.getByTestId('create-button');
    this.cancelButton = page.getByTestId('cancel-button');
    this.errorMessage = page.getByTestId('create-album-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 30000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async setName(name: string): Promise<void> {
    await this.nameInput.fill(name);
  }

  async submit(): Promise<void> {
    await this.createButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }

  async createAlbum(name: string): Promise<void> {
    await this.waitForOpen();
    await this.setName(name);
    await this.submit();
    await this.waitForClose();
  }

  async expectError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5000 });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }
}

/**
 * Gallery Page Object
 */
export class GalleryPage {
  readonly page: Page;
  readonly gallery: Locator;
  readonly photoGrid: Locator;
  readonly justifiedGrid: Locator;
  readonly uploadButton: Locator;
  readonly uploadInput: Locator;
  readonly emptyState: Locator;
  readonly viewJustifiedButton: Locator;
  readonly viewGridButton: Locator;
  readonly viewMapButton: Locator;
  readonly membersButton: Locator;
  readonly shareButton: Locator;
  readonly renameAlbumButton: Locator;
  readonly deleteAlbumButton: Locator;
  readonly albumSettingsButton: Locator;
  readonly albumSettingsMenu: Locator;

  constructor(page: Page) {
    this.page = page;
    this.gallery = page.locator('.gallery, .photo-gallery, [data-testid*="gallery"]');
    this.photoGrid = page.getByTestId('photo-grid');
    this.justifiedGrid = page.getByTestId('justified-grid');
    this.uploadButton = page.getByTestId('upload-button');
    this.uploadInput = page.getByTestId('upload-input');
    this.emptyState = page.locator('[data-testid="justified-grid-empty"], [data-testid="photo-grid-empty"]');
    this.viewJustifiedButton = page.getByTestId('view-toggle-justified');
    this.viewGridButton = page.getByTestId('view-toggle-grid');
    this.viewMapButton = page.getByTestId('view-toggle-map');
    this.membersButton = page.getByTestId('menu-share-button');
    this.shareButton = page.getByTestId('menu-links-button');
    this.renameAlbumButton = page.getByTestId('menu-rename-button');
    // Delete button is inside the album settings dropdown menu
    this.deleteAlbumButton = page.getByTestId('menu-delete-button');
    this.albumSettingsButton = page.getByTestId('album-settings-button');
    this.albumSettingsMenu = page.getByTestId('album-settings-menu');
  }

  async waitForLoad(timeout = 30000): Promise<void> {
    await expect(this.gallery).toBeVisible({ timeout });
  }

  getPhotos(): Locator {
    return this.page.locator(
      '[data-testid="photo-thumbnail"], [data-testid="justified-photo-thumbnail"]'
    );
  }

  async getPhotoCount(): Promise<number> {
    return this.getPhotos().count();
  }

  async expectPhotoCount(count: number, timeout = 30000): Promise<void> {
    await expect(this.getPhotos()).toHaveCount(count, { timeout });
  }

  async expectEmptyState(): Promise<void> {
    await expect(this.emptyState.first()).toBeVisible({ timeout: 10000 });
  }

  async uploadPhoto(imageBuffer: Buffer, filename = 'test.png'): Promise<void> {
    // Count photos before upload
    const photoCountBefore = await this.getPhotos().count();
    const startTime = Date.now();
    console.log(`[GalleryPage PO] Photo count before: ${photoCountBefore}`);
    
    await expect(this.uploadInput).toBeAttached({ timeout: 10000 });
    console.log(`[GalleryPage PO] Upload input found at T+${Date.now() - startTime}ms`);

    const expectedCount = photoCountBefore + 1;
    
    // Retry loop: sometimes setInputFiles doesn't trigger the change event
    // We detect this by checking if upload started within 2 seconds
    let attempt = 0;
    const maxAttempts = 3;
    
    while (attempt < maxAttempts) {
      attempt++;
      console.log(`[GalleryPage PO] Upload attempt ${attempt}/${maxAttempts} at T+${Date.now() - startTime}ms`);
      
      // Set files on the input
      await this.uploadInput.setInputFiles({
        name: filename,
        mimeType: 'image/png',
        buffer: imageBuffer,
      });
      console.log(`[GalleryPage PO] Files set at T+${Date.now() - startTime}ms`);

      // CRITICAL: Give React time to process the change event and update state.
      await this.page.waitForTimeout(100);
      
      // Quick check: did upload start or photo appear?
      const btn = this.page.getByTestId('upload-button');
      const buttonText = await btn.textContent().catch(() => '');
      const currentCount = await this.getPhotos().count();
      // Button shows "Uploading..." or a percentage like "33%", "66%" during upload
      const isUploading = buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');
      const hasNewPhoto = currentCount >= expectedCount;
      
      console.log(`[GalleryPage PO] Quick check at T+${Date.now() - startTime}ms: button="${buttonText}", photos=${currentCount}, uploading=${isUploading}, hasNew=${hasNewPhoto}`);
      
      if (isUploading || hasNewPhoto) {
        console.log(`[GalleryPage PO] Upload triggered on attempt ${attempt}`);
        break;
      }
      
      // Wait a bit more and check again before retrying
      await this.page.waitForTimeout(500);
      const buttonText2 = await btn.textContent().catch(() => '');
      const currentCount2 = await this.getPhotos().count();
      // Button shows "Uploading..." or a percentage like "33%", "66%" during upload
      const isUploading2 = buttonText2?.includes('Uploading') || /\d+%/.test(buttonText2 || '');
      const hasNewPhoto2 = currentCount2 >= expectedCount;
      
      if (isUploading2 || hasNewPhoto2) {
        console.log(`[GalleryPage PO] Upload triggered on attempt ${attempt} (delayed detection)`);
        break;
      }
      
      if (attempt < maxAttempts) {
        console.log(`[GalleryPage PO] Upload not triggered, will retry...`);
        // Clear the input before retry
        await this.uploadInput.evaluate((el: HTMLInputElement) => { el.value = ''; });
      }
    }

    // Wait for upload to fully start (button text changes to "Uploading" or shows percentage)
    // OR if upload is already complete (photo count increased)
    let pollCount = 0;
    await expect(async () => {
      pollCount++;
      const btn = this.page.getByTestId('upload-button');
      const buttonText = await btn.textContent().catch(() => '');
      const currentCount = await this.getPhotos().count();
      // Button shows "Uploading..." or a percentage like "33%", "66%" during upload
      const isUploading = buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');
      const hasNewPhoto = currentCount >= expectedCount;
      
      if (pollCount <= 5 || pollCount % 10 === 0) {
        console.log(`[GalleryPage PO] Poll #${pollCount} at T+${Date.now() - startTime}ms: button="${buttonText}", photos=${currentCount}, uploading=${isUploading}, hasNew=${hasNewPhoto}`);
      }
      
      expect(isUploading || hasNewPhoto).toBe(true);
    }).toPass({ timeout: 30000, intervals: [100, 200, 500, 1000] });
    console.log(`[GalleryPage PO] Upload started or photo appeared at T+${Date.now() - startTime}ms (${pollCount} polls)`);

    // Wait for upload to complete: button NOT uploading AND photo count reached
    let completePollCount = 0;
    await expect(async () => {
      completePollCount++;
      const btn = this.page.getByTestId('upload-button');
      const buttonText = await btn.textContent().catch(() => '');
      const currentCount = await this.getPhotos().count();
      // Button shows "Uploading..." or a percentage like "33%", "66%" during upload
      const isUploading = buttonText?.includes('Uploading') || /\d+%/.test(buttonText || '');
      
      if (completePollCount <= 3 || completePollCount % 5 === 0) {
        console.log(`[GalleryPage PO] Complete poll #${completePollCount} at T+${Date.now() - startTime}ms: button="${buttonText}", photos=${currentCount}`);
      }
      
      expect(!isUploading && currentCount >= expectedCount).toBe(true);
    }).toPass({ timeout: 60000, intervals: [100, 250, 500, 1000] });
    
    console.log(`[GalleryPage PO] Upload complete at T+${Date.now() - startTime}ms. Final count: ${await this.getPhotos().count()}`);
  }

  async uploadMultiplePhotos(
    images: Array<{ buffer: Buffer; filename: string }>
  ): Promise<void> {
    await expect(this.uploadInput).toBeAttached({ timeout: 10000 });

    await this.uploadInput.setInputFiles(
      images.map((img) => ({
        name: img.filename,
        mimeType: 'image/png',
        buffer: img.buffer,
      }))
    );
  }

  /**
   * Wait for all photos to finish syncing.
   * In Grid view: pending photos have data-testid="pending-photo-thumbnail".
   * In Justified view: pending photos have data-testid="photo-pending-overlay" inside them.
   * 
   * We also verify that after pending state clears, the photos remain visible as non-pending.
   */
  async waitForSync(timeout = 60000): Promise<void> {
    const startTime = Date.now();
    
    // Grid view uses a separate testid for pending photos
    const pendingGridPhotos = this.page.getByTestId('pending-photo-thumbnail');
    // Justified view uses an overlay inside the same photo testid
    const pendingOverlays = this.page.getByTestId('photo-pending-overlay');
    
    const initialGridCount = await pendingGridPhotos.count();
    const initialOverlayCount = await pendingOverlays.count();
    
    // Total expected photos = pending overlays (justified view) + any already stable photos
    // We use initialOverlayCount as minimum photos to expect after sync
    const minExpectedPhotos = initialOverlayCount > 0 ? initialOverlayCount : 0;
    
    console.log(`[GalleryPage PO] waitForSync started: ${initialGridCount} pending grid photos, ${initialOverlayCount} pending overlays, expecting at least ${minExpectedPhotos} photos after sync`);
    
    if (initialGridCount + initialOverlayCount === 0) {
      // Nothing pending, we're done
      console.log(`[GalleryPage PO] waitForSync complete after ${Date.now() - startTime}ms (no pending photos)`);
      return;
    }
    
    // Wait for pending state to clear AND photos to be visible
    await expect(async () => {
      const gridCount = await pendingGridPhotos.count();
      const overlayCount = await pendingOverlays.count();
      const stablePhotoCount = await this.getPhotos().count();
      
      // All pending states must be gone
      expect(gridCount + overlayCount).toBe(0);
      
      // And we must have at least as many stable photos as we had pending overlays
      if (minExpectedPhotos > 0) {
        expect(stablePhotoCount).toBeGreaterThanOrEqual(minExpectedPhotos);
      }
    }).toPass({ timeout, intervals: [100, 250, 500, 1000] });
    
    console.log(`[GalleryPage PO] waitForSync complete after ${Date.now() - startTime}ms`);
  }

  async selectPhoto(index: number): Promise<void> {
    // Wait for any pending photos to finish syncing first
    await this.waitForSync();
    
    // Wait for photos to be stable and click atomically
    let clicked = false;
    await expect(async () => {
      const photos = await this.getPhotos().all();
      console.log(`[GalleryPage PO] selectPhoto(${index}): found ${photos.length} photos`);
      if (!photos[index]) {
        throw new Error(`Photo at index ${index} not found, have ${photos.length} photos`);
      }
      if (!clicked) {
        await photos[index].click();
        clicked = true;
        console.log(`[GalleryPage PO] selectPhoto(${index}): clicked`);
      }
    }).toPass({ timeout: 30000, intervals: [100, 250, 500] });
  }

  async openMembers(): Promise<void> {
    // Close members panel first if it's already open (to allow reopening)
    const membersPanel = this.page.getByTestId('member-panel');
    const isPanelOpen = await membersPanel.isVisible().catch(() => false);
    if (isPanelOpen) {
      const closeBtn = this.page.getByTestId('close-members-button');
      await closeBtn.click();
      await expect(membersPanel).toBeHidden({ timeout: 5000 });
    }
    
    // The menu can be detached during React re-renders, so use a retry pattern
    await expect(async () => {
      // Ensure the settings menu is open (will skip if already open)
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      if (!isMenuVisible) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
      // Wait for members button to be visible and click it
      await expect(this.membersButton).toBeVisible({ timeout: 2000 });
      await this.membersButton.click();
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async setViewMode(mode: 'justified' | 'grid' | 'map'): Promise<void> {
    switch (mode) {
      case 'justified':
        await this.viewJustifiedButton.click();
        break;
      case 'grid':
        await this.viewGridButton.click();
        break;
      case 'map':
        await this.viewMapButton.click();
        break;
    }
  }

  async openShareLinks(): Promise<void> {
    // The menu can be detached during React re-renders, so use a retry pattern
    await expect(async () => {
      // Ensure the settings menu is open (will skip if already open)
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      if (!isMenuVisible) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
      // Wait for share button to be visible and click it
      await expect(this.shareButton).toBeVisible({ timeout: 2000 });
      await this.shareButton.click();
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async openAlbumSettings(): Promise<void> {
    // Use a retry pattern since menu can be detached during React re-renders
    await expect(async () => {
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      if (!isMenuVisible) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async openRenameDialog(): Promise<void> {
    // The menu can be detached during React re-renders, so use a retry pattern
    // Also, permissions may take time to load, so the button may not be visible initially
    await expect(async () => {
      // Close menu if open but button isn't visible (permissions not loaded yet)
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      const isRenameButtonVisible = isMenuVisible && await this.renameAlbumButton.isVisible().catch(() => false);
      
      if (isMenuVisible && !isRenameButtonVisible) {
        // Close menu by pressing Escape, then retry
        await this.page.keyboard.press('Escape');
        await expect(this.albumSettingsMenu).toBeHidden({ timeout: 1000 }).catch(() => {});
      }
      
      // Ensure the settings menu is open
      if (!await this.albumSettingsMenu.isVisible().catch(() => false)) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
      
      // Wait for rename button to be visible and click it
      await expect(this.renameAlbumButton).toBeVisible({ timeout: 2000 });
      await this.renameAlbumButton.click();
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async clickDeleteAlbum(): Promise<void> {
    // The menu can be detached during React re-renders, so use a retry pattern
    // Also, permissions may take time to load, so the button may not be visible initially
    await expect(async () => {
      // Close menu if open but button isn't visible (permissions not loaded yet)
      const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
      const isDeleteButtonVisible = isMenuVisible && await this.deleteAlbumButton.isVisible().catch(() => false);
      
      if (isMenuVisible && !isDeleteButtonVisible) {
        // Close menu by pressing Escape, then retry
        await this.page.keyboard.press('Escape');
        await expect(this.albumSettingsMenu).toBeHidden({ timeout: 1000 }).catch(() => {});
      }
      
      // Ensure the settings menu is open
      if (!await this.albumSettingsMenu.isVisible().catch(() => false)) {
        await this.albumSettingsButton.click();
        await expect(this.albumSettingsMenu).toBeVisible({ timeout: 2000 });
      }
      
      // Wait for delete button to be visible and click it
      await expect(this.deleteAlbumButton).toBeVisible({ timeout: 2000 });
      await this.deleteAlbumButton.click();
    }).toPass({ timeout: 15000, intervals: [100, 500, 1000] });
  }

  async expectDeleteButtonVisible(): Promise<void> {
    // Open the dropdown first to check if delete button is visible
    await this.openAlbumSettings();
    await expect(this.deleteAlbumButton).toBeVisible({ timeout: 5000 });
  }

  async expectDeleteButtonHidden(): Promise<void> {
    // If dropdown is open, check that delete button is hidden (non-owner)
    // If dropdown is not open, try to open it first
    const isMenuVisible = await this.albumSettingsMenu.isVisible().catch(() => false);
    if (!isMenuVisible) {
      await this.albumSettingsButton.click().catch(() => {
        // Settings button might not be visible for some users
      });
    }
    await expect(this.deleteAlbumButton).toBeHidden({ timeout: 5000 });
  }
}

/**
 * Lightbox Page Object
 */
export class Lightbox {
  readonly page: Page;
  readonly container: Locator;
  readonly image: Locator;
  readonly closeButton: Locator;
  readonly nextButton: Locator;
  readonly prevButton: Locator;
  readonly deleteButton: Locator;
  readonly downloadButton: Locator;
  readonly photoInfo: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.getByTestId('lightbox');
    this.image = page.getByTestId('lightbox-image');
    this.closeButton = page.getByTestId('lightbox-close');
    this.nextButton = page.getByTestId('lightbox-next');
    this.prevButton = page.getByTestId('lightbox-prev');
    this.deleteButton = page.getByTestId('lightbox-delete');
    this.downloadButton = page.getByTestId('lightbox-download');
    this.photoInfo = page.getByTestId('lightbox-info');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.container).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.container).toBeHidden({ timeout });
  }

  async waitForImage(timeout = 30000): Promise<void> {
    await expect(this.image).toBeVisible({ timeout });
    // Wait for image to actually load
    await this.page.waitForFunction(
      () => {
        const img = document.querySelector('[data-testid="lightbox-image"]') as HTMLImageElement;
        return img && img.complete && img.naturalWidth > 0;
      },
      { timeout }
    );
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await this.waitForClose();
  }

  async closeByEscape(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.waitForClose();
  }

  async closeByClickOutside(): Promise<void> {
    // Click on the backdrop/overlay area
    await this.container.click({ position: { x: 10, y: 10 } });
    await this.waitForClose();
  }

  async goToNext(): Promise<void> {
    await this.nextButton.click();
  }

  async goToPrevious(): Promise<void> {
    await this.prevButton.click();
  }

  async navigateWithKeyboard(direction: 'left' | 'right'): Promise<void> {
    await this.page.keyboard.press(direction === 'right' ? 'ArrowRight' : 'ArrowLeft');
  }

  async deletePhoto(): Promise<void> {
    await this.deleteButton.click();
  }

  async download(): Promise<void> {
    await this.downloadButton.click();
  }
}

/**
 * Members Panel Page Object
 */
export class MembersPanel {
  readonly page: Page;
  readonly panel: Locator;
  readonly memberList: Locator;
  readonly inviteButton: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByTestId('member-panel');
    this.memberList = page.getByTestId('member-list');
    this.inviteButton = page.getByRole('button', { name: /invite|add member/i });
    this.closeButton = page.getByTestId('close-members-button');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.panel).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.panel).toBeHidden({ timeout });
  }

  async close(): Promise<void> {
    const isVisible = await this.panel.isVisible().catch(() => false);
    if (isVisible) {
      await this.closeButton.click();
      await this.waitForClose();
    }
  }

  async getMemberRows(): Promise<Locator[]> {
    return this.page.getByTestId('member-item').all();
  }

  async getMemberCount(): Promise<number> {
    return (await this.getMemberRows()).length;
  }

  async openInviteDialog(): Promise<void> {
    await this.inviteButton.click();
  }

  async removeMember(userIdOrDisplayName: string): Promise<void> {
    // Try to find by exact match first
    let memberRow = this.page.getByTestId('member-item').filter({ hasText: userIdOrDisplayName });
    let isVisible = await memberRow.first().isVisible().catch(() => false);
    
    // If not found, try with first 8 chars of user ID (how it's displayed in UI)
    if (!isVisible && userIdOrDisplayName.length > 8) {
      const shortId = userIdOrDisplayName.substring(0, 8);
      memberRow = this.page.getByTestId('member-item').filter({ hasText: shortId });
      isVisible = await memberRow.first().isVisible().catch(() => false);
    }
    
    // If still not found, just click the first non-owner remove button
    if (!isVisible) {
      const removeButtons = this.page.getByTestId('member-item').getByRole('button', { name: /remove|delete/i });
      const count = await removeButtons.count();
      if (count > 0) {
        await removeButtons.first().click();
        return;
      }
      throw new Error(`Member not found: ${userIdOrDisplayName}`);
    }
    
    const removeBtn = memberRow.first().getByRole('button', { name: /remove|delete/i });
    await removeBtn.click();
  }

  async expectMemberVisible(userId: string): Promise<void> {
    await expect(
      this.page.getByTestId('member-item').filter({ hasText: userId })
    ).toBeVisible({ timeout: 5000 });
  }

  async expectMemberNotVisible(userId: string): Promise<void> {
    await expect(
      this.page.getByTestId('member-item').filter({ hasText: userId })
    ).toBeHidden({ timeout: 5000 });
  }

  /**
   * Remove a member and confirm the action
   * @param userIdOrDisplayName - User ID or display name to identify the member
   */
  async removeMemberWithConfirmation(userIdOrDisplayName: string): Promise<void> {
    // Click the remove button for this member
    await this.removeMember(userIdOrDisplayName);

    // Wait for and interact with the confirmation dialog
    const removeDialog = new RemoveMemberDialog(this.page);
    await removeDialog.waitForOpen();
    await removeDialog.confirm();
  }
}

/**
 * Remove Member Dialog Page Object
 * Handles the confirmation dialog when removing a member from an album.
 * Note: This dialog also shows key rotation progress.
 */
export class RemoveMemberDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;
  readonly progressIndicator: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('remove-member-dialog');
    this.confirmButton = page.getByTestId('confirm-remove-button');
    this.cancelButton = page.getByTestId('cancel-remove-button');
    this.progressIndicator = page.getByTestId('removal-progress');
    this.errorMessage = page.getByTestId('remove-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 30000): Promise<void> {
    // Longer timeout because key rotation can take time
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async confirm(): Promise<void> {
    await this.confirmButton.click();
    // Wait for progress to complete and dialog to close
    await this.waitForClose();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }

  async expectProgress(): Promise<void> {
    await expect(this.progressIndicator).toBeVisible({ timeout: 5000 });
  }

  async expectError(message?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5000 });
    if (message) {
      await expect(this.errorMessage).toHaveText(message);
    }
  }
}

/**
 * Invite Member Dialog Page Object
 */
export class InviteMemberDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly userIdInput: Locator;
  readonly lookupButton: Locator;
  readonly foundUser: Locator;
  readonly roleSelect: Locator;
  readonly inviteButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('invite-member-dialog');
    this.userIdInput = page.getByTestId('user-query-input');
    this.lookupButton = page.getByTestId('lookup-button');
    this.foundUser = page.getByTestId('found-user');
    this.roleSelect = page.getByTestId('role-selector');
    this.inviteButton = page.getByTestId('submit-invite-button');
    this.cancelButton = page.getByTestId('cancel-invite-button');
    this.errorMessage = page.getByTestId('invite-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async setUserId(userId: string): Promise<void> {
    await this.userIdInput.fill(userId);
    // Click lookup button and wait for user to be found
    await this.lookupButton.click();
    await expect(this.foundUser).toBeVisible({ timeout: 10000 });
  }

  async setRole(role: 'viewer' | 'editor'): Promise<void> {
    // Role is selected via radio buttons inside role-selector
    const roleInput = this.roleSelect.getByRole('radio', { name: new RegExp(role, 'i') });
    if (await roleInput.isVisible().catch(() => false)) {
      await roleInput.check();
    }
  }

  async submit(): Promise<void> {
    await this.inviteButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }

  async inviteMember(userId: string, role: 'viewer' | 'editor' = 'viewer'): Promise<void> {
    await this.waitForOpen();
    await this.setUserId(userId);
    await this.setRole(role);
    await this.submit();
    
    // Wait for dialog to close (invite completion) with longer timeout
    // The invite might take time due to key rotation
    await this.waitForClose(30000);
  }
}

/**
 * Settings Page Object
 */
export class SettingsPage {
  readonly page: Page;
  readonly container: Locator;
  readonly themeSelect: Locator;
  readonly autoSyncToggle: Locator;
  readonly keyCacheDurationSelect: Locator;
  readonly saveButton: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.getByTestId('settings-page');
    this.themeSelect = page.getByLabel(/theme/i);
    this.autoSyncToggle = page.getByLabel(/auto.*sync/i);
    this.keyCacheDurationSelect = page.getByLabel(/remember|cache|session/i);
    this.saveButton = page.getByRole('button', { name: /save/i });
    this.closeButton = page.getByRole('button', { name: /close|back/i });
  }

  async waitForLoad(timeout = 10000): Promise<void> {
    await expect(this.container).toBeVisible({ timeout });
  }

  async setTheme(theme: 'light' | 'dark' | 'system'): Promise<void> {
    await this.themeSelect.selectOption(theme);
  }

  async setAutoSync(enabled: boolean): Promise<void> {
    const isChecked = await this.autoSyncToggle.isChecked();
    if (isChecked !== enabled) {
      await this.autoSyncToggle.click();
    }
  }

  async setKeyCacheDuration(value: string): Promise<void> {
    await this.keyCacheDurationSelect.selectOption(value);
  }

  async save(): Promise<void> {
    await this.saveButton.click();
  }

  async close(): Promise<void> {
    await this.closeButton.click();
  }
}

/**
 * Delete Confirmation Dialog Page Object
 */
export class DeleteConfirmDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;
  readonly message: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('delete-confirm-dialog');
    this.confirmButton = page.getByRole('button', { name: /delete|confirm|yes/i });
    this.cancelButton = page.getByRole('button', { name: /cancel|no/i });
    this.message = page.getByTestId('delete-confirm-message');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async confirm(): Promise<void> {
    await this.confirmButton.click();
    await this.waitForClose();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }
}

/**
 * Delete Album Dialog Page Object
 */
export class DeleteAlbumDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;
  readonly albumInfo: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('delete-album-dialog');
    this.confirmButton = page.getByTestId('delete-album-confirm-button');
    this.cancelButton = page.getByTestId('delete-album-cancel-button');
    this.albumInfo = page.getByTestId('delete-album-info');
    this.errorMessage = page.getByTestId('delete-album-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async confirm(): Promise<void> {
    await this.confirmButton.click();
  }

  async confirmAndWaitForClose(timeout = 30000): Promise<void> {
    await this.confirmButton.click();
    await this.waitForClose(timeout);
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }

  async expectError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5000 });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }

  async expectAlbumInfo(albumName: string): Promise<void> {
    await expect(this.albumInfo).toContainText(albumName);
  }
}

/**
 * Rename Album Dialog Page Object
 */
export class RenameAlbumDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly nameInput: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('rename-album-dialog');
    this.nameInput = page.getByTestId('rename-album-name-input');
    this.saveButton = page.getByTestId('rename-album-save-button');
    this.cancelButton = page.getByTestId('rename-album-cancel-button');
    this.errorMessage = page.getByTestId('rename-album-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async setName(name: string): Promise<void> {
    await this.nameInput.clear();
    await this.nameInput.fill(name);
  }

  async getName(): Promise<string> {
    return this.nameInput.inputValue();
  }

  async save(): Promise<void> {
    await this.saveButton.click();
  }

  async saveAndWaitForClose(timeout = 30000): Promise<void> {
    await this.saveButton.click();
    await this.waitForClose(timeout);
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }

  async rename(newName: string): Promise<void> {
    await this.setName(newName);
    await this.saveAndWaitForClose();
  }

  async expectError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5000 });
    if (text) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }

  async expectSaveDisabled(): Promise<void> {
    await expect(this.saveButton).toBeDisabled();
  }

  async expectSaveEnabled(): Promise<void> {
    await expect(this.saveButton).toBeEnabled();
  }
}

/**
 * Share Links Panel Page Object
 */
export class ShareLinksPanel {
  readonly page: Page;
  readonly panel: Locator;
  readonly closeButton: Locator;
  readonly createButton: Locator;
  readonly linksList: Locator;
  readonly emptyState: Locator;
  readonly errorState: Locator;
  readonly loadingState: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByTestId('share-links-panel');
    this.closeButton = page.getByTestId('close-share-links-button');
    this.createButton = page.getByTestId('create-share-link-button');
    this.linksList = page.getByTestId('active-share-links');
    this.emptyState = page.getByTestId('share-links-empty');
    this.errorState = page.getByTestId('share-links-error');
    this.loadingState = page.getByTestId('share-links-loading');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.panel).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.panel).toBeHidden({ timeout });
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await this.waitForClose();
  }

  async openCreateDialog(): Promise<void> {
    await this.createButton.click();
  }

  async getLinkItems(): Promise<Locator[]> {
    return this.page.getByTestId('share-link-item').all();
  }

  async getLinkCount(): Promise<number> {
    return (await this.getLinkItems()).length;
  }

  async copyLink(index: number): Promise<void> {
    const links = await this.getLinkItems();
    if (links[index]) {
      await links[index].getByTestId('copy-link-button').click();
    }
  }

  async revokeLink(index: number): Promise<void> {
    const links = await this.getLinkItems();
    if (links[index]) {
      await links[index].getByTestId('revoke-link-button').click();
      // Wait for and click the confirmation button in the revoke dialog
      await this.page.getByTestId('confirm-revoke-button').click();
      // Wait for the link to be removed from the list
      await this.page.waitForTimeout(500);
    }
  }

  async editLink(index: number): Promise<void> {
    const links = await this.getLinkItems();
    if (links[index]) {
      await links[index].getByTestId('edit-link-button').click();
    }
  }
}

/**
 * Create Share Link Dialog Page Object
 */
export class CreateShareLinkDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly tierSelector: Locator;
  readonly expiryPresets: Locator;
  readonly maxUsesCheckbox: Locator;
  readonly maxUsesInput: Locator;
  readonly generateButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;
  readonly urlInput: Locator;
  readonly copyButton: Locator;
  readonly doneButton: Locator;
  readonly neverExpiresWarning: Locator;

  constructor(page: Page) {
    this.page = page;
    // Use 'create-share-link-view' which is the actual test ID in the component
    // This view appears when creating a share link within ShareLinksPanel
    this.dialog = page.getByTestId('create-share-link-view');
    this.tierSelector = page.getByTestId('tier-selector');
    this.expiryPresets = page.getByTestId('expiry-presets');
    this.maxUsesCheckbox = page.getByTestId('max-uses-checkbox');
    this.maxUsesInput = page.getByTestId('max-uses-input');
    this.generateButton = page.getByTestId('generate-button');
    this.cancelButton = page.getByTestId('cancel-button');
    this.errorMessage = page.getByTestId('share-link-error');
    this.urlInput = page.getByTestId('share-url-input');
    this.copyButton = page.getByTestId('copy-link-button');
    this.doneButton = page.getByTestId('done-button');
    this.neverExpiresWarning = page.getByTestId('never-expires-warning');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async selectTier(tier: 'view' | 'download'): Promise<void> {
    const tierButton = this.tierSelector.locator(`[data-tier="${tier}"], button:has-text("${tier}")`);
    await tierButton.first().click();
  }

  async selectExpiry(preset: string): Promise<void> {
    const presetButton = this.page.getByTestId(`expiry-preset-${preset.toLowerCase().replace(/\s/g, '-')}`);
    await presetButton.click();
  }

  async setMaxUses(uses: number): Promise<void> {
    await this.maxUsesCheckbox.check();
    await this.maxUsesInput.fill(uses.toString());
  }

  async generate(): Promise<void> {
    await this.generateButton.click();
    // Wait for the success state with URL input
    await expect(this.urlInput).toBeVisible({ timeout: 30000 });
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
    await this.waitForClose();
  }

  async done(): Promise<void> {
    await this.doneButton.click();
    await this.waitForClose();
    // Wait for the share link list to refresh - the list is refetched asynchronously after dialog closes
    // We need at least one share-link-item to appear before returning
    await expect(this.page.getByTestId('share-link-item').first()).toBeVisible({ timeout: 10000 });
  }

  async copyLink(): Promise<string> {
    const url = await this.urlInput.inputValue();
    await this.copyButton.click();
    return url;
  }

  async getGeneratedUrl(): Promise<string> {
    return this.urlInput.inputValue();
  }
}

/**
 * Admin Page Object
 */
export class AdminPage {
  readonly page: Page;
  readonly container: Locator;
  readonly dashboardTab: Locator;
  readonly usersTab: Locator;
  readonly albumsTab: Locator;
  readonly settingsTab: Locator;
  readonly userTable: Locator;
  readonly albumTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.container = page.getByTestId('admin-page');
    this.dashboardTab = page.getByRole('tab', { name: /dashboard/i });
    this.usersTab = page.getByRole('tab', { name: /users/i });
    this.albumsTab = page.getByRole('tab', { name: /albums/i });
    this.settingsTab = page.getByRole('tab', { name: /settings/i });
    this.userTable = page.getByTestId('users-table');
    this.albumTable = page.getByTestId('albums-table');
  }

  async waitForLoad(timeout = 10000): Promise<void> {
    await expect(this.container).toBeVisible({ timeout });
  }

  async openDashboard(): Promise<void> {
    await this.dashboardTab.click();
  }

  async openUsers(): Promise<void> {
    await this.usersTab.click();
    await expect(this.userTable).toBeVisible({ timeout: 10000 });
  }

  async openAlbums(): Promise<void> {
    await this.albumsTab.click();
    await expect(this.albumTable).toBeVisible({ timeout: 10000 });
  }

  async openSettings(): Promise<void> {
    await this.settingsTab.click();
  }

  async getUserRows(): Promise<Locator[]> {
    return this.userTable.locator('tr').all();
  }

  async getAlbumRows(): Promise<Locator[]> {
    return this.albumTable.locator('tr').all();
  }
}
