import { type as ark } from "arktype";
import type { JsonObject, JsonValue } from "./common";
import {
	jsonObject as jsonObjectSchema,
	jsonValue as jsonValueSchema,
} from "./common";

export type EntityFieldType = "string" | "number" | "boolean" | "date" | "json";

export type EntityFieldMeta = {
	type: EntityFieldType;
	required?: boolean;
	unique?: boolean;
	index?: boolean;
	references?: { model: string; field: string };
	fieldName?: string;
	input?: boolean;
	returned?: boolean;
	writable?: boolean;
	pii?: "none" | "possible" | "contains" | "redacted";
	retention?: "default" | "ephemeral" | "audit" | "until-erasure";
	defaultValue?: unknown | (() => unknown);
	onUpdate?: () => unknown;
};

type FieldKind =
	| "string"
	| "number"
	| "boolean"
	| "jsonObject"
	| "jsonValue"
	| "enum";

export type EntityField<
	Kind extends FieldKind = FieldKind,
	Values extends readonly string[] = readonly string[],
	Value = FieldValueFor<Kind, Values>,
> = EntityFieldMeta & {
	kind: Kind;
	values?: Values;
	ark: unknown;
	optionalArk: unknown;
	readonly __value: Value;
};

type FieldValueFor<
	Kind extends FieldKind,
	Values extends readonly string[],
> = Kind extends "string"
	? string
	: Kind extends "number"
		? number
		: Kind extends "boolean"
			? boolean
			: Kind extends "jsonObject"
				? JsonObject
				: Kind extends "jsonValue"
					? JsonValue
					: Kind extends "enum"
						? Values[number]
						: never;

type FieldValue<F> = F extends { readonly __value: infer Value }
	? Value
	: never;

type EmptyFieldMeta = Record<never, never>;

type JsonEntityFieldMeta = Omit<EntityFieldMeta, "type"> & {
	ark?: unknown;
	optionalArk?: unknown;
};

type JsonEntityStorageMeta<Meta> = Omit<Meta, "ark" | "optionalArk"> & {
	type: "json";
};

type RequiredKeys<Fields extends Record<string, EntityField>> = {
	[K in keyof Fields]: Fields[K]["required"] extends true ? K : never;
}[keyof Fields];

type OptionalKeys<Fields extends Record<string, EntityField>> = Exclude<
	keyof Fields,
	RequiredKeys<Fields>
>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type EntityRecord<Fields extends Record<string, EntityField>> = Simplify<
	{ [K in RequiredKeys<Fields>]: FieldValue<Fields[K]> } & {
		[K in OptionalKeys<Fields>]?: FieldValue<Fields[K]>;
	}
>;

export type EntityInput<
	Fields extends Record<string, EntityField>,
	Omitted extends keyof Fields = never,
	Optional extends Exclude<keyof Fields, Omitted> = never,
> = Simplify<
	{
		[K in Exclude<RequiredKeys<Fields>, Omitted | Optional>]: FieldValue<
			Fields[K]
		>;
	} & {
		[K in Exclude<OptionalKeys<Fields>, Omitted> | Optional]?: FieldValue<
			Fields[K]
		>;
	}
>;

export type EntitySchemaOptions<Fields extends Record<string, EntityField>> = {
	omit?: readonly (keyof Fields & string)[];
	optional?: readonly (keyof Fields & string)[];
	pick?: readonly (keyof Fields & string)[];
};

type OptionKeys<
	Options,
	Key extends keyof EntitySchemaOptions<Record<string, EntityField>>,
> =
	Options extends Record<Key, readonly (infer Value)[]>
		? Extract<Value, string>
		: never;

type PickedKeys<
	Fields extends Record<string, EntityField>,
	Options,
> = Options extends { pick: readonly (infer Value)[] }
	? Extract<Value, keyof Fields>
	: keyof Fields;

type SchemaKeys<Fields extends Record<string, EntityField>, Options> = Exclude<
	PickedKeys<Fields, Options>,
	Extract<OptionKeys<Options, "omit">, keyof Fields>
>;

type SchemaRequiredKeys<
	Fields extends Record<string, EntityField>,
	Options,
> = Exclude<
	Extract<RequiredKeys<Fields>, SchemaKeys<Fields, Options>>,
	Extract<OptionKeys<Options, "optional">, keyof Fields>
>;

type SchemaOptionalKeys<
	Fields extends Record<string, EntityField>,
	Options,
> = Exclude<SchemaKeys<Fields, Options>, SchemaRequiredKeys<Fields, Options>>;

export type EntitySchemaInput<
	Fields extends Record<string, EntityField>,
	Options extends EntitySchemaOptions<Fields>,
> = Simplify<
	{ [K in SchemaRequiredKeys<Fields, Options>]: FieldValue<Fields[K]> } & {
		[K in SchemaOptionalKeys<Fields, Options>]?: FieldValue<Fields[K]>;
	}
>;

function enumExpression(values: readonly string[]): string {
	return values.map((value) => `'${value}'`).join(" | ");
}

function optionalExpression(expression: string): string {
	return `${expression} | undefined`;
}

