import { assert } from "./assert";

export function randomElement<T>(arr: T[]): T {
  const t = arr[Math.floor(Math.random() * arr.length)];

  assert(t !== undefined);
  return t;
}
export function includes<T extends U, U>(
  arr: ReadonlyArray<T>,
  searchElement: U,
): searchElement is T {
  return arr.includes(searchElement as T);
}
