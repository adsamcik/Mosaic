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
 */
export class LoginPage {
  readonly page: Page;
  readonly form: Locator;
  readonly passwordInput: Locator;
  readonly usernameInput: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.form = page.getByTestId('login-form');
    this.passwordInput = page.getByLabel('Password');
    this.usernameInput = page.getByLabel(/username|user/i);
    this.loginButton = page.getByRole('button', { name: /unlock/i });
    this.errorMessage = page.getByRole('alert');
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  async waitForForm(timeout = 30000): Promise<void> {
    await expect(this.form).toBeVisible({ timeout });
  }

  async login(password: string = TEST_PASSWORD): Promise<void> {
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  async loginWithUsername(username: string, password: string = TEST_PASSWORD): Promise<void> {
    // For dev mode with username field
    if (await this.usernameInput.isVisible().catch(() => false)) {
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
    this.createAlbumButton = page.getByRole('button', { name: /create album|new album|\+/i });
    this.logoutButton = page.getByRole('button', { name: /lock|logout/i });
    this.settingsButton = page.getByRole('button', { name: /settings|gear|cog/i });
    this.adminButton = page.getByRole('button', { name: /admin|shield/i });
    this.backButton = page.getByRole('button', { name: /back|albums/i });
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
    this.membersButton = page.getByTestId('share-button');
    this.shareButton = page.getByTestId('share-links-button');
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
    await expect(this.uploadInput).toBeAttached({ timeout: 10000 });

    await this.uploadInput.setInputFiles({
      name: filename,
      mimeType: 'image/png',
      buffer: imageBuffer,
    });

    // Wait for upload to complete
    await this.page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="upload-button"]');
        const hasPhoto = document.querySelector(
          '[data-testid="photo-thumbnail"], [data-testid="justified-photo-thumbnail"]'
        );
        const isUploading = btn?.textContent?.includes('Uploading');
        return hasPhoto || (btn && !isUploading);
      },
      { timeout: 60000 }
    );
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

  async selectPhoto(index: number): Promise<void> {
    const photos = await this.getPhotos().all();
    if (photos[index]) {
      await photos[index].click();
    } else {
      throw new Error(`Photo at index ${index} not found`);
    }
  }

  async openMembers(): Promise<void> {
    await this.membersButton.first().click();
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
    await this.shareButton.click();
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
    await this.closeButton.click();
    await this.waitForClose();
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

  async removeMember(userId: string): Promise<void> {
    const memberRow = this.page.getByTestId('member-item').filter({ hasText: userId });
    const removeBtn = memberRow.getByRole('button', { name: /remove|delete/i });
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
}

/**
 * Invite Member Dialog Page Object
 */
export class InviteMemberDialog {
  readonly page: Page;
  readonly dialog: Locator;
  readonly userIdInput: Locator;
  readonly roleSelect: Locator;
  readonly inviteButton: Locator;
  readonly cancelButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByTestId('invite-member-dialog');
    this.userIdInput = page.getByLabel(/user|member|email|id/i);
    this.roleSelect = page.getByLabel(/role/i);
    this.inviteButton = page.getByRole('button', { name: /invite|add|confirm/i });
    this.cancelButton = page.getByRole('button', { name: /cancel/i });
    this.errorMessage = page.getByTestId('invite-error');
  }

  async waitForOpen(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout });
  }

  async waitForClose(timeout = 10000): Promise<void> {
    await expect(this.dialog).toBeHidden({ timeout });
  }

  async setUserId(userId: string): Promise<void> {
    await this.userIdInput.first().fill(userId);
  }

  async setRole(role: 'viewer' | 'editor'): Promise<void> {
    if (await this.roleSelect.isVisible().catch(() => false)) {
      await this.roleSelect.selectOption(role);
    }
  }

  async submit(): Promise<void> {
    await this.inviteButton.first().click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }

  async inviteMember(userId: string, role: 'viewer' | 'editor' = 'viewer'): Promise<void> {
    await this.waitForOpen();
    await this.setUserId(userId);
    await this.setRole(role);
    await this.submit();
    await this.waitForClose();
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
