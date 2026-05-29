import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, '__mocks__/obsidian.ts'),
		},
	},
});
