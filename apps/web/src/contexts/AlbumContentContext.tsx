/**
 * Album Content Context
 *
 * Manages encrypted album content (story blocks) with:
 * - Loading content from server
 * - Decrypting with epoch key
 * - Editing blocks in memory
 * - Encrypting and saving to server
 * - Optimistic concurrency control
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getApi, ApiError } from '../lib/api';
import { toBase64, fromBase64 } from '../lib/api';
import { getCryptoClient } from '../lib/crypto-client';
import { getCurrentEpochKey } from '../lib/epoch-key-store';
import { createLogger } from '../lib/logger';
import {
  type AlbumContentDocument,
  type ContentBlock,
  AlbumContentDocumentSchema,
  createEmptyContentDocument,
  createHeadingBlock,
  createTextBlock,
} from '../lib/content-blocks';

const log = createLogger('AlbumContentContext');

// =============================================================================
// Types
// =============================================================================

/** Content loading state */
export type ContentLoadState =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'not-found'
  | 'error';

/** Content save state */
export type ContentSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

/** Album content context value */
export interface AlbumContentContextValue {
  /** Album ID */
  albumId: string;
  /** Current loading state */
  loadState: ContentLoadState;
  /** Current save state */
  saveState: ContentSaveState;
  /** Error message if loadState or saveState is 'error' */
  errorMessage: string | null;
  /** The current content document (null if not loaded) */
  document: AlbumContentDocument | null;
  /** Current server version for optimistic concurrency */
  serverVersion: number;
  /** Whether the document has unsaved changes */
  isDirty: boolean;
  /** Whether the user can edit (has epoch key access) */
  canEdit: boolean;
  /** Load content from server */
  loadContent: () => Promise<void>;
  /** Update a specific block */
  updateBlock: (blockId: string, updates: Partial<ContentBlock>) => void;
  /** Add a new block at position (default: end) */
  addBlock: (block: ContentBlock, afterBlockId?: string) => void;
  /** Remove a block */
  removeBlock: (blockId: string) => void;
  /** Reorder blocks */
  moveBlock: (blockId: string, toIndex: number) => void;
  /** Save content to server */
  saveContent: () => Promise<boolean>;
  /** Discard local changes and reload from server */
  discardChanges: () => Promise<void>;
  /** Create initial content (for new albums) */
  createInitialContent: (title?: string) => void;
}

const AlbumContentContext = createContext<AlbumContentContextValue | null>(
  null,
);

// =============================================================================
// Provider
// =============================================================================

export interface AlbumContentProviderProps {
  children: ReactNode;
  /** Album ID */
  albumId: string;
  /** Current epoch ID for encryption */
  epochId: number;
}

