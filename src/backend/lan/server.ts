import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { Data, assert, object, parseJSON } from '../../shared/model';
import { LANAdapter, Unauthorized } from './adapter';
export function privateIP(address: string) {
    address = address.replace(/^::ffff:/, '');
    if (address === '::1') return true;
    const p = address.split('.').map(Number);
    return (
        p.length === 4 &&
        p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
        (p[0] === 10 ||
            p[0] === 127 ||
            (p[0] === 192 && p[1] === 168) ||
            (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
            (p[0] === 169 && p[1] === 254))
    );
}
export function allowed(req: http.IncomingMessage, origins: string[]) {
    if (!privateIP(req.socket.remoteAddress ?? '')) return false;
    const authority = req.headers.host;
    if (!authority || /[\/\\@#?\s]/.test(authority)) return false;
    try {
        const host = new URL('http://' + authority).hostname;
        if (host !== 'localhost' && !privateIP(host)) return false;
    } catch {
        return false;
    }
    const origin = req.headers.origin;
    return !origin || origin === 'http://' + authority || origins.includes(origin);
}
const mime: Data = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
};
export class LANServer {
    server: http.Server;
    private sockets = new Set<import('node:net').Socket>();
    constructor(
        readonly adapter: LANAdapter,
        readonly root: string,
        readonly origins: string[],
    ) {
        this.server = http.createServer((req, res) => {
            void this.handle(req, res).catch(() => {
                if (!res.headersSent)
                    this.reply(req, res, 400, {
                        ok: false,
                        error: '请求失败，请同步状态并核对操作参数',
                        revision: adapter.revision,
                    });
                else res.destroy();
            });
        });
        this.server.requestTimeout = 10000;
        this.server.headersTimeout = 10000;
        this.server.on('connection', (sock) => {
            this.sockets.add(sock);
            sock.once('close', () => this.sockets.delete(sock));
        });
    }
    private reply(req: http.IncomingMessage, res: http.ServerResponse, status: number, data: Data) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (req.headers.origin && allowed(req, this.origins)) {
            res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
            res.setHeader('Vary', 'Origin');
        }
        res.end(JSON.stringify(data));
    }
    private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
        if (!allowed(req, this.origins)) {
            this.reply(req, res, 403, { ok: false, error: '来源未授权' });
            return;
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': req.headers.origin ?? '',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Private-Network': 'true',
                Vary: 'Origin',
            });
            res.end();
            return;
        }
        if (req.method === 'POST') {
            try {
                assert(
                    /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? ''),
                    '请求格式不正确',
                );
                const length = Number(req.headers['content-length']);
                assert(Number.isInteger(length) && length > 0 && length <= 262144, '请求格式不正确或过大');
                let size = 0;
                const chunks: Buffer[] = [];
                for await (const chunk of req) {
                    size += chunk.length;
                    assert(size <= 262144, '请求过大');
                    chunks.push(chunk);
                }
                assert(size === length, '请求不完整');
                const data = parseJSON(Buffer.concat(chunks).toString('utf8'));
                assert(object(data), '请求格式不正确');
                let result: Data;
                switch (req.url) {
                    case '/api/connect':
                        result = {
                            ok: true,
                            data: this.adapter.connect(
                                data.invite,
                                data.name,
                                req.socket.remoteAddress ?? '',
                                data.join_id,
                            ),
                        };
                        break;
                    case '/api/pair/request':
                        result = {
                            ok: true,
                            data: this.adapter.requestPair(data.name, req.socket.remoteAddress ?? ''),
                        };
                        break;
                    case '/api/pair/status':
                    case '/api/pair/cancel':
                        result = {
                            ok: true,
                            data: this.adapter.pairStatus(data.request, req.url.endsWith('cancel')),
                        };
                        break;
                    case '/api/call':
                        result = await this.adapter.dispatch(
                            (req.headers.authorization ?? '').startsWith('Bearer ')
                                ? req.headers.authorization!.slice(7)
                                : '',
                            data.method,
                            data.args,
                            data.revision,
                        );
                        break;
                    default:
                        this.reply(req, res, 404, { ok: false, error: '接口不存在' });
                        return;
                }
                this.reply(req, res, 200, result);
            } catch (error) {
                const status = error instanceof Unauthorized ? 401 : 400;
                const text = error instanceof Error ? error.message : '';
                const safe = /^(配对|其他终端|请在本终端|已配对|未知操作|复位正在)/.test(text);
                this.reply(req, res, status, {
                    ok: false,
                    error: status === 401 ? text : safe ? text : '请求格式不正确',
                    ...(status === 400 ? { revision: this.adapter.revision } : {}),
                });
            }
            return;
        }
        if (req.method !== 'GET') {
            this.reply(req, res, 405, { ok: false, error: '不支持的请求方式' });
            return;
        }
        const url = req.url ?? '/';
        const relative = decodeURIComponent(url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
        const root = await realpath(this.root);
        const path = resolve(root, relative);
        if (path !== root && !path.startsWith(root + sep)) {
            this.reply(req, res, 404, { ok: false, error: '页面不存在' });
            return;
        }
        let body: Buffer;
        try {
            const actual = await realpath(path);
            assert(actual.startsWith(root + sep), '无效路径');
            body = await readFile(actual);
        } catch {
            this.reply(req, res, 404, { ok: false, error: '页面不存在' });
            return;
        }
        if (relative === 'index.html') {
            const bootstrap =
                '<script>window.__WIFI_BRIDGE__=' +
                JSON.stringify({ invite: this.adapter.invite }) +
                ';</script>';
            body = Buffer.from(body.toString('utf8').replace('<head>', '<head>' + bootstrap));
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        }
        res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', relative === 'index.html' ? 'no-store' : 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.end(body);
    }
    async listen(host: string, port: number) {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => {
                this.server.removeListener('error', reject);
                resolve();
            });
        });
        this.server.on('error', () => this.adapter.service.log('网页服务异常，请停止后重新启动'));
        return (this.server.address() as import('node:net').AddressInfo).port;
    }
    async close() {
        for (const s of this.sockets) s.destroy();
        if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
}
