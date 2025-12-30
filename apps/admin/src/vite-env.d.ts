/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_PORT?: string;
  /**
   * Enable weak Argon2 parameters for E2E testing.
   * @security NEVER set to 'true' in production builds.
   */
  readonly VITE_E2E_WEAK_KEYS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Extend Vite's worker import types
declare module '*?worker' {
  const workerConstructor: new (options?: WorkerOptions) => Worker;
  export default workerConstructor;
}

declare module '*?sharedworker' {
  const sharedWorkerConstructor: new (options?: WorkerOptions) => SharedWorker;
  export default sharedWorkerConstructor;
}