export function AlbumContentProvider({
  children,
  albumId,
  epochId,
}: AlbumContentProviderProps) {
  // State
  const [loadState, setLoadState] = useState<ContentLoadState>('idle');
  const [saveState, setSaveState] = useState<ContentSaveState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [document, setDocument] = useState<AlbumContentDocument | null>(null);
  const [serverVersion, setServerVersion] = useState(0);
  const [isDirty, setIsDirty] = useState(false);

  // Track if we have epoch key access
  const epochKey = getCurrentEpochKey(albumId);
  const canEdit = epochKey !== null;

  // Ref to track current albumId for async operations
  const albumIdRef = useRef(albumId);
  albumIdRef.current = albumId;

  // Load content from server
  const loadContent = useCallback(async () => {
    if (!albumId) return;

    setLoadState('loading');
    setErrorMessage(null);

    try {
      const api = getApi();
      const response = await api.getAlbumContent(albumId);

      // Check if we're still on the same album
      if (albumIdRef.current !== albumId) return;

      // Get epoch key for decryption
      const epochKey = getCurrentEpochKey(albumId);
      if (!epochKey) {
        log.warn('No epoch key available for content decryption');
        setLoadState('error');
        setErrorMessage('No encryption key available');
        return;
      }

      // Decrypt content
      const crypto = await getCryptoClient();
      const ciphertext = fromBase64(response.encryptedContent);
      const nonce = fromBase64(response.nonce);

      const plaintext = await crypto.decryptAlbumContent(
        ciphertext,
        nonce,
        epochKey.epochSeed,
        response.epochId,
      );

      // Parse JSON
      const decoder = new TextDecoder();
      const jsonStr = decoder.decode(plaintext);
      const parsed = JSON.parse(jsonStr);

      // Validate with Zod schema
      const validated = AlbumContentDocumentSchema.parse(parsed);

      setDocument(validated);
      setServerVersion(response.version);
      setIsDirty(false);
      setLoadState('loaded');
      log.debug(`Loaded content: ${validated.blocks.length} blocks, version ${response.version}`);
    } catch (err) {
      if (albumIdRef.current !== albumId) return;

      if (err instanceof ApiError && err.status === 404) {
        setLoadState('not-found');
        setDocument(null);
        setServerVersion(0);
      } else {
        log.error('Failed to load content:', err);
        setLoadState('error');
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to load content',
        );
      }
    }
  }, [albumId]);

  // Create initial content for new albums
  const createInitialContent = useCallback((title?: string) => {
    const doc = createEmptyContentDocument();
    if (title) {
      // Use 'a' and 'b' as initial positions (like fractional indexing)
      doc.blocks.push(createHeadingBlock(1, title, 'a'));
      doc.blocks.push(createTextBlock([], 'b'));
    }
    setDocument(doc);
    setServerVersion(0);
    setIsDirty(true);
    setLoadState('loaded');
  }, []);

  // Update a specific block
  const updateBlock = useCallback(
    (blockId: string, updates: Partial<ContentBlock>) => {
      setDocument((prev) => {
        if (!prev) return prev;
        const newBlocks = prev.blocks.map((block) => {
          if (block.id !== blockId) return block;
          // Use Object.assign to preserve discriminated union type
          return Object.assign({}, block, updates) as ContentBlock;
        });
        return { ...prev, blocks: newBlocks };
      });
      setIsDirty(true);
    },
    [],
  );

  // Add a new block
  const addBlock = useCallback(
    (block: ContentBlock, afterBlockId?: string) => {
      setDocument((prev) => {
        if (!prev) return prev;
        const newBlocks = [...prev.blocks];
        if (afterBlockId) {
          const index = newBlocks.findIndex((b) => b.id === afterBlockId);
          if (index >= 0) {
            newBlocks.splice(index + 1, 0, block);
          } else {
            newBlocks.push(block);
          }
        } else {
          newBlocks.push(block);
        }
        return { ...prev, blocks: newBlocks };
      });
      setIsDirty(true);
    },
    [],
  );

  // Remove a block
  const removeBlock = useCallback((blockId: string) => {
    setDocument((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        blocks: prev.blocks.filter((b) => b.id !== blockId),
      };
    });
    setIsDirty(true);
  }, []);

  // Move a block to new position
  const moveBlock = useCallback((blockId: string, toIndex: number) => {
    setDocument((prev) => {
      if (!prev) return prev;
      const blocks = [...prev.blocks];
      const fromIndex = blocks.findIndex((b) => b.id === blockId);
      if (fromIndex < 0 || fromIndex === toIndex) return prev;

      const removed = blocks.splice(fromIndex, 1);
      if (removed.length === 0 || !removed[0]) return prev;
      blocks.splice(toIndex, 0, removed[0]);
      return { ...prev, blocks };
    });
    setIsDirty(true);
  }, []);

  // Save content to server
  const saveContent = useCallback(async (): Promise<boolean> => {
    if (!document || !albumId) return false;

    const epochKey = getCurrentEpochKey(albumId);
    if (!epochKey) {
      setErrorMessage('No encryption key available');
      setSaveState('error');
      return false;
    }

    setSaveState('saving');
    setErrorMessage(null);

    try {
      // Serialize to JSON
      const encoder = new TextEncoder();
      const plaintext = encoder.encode(JSON.stringify(document));

      // Encrypt
      const crypto = await getCryptoClient();
      const { ciphertext, nonce } = await crypto.encryptAlbumContent(
        plaintext,
        epochKey.epochSeed,
        epochId,
      );

      // Save to server
      const api = getApi();
      const response = await api.updateAlbumContent(albumId, {
        encryptedContent: toBase64(ciphertext),
        nonce: toBase64(nonce),
        epochId,
        expectedVersion: serverVersion,
      });

      setServerVersion(response.version);
      setIsDirty(false);
      setSaveState('saved');
      log.debug(`Saved content: version ${response.version}`);

      // Reset save state after delay
      setTimeout(() => setSaveState('idle'), 2000);
      return true;
    } catch (err) {
      log.error('Failed to save content:', err);
      
      if (err instanceof ApiError && err.status === 409) {
        setSaveState('conflict');
        setErrorMessage('Content was modified by another user');
      } else {
        setSaveState('error');
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to save content',
        );
      }
      return false;
    }
  }, [document, albumId, epochId, serverVersion]);

  // Discard changes and reload
  const discardChanges = useCallback(async () => {
    setIsDirty(false);
    await loadContent();
  }, [loadContent]);

  // Auto-load content on mount or album change
  useEffect(() => {
    loadContent();
  }, [loadContent]);

  // Context value
  const value = useMemo<AlbumContentContextValue>(
    () => ({
      albumId,
      loadState,
      saveState,
      errorMessage,
      document,
      serverVersion,
      isDirty,
      canEdit,
      loadContent,
      updateBlock,
      addBlock,
      removeBlock,
      moveBlock,
      saveContent,
      discardChanges,
      createInitialContent,
    }),
    [
      albumId,
      loadState,
      saveState,
      errorMessage,
      document,
      serverVersion,
      isDirty,
      canEdit,
      loadContent,
      updateBlock,
      addBlock,
      removeBlock,
      moveBlock,
      saveContent,
      discardChanges,
      createInitialContent,
    ],
  );

  return (
    <AlbumContentContext.Provider value={value}>
      {children}
    </AlbumContentContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to access album content context.
 * Must be used within an AlbumContentProvider.
 */
export function useAlbumContent(): AlbumContentContextValue {
  const context = useContext(AlbumContentContext);
  if (!context) {
    throw new Error(
      'useAlbumContent must be used within an AlbumContentProvider',
    );
  }
  return context;
}

/**
 * Hook to check if album content context is available.
 * Returns null if not within a provider.
 */
export function useAlbumContentOptional(): AlbumContentContextValue | null {
  return useContext(AlbumContentContext);
}
