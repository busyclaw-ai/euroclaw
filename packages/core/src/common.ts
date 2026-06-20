import { type } from "arktype";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

function isPlainObject(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isJsonValue(
	value: unknown,
	seen = new WeakSet<object>(),
): value is JsonValue {
	if (value === null) return true;
	const valueType = typeof value;
	if (valueType === "string" || valueType === "boolean") return true;
	if (valueType === "number") return Number.isFinite(value);
	if (valueType !== "object") return false;
	const objectValue = value as object;
	if (seen.has(objectValue)) return false;
	seen.add(objectValue);
	try {
		if (Array.isArray(value))
			return value.every((item) => isJsonValue(item, seen));
		if (!isPlainObject(objectValue)) return false;
		if (Object.getOwnPropertySymbols(objectValue).length > 0) return false;
		const descriptors = Object.getOwnPropertyDescriptors(objectValue);
		for (const descriptor of Object.values(descriptors)) {
			if (!descriptor.enumerable) return false;
			if (!("value" in descriptor)) return false;
			if (!isJsonValue(descriptor.value, seen)) return false;
		}
		return true;
	} finally {
		seen.delete(objectValue);
	}
}

function isJsonObject(value: unknown): value is JsonObject {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		isJsonValue(value)
	);
}

/** Any JSON-safe value accepted in durable/core payloads. */
export const jsonValue = type("unknown").narrow((value): value is JsonValue =>
	isJsonValue(value),
);

/** Object-shaped JSON payloads. The root must be an object; nested arrays/scalars are allowed. */
export const jsonObject = type("object").narrow((value): value is JsonObject =>
	isJsonObject(value),
);
