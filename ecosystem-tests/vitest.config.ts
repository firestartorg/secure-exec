import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		testTimeout: 60000,
		// Disable all parallelism
		fileParallelism: false,
		// Run each test file in its own isolated process
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true,
				isolate: true,
			},
		},
		// Run tests sequentially within files
		sequence: {
			concurrent: false,
		},
		// Isolate test environments
		isolate: true,
	},
});
