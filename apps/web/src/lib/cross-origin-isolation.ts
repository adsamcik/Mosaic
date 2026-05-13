export interface CrossOriginIsolationState {
  readonly crossOriginIsolated: boolean;
}

export function isCrossOriginIsolationAvailable(
  isolationState: CrossOriginIsolationState | undefined =
    typeof window === 'undefined' ? undefined : window,
): boolean {
  return isolationState?.crossOriginIsolated === true;
}
