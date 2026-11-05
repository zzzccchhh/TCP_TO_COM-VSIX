const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const QRCode = require('qrcode');
const root = path.join(__dirname, '..');
const rows = [
    { id: 'wifi', name: 'WLAN', ip: '192.168.1.2', shareable: true },
    { id: 'off', name: 'Disconnected Ethernet', ip: '', shareable: false, reason: '网卡未连接' },
    { id: 'six', name: 'IPv6 only', ip: 'fe80::1', shareable: false, reason: '当前服务仅支持 IPv4' },
    { id: 'loopback', name: '本机专用', ip: '127.0.0.1', shareable: true },
    { id: 'wifi', name: 'WLAN', ip: '192.168.1.9', shareable: true },
];
async function setup(page, theme = 'dark', networkLogs = false) {
    const { defaults, defaultConfig } = require('../dist/src/shared/model');
    const images = {};
    for (const id of ['first', 'second'])
        for (const ip of ['192.168.1.2', '192.168.1.9'])
            images[id + ip] = await QRCode.toDataURL(`http://${ip}:8765/#invite=${id}`, {
                width: 208,
                margin: 3,
            });
    await page.addInitScript(
        ({ defaults, configDefaults, rows, images }) => {
            const state = {
                backend: false,
                share_id: 'first',
                listen: '0.0.0.0',
                port: 8765,
                revision: 0,
                settings: { ...defaults, com: 'COM42' },
                device_config_defaults: configDefaults,
                snapshot: {
                    running: false,
                    connected: false,
                    usb: null,
                    busy: false,
                    config_busy: false,
                    epoch: 0,
                    address: '业务桥接已停止',
                },
            };
            let selected = rows[0];
            let readEpoch = null;
            const savedCalls = [];
            const controlCalls = [];
            let all = rows;
            const emit = (m) => window.postMessage(m, '*');
            const network = () => ({
                running: state.backend,
                share_id: state.share_id,
                addresses: all,
                selected,
                address: selected ? `http://${selected.ip}:8765/` : '',
                warning: '',
                qr:
                    state.backend && selected?.id !== 'loopback' && selected?.shareable
                        ? { image: images[state.share_id + selected.ip], message: '手机扫码连接工作台' }
                        : {
                              image: '',
                              message:
                                  selected?.id === 'loopback'
                                      ? '本机地址仅限本机访问'
                                      : '请选择可用的局域网网卡',
                          },
            });
            window.acquireVsCodeApi = () => ({
                getState: () => JSON.parse(sessionStorage.getItem('home-view-state') || 'null'),
                setState: (value) => sessionStorage.setItem('home-view-state', JSON.stringify(value)),
                postMessage: (m) =>
                    setTimeout(() => {
                        let error = '';
                        let data;
                        if (m.action === 'backend-start') state.backend = true;
                        else if (m.action === 'backend-stop') state.backend = false;
                        else if (m.action === 'choose')
                            selected = all.find((r) => r.id === m.adapter && r.ip === m.ip && r.shareable);
                        else if (m.action === 'control') {
                            controlCalls.push(m);
                            if (m.operation === 'net-connect') { state.backend = true; state.snapshot.net_log = { connected: true, host: m.patch.net_log_host || state.settings.net_log_host, port: Number(m.patch.net_log_port || state.settings.net_log_port), message: '已连接', dropped: 0 }; }
                            if (m.operation === 'net-disconnect') state.snapshot.net_log = null;
                            if (m.revision !== state.revision) error = '其他终端已更新设置';
                            else {
                                Object.assign(state.settings, m.patch);
                                state.revision++;
                            }
                        } else if (m.action === 'config') {
                            if (m.revision !== state.revision) error = '其他终端已更新设置';
                            else {
                                Object.assign(state.settings, m.patch || {});
                                if (m.operation === 'read_device') {
                                    state.snapshot.epoch++;
                                    readEpoch = state.snapshot.epoch;
                                    state.snapshot.baseline = structuredClone(configDefaults);
                                    data = structuredClone(configDefaults);
                                } else if (
                                    ['preview_save', 'save_device'].includes(m.operation) &&
                                    readEpoch !== state.snapshot.epoch
                                )
                                    error = '请在本终端重新读取设备';
                                else if (m.operation === 'preview_save')
                                    data = {
                                        needed: true,
                                        epoch: readEpoch,
                                        changes: [
                                            { field: 'baud', value: String(m.args[0].baud) },
                                            ...(m.args[1].ap
                                                ? [{ field: 'ap_password', value: '（更新密码）' }]
                                                : []),
                                        ],
                                    };
                                else if (m.operation === 'save_device') {
                                    savedCalls.push(m.args);
                                    state.snapshot.epoch++;
                                    data = { saved: true };
                                } else if (m.operation === 'import_config')
                                    data = { ...configDefaults, ap_ssid: 'Imported AP' };
                                state.revision++;
                                data = { data, epoch: state.snapshot.epoch, revision: state.revision };
                            }
                        }
                        if (m.action === 'network') emit({ kind: 'network', data: network() });
                        else if (m.action === 'ports')
                            emit({
                                kind: 'ports',
                                data: [
                                    { device: 'COM42', description: '测试串口' },
                                    { device: 'COM7', description: 'USB Serial' },
                                ],
                            });
                        else emit({ kind: 'state', data: structuredClone(state) });
                        emit({ kind: 'result', id: m.id, ok: !error, error, data });
                    }, 0),
            });
            window.__homeTest = {
                state,
                savedCalls,
                controlCalls,
                refresh() {
                    emit({ kind: 'state', data: structuredClone(state) });
                },
                remoteRead() {
                    state.snapshot.epoch++;
                    state.revision++;
                    emit({ kind: 'state', data: structuredClone(state) });
                },
                rotate() {
                    state.share_id = 'second';
                    emit({ kind: 'state', data: structuredClone(state) });
                },
                empty() {
                    all = rows.filter((r) => !r.shareable);
                    selected = undefined;
                    emit({ kind: 'network', data: network() });
                },
                busy() {
                    state.snapshot.config_busy = true;
                    emit({ kind: 'state', data: structuredClone(state) });
                },
            };
        },
        { defaults, configDefaults: { ...defaultConfig('c5'), ...(networkLogs ? { log_enabled: true, log_port: 19082 } : {}) }, rows, images },
    );
    await page.route('http://home.test/**', async (route) => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (!name) {
            let html = await fs.readFile(path.join(root, 'media/home.html'), 'utf8');
            html = html
                .replaceAll('{{CSP}}', "'self'")
                .replaceAll('{{NONCE}}', 'testnonce')
                .replaceAll('{{CSS}}', '/home.css')
                .replaceAll('{{JS}}', '/home.js')
                .replaceAll('{{PICKER}}', '/home-picker.js')
                .replaceAll('{{CONFIG}}', '/home-config.js')
                .replace('</head>', '<link rel="stylesheet" href="/theme.css"></head>');
            await route.fulfill({ contentType: 'text/html', body: html });
        } else if (name === 'theme.css') {
            const light = theme === 'light';
            await route.fulfill({
                contentType: 'text/css',
                body: `:root{--vscode-font-size:13px;--vscode-font-family:system-ui;--vscode-foreground:${light ? '#202020' : '#ddd'};--vscode-sideBar-background:${light ? '#f3f3f3' : '#181818'};--vscode-input-background:${light ? '#fff' : '#252526'};--vscode-input-foreground:${light ? '#222' : '#ddd'};--vscode-dropdown-background:${light ? '#fff' : '#252526'};--vscode-dropdown-foreground:${light ? '#222' : '#ddd'};--vscode-dropdown-border:${theme === 'contrast' ? '#f38518' : '#666'};--vscode-contrastBorder:#f38518;--vscode-focusBorder:#007acc;--vscode-list-focusBackground:#04395e;--vscode-list-focusForeground:#fff;--vscode-list-hoverBackground:${light ? '#e5e5e5' : '#333'};--vscode-toolbar-hoverBackground:${light ? '#e5e5e5' : '#333'};--vscode-button-background:#007acc;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#444;--vscode-button-secondaryForeground:#fff;--vscode-descriptionForeground:#999;--vscode-panel-border:#555;--vscode-errorForeground:#f66}`,
            });
        } else if (['home.js', 'home-picker.js', 'home-config.js', 'home.css'].includes(name))
            await route.fulfill({
                contentType: name.endsWith('css') ? 'text/css' : 'text/javascript',
                body: await fs.readFile(path.join(root, 'media', name), 'utf8'),
            });
        else await route.abort();
    });
    await page.goto('http://home.test/');
    if (theme === 'contrast') await page.evaluate(() => document.body.classList.add('vscode-high-contrast'));
    await expect(page.getByRole('status', { name: '后端状态', exact: true })).toHaveText('已停止');
    await expect(page.locator('#adapter-select option')).toHaveCount(3);
}
test('header removed and themed device picker supports Escape and keyboard commit', async ({ page }) => {
    await setup(page);
    await expect(page.locator('header,h1,.eyebrow')).toHaveCount(0);
    const picker = page.getByRole('combobox', { name: '设备', exact: true });
    await picker.click();
    await expect(page.getByRole('option', { name: 'ESP32-S3', exact: true })).toBeVisible();
    await picker.press('Escape');
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('select[data-setting=device]')).toHaveValue('c5');
    await picker.press('ArrowDown');
    await picker.press('End');
    await picker.press('Enter');
    await expect(page.locator('select[data-setting=device]')).toHaveValue('esp01s');
});
test('panels fold independently with keyboard, retain live status and stay usable while busy', async ({
    page,
}) => {
    await setup(page);
    await expect(page.locator('[data-panel-toggle]')).toHaveCount(7);
    await expect(page.locator('.panel-body:not([hidden])')).toHaveCount(7);
    const backend = page.getByRole('button', { name: '后端服务', exact: true });
    await backend.focus();
    await backend.press('Enter');
    await expect(backend).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#backend-start')).toBeHidden();
    await expect(page.locator('#backend-state')).toBeVisible();
    await expect(page.locator('#panel-body-bridge')).toBeVisible();
    await backend.press('Space');
    await page.locator('#backend-start').click();
    await backend.click();
    await expect(page.locator('#backend-state')).toHaveText('运行中');
    await page.evaluate(() => {
        window.__homeTest.state.backend = false;
        window.__homeTest.refresh();
    });
    await expect(page.locator('#backend-state')).toHaveText('已停止');
    await expect(backend).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => window.__homeTest.busy());
    await expect(backend).toBeEnabled();
    await backend.click();
    await expect(page.locator('#backend-start')).toBeVisible();
    await expect(page.locator('#backend-start')).toBeDisabled();
});
test('folding preserves live drafts and read receipt; persisted drafts and panel state survive reload without passwords', async ({
    page,
}) => {
    await setup(page);
    await page.locator('#config-read').click();
    await page.getByRole('tab', { name: 'AP 热点', exact: true }).click();
    await page.locator('#cfg-ap_ssid').fill('Folded AP');
    await page.locator('#cfg-password-ap').fill('temporary-fold-password');
    await page.getByRole('combobox', { name: '业务 COM', exact: true }).fill('COM-DRAFT');
    await page.getByRole('button', { name: '业务桥接', exact: true }).click();
    const config = page.getByRole('button', { name: '设备配置', exact: true });
    await config.click();
    await expect(page.locator('#config-editor')).toBeHidden();
    await expect(page.locator('#save-settings')).toBeVisible();
    await expect(page.locator('#notice')).toBeVisible();
    await config.click();
    await expect(page.getByRole('tab', { name: 'AP 热点', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.locator('#cfg-password-ap')).toHaveValue('temporary-fold-password');
    await expect(page.locator('#config-preview')).toBeEnabled();
    await expect(page.locator('[data-setting=com]')).toHaveValue('COM-DRAFT');
    await page.locator('#cfg-ap_ssid').fill('Draft after folding');
    await config.click();
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('home-view-state')));
    expect(stored.collapsedPanels.bridge).toBe(true);
    expect(stored.collapsedPanels.config).toBe(true);
    expect(stored.deviceDrafts.c5.ap_ssid).toBe('Draft after folding');
    expect(JSON.stringify(stored)).not.toContain('temporary-fold-password');
    await page.reload();
    await expect(page.locator('#panel-body-bridge')).toBeHidden();
    await expect(page.locator('#panel-body-config')).toBeHidden();
    await config.click();
    await page.getByRole('tab', { name: 'AP 热点', exact: true }).click();
    await expect(page.locator('#cfg-ap_ssid')).toHaveValue('Draft after folding');
    await expect(page.locator('#cfg-password-ap')).toHaveValue('');
    await expect(page.locator('#config-preview')).toBeDisabled();
});
test('USB shortcut expands its panel, and folding closes an open picker', async ({ page }) => {
    await setup(page);
    const usb = page.getByRole('button', { name: 'USB 日志与配置', exact: true });
    await usb.click();
    await expect(page.locator('#panel-body-usb')).toBeHidden();
    await page.locator('#config-usb-settings').click();
    await expect(usb).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-setting=usb_port]')).toBeFocused();
    await page.getByRole('combobox', { name: '配置连接', exact: true }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.getByRole('button', { name: '设备配置', exact: true }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.locator('#panel-body-config')).toBeHidden();
});
test('inline config preserves groups, masks passwords and requires explicit save confirmation', async ({
    page,
}) => {
    await setup(page);
    const config = page.getByRole('region', { name: '设备配置' });
    await expect(page.locator('#device-config')).toBeVisible();
    const order = await page
        .locator('main > section')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
    expect(order.slice(0, 5)).toEqual(['后端服务', '业务桥接', 'USB 日志与配置', '网络日志', '设备配置']);
    await expect(page.locator('#config-preview')).toBeDisabled();
    await page.locator('#config-read').click();
    await expect(page.locator('#config-status')).toContainText('已在本页读取');
    await page.locator('#cfg-baud').fill('2000000');
    await page.getByRole('tab', { name: 'AP 热点', exact: true }).click();
    await page.locator('#cfg-ap_ssid').fill('My AP');
    await page.locator('#cfg-password-ap').fill('private-test-password');
    await page.getByRole('tab', { name: '电脑 STA', exact: true }).click();
    await expect(page.locator('#cfg-pc-ip')).toBeHidden();
    await page.locator('#cfg-pc-static_ip').check();
    await expect(page.locator('#cfg-pc-ip')).toBeVisible();
    await page.getByRole('tab', { name: '接口与网络', exact: true }).click();
    await expect(page.locator('#cfg-baud')).toHaveValue('2000000');
    await page.locator('#config-preview').click();
    await expect(page.locator('#config-confirmation')).toBeVisible();
    await expect(page.locator('#config-changes')).toContainText('更新密码');
    await expect(page.locator('#config-changes')).not.toContainText('private-test-password');
    expect(await page.evaluate(() => window.__homeTest.savedCalls.length)).toBe(0);
    await page.locator('#config-confirm').click();
    await expect(page.locator('#notice')).toContainText('设备已确认保存');
    expect(await page.evaluate(() => window.__homeTest.savedCalls.length)).toBe(1);
    await expect(page.locator('#config-preview')).toBeDisabled();
    await expect(page.locator('#cfg-password-ap')).toHaveValue('');
});
test('remote reads invalidate local receipt and confirmation while retaining the local draft', async ({
    page,
}) => {
    await setup(page);
    await page.locator('#config-read').click();
    await page.locator('#cfg-baud').fill('2000000');
    await page.locator('#config-preview').click();
    await expect(page.locator('#config-confirmation')).toBeVisible();
    await page.evaluate(() => window.__homeTest.remoteRead());
    await expect(page.locator('#config-confirmation')).toBeHidden();
    await expect(page.locator('#config-preview')).toBeDisabled();
    await expect(page.locator('#cfg-baud')).toHaveValue('2000000');
    await page.locator('#config-read').click();
    await expect(page.locator('#cfg-baud')).toHaveValue('1152000');
    await page.locator('#config-restore').click();
    await expect(page.locator('#cfg-baud')).toHaveValue('2000000');
    const transport = page.getByRole('combobox', { name: '配置连接', exact: true });
    await transport.click();
    await page.getByRole('option', { name: 'HTTP 配网', exact: true }).click();
    await expect(page.locator('#config-preview')).toBeDisabled();
    await expect(page.locator('#config-http')).toBeVisible();
});
test('editable COM and baud retain custom input and themed suggestions', async ({ page }) => {
    await setup(page);
    const com = page.getByRole('combobox', { name: '业务 COM', exact: true });
    await com.fill('COM-CUSTOM9');
    await com.press('Escape');
    await expect(com).toHaveValue('COM-CUSTOM9');
    await expect(com).not.toHaveAttribute('list');
    await page.getByRole('button', { name: '保存本机参数', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__homeTest.state.settings.com)).toBe('COM-CUSTOM9');
    await com.press('ArrowDown');
    await com.press('Enter');
    await expect(com).toHaveValue('COM42');
    await page.getByRole('button', { name: '选择波特率', exact: true }).click();
    await page.getByRole('option', { name: '2000000', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '波特率', exact: true })).toHaveValue('2000000');
});
test('adapter popup contains only eligible rows and preserves original row indices', async ({ page }) => {
    await setup(page);
    const picker = page.getByRole('combobox', { name: '分享网卡', exact: true });
    await picker.click();
    await expect(page.getByRole('option')).toHaveCount(3);
    await expect(page.getByRole('option', { name: /Disconnected|IPv6/ })).toHaveCount(0);
    await page.getByRole('option').filter({ hasText: '192.168.1.9' }).click();
    await expect(picker).toContainText('192.168.1.9');
    await page.locator('#adapter-count').click();
    await expect(page.locator('#adapter-list')).toContainText('Disconnected Ethernet');
});
test('inline QR appears automatically, rotates, hides for loopback and stops', async ({ page }) => {
    await setup(page);
    const image = page.locator('#share-qrcode');
    await expect(image).toBeHidden();
    await page.getByRole('button', { name: '开启后端', exact: true }).click();
    await expect(image).toBeVisible();
    const first = await image.getAttribute('src');
    await page.evaluate(() => window.__homeTest.rotate());
    await expect(image).not.toHaveAttribute('src', first);
    await expect(image).toBeVisible();
    const picker = page.getByRole('combobox', { name: '分享网卡', exact: true });
    await picker.click();
    await page.getByRole('option').filter({ hasText: '127.0.0.1' }).click();
    await expect(image).toBeHidden();
    await expect(page.locator('#qr-message')).toContainText('本机');
    await page.getByRole('button', { name: '停止后端', exact: true }).click();
    await expect(image).not.toHaveAttribute('src');
    await expect(page.locator('#qr-message')).toContainText('开启后端');
});
test('empty adapter selection is disabled and busy state closes an open picker', async ({ page }) => {
    await setup(page);
    const device = page.getByRole('combobox', { name: '设备', exact: true });
    await device.click();
    await page.evaluate(() => window.__homeTest.busy());
    await expect(device).toBeDisabled();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.evaluate(() => window.__homeTest.empty());
    await expect(page.getByRole('combobox', { name: '分享网卡', exact: true })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: '分享网卡', exact: true })).toContainText('暂无可用网卡');
});
for (const theme of ['dark', 'light', 'contrast'])
    test(`picker and QR fit narrow sidebar with ${theme} theme`, async ({ page }) => {
        await page.setViewportSize({ width: 260, height: 760 });
        await setup(page, theme);
        await page.getByRole('button', { name: '开启后端', exact: true }).click();
        await expect(page.locator('#share-qrcode')).toBeVisible();
        await page.getByRole('combobox', { name: '分享网卡', exact: true }).click();
        const bounds = await page.getByRole('listbox').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(260);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(760);
        await page.screenshot({ path: path.join(root, 'artifacts', `home-theme-${theme}.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.getByRole('combobox', { name: '分享网卡', exact: true }).press('Escape');
        for (const toggle of await page.locator('[data-panel-toggle]').all()) await toggle.click();
        await expect(page.locator('.panel-body:not([hidden])')).toHaveCount(0);
        await page.screenshot({ path: path.join(root, 'artifacts', `home-panels-${theme}.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });


test('network log sidebar connects without a COM bridge, disconnects and exposes NVS settings', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await setup(page, 'dark', true);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('[data-setting=net_log_host]').fill('192.168.4.1');
    await page.locator('[data-setting=net_log_port]').fill('19082');
    await page.locator('#net-connect').click();
    await expect(page.locator('#netlog-state')).toHaveText('已连接');
    await expect(page.locator('#bridge-state')).toHaveText('已停止');
    await page.locator('#net-disconnect').click();
    await expect(page.locator('#netlog-state')).toHaveText('未连接');
    expect(await page.evaluate(() => window.__homeTest.controlCalls.map((m) => m.operation))).toEqual(['net-connect', 'net-disconnect']);
    await page.locator('#config-read').click();
    await expect(page.getByLabel('设备 TCP 日志端口', { exact: true })).toHaveValue('19082');
    await expect(page.getByLabel('设备 TCP 日志端口', { exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'test-results/network-log-sidebar.png', fullPage: true });
});
