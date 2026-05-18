import { describe, expect, it } from 'vitest';
import { UploadQueue } from '../upload-queue';

describe('UploadQueue offline pause/resume (v1.0.x s49-y3)', () => {
  it('latches offlinePaused on pauseForOffline', () => {
    const queue = new UploadQueue();
    expect(queue.isOfflinePaused).toBe(false);
    queue.pauseForOffline();
    expect(queue.isOfflinePaused).toBe(true);
    queue.dispose();
  });

  it('idempotent pause does not toggle the flag', () => {
    const queue = new UploadQueue();
    queue.pauseForOffline();
    queue.pauseForOffline();
    expect(queue.isOfflinePaused).toBe(true);
    queue.dispose();
  });

  it('clears the flag on resumeAfterOnline', () => {
    const queue = new UploadQueue();
    queue.pauseForOffline();
    queue.resumeAfterOnline();
    expect(queue.isOfflinePaused).toBe(false);
    queue.dispose();
  });

  it('resume is a no-op when not paused', () => {
    const queue = new UploadQueue();
    queue.resumeAfterOnline();
    expect(queue.isOfflinePaused).toBe(false);
    queue.dispose();
  });
});
