import { defineConfig } from 'vitest/config';

export default defineConfig({
	define: {
		DEBUG_MODE: false,
		LIVESYNC_ENABLED: true,
	},
	test: {
		include: ['src/**/*.test.ts'],
		globals: true,
		alias: {
			'webextension-polyfill': new URL('./src/utils/__mocks__/webextension-polyfill.ts', import.meta.url).pathname,
		},
	},
});
