import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// The QuickJS wasm module loads in-process on first execute; give the real-provider suites room.
		testTimeout: 30000,
	},
});
