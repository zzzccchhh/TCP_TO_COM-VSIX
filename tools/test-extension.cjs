const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');
const root = path.join(__dirname, '..');
// Keep the user's service on the default port running during isolated host checks.
const backendPort = Number(
    require('node:child_process').execFileSync(
        process.execPath,
        [
            '-e',
            "const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close()})",
        ],
        { encoding: 'utf8', windowsHide: true },
    ),
);
const serviceURL = `http://127.0.0.1:${backendPort}`;
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const visual = path.join(root, 'artifacts', 'extension-visual.json');
if (fs.existsSync(visual)) fs.unlinkSync(visual);
let finished = false;
let homepage = false;
let inlineQR = false;
let configVerified = false;
let panelsVerified = false;
(async () => {
    const { chromium } = require('@playwright/test');
    const { defaultConfig } = require('../dist/src/shared/model');
    let configPosts = 0;
    const fixture = require('node:http').createServer((req, res) => {
        if (req.method === 'GET')
            res.end(
                JSON.stringify({
                    ...defaultConfig('c5'),
                    config_api: 'c5-config-2',
                    revision: 5,
                    http_session: '0123456789abcdef-1',
                }),
            );
        else {
            let text = '';
            req.on('data', (chunk) => (text += chunk));
            req.on('end', () => {
                const patch = JSON.parse(text);
                if (
                    patch.baud !== 2000000 ||
                    patch.revision !== 5 ||
                    req.headers['x-c5-session'] !== '0123456789abcdef-1'
                ) {
                    res.writeHead(400);
                    res.end('{}');
                    return;
                }
                configPosts++;
                res.end('{"saved":true,"restart":true}');
            });
        }
    });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const configURL = `http://127.0.0.1:${fixture.address().port}/`;
    let browser;
    let interacting = false;
    try {
        for (let i = 0; i < 60 && !finished; i++) {
            try {
                browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
                const pages = browser.contexts().flatMap((c) => c.pages());
                if (!homepage) {
                    const { expect } = require('@playwright/test');
                    let home, homePage;
                    for (const p of pages)
                        for (const f of p.frames())
                            if (await f.locator('.home-shell').count()) {
                                home = f;
                                homePage = p;
                            }
                    if (home) {
                        interacting = true;
                        await expect(home.locator('[data-panel-toggle]')).toHaveCount(6);
                        for (const toggle of await home.locator('[data-panel-toggle]').all())
                            if ((await toggle.getAttribute('aria-expanded')) === 'false')
                                await toggle.click();
                        await expect(home.getByRole('status', { name: '后端状态', exact: true })).toHaveText(
                            '已停止',
                        );
                        await home.getByRole('button', { name: '开启后端', exact: true }).click();
                        await expect(home.getByRole('status', { name: '后端状态', exact: true })).toHaveText(
                            '运行中',
                        );
                        await expect(
                            home.getByRole('button', { name: '开启后端', exact: true }),
                        ).toBeDisabled();
                        const backendPanel = home.getByRole('button', { name: '后端服务', exact: true });
                        await backendPanel.click();
                        await expect(home.locator('#backend-start')).toBeHidden();
                        await expect(home.locator('#backend-state')).toHaveText('运行中');
                        await backendPanel.press('Enter');
                        await expect(home.locator('#backend-start')).toBeVisible();
                        await home.getByLabel('业务 COM', { exact: true }).fill('');
                        await home.getByRole('button', { name: '开启桥接', exact: true }).click();
                        await expect(home.locator('#notice')).toContainText('请选择业务 COM');
                        await expect(home.getByRole('status', { name: '桥接状态', exact: true })).toHaveText(
                            '已停止',
                        );
                        await home.getByRole('button', { name: '放弃编辑并同步', exact: true }).click();
                        await home.getByRole('button', { name: '刷新网卡', exact: true }).click();
                        await expect(home.locator('#notice')).toHaveText('操作已完成');
                        await expect(home.locator('#adapter-count')).toContainText('条');
                        await expect(home.locator('#adapter-list li')).not.toHaveCount(0);
                        await expect(home.locator('header,h1,.eyebrow')).toHaveCount(0);
                        const options = await home
                            .locator('#adapter-select')
                            .evaluate((e) =>
                                [...e.options]
                                    .filter((o) => !o.disabled)
                                    .map((o) => ({ value: o.value, ip: o.dataset.ip })),
                            );
                        const picker = home.getByRole('combobox', { name: '分享网卡', exact: true });
                        await picker.click();
                        await expect(home.getByRole('option')).toHaveCount(options.length);
                        await picker.press('Escape');
                        const external = options.find((o) => o.ip && !o.ip.startsWith('127.'));
                        if (external) {
                            await picker.click();
                            await home
                                .locator(`.picker-popup:not([hidden]) [data-value="${external.value}"]`)
                                .click();
                            await expect(home.locator('#share-qrcode')).toBeVisible();
                            await expect(home.locator('#share-qrcode')).toHaveJSProperty('naturalWidth', 208);
                            inlineQR = true;
                            await homePage.screenshot({
                                path: path.join(root, 'artifacts', 'vscode-home-share.png'),
                            });
                        }
                        const local = options.find((o) => o.ip === '127.0.0.1');
                        if (local) {
                            await picker.click();
                            await home
                                .locator(`.picker-popup:not([hidden]) [data-value="${local.value}"]`)
                                .click();
                            await expect(home.locator('#share-qrcode')).toBeHidden();
                            await expect(home.locator('#qr-message')).toContainText('本机');
                        }
                        const transport = home.getByRole('combobox', { name: '配置连接', exact: true });
                        await transport.click();
                        await home.locator('.picker-popup:not([hidden]) [data-value="http"]').click();
                        await home.getByLabel('设备配置地址', { exact: true }).fill(configURL);
                        await home.locator('#config-read').click();
                        await expect(home.locator('#config-status')).toContainText('已在本页读取');
                        await home.locator('#cfg-baud').fill('2000000');
                        await home.locator('#config-preview').click();
                        await expect(home.locator('#config-changes')).toContainText('2000000');
                        await home.locator('#config-confirm').click();
                        await expect(home.locator('#notice')).toContainText('设备已确认保存');
                        await expect(home.locator('#config-preview')).toBeDisabled();
                        if (configPosts !== 1)
                            throw Error('Sidebar save did not reach mock firmware exactly once');
                        configVerified = true;
                        await home.getByRole('tab', { name: 'AP 热点', exact: true }).click();
                        await home.locator('#device-config').scrollIntoViewIfNeeded();
                        await homePage.screenshot({
                            path: path.join(root, 'artifacts', 'vscode-home-config.png'),
                        });
                        await home.getByRole('button', { name: '停止后端', exact: true }).click();
                        await expect(home.getByRole('status', { name: '后端状态', exact: true })).toHaveText(
                            '已停止',
                        );
                        await expect(home.locator('#share-qrcode')).toBeHidden();
                        await home
                            .getByRole('button', { name: '开启后端', exact: true })
                            .scrollIntoViewIfNeeded();
                        await homePage.screenshot({ path: path.join(root, 'artifacts', 'vscode-home.png') });
                        for (const toggle of await home.locator('[data-panel-toggle]').all())
                            await toggle.click();
                        await expect(home.locator('.panel-body:not([hidden])')).toHaveCount(0);
                        await expect(home.locator('#save-settings')).toBeVisible();
                        await homePage.screenshot({
                            path: path.join(root, 'artifacts', 'vscode-home-panels.png'),
                        });
                        for (const toggle of await home.locator('[data-panel-toggle]').all())
                            await toggle.click();
                        panelsVerified = true;
                        homepage = true;
                        fs.writeFileSync(
                            visual,
                            JSON.stringify({ homepage: true, configVerified, panelsVerified }, null, 2),
                        );
                    }
                }
                let frame, page;
                for (const p of pages) {
                    for (const f of p.frames()) {
                        if (await f.locator('.app-shell').count()) {
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
                const res = await fetch(serviceURL + '/');
                const html = await res.text();
                const invite = JSON.parse(html.match(/window\.__WIFI_BRIDGE__=(\{[^<]+\});/)[1]).invite;
                const post = async (p, body, token) =>
                    await (
                        await fetch(serviceURL + p, {
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
                fs.writeFileSync(
                    visual,
                    JSON.stringify(
                        {
                            homepage,
                            inlineQR,
                            configVerified,
                            panelsVerified,
                            connected: true,
                            synchronized: true,
                        },
                        null,
                        2,
                    ),
                );
                await browser.close();
                return;
            } catch (e) {
                if (browser) {
                    await browser.close().catch(() => {});
                    browser = undefined;
                }
                if (interacting || i === 59) throw e;
                await new Promise((r) => setTimeout(r, 800));
            }
        }
    } catch (e) {
        console.error('Webview verification:', e.message);
    } finally {
        await new Promise((resolve) => fixture.close(resolve));
    }
})();
runTests({
    vscodeExecutablePath:
        process.env.TCP2COM_VSCODE_EXECUTABLE ||
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
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
        TCP2COM_TEST_PORT: String(backendPort),
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
