// Credential application over a request plan. Given the plan, the binding's security requirements
// (the AND-ed alternatives), the denormalized scheme definitions, and a SecretResolver, place the
// right credential material onto the plan — or fail LOUD when a required credential is unconfigured.
//
// Credentials come ONLY from the resolver, keyed by {organizationId, source, scheme, actor?} drawn
// from trusted turn context — never from model args, never from the spec. A required-but-
// unconfigured scheme fails the call (an actionable configure-your-credential error) rather than
// silently sending an unauthenticated request. A resolver THROW is infrastructure failure and
// propagates unchanged — it is never swallowed into "unsatisfiable".

import type {
	SecretMaterial,
	SecretRequest,
	SecretResolver,
} from "@euroclaw/contracts";
import { configurationError } from "@euroclaw/contracts";
import type { OpenApiAuthScheme, OpenApiBinding } from "./contracts";
import type { HttpRequestPlan } from "./request-plan";

/** The trusted keying context for credential resolution — the turn's org + actor, plus the row's
 *  registration source. NONE of it comes from model args. */
export type CredentialContext = {
	organizationId: string;
	source: string;
	actor?: string;
};

/** Apply the first fully satisfiable security alternative to a COPY of the plan. Public operations
 *  (no security, `[]`, or a `{}` alternative) pass through unchanged. */
export async function applyCredentials(
	plan: HttpRequestPlan,
	binding: OpenApiBinding,
	resolveSecret: SecretResolver,
	context: CredentialContext,
): Promise<HttpRequestPlan> {
	const requirements = binding.security;
	// Undefined or `[]` security ⇒ the operation declared no auth ⇒ public.
	if (!requirements || requirements.length === 0) return plan;

	const unmet: string[] = [];
	for (const requirement of requirements) {
		const schemeNames = Object.keys(requirement);
		// A `{}` alternative is explicitly public — accept it, credential-free.
		if (schemeNames.length === 0) return plan;

		const staged: {
			scheme: string;
			def: OpenApiAuthScheme;
			material: SecretMaterial;
		}[] = [];
		let satisfiable = true;
		for (const scheme of schemeNames) {
			const def = binding.authSchemes?.[scheme];
			if (!def) {
				// Referenced scheme has no supported definition — this alternative can't be placed.
				unmet.push(`${scheme} (unsupported or undefined scheme)`);
				satisfiable = false;
				break;
			}
			const scopes = requirement[scheme] ?? [];
			const request: SecretRequest = {
				organizationId: context.organizationId,
				source: context.source,
				scheme,
				...(scopes.length > 0 ? { scopes } : {}),
				...(context.actor !== undefined ? { actor: context.actor } : {}),
			};
			// A resolver THROW is infra failure — let it propagate (never coerced to "unsatisfiable").
			const material = await resolveSecret(request);
			if (material === null) {
				unmet.push(`${scheme} (not configured)`);
				satisfiable = false;
				break;
			}
			staged.push({ scheme, def, material });
		}
		if (!satisfiable) continue;

		// Every AND-ed scheme resolved — apply them all to a fresh copy and take this alternative.
		const applied: HttpRequestPlan = { ...plan, headers: { ...plan.headers } };
		for (const { scheme, def, material } of staged) {
			applyScheme(applied, scheme, def, material);
		}
		return applied;
	}

	// No alternative was fully satisfiable and the operation required auth — fail loud, actionably.
	throw configurationError(
		"registered tool requires a credential that is not configured",
		{ source: context.source, unsatisfied: unmet },
	);
}

function applyScheme(
	plan: HttpRequestPlan,
	scheme: string,
	def: OpenApiAuthScheme,
	material: SecretMaterial,
): void {
	if (def.type === "apiKey") {
		const value = tokenValue(scheme, def.type, material);
		if (def.in === "header") {
			plan.headers[def.name] = value;
		} else {
			appendQueryParam(plan, def.name, value);
		}
		return;
	}
	if (def.type === "http" && def.scheme === "basic") {
		if (material.kind !== "basic") {
			throw configurationError(
				`scheme "${scheme}" is http/basic but the resolver returned ${material.kind} material`,
				{ scheme },
			);
		}
		plan.headers.authorization = `Basic ${base64Utf8(`${material.username}:${material.password}`)}`;
		return;
	}
	// http/bearer and oauth2/openIdConnect all place a bearer token.
	plan.headers.authorization = `Bearer ${tokenValue(scheme, def.type, material)}`;
}

function tokenValue(
	scheme: string,
	type: string,
	material: SecretMaterial,
): string {
	if (material.kind !== "token") {
		throw configurationError(
			`scheme "${scheme}" (${type}) needs token material but the resolver returned ${material.kind}`,
			{ scheme },
		);
	}
	return material.value;
}

function appendQueryParam(
	plan: HttpRequestPlan,
	name: string,
	value: string,
): void {
	const separator = plan.url.includes("?") ? "&" : "?";
	plan.url = `${plan.url}${separator}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

/** Base64 of a UTF-8 string using web-standard primitives (euroclaw packages avoid node `Buffer`
 *  types): TextEncoder → bytes → btoa. Correct for non-ASCII basic-auth credentials. */
function base64Utf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
