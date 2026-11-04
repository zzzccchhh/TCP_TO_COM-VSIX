const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
    testDir: './tests',
    testMatch: 'home-ui.spec.cjs',
    workers: 1,
    timeout: 20000,
    reporter: 'list',
    use: {
        channel: process.platform === 'win32' ? 'msedge' : undefined,
        viewport: { width: 360, height: 900 },
        trace: 'retain-on-failure',
    },
    outputDir: 'test-results/home-ui',
});
