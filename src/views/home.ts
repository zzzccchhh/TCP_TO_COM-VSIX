import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Broker } from '../host/broker';
import { Data, assert, object } from '../shared/model';
import { ShareQR } from './share-qr';

export class HomeView implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView;
    private timer?: NodeJS.Timeout;
    private refreshing = false;
    private changing = false;
    private disposed = false;
    private qr = new ShareQR();
    private networkGeneration = 0;
    private configScope = `home-${randomBytes(12).toString('hex')}`;
    constructor(
        private context: vscode.ExtensionContext,
        private broker: Broker,
        private onState: (state: Data) => void,
    ) {}
    async resolveWebviewView(view: vscode.WebviewView) {
        this.view = view;
        const webview = view.webview;
        const root = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        webview.options = { enableScripts: true, localResourceRoots: [root] };
        const nonce = randomBytes(18).toString('base64');
        const html = await readFile(join(this.context.extensionPath, 'media/home.html'), 'utf8');
        webview.html = html
            .replaceAll('{{CSP}}', webview.cspSource)
            .replaceAll('{{NONCE}}', nonce)
            .replaceAll('{{CSS}}', webview.asWebviewUri(vscode.Uri.joinPath(root, 'home.css')).toString())
            .replaceAll(
                '{{PICKER}}',
                webview.asWebviewUri(vscode.Uri.joinPath(root, 'home-picker.js')).toString(),
            )
            .replaceAll(
                '{{CONFIG}}',
                webview.asWebviewUri(vscode.Uri.joinPath(root, 'home-config.js')).toString(),
            )
            .replaceAll('{{JS}}', webview.asWebviewUri(vscode.Uri.joinPath(root, 'home.js')).toString());
        this.context.subscriptions.push(
            webview.onDidReceiveMessage(async (message) => {
                if (!object(message) || typeof message.id !== 'string' || typeof message.action !== 'string')
                    return;
                const readonly = ['ready', 'refresh', 'network', 'ports'].includes(message.action);
                if (this.changing && !readonly) {
                    await webview.postMessage({
                        kind: 'result',
                        id: message.id,
                        error: '操作正在进行，请稍后再试',
                    });
                    return;
                }
                if (!readonly) this.changing = true;
                try {
                    let data: any;
                    switch (message.action) {
                        case 'config': {
                            const operation = message.operation;
                            let args = message.args;
                            if (operation === 'import_config') {
                                const files = await vscode.window.showOpenDialog({
                                    canSelectMany: false,
                                    filters: { 设备配置备份: ['json'] },
                                });
                                if (!files?.length) break;
                                const stat = await vscode.workspace.fs.stat(files[0]);
                                assert(stat.size <= 131072, '备份文件过大');
                                args = [
                                    Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString(
                                        'utf8',
                                    ),
                                ];
                            }
                            const reply = await this.broker.call(
                                'home-config',
                                this.configScope,
                                operation,
                                args,
                                message.revision,
                                message.patch,
                            );
                            assert(reply.ok, reply.error);
                            data = reply;
                            if (operation === 'backup_config') {
                                const target = await vscode.window.showSaveDialog({
                                    defaultUri: vscode.Uri.file(join(homedir(), 'esp-device-config.json')),
                                    filters: { 设备配置备份: ['json'] },
                                });
                                if (target)
                                    await vscode.workspace.fs.writeFile(
                                        target,
                                        Buffer.from(JSON.stringify(reply.data, null, 2) + '\n'),
                                    );
                            }
                            break;
                        }
                        case 'ready':
                        case 'refresh':
                            await this.refresh();
                            break;
                        case 'network': {
                            const generation = ++this.networkGeneration;
                            const state = await this.broker.call('status', message.force === true);
                            const qr = await this.qr
                                .image(state)
                                .catch(() => ({ image: '', message: '二维码生成失败，请刷新网卡重试' }));
                            if (generation === this.networkGeneration)
                                await webview.postMessage({
                                    kind: 'network',
                                    data: { ...state, qr },
                                });
                            break;
                        }
                        case 'ports': {
                            const { token } = await this.broker.call('register');
                            const reply = await this.broker.call('call', token, 'ports', [], undefined);
                            assert(reply.ok, reply.error);
                            await webview.postMessage({ kind: 'ports', data: reply.data });
                            break;
                        }
                        case 'control':
                            await this.broker.call(
                                'home-control',
                                message.operation,
                                message.patch,
                                message.revision,
                            );
                            break;
                        default: {
                            const commands: Data = {
                                'backend-start': 'tcp2com.start',
                                'backend-stop': 'tcp2com.stop',
                                workspace: 'tcp2com.open',
                                share: 'tcp2com.share',
                                qr: 'tcp2com.qr',
                                logs: 'tcp2com.logs',
                                manage: 'tcp2com.manage',
                                listener: 'tcp2com.listener',
                            };
                            if (message.action === 'choose')
                                await this.broker.call('choose', message.adapter, message.ip);
                            else {
                                assert(Object.hasOwn(commands, message.action), '未知首页操作');
                                await vscode.commands.executeCommand(commands[message.action]);
                            }
                        }
                    }
                    await this.refresh();
                    await webview.postMessage({ kind: 'result', id: message.id, ok: true, data });
                } catch (error: any) {
                    await this.refresh();
                    await webview.postMessage({
                        kind: 'result',
                        id: message.id,
                        error: error.message || '操作失败',
                    });
                } finally {
                    if (!readonly) this.changing = false;
                }
            }),
            view.onDidChangeVisibility(() => {
                if (view.visible) void this.refresh();
            }),
            view.onDidDispose(() => {
                this.view = undefined;
                clearInterval(this.timer);
                void this.broker.call('unregister', this.configScope).catch(() => {});
            }),
        );
        clearInterval(this.timer);
        this.timer = setInterval(() => {
            if (view.visible) void this.refresh();
        }, 1000);
    }
    async refresh() {
        if (!this.view || this.disposed || this.refreshing) return;
        this.refreshing = true;
        try {
            const state = await this.broker.call('home-state');
            this.onState(state);
            await this.view.webview.postMessage({ kind: 'state', data: state });
        } catch (error: any) {
            await this.view.webview.postMessage({
                kind: 'error',
                error: error.message || '无法读取后端状态',
            });
        } finally {
            this.refreshing = false;
        }
    }
    dispose() {
        this.disposed = true;
        clearInterval(this.timer);
    }
}
