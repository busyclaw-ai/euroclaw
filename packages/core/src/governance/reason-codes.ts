/**
 * Portions of this file are adapted from Better Auth
 * (https://github.com/better-auth/better-auth), Copyright (c) 2024 - present,
 * Bereket Engida, licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 * Copyright (c) 2026 Konstantin Ponomarev.
 *
 * Adapted (patterns/API, not verbatim): Better Auth's error-code catalog pattern,
 * renamed here to reason codes because governance outcomes are not thrown system errors.
 */

type UpperLetter =
	| "A"
	| "B"
	| "C"
	| "D"
	| "E"
	| "F"
	| "G"
	| "H"
	| "I"
	| "J"
	| "K"
	| "L"
	| "M"
	| "N"
	| "O"
	| "P"
	| "Q"
	| "R"
	| "S"
	| "T"
	| "U"
	| "V"
	| "W"
	| "X"
	| "Y"
	| "Z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type ReasonCodeCharacter = UpperLetter | Digit | "_";

type IsValidUpperSnakeCase<S extends string> = S extends `${infer F}${infer R}`
	? F extends ReasonCodeCharacter
		? IsValidUpperSnakeCase<R>
		: false
	: true;

type InvalidReasonCodeKey<K extends string> =
	`Invalid reason code key: "${K}" - must only contain uppercase letters (A-Z), digits (0-9), and underscores (_)`;

type ValidateReasonCodes<T> = {
	[K in keyof T]: K extends string
		? IsValidUpperSnakeCase<K> extends false
			? InvalidReasonCodeKey<K>
			: T[K]
		: T[K];
};

export type ReasonCode<K extends string = string> = {
	readonly code: K;
	message: string;
	toString: () => K;
};

/** Identity that pins literal reason-code keys/messages and enforces UPPER_SNAKE_CASE keys. */
export function defineReasonCodes<
	const T extends Record<string, string>,
	R extends { [K in keyof T & string]: ReasonCode<K> },
>(codes: ValidateReasonCodes<T>): R {
	return Object.fromEntries(
		Object.entries(codes).map(([key, value]) => [
			key,
			{ code: key, message: value, toString: () => key },
		]),
	) as R;
}
