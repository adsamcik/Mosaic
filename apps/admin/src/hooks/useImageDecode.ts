import { useEffect, useRef, useState } from 'react';

/**
 * Result of the useImageDecode hook
 */
export interface UseImageDecodeResult {
  /** Whether the image has been decoded and is ready for display */
  isDecoded: boolean;
  /** Error if decode failed */
  error: Error | null;
}

/**
 * Hook for progressive image decoding using the img.decode() API.
 *
 * Decodes images off the main thread before displaying, preventing
 * jank during gallery scrolling. The hook handles:
 * - Aborting previous decode when URL changes
 * - Cleaning up on unmount (no state updates after unmount)
 * - Error handling for failed decodes
 *
 * @param url - The image URL to decode (blob URL, data URL, or regular URL)
 * @returns { isDecoded, error }
 *
 * @example
 * ```tsx
 * const { isDecoded, error } = useImageDecode(blobUrl);
 *
 * return isDecoded ? (
 *   <img src={blobUrl} alt="Photo" />
 * ) : (
 *   <div className="placeholder" />
 * );
 * ```
 */
export function useImageDecode(
  url: string | null | undefined,
): UseImageDecodeResult {
  const [isDecoded, setIsDecoded] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track the current decode operation to abort on URL change
  const currentUrlRef = useRef<string | null | undefined>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Skip if no URL provided
    if (!url) {
      setIsDecoded(false);
      setError(null);
      return;
    }

    // URL changed - reset state
    if (url !== currentUrlRef.current) {
      setIsDecoded(false);
      setError(null);
      currentUrlRef.current = url;
    }

    // Create image and decode
    const img = new Image();
    img.src = url;

    img
      .decode()
      .then(() => {
        // Only update state if still mounted and URL hasn't changed
        if (isMountedRef.current && currentUrlRef.current === url) {
          setIsDecoded(true);
          setError(null);
        }
      })
      .catch((err: Error) => {
        // Only update state if still mounted and URL hasn't changed
        if (isMountedRef.current && currentUrlRef.current === url) {
          setIsDecoded(false);
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      });

    // No explicit cleanup needed - the URL check prevents stale updates
  }, [url]);

  return { isDecoded, error };
}
