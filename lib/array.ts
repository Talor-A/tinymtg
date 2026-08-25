import { assert } from "./assert";

export function randomElement<T>(arr: T[]): T {
	const t = arr[Math.floor(Math.random() * arr.length)];

	assert(t !== undefined);
	return t;
}
