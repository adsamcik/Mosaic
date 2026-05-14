export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

export function makeStringSetGuard<T extends string>(
  set: ReadonlySet<T>,
): (value: unknown) => value is T {
  return (value: unknown): value is T =>
    typeof value === 'string' && set.has(value as T);
}