function makeField<
	const Kind extends FieldKind,
	const Values extends readonly string[],
	Value,
	const Meta extends EntityFieldMeta,
>(
	input: Meta & {
		kind: Kind;
		values?: Values;
		ark: unknown;
		optionalArk: unknown;
	},
): EntityField<Kind, Values, Value> & Meta {
	return input as EntityField<Kind, Values, Value> & Meta;
}

export const field = {
	string: <const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta>(
		meta?: Meta,
	) =>
		makeField<"string", readonly string[], string, Meta & { type: "string" }>({
			...(meta ?? ({} as Meta)),
			type: "string",
			kind: "string",
			ark: "string",
			optionalArk: "string | undefined",
		}),
	number: <const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta>(
		meta?: Meta,
	) =>
		makeField<"number", readonly string[], number, Meta & { type: "number" }>({
			...(meta ?? ({} as Meta)),
			type: "number",
			kind: "number",
			ark: "number",
			optionalArk: "number | undefined",
		}),
	boolean: <const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta>(
		meta?: Meta,
	) =>
		makeField<
			"boolean",
			readonly string[],
			boolean,
			Meta & { type: "boolean" }
		>({
			...(meta ?? ({} as Meta)),
			type: "boolean",
			kind: "boolean",
			ark: "boolean",
			optionalArk: "boolean | undefined",
		}),
	jsonObject: <
		Value = JsonObject,
		const Meta extends JsonEntityFieldMeta = EmptyFieldMeta,
	>(
		meta?: Meta,
	) => {
		const { ark, optionalArk, ...fieldMeta } = meta ?? {};
		const input = {
			...fieldMeta,
			type: "json",
			kind: "jsonObject",
			ark: ark ?? jsonObjectSchema,
			optionalArk: optionalArk ?? jsonObjectSchema.or("undefined"),
		} as JsonEntityStorageMeta<Meta> & {
			kind: "jsonObject";
			ark: unknown;
			optionalArk: unknown;
		};
		return makeField<
			"jsonObject",
			readonly string[],
			Value,
			JsonEntityStorageMeta<Meta>
		>(input);
	},
	jsonValue: <
		Value = JsonValue,
		const Meta extends JsonEntityFieldMeta = EmptyFieldMeta,
	>(
		meta?: Meta,
	) => {
		const { ark, optionalArk, ...fieldMeta } = meta ?? {};
		const input = {
			...fieldMeta,
			type: "json",
			kind: "jsonValue",
			ark: ark ?? jsonValueSchema,
			optionalArk: optionalArk ?? jsonValueSchema.or("undefined"),
		} as JsonEntityStorageMeta<Meta> & {
			kind: "jsonValue";
			ark: unknown;
			optionalArk: unknown;
		};
		return makeField<
			"jsonValue",
			readonly string[],
			Value,
			JsonEntityStorageMeta<Meta>
		>(input);
	},
	enum: <
		const Values extends readonly [string, ...string[]],
		const Meta extends Omit<EntityFieldMeta, "type"> = EmptyFieldMeta,
	>(
		values: Values,
		meta?: Meta,
	) => {
		const expression = enumExpression(values);
		return makeField<"enum", Values, Values[number], Meta & { type: "string" }>(
			{
				...(meta ?? ({} as Meta)),
				type: "string",
				kind: "enum",
				values,
				ark: expression,
				optionalArk: optionalExpression(expression),
			},
		);
	},
};

function shapeFor(
	fields: Record<string, EntityField>,
	input: {
		omit?: readonly string[];
		optional?: readonly string[];
		pick?: readonly string[];
	} = {},
): Record<string, unknown> {
	const omit = new Set(input.omit ?? []);
	const pick = input.pick ? new Set(input.pick) : undefined;
	const optional = new Set(input.optional ?? []);
	const shape: Record<string, unknown> = {};
	for (const [name, field] of Object.entries(fields)) {
		if (omit.has(name)) continue;
		if (pick && !pick.has(name)) continue;
		const required = field.required === true && !optional.has(name);
		shape[required ? name : `${name}?`] = required
			? field.ark
			: field.optionalArk;
	}
	return shape;
}

export function entity<const Fields extends Record<string, EntityField>>(
	name: string,
	fields: Fields,
) {
	const record = ark(shapeFor(fields));
	const storage = {
		[name]: {
			fields: Object.fromEntries(
				Object.entries(fields).map(([fieldName, field]) => [
					fieldName,
					{
						type: field.type,
						required: field.required,
						unique: field.unique,
						index: field.index,
						references: field.references,
						fieldName: field.fieldName,
						input: field.input,
						returned: field.returned,
						writable: field.writable,
						pii: field.pii,
						retention: field.retention,
						defaultValue: field.defaultValue,
						onUpdate: field.onUpdate,
					},
				]),
			),
		},
	};
	return {
		fields,
		name,
		record,
		storage,
		schema: <const Options extends EntitySchemaOptions<Fields>>(
			input?: Options,
		) => ark(shapeFor(fields, input)),
	};
}
