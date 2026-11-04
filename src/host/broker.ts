import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Data, assert, object, parseJSON } from '../shared/model';
import { Store, atomicJSON } from '../backend/storage/state';
import { Service } from '../backend/service/service';
import { LANAdapter } from '../backend/lan/adapter';
import { LANServer } from '../backend/lan/server';
import { Address, addresses, choose, shareLink } from '../backend/lan/network';
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
    private async status() {
        const scan = await addresses(this.options.listen),
            selection = choose(scan.items, this.preferred);
        const selected = selection.selected ?? { id: 'loopback', name: '本机专用', ip: '127.0.0.1' };
        const address = `http://${selected.ip}:${this.port || this.options.port}/`;
        return {
            running: !!this.http,
            port: this.port || this.options.port,
            listen: this.options.listen,
            addresses: scan.items,
            selected,
            warning: scan.warning || selection.warning,
            address,
            link: shareLink(address, this.adapter.invite),
            localLink: shareLink(address, this.adapter.invite, false),
            ...this.adapter.snapshot(),
            bridge: this.service.engine.running,
            usb: !!this.service.usbMonitor,
        };
    }
    async call(method: string, args: any[], client: string) {
        if (method === 'call') return this.adapter.dispatch(args[0], args[1], args[2], args[3]);
        if (method === 'register') {
            for (const [token, c] of this.adapter.clients)
                if (c.join_id === `native:${client}`) return { token, instance: this.instance };
            assert(this.adapter.clients.size < 32, '已连接终端达到上限');
            const token = randomBytes(32).toString('base64url');
            this.adapter.clients.set(token, {
                id: randomBytes(8).toString('hex'),
                name: 'VS Code 工作台',
                address: '本机插件',
                read_epoch: null,
                join_id: `native:${client}`,
            });
            return { token, instance: this.instance };
        }
        if (method === 'unregister') {
            for (const [token, c] of this.adapter.clients)
                if (c.join_id === `native:${client}`) this.adapter.clients.delete(token);
            return true;
        }
        // Management and lifecycle writes serialize independently of browser reads.
        if (method === 'status') return this.status();
        let release!: () => void;
        const previous = this.management;
        this.management = new Promise<void>((r) => (release = r));
        await previous;
        try {
            switch (method) {
                case 'start':
                    return this.start();
                case 'stop':
                    await this.http?.close();
                    this.http = undefined;
                    await this.service.execute('bridge', ['stop']);
                    this.adapter.clients.clear();
                    this.adapter.pending.clear();
                    this.adapter.rotate();
                    return true;
                case 'rotate':
                    return this.adapter.rotate();
                case 'revoke':
                    return this.adapter.revoke(args[0]);
                case 'decide':
                    return this.adapter.decide(args[0], args[1]);
                case 'choose': {
                    const scan = await addresses(this.options.listen);
                    const selected = scan.items.find((x) => x.id === args[0] && x.ip === args[1]);
                    assert(selected, '网卡地址已改变，请重新选择');
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
