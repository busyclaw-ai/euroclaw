import {
	type ClawRequestHandlerOptions,
	toRequestHandler,
} from "@euroclaw/adapter-core";
import type { Claw } from "euroclaw";

export function toNextJsHandler(
	claw: Claw,
	options?: ClawRequestHandlerOptions,
) {
	const handler = toRequestHandler(claw, options);
	return {
		DELETE: handler,
		GET: handler,
		PATCH: handler,
		POST: handler,
		PUT: handler,
	};
}

export type { ClawRequestHandlerOptions };
