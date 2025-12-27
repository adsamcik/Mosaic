/// <reference types="vite/client" />

// Extend Vite's worker import types
declare module '*?worker' {
  const workerConstructor: new (options?: WorkerOptions) => Worker;
  export default workerConstructor;
}

declare module '*?sharedworker' {
  const sharedWorkerConstructor: new (options?: WorkerOptions) => SharedWorker;
  export default sharedWorkerConstructor;
}