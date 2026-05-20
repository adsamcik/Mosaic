import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApi } from '../api';

/**
 * Regression test for v1.0.1 photos-f (bulk delete selection mode).
 *
 * The selection-mode bulk delete signs a tombstone for each manifest and
 * issues `DELETE /api/v1/manifests/{id}` with the signed body. The body
 * MUST cross the wire as a JSON object so ASP.NET's
 * `[FromBody] DeleteManifestRequest?` can bind it.
 *
 * Before this fix, `api.deleteManifest` called `JSON.stringify(body)` and
 * passed the resulting string into `apiRequest`'s `body` option, which
 * stringifies again — producing a JSON-encoded string literal on the
 * wire. The backend then rejected every signed delete with HTTP 400
 * ("Invalid request. Please check your input.") which the dialog surfaced
 * to the user as an unfixable error banner. Album cascade-delete also
 * appeared broken because users could never empty an album first.
 */
describe('api.deleteManifest wire format (photos-f regression)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let lastBody: string | null;

  beforeEach(() => {
    lastBody = null;
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        lastBody = typeof init?.body === 'string' ? init.body : null;
        return new Response(null, { status: 204 });
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends a JSON object (not a doubly-stringified JSON string) when body is provided', async () => {
    const api = getApi();
    await api.deleteManifest('manifest-id-1', {
      tombstoneSignature: 'AAAA',
      signerEpochId: 7,
    });

    expect(lastBody).not.toBeNull();
    // Single-pass JSON.parse must yield the object, not another string.
    const parsed: unknown = JSON.parse(lastBody as string);
    expect(parsed).toEqual({
      tombstoneSignature: 'AAAA',
      signerEpochId: 7,
    });
    // Defensive: confirm we are NOT looking at a doubly-stringified value.
    expect(typeof parsed).toBe('object');
  });

  it('omits the body entirely when no signed tombstone is provided', async () => {
    const api = getApi();
    await api.deleteManifest('manifest-id-2', null);

    expect(lastBody).toBeNull();
  });

  it('sets Content-Type: application/json when body is provided', async () => {
    const api = getApi();
    await api.deleteManifest('manifest-id-3', {
      tombstoneSignature: 'BBBB',
      signerEpochId: 1,
    });

    const lastCall = fetchSpy.mock.calls.at(-1);
    const headers = (lastCall?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.['Content-Type']).toBe('application/json');
  });
});
