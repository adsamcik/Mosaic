# SPEC: Enhanced Upload Experience

> **Status:** Draft for Review  
> **Scope:** Frontend upload UX improvements  
> **Files Affected:** ~8-10 files (components, context, styles)

## Current State Analysis

### What Works
- ✅ Basic file selection via button
- ✅ Drag-and-drop to gallery area
- ✅ Progress indicator (fixed bottom-right)
- ✅ Error toast with auto-dismiss
- ✅ Resumable uploads via Tus protocol
- ✅ Thumbnail generation during upload

### Pain Points Identified
1. **No multi-file queue visibility** - When uploading multiple files, users only see overall progress, not individual file status
2. **No upload preview** - Users can't see what they're about to upload before it starts
3. **No cancel capability exposed** - Queue has `cancel()` but no UI button
4. **Single progress indicator** - No differentiation between files
5. **No file validation feedback** - Invalid files silently ignored
6. **No success confirmation** - Progress just disappears when done
7. **No retry option** - Errors require manual re-upload
8. **Limited upload status details** - No file names, sizes, or stage indicators

## Proposed Design

### 1. Upload Panel Component (New)
A slide-in panel showing the full upload queue with per-file status.

```
┌─────────────────────────────────────────────┐
│ Uploads                              ✕ Close │
├─────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────┐ │
│ │ 📷 beach-sunset.jpg                      │ │
│ │ ████████████░░░░░░░░░░░░░░░░ 45%        │ │
│ │ Encrypting... 2.3 MB                [✕] │ │
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ 📷 family-photo.png         ✓ Complete  │ │
│ │ 4.1 MB                                  │ │
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ 📷 vacation.heic             ⚠ Error    │ │
│ │ Network failed              [↻ Retry]   │ │
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ 📷 document.pdf             ⊘ Skipped   │ │
│ │ Invalid file type                       │ │
│ └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│ 2 of 4 files uploaded • 6.4 MB total        │
└─────────────────────────────────────────────┘
```

### 2. Upload Status Badge (New)
A small badge on the upload button showing queue count.

```
┌──────────────────┐
│ 📷 Upload   (3)  │  <- Shows pending count
└──────────────────┘
```

### 3. Enhanced Drop Zone
Visual improvements during drag-over state with file count preview.

```
┌─────────────────────────────────────────────┐
│                                             │
│           📷                                │
│                                             │
│      Drop 5 photos to upload               │
│                                             │
│      Supported: JPEG, PNG, WebP, HEIC      │
│                                             │
└─────────────────────────────────────────────┘
```

### 4. Upload Stages
Show clear stages for each file:
1. **Queued** - Waiting to start
2. **Generating thumbnail** - Creating preview
3. **Encrypting** - Client-side encryption
4. **Uploading** - Sending to server (with %)
5. **Finalizing** - Creating manifest
6. **Complete** - ✓ Success
7. **Error** - ⚠ With retry option

### 5. Floating Mini Progress (Compact Mode)
When panel is closed, show a minimized indicator:

```
┌──────────────────────────┐
│ 📷 Uploading 2/5 • 67%  ▲│  <- Click to expand
└──────────────────────────┘
```

## Component Architecture

```
Gallery
├── UploadProvider (enhanced with queue state)
│   ├── UploadButton (with badge)
│   ├── DropZone (enhanced feedback)
│   ├── UploadPanel (NEW - slide-in queue view)
│   │   ├── UploadQueueItem (per-file status)
│   │   └── UploadSummary (totals)
│   └── UploadMiniBadge (NEW - floating mini progress)
```

## Data Flow

### Enhanced UploadContext State
```typescript
interface UploadQueueState {
  /** All files in queue (pending, active, complete, error) */
  queue: UploadQueueItem[];
  /** Currently active uploads */
  activeCount: number;
  /** Completed count (this session) */
  completedCount: number;
  /** Error count */
  errorCount: number;
  /** Total bytes uploaded */
  totalBytesUploaded: number;
  /** Total bytes to upload */
  totalBytes: number;
  /** Overall progress (0-100) */
  overallProgress: number;
  /** Panel open state */
  isPanelOpen: boolean;
}

interface UploadQueueItem {
  id: string;
  file: File;
  albumId: string;
  status: 'queued' | 'thumbnail' | 'encrypting' | 'uploading' | 'finalizing' | 'complete' | 'error' | 'skipped';
  progress: number; // 0-100
  bytesUploaded: number;
  error?: string;
  thumbnail?: string; // Base64 preview
}
```

### Actions
```typescript
interface UploadContextActions {
  upload: (files: File[], albumId: string) => Promise<void>;
  cancel: (taskId: string) => void;
  retry: (taskId: string) => void;
  clearCompleted: () => void;
  openPanel: () => void;
  closePanel: () => void;
}
```

## ZK Invariants

1. ✅ No plaintext photo data sent to server (encryption before upload)
2. ✅ File previews use local `URL.createObjectURL()` - never server
3. ✅ Progress reflects encrypted shard upload, not raw file
4. ✅ Thumbnails generated client-side, never from server

## Verification Plan

### Unit Tests
1. `UploadPanel.test.tsx` - Panel open/close, item rendering
2. `UploadQueueItem.test.tsx` - Status display, cancel/retry buttons
3. `UploadMiniBadge.test.tsx` - Compact progress display
4. `UploadContext.test.tsx` - Queue state management

### E2E Tests
1. Upload 5 files, verify all appear in queue
2. Cancel mid-upload, verify cancellation
3. Network failure recovery with retry
4. Drag 10 files, verify count in drop zone feedback

## Implementation Phases

### Phase 1: Enhanced Context (Foundation)
- Extend `UploadContext` with queue visibility
- Add per-file tracking
- Expose cancel/retry actions

### Phase 2: Upload Panel
- Create `UploadPanel` component
- Create `UploadQueueItem` component
- Add slide-in animation

### Phase 3: UI Polish
- Enhance `DropZone` with file count
- Add `UploadMiniBadge` floating indicator
- Update button with pending count badge

### Phase 4: File Validation
- Add file type validation with feedback
- Add file size validation (quota check)
- Show skipped files with reason

## Success Metrics
- Users can see all pending uploads
- Users can cancel specific uploads
- Users can retry failed uploads
- Users get clear feedback for invalid files
- Upload state persists across panel toggle
