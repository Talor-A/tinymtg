export function assert(
	condition: unknown,
	message?: string,
): asserts condition {
	if (!condition) {
		throw new Error(message ?? "Assertion failed");
	}
}

export function assertDefined<T>(
	value: T | undefined | null,
	message?: string,
): asserts value is T {
	assert(
		value !== undefined && value !== null,
		message ?? "Value should be defined",
	);
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${value}`);
}
