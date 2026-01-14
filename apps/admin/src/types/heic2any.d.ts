/**
 * Type declarations for heic2any library
 */
declare module 'heic2any' {
  interface Heic2anyOptions {
    /** The source HEIC blob to convert */
    blob: Blob;
    /** Target output format */
    toType?: 'image/jpeg' | 'image/png' | 'image/gif';
    /** Quality for JPEG output (0-1) */
    quality?: number;
    /** If true, output all images from multi-image HEIC */
    multiple?: boolean;
  }

  /**
   * Convert HEIC/HEIF blob to another format
   *
   * @param options - Conversion options
   * @returns Single Blob or array of Blobs (for multi-image HEIC)
   */
  function heic2any(options: Heic2anyOptions): Promise<Blob | Blob[]>;

  export default heic2any;
}
