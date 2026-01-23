/**
 * Page Objects for E2E Tests
 *
 * Page Object Model implementations for all major UI components.
 * These encapsulate UI interactions and provide a clean API for tests.
 *
 * This file is a barrel export that re-exports all page objects from their
 * individual modules for backward compatibility with existing test imports.
 *
 * Module structure:
 * - auth/     - Authentication-related pages (LoginPage)
 * - shell/    - Application shell components (AppShell)
 * - albums/   - Album management dialogs (CreateAlbumDialog, DeleteAlbumDialog, RenameAlbumDialog)
 * - gallery/  - Gallery view components (GalleryPage)
 * - lightbox/ - Lightbox/viewer components (Lightbox)
 * - members/  - Member management (MembersPanel, InviteMemberDialog, RemoveMemberDialog)
 * - sharing/  - Share link management (ShareLinksPanel, CreateShareLinkDialog)
 * - settings/ - Settings pages (SettingsPage)
 * - common/   - Common dialogs (DeleteConfirmDialog)
 * - admin/    - Admin pages (AdminPage)
 */

// Re-export all page objects from their modules
export { LoginPage } from './auth';
export { AppShell } from './shell';
export { CreateAlbumDialog, DeleteAlbumDialog, RenameAlbumDialog } from './albums';
export { GalleryPage } from './gallery';
export { Lightbox } from './lightbox';
export { MembersPanel, InviteMemberDialog, RemoveMemberDialog } from './members';
export { ShareLinksPanel, CreateShareLinkDialog } from './sharing';
export { SettingsPage } from './settings';
export { DeleteConfirmDialog } from './common';
export { AdminPage } from './admin';
