import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
    Data,
    assert,
    object,
    parseJSON,
    runtimeSettings,
    settingsPatch,
    defaultConfig,
} from '../shared/model';
import { Store, atomicJSON } from '../backend/storage/state';
import { Service } from '../backend/service/service';
import { LANAdapter } from '../backend/lan/adapter';
import { LANServer } from '../backend/lan/server';
import { Address, addresses, annotate, choose, shareLink } from '../backend/lan/network';
type Options = { listen: string; port: number; origins: string[] };
export class BackendOwner {
    readonly instance = randomBytes(16).toString('hex');
    service: Service;
    adapter: LANAdapter;
    http?: LANServer;
    port = 0;
    preferred?: Address;
    private server?: net.Server;
    private sockets = new Set<net.Socket>();
    private management = Promise.resolve();
    private scan?: { items: Address[]; warning: string; at: number };
    private scanning?: Promise<void>;
    private pendingOptions?: Options;
    constructor(
        readonly directory: string,
        readonly frontend: string,
        readonly secret: string,
        readonly options: Options,
    ) {
        this.service = new Service(new Store(directory));
        this.adapter = new LANAdapter(this.service);
    }
    async initialize() {
        await this.service.init();
        try {
            const doc = JSON.parse(await readFile(join(this.directory, 'lan.json'), 'utf8'));
            if (object(doc.preferred_interface)) this.preferred = doc.preferred_interface as Address;
        } catch {}
    }
    private async start() {
        if (this.http) return true;
        if (this.pendingOptions) {
            Object.assign(this.options, this.pendingOptions);
            this.pendingOptions = undefined;
            this.scan = undefined;
        }
        assert(
            net.isIP(this.options.listen) === 4 &&
                Number.isInteger(this.options.port) &&
                this.options.port >= 1 &&
                this.options.port <= 65535,
            '服务监听地址或端口无效',
        );
        const server = new LANServer(this.adapter, this.frontend, this.options.origins);
        try {
            this.port = await server.listen(this.options.listen, this.options.port);
            this.http = server;
            return true;
        } catch (error: any) {
            throw new Error(
                error.code === 'EADDRINUSE'
                    ? '网页端口已被占用，请停止原服务或修改插件端口'
                    : '无法启动网页服务，请检查监听地址和端口',
            );
        }
    }
    private async status(force = false) {
        if (force || !this.scan || Date.now() - this.scan.at > 10000) {
            if (!this.scanning)
                this.scanning = addresses(this.options.listen)
                    .then((value) => {
                        this.scan = { ...value, at: Date.now() };
                    })
                    .finally(() => (this.scanning = undefined));
            await this.scanning;
        }
        // A scan started before a listener restart may finish after it. Re-evaluate
        // eligibility against the current listener instead of retaining old annotations.
        const scan = {
                items: this.scan!.items.map((row) => annotate(row, this.options.listen)),
                warning: this.scan!.warning,
            },
            selection = choose(scan.items, this.preferred);
        const selected = selection.selected;
        const address = selected ? `http://${selected.ip}:${this.port || this.options.port}/` : '';
        return {
            running: !!this.http,
            share_id: createHash('sha256').update(this.adapter.invite).digest('hex'),
            port: this.port || this.options.port,
            listen: this.options.listen,
            addresses: scan.items,
            selected,
            warning: scan.warning || selection.warning,
            address,
            link: address ? shareLink(address, this.adapter.invite) : '',
            localLink: address ? shareLink(address, this.adapter.invite, false) : '',
            ...this.adapter.snapshot(),
            bridge: this.service.engine.running,
            usb: !!this.service.usbMonitor,
        };
    }
    async call(method: string, args: any[], client: string) {
        if (method === 'home-state')
            return {
                backend: !!this.http,
                share_id: createHash('sha256').update(this.adapter.invite).digest('hex'),
                listen: this.options.listen,
                port: this.port || this.options.port,
                settings: { ...this.service.settings },
                device_config_defaults: defaultConfig(this.service.settings.device),
                revision: this.adapter.revision,
                snapshot: this.service.poll(this.service.cursor),
            };
        if (method === 'call') return this.adapter.dispatch(args[0], args[1], args[2], args[3]);
        if (method === 'register') {
            const scope = args[0] ?? '';
            assert(typeof scope === 'string' && /^(|home-[a-f0-9]{24})$/.test(scope), '本机页面标识无效');
            const identity = `native:${client}${scope ? ':' + scope : ''}`;
            for (const [token, c] of this.adapter.clients)
                if (c.join_id === identity) return { token, instance: this.instance };
            assert(this.adapter.clients.size < 32, '已连接终端达到上限');
            const token = randomBytes(32).toString('base64url');
            this.adapter.clients.set(token, {
                id: randomBytes(8).toString('hex'),
                name: scope ? 'VS Code 侧栏配置' : 'VS Code 工作台',
                address: '本机插件',
                read_epoch: null,
                join_id: identity,
            });
            return { token, instance: this.instance };
        }
        if (method === 'unregister') {
            for (const [token, c] of this.adapter.clients)
                if (
                    args[0]
                        ? c.join_id === `native:${client}:${args[0]}`
                        : c.join_id === `native:${client}` || c.join_id?.startsWith(`native:${client}:`)
                )
                    this.adapter.clients.delete(token);
            return true;
        }
        // Management and lifecycle writes serialize independently of browser reads.
        if (method === 'status') return this.status(args[0] === true);
        let release!: () => void;
        const previous = this.management;
        this.management = new Promise<void>((r) => (release = r));
        await previous;
        try {
            switch (method) {
                case 'configure': {
                    const value = args[0];
                    assert(
                        object(value) &&
                            net.isIP(value.listen) === 4 &&
                            Number.isInteger(value.port) &&
                            value.port >= 1 &&
                            value.port <= 65535 &&
                            Array.isArray(value.origins) &&
                            value.origins.every((o: any) => typeof o === 'string'),
                        '服务监听配置无效',
                    );
                    this.pendingOptions = {
                        listen: value.listen,
                        port: value.port,
                        origins: [...value.origins],
                    };
                    return true;
                }
                case 'start':
                    return this.start();
                case 'stop': {
                    const registered = await this.call('register', [], client);
                    for (const [method, args] of [
                        ['bridge', ['stop']],
                        ['usb', [false]],
                        ['network_log', [false]],
                    ] as [string, any[]][]) {
                        const reply = await this.adapter.dispatch(
                            registered.token,
                            method,
                            args,
                            this.adapter.revision,
                        );
                        assert(reply.ok, reply.error || '停止失败');
                    }
                    await this.http?.close();
                    this.http = undefined;
                    this.adapter.clients.clear();
                    this.adapter.pending.clear();
                    this.adapter.rotate();
                    return true;
                }
                case 'home-config': {
                    const [scope, operation, values, revision, patch = {}] = args;
                    assert(
                        typeof scope === 'string' && /^home-[a-f0-9]{24}$/.test(scope),
                        '侧栏页面标识无效',
                    );
                    assert(
                        [
                            'read_device',
                            'preview_save',
                            'save_device',
                            'import_config',
                            'backup_config',
                        ].includes(operation),
                        '未知设备配置操作',
                    );
                    assert(revision === this.adapter.revision, '其他终端已更新设置，请核对后重试');
                    assert(Array.isArray(values), '设备配置参数无效');
                    const changes = settingsPatch(patch ?? {});
                    assert(
                        operation === 'read_device' || !Object.keys(changes).length,
                        '请先应用连接设置并重新读取',
                    );
                    const { token } = await this.call('register', [scope], client);
                    let nextRevision = revision;
                    if (Object.keys(changes).length) {
                        const reply = await this.adapter.dispatch(
                            token,
                            'update_settings',
                            [changes],
                            nextRevision,
                        );
                        assert(reply.ok, reply.error);
                        nextRevision = reply.revision;
                    }
                    const reply = await this.adapter.dispatch(token, operation, values, nextRevision);
                    return { ...reply, epoch: this.service.epoch };
                }
                case 'home-control': {
                    const [action, patch, revision] = args;
                    assert(
                        [
                            'save-settings',
                            'bridge-start',
                            'bridge-stop',
                            'bridge-restart',
                            'usb-connect',
                            'usb-disconnect',
                            'net-connect',
                            'net-disconnect',
                        ].includes(action),
                        '未知首页操作',
                    );
                    assert(revision === this.adapter.revision, '其他终端已更新设置，请同步后检查并重试');
                    const values = settingsPatch(patch ?? {});
                    const candidate = { ...this.service.settings, ...values };
                    if (action === 'bridge-start' || action === 'bridge-restart') runtimeSettings(candidate);
                    if (action === 'bridge-start' || action === 'bridge-restart')
                        assert(
                            !this.service.usbMonitor ||
                                this.service.usbMonitor.port.toLowerCase() !== candidate.com.toLowerCase(),
                            '业务 COM 正由 USB 诊断占用',
                        );
                    if (action === 'usb-connect')
                        assert(
                            candidate.device !== 'esp01s' && candidate.usb_port,
                            '请选择 C5/S3 原生 USB COM',
                        );
                    const registered = await this.call('register', [], client);
                    let nextRevision = revision;
                    if (Object.keys(values).length) {
                        const reply = await this.adapter.dispatch(
                            registered.token,
                            'update_settings',
                            [values],
                            nextRevision,
                        );
                        assert(reply.ok, reply.error);
                        nextRevision = reply.revision;
                    }
                    if (action === 'save-settings') return true;
                    if (['bridge-start', 'bridge-restart', 'usb-connect', 'net-connect'].includes(action))
                        await this.start();
                    const isBridge = action.startsWith('bridge-');
                    const isNet = action.startsWith('net-');
                    const operation = isBridge ? action.slice(7) : action === 'usb-connect' || action === 'net-connect';
                    const reply = await this.adapter.dispatch(
                        registered.token,
                        isBridge ? 'bridge' : isNet ? 'network_log' : 'usb',
                        [operation],
                        nextRevision,
                    );
                    assert(reply.ok, reply.error || '操作失败');
                    return true;
                }
                case 'rotate':
                    return this.adapter.rotate();
                case 'revoke':
                    return this.adapter.revoke(args[0]);
                case 'decide':
                    return this.adapter.decide(args[0], args[1]);
                case 'choose': {
                    const scan = await this.status(true);
                    const selected = scan.addresses.find((x) => x.id === args[0] && x.ip === args[1]);
                    assert(selected, '网卡地址已改变，请重新选择');
                    assert(selected.shareable, selected.reason || '该网卡暂不可用');
                    this.preferred = selected;
                    await atomicJSON(join(this.directory, 'lan.json'), {
                        version: 1,
                        listen: this.options.listen,
                        port: this.options.port,
                        origins: this.options.origins,
                        preferred_interface: selected,
                    });
                    return true;
                }
                case 'import':
                    await this.service.importState(args[0]);
                    return true;
                case 'logs':
                    return this.service.execute('export_logs', []);
                default:
                    throw new Error('未知管理操作');
            }
        } finally {
            release();
        }
    }
    async listen(pipe: string) {
        this.server = net.createServer((socket) => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
            socket.setTimeout(50000, () => socket.destroy());
            let data = '',
                handled = false;
            socket.on('error', () => {});
            socket.on('data', (chunk) => {
                if (handled) return;
                data += chunk.toString('utf8');
                if (Buffer.byteLength(data) > 524288) {
                    socket.destroy();
                    return;
                }
                if (!data.includes('\n')) return;
                handled = true;
                void (async () => {
                    try {
                        const req = parseJSON(data.slice(0, data.indexOf('\n')));
                        assert(
                            req.secret === this.secret &&
                                typeof req.client === 'string' &&
                                typeof req.method === 'string' &&
                                Array.isArray(req.args),
                            '无效的本机请求',
                        );
                        const result = await this.call(req.method, req.args, req.client);
                        socket.end(JSON.stringify({ ok: true, data: result }) + '\n');
                    } catch (e: any) {
                        socket.end(JSON.stringify({ ok: false, error: e.message }) + '\n');
                    }
                })();
            });
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(pipe, () => {
                this.server!.removeListener('error', reject);
                resolve();
            });
        });
        this.server.on('error', () => {});
    }
    async close() {
        for (const s of this.sockets) s.destroy();
        if (this.server?.listening) await new Promise<void>((r) => this.server!.close(() => r()));
        await this.http?.close();
        await this.service.close();
    }
}
export class Broker {
    owner?: BackendOwner;
    private secret = '';
    readonly client = randomBytes(16).toString('hex');
    private pipe: string;
    private ready?: Promise<void>;
    constructor(
        readonly directory: string,
        readonly frontend: string,
        readonly options: Options,
    ) {
        const hash = createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 24);
        this.pipe =
            process.platform === 'win32' ? `\\\\.\\pipe\\tcp2com-${hash}` : join(directory, 'backend.sock');
    }
    private async ensure() {
        if (this.ready) return this.ready;
        this.ready = this.connectOrOwn().catch((e) => {
            this.ready = undefined;
            throw e;
        });
        return this.ready;
    }
    private async connectOrOwn() {
        await mkdir(this.directory, { recursive: true });
        const secretFile = join(this.directory, 'broker.json');
        try {
            const doc = JSON.parse(await readFile(secretFile, 'utf8'));
            this.secret = doc.secret;
            await this.request('status', []);
            return;
        } catch {}
        const secret = randomBytes(32).toString('hex'),
            owner = new BackendOwner(this.directory, this.frontend, secret, this.options);
        try {
            await owner.listen(this.pipe);
        } catch (e: any) {
            if (e.code !== 'EADDRINUSE') throw e;
            for (let i = 0; i < 20; i++) {
                await new Promise((r) => setTimeout(r, 100));
                try {
                    const doc = JSON.parse(await readFile(secretFile, 'utf8'));
                    this.secret = doc.secret;
                    await this.request('status', []);
                    return;
                } catch {}
            }
            throw new Error('另一窗口的后端暂不可用，请重新打开工作台');
        }
        this.owner = owner;
        this.secret = secret;
        try {
            await owner.initialize();
            await atomicJSON(secretFile, { secret });
        } catch (error) {
            await owner.close();
            this.owner = undefined;
            throw error;
        }
    }
    private request(method: string, args: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(this.pipe);
            let text = '';
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('本机后端响应超时'));
            }, 48000);
            socket.once('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });
            socket.once('connect', () =>
                socket.write(
                    JSON.stringify({ secret: this.secret, client: this.client, method, args }) + '\n',
                ),
            );
            socket.on('data', (chunk) => {
                text += chunk.toString('utf8');
                if (text.length > 4 * 1024 * 1024) {
                    socket.destroy();
                    clearTimeout(timer);
                    reject(new Error('本机响应过大'));
                    return;
                }
                if (text.includes('\n')) {
                    clearTimeout(timer);
                    socket.destroy();
                    try {
                        const reply = parseJSON(text.slice(0, text.indexOf('\n')));
                        reply.ok ? resolve(reply.data) : reject(new Error(reply.error));
                    } catch (e) {
                        reject(e);
                    }
                }
            });
            socket.once('end', () => {
                if (!text.includes('\n')) {
                    clearTimeout(timer);
                    reject(new Error('本机后端已关闭，请重试连接'));
                }
            });
        });
    }
    async call(method: string, ...args: any[]) {
        await this.ensure();
        try {
            return await this.request(method, args);
        } catch (error: any) {
            if (['ECONNREFUSED', 'ENOENT', 'EPIPE'].includes(error.code)) {
                this.ready = undefined;
                this.owner = undefined;
            }
            throw error;
        }
    }
    async close() {
        if (!this.ready) return;
        try {
            await this.call('unregister');
        } catch {}
        if (this.owner) {
            await this.owner.close();
            try {
                await unlink(join(this.directory, 'broker.json'));
            } catch {}
        }
        this.ready = undefined;
        this.owner = undefined;
    }
}
