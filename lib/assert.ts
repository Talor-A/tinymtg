export function assert(
	condition: boolean,
	message?: string,
): condition is true {
	if (!condition) {
		throw new Error(message ?? "Assertion failed");
	}
	return true;
}

export function assertDefined<T>(
	value: T | undefined | null,
): asserts value is T {
	assert(value !== undefined, "Value should be defined");
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${value}`);
}
