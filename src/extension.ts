import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import QRCode from 'qrcode';
import { Broker } from './host/broker';
import { Data, object, assert } from './shared/model';
import { methods } from './backend/lan/adapter';
let broker: Broker | undefined;
let panel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel;
let nativeRevision: number | undefined;
let instance = '';
export async function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('TCP2COM');
    context.subscriptions.push(output);
    const config = vscode.workspace.getConfiguration('tcp2com');
    broker = new Broker(context.globalStorageUri.fsPath, join(context.extensionPath, 'frontend', 'dist'), {
        listen: config.get('listen', '0.0.0.0'),
        port: config.get('port', 8765),
        origins: config.get('origins', ['https://zzzccchhh.github.io']),
    });
    const run = (action: () => Promise<unknown>) => async () => {
        try {
            return await action();
        } catch (e: any) {
            output.appendLine(e.message);
            void vscode.window.showErrorMessage('TCP2COM：' + e.message);
        }
    };
    const command = (name: string, action: () => Promise<unknown>) =>
        context.subscriptions.push(vscode.commands.registerCommand('tcp2com.' + name, run(action)));
    command('start', async () => {
        await broker!.call('start');
        status.text = '$(radio-tower) TCP2COM';
        void vscode.window.showInformationMessage('TCP2COM 后端服务已启动；桥接与 USB 需手动连接');
    });
    command('stop', async () => {
        await broker!.call('stop');
        nativeRevision = undefined;
        status.text = '$(plug) TCP2COM';
        panel?.webview.postMessage({ kind: 'reconnect' });
    });
    command('open', async () => {
        await broker!.call('start');
        if (panel) {
            panel.reveal();
            return;
        }
        panel = vscode.window.createWebviewPanel('tcp2com', 'TCP2COM 工作台', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(join(context.extensionPath, 'frontend', 'dist'))],
        });
        const current = panel;
        current.onDidDispose(() => (panel = undefined), undefined, context.subscriptions);
        current.webview.onDidReceiveMessage(
            async (message) => {
                if (!object(message)) return;
                if (message.kind === 'download') {
                    try {
                        assert(
                            typeof message.name === 'string' &&
                                typeof message.text === 'string' &&
                                Buffer.byteLength(message.text) < 4 * 1024 * 1024,
                            '导出内容过大',
                        );
                        const destination = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(
                                join(context.globalStorageUri.fsPath, basename(message.name)),
                            ),
                        });
                        if (destination)
                            await vscode.workspace.fs.writeFile(destination, Buffer.from(message.text));
                    } catch {
                        void vscode.window.showErrorMessage('无法导出文件');
                    }
                    return;
                }
                if (
                    message.kind !== 'call' ||
                    typeof message.id !== 'string' ||
                    !methods.has(message.method) ||
                    !Array.isArray(message.args)
                )
                    return;
                let reply: Data;
                try {
                    const registered = await broker!.call('register');
                    if (instance && instance !== registered.instance) {
                        instance = registered.instance;
                        nativeRevision = undefined;
                        await current.webview.postMessage({ kind: 'reconnect' });
                        throw new Error('后端已重新启动，正在重新同步；设备需手动连接');
                    }
                    instance = registered.instance;
                    reply = await broker!.call(
                        'call',
                        registered.token,
                        message.method,
                        message.args,
                        nativeRevision,
                    );
                    if (typeof reply.revision === 'number')
                        nativeRevision =
                            message.method === 'initial'
                                ? reply.revision
                                : Math.max(nativeRevision ?? 0, reply.revision);
                } catch (e: any) {
                    reply = { ok: false, error: e.message };
                }
                if (panel === current)
                    await current.webview.postMessage({ kind: 'reply', id: message.id, reply });
            },
            undefined,
            context.subscriptions,
        );
        let html = await readFile(join(context.extensionPath, 'frontend', 'dist', 'index.html'), 'utf8');
        const webview = current.webview;
        html = html.replace(
            /(src|href)="(?:\.\/|\/)?([^":]+)"/g,
            (_all, attr, path) =>
                `${attr}="${webview.asWebviewUri(vscode.Uri.file(join(context.extensionPath, 'frontend', 'dist', path)))}"`,
        );
        const csp = `default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data:; connect-src ${webview.cspSource};`;
        current.webview.html = html.replace(
            '<head>',
            `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`,
        );
        status.text = '$(radio-tower) TCP2COM';
    });
    command('share', async () => {
        await broker!.call('start');
        const state = await broker!.call('status');
        await vscode.env.clipboard.writeText(state.link);
        void vscode.window.showInformationMessage('已复制完整连接链接；手机需与电脑处于可互通的局域网');
    });
    command('browser', async () => {
        await broker!.call('start');
        const state = await broker!.call('status');
        await vscode.env.openExternal(vscode.Uri.parse(state.localLink));
    });
    command('logs', async () => {
        output.clear();
        output.append(await broker!.call('logs'));
        output.show();
    });
    command('importState', async () => {
        const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 旧版状态文件: ['json'] },
            title: '选择 tcp2com_last_state.json',
        });
        if (!selected?.[0]) return;
        const data = await vscode.workspace.fs.readFile(selected[0]);
        assert(data.length <= 131072, '状态文件过大');
        await broker!.call('import', Buffer.from(data).toString('utf8'));
        nativeRevision = undefined;
        panel?.webview.postMessage({ kind: 'reconnect' });
        void vscode.window.showInformationMessage('已导入旧版设置；设备尚未连接');
    });
    command('manage', async () => {
        const state = await broker!.call('status');
        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: state.running ? '停止后端服务' : '启动后端服务',
                    id: state.running ? 'stop' : 'start',
                },
                { label: '选择分享网卡', id: 'adapter' },
                { label: '显示连接二维码', id: 'qr' },
                { label: '复制在线连接链接', id: 'share' },
                { label: '刷新邀请链接', id: 'rotate' },
                { label: '撤销已连接终端', id: 'revoke' },
                { label: '处理旧版配对申请', id: 'pair' },
            ],
            {
                title: `TCP2COM · ${state.running ? state.address : '服务未启动'}${state.warning ? ' · ' + state.warning : ''}`,
            },
        );
        if (!choice) return;
        if (['start', 'stop', 'share'].includes(choice.id)) {
            await vscode.commands.executeCommand('tcp2com.' + choice.id);
            return;
        }
        if (choice.id === 'adapter') {
            const selected = (await vscode.window.showQuickPick(
                state.addresses.map((a: Data) => ({ label: a.name, description: a.ip, address: a })),
            )) as any;
            if (selected) await broker!.call('choose', selected.address.id, selected.address.ip);
        } else if (choice.id === 'rotate') {
            await broker!.call('rotate');
            void vscode.window.showInformationMessage('邀请链接已刷新，已连接终端继续使用原连接');
        } else if (choice.id === 'revoke') {
            const selected = (await vscode.window.showQuickPick(
                state.clients.map((c: Data) => ({ label: c.name, description: c.address, id: c.id })),
            )) as any;
            if (selected) await broker!.call('revoke', selected.id);
        } else if (choice.id === 'pair') {
            const selected = (await vscode.window.showQuickPick(
                state.pending.map((c: Data) => ({
                    label: c.name,
                    description: c.id + ' · ' + c.address,
                    id: c.id,
                })),
            )) as any;
            if (selected) {
                const decision = await vscode.window.showQuickPick(['允许连接', '拒绝连接']);
                if (decision) await broker!.call('decide', selected.id, decision === '允许连接');
            }
        } else if (choice.id === 'qr') {
            await broker!.call('start');
            const latest = await broker!.call('status'),
                data = await QRCode.toDataURL(latest.localLink);
            const qr = vscode.window.createWebviewPanel(
                'tcp2com.share',
                'TCP2COM 手机连接',
                vscode.ViewColumn.Beside,
                {},
            );
            qr.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"></head><body style="text-align:center;padding:24px;font-family:system-ui"><h2>手机扫码连接工作台</h2><img width="300" height="300" src="${data}" alt="连接二维码"><p>${latest.address}</p><p>手机与电脑需处于可互通的局域网。关闭此页面不会停止服务。</p></body></html>`;
            let previousLink = latest.localLink;
            let scanning = false;
            let disposed = false;
            const refresh = setInterval(async () => {
                if (scanning || disposed) return;
                scanning = true;
                try {
                    const state = await broker!.call('status');
                    if (!disposed && state.running && state.localLink !== previousLink) {
                        const image = await QRCode.toDataURL(state.localLink);
                        if (!disposed) {
                            previousLink = state.localLink;
                            qr.webview.html = qr.webview.html
                                .replace(/src="data:[^"]+"/, `src="${image}"`)
                                .replace(/<p>http:[^<]+<\/p>/, `<p>${state.address}</p>`);
                        }
                    }
                } catch {
                } finally {
                    scanning = false;
                }
            }, 5000);
            qr.onDidDispose(
                () => {
                    disposed = true;
                    clearInterval(refresh);
                },
                undefined,
                context.subscriptions,
            );
        }
    });
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    status.text = '$(plug) TCP2COM';
    status.command = 'tcp2com.open';
    status.tooltip = '打开无线串口工作台';
    status.show();
    context.subscriptions.push(status);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('tcp2com.controls', {
            getChildren: () => [
                { label: '打开工作台', command: 'tcp2com.open' },
                { label: '服务、网卡与终端', command: 'tcp2com.manage' },
                { label: '复制连接链接', command: 'tcp2com.share' },
                { label: '查看日志', command: 'tcp2com.logs' },
            ],
            getTreeItem: (item: { label: string; command: string }) => {
                const tree = new vscode.TreeItem(item.label);
                tree.command = { command: item.command, title: item.label };
                return tree;
            },
        }),
    );
}
export async function deactivate() {
    await broker?.close();
    broker = undefined;
}
