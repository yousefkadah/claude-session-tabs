/** Trailing-edge debounce: coalesces rapid calls into one after `ms` of quiet. */
export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (handle) {
      clearTimeout(handle);
    }
    handle = setTimeout(() => fn(...args), ms);
  };
}
