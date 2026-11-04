const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const visual = path.join(root, 'artifacts', 'extension-visual.json');
if (fs.existsSync(visual)) fs.unlinkSync(visual);
let finished = false;
(async () => {
    const { chromium } = require('@playwright/test');
    let browser;
    try {
        for (let i = 0; i < 60 && !finished; i++) {
            try {
                browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
                const pages = browser.contexts().flatMap((c) => c.pages());
                let frame, page;
                for (const p of pages) {
                    for (const f of p.frames()) {
                        if (await f.getByLabel('业务 COM', { exact: true }).count()) {
                            frame = f;
                            page = p;
                            break;
                        }
                    }
                    if (frame) break;
                }
                if (!frame) {
                    fs.writeFileSync(
                        path.join(root, 'artifacts', 'webview-diagnostic.json'),
                        JSON.stringify(
                            pages.map((p) => ({ url: p.url(), frames: p.frames().map((f) => f.url()) })),
                            null,
                            2,
                        ),
                    );
                    if (pages[0])
                        await pages[0].screenshot({
                            path: path.join(root, 'artifacts', 'webview-diagnostic.png'),
                        });
                    await browser.close();
                    browser = undefined;
                    await new Promise((r) => setTimeout(r, 800));
                    continue;
                }
                const { expect } = require('@playwright/test');
                await expect(frame.getByRole('status', { name: '服务连接状态', exact: true })).toHaveText(
                    '服务已连接',
                );
                await expect(frame.getByRole('button', { name: '启动桥接', exact: true })).toBeVisible();
                await frame.getByLabel('业务 COM', { exact: true }).click();
                await frame.getByLabel('业务 COM', { exact: true }).fill('COM-EXTENSION-TEST');
                const res = await fetch('http://127.0.0.1:8765/');
                const html = await res.text();
                const invite = JSON.parse(html.match(/window\.__WIFI_BRIDGE__=(\{[^<]+\});/)[1]).invite;
                const post = async (p, body, token) =>
                    await (
                        await fetch('http://127.0.0.1:8765' + p, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                ...(token ? { Authorization: 'Bearer ' + token } : {}),
                            },
                            body: JSON.stringify(body),
                        })
                    ).json();
                const enrollment = await post('/api/connect', {
                    invite,
                    name: 'extension-test-browser',
                    join_id: 'extension-test-browser-000001',
                });
                let synchronized = false;
                for (let turn = 0; turn < 30; turn++) {
                    const result = await post(
                        '/api/call',
                        { method: 'poll', args: [] },
                        enrollment.data.token,
                    );
                    if (result.data.settings.com === 'COM-EXTENSION-TEST') {
                        synchronized = true;
                        break;
                    }
                    await new Promise((r) => setTimeout(r, 100));
                }
                if (!synchronized) throw Error('Webview edit did not reach shared backend');
                await page.screenshot({ path: path.join(root, 'artifacts', 'vscode-workbench.png') });
                fs.writeFileSync(visual, JSON.stringify({ connected: true, synchronized: true }, null, 2));
                await browser.close();
                return;
            } catch (e) {
                if (browser) {
                    await browser.close().catch(() => {});
                    browser = undefined;
                }
                if (i === 59) throw e;
                await new Promise((r) => setTimeout(r, 800));
            }
        }
    } catch (e) {
        console.error('Webview verification:', e.message);
    }
})();
runTests({
    vscodeExecutablePath: path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    extensionDevelopmentPath: process.env.TCP2COM_EXTENSION_ROOT || root,
    extensionTestsPath: path.join(root, 'dist', 'tests', 'extension', 'index.js'),
    launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-updates',
        '--user-data-dir=' + path.join(root, '.vscode-test', 'user-data'),
        '--extensions-dir=' + path.join(root, '.vscode-test', 'extensions'),
        '--remote-debugging-port=9333',
    ],
    extensionTestsEnv: {
        TCP2COM_TEST_REPORT: path.join(root, 'artifacts', 'extension-test.json'),
        TCP2COM_VISUAL_REPORT: visual,
    },
})
    .then(() => (finished = true))
    .catch((e) => {
        finished = true;
        console.error(e);
        process.exit(1);
    });
