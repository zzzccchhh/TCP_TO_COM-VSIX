import { isIP, Socket } from 'node:net';
import { assert, Data } from '../../shared/model';
import { parseStats } from '../usb/monitor';

export function logTarget(host: string, port: string) {
    assert(typeof host === 'string' && isIP(host.trim()) === 4, '请输入日志设备 IPv4 地址');
    assert(/^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535, '日志端口应为 1024～65535');
    return { host: host.trim(), port: Number(port) };
}

export class NetworkLogMonitor {
    private socket?: Socket;
    private retry?: NodeJS.Timeout;
    private closing = false;
    private buffer = Buffer.alloc(0);
    private discard = false;
    private updated: number | null = null;
    connected = false;
    message = '连接中';
    fields: Data = {};
    dropped = 0;
    constructor(readonly host: string, readonly port: number,
        private log: (text: string) => void, private event: (text: string) => void = () => {}) {}
    start() { this.connect(); }
    private connect() {
        if (this.closing) return;
        const socket = this.socket = new Socket();
        this.buffer = Buffer.alloc(0);
        this.discard = false;
        socket.setTimeout(2000);
        socket.on('timeout', () => { if (!this.connected) socket.destroy(new Error('连接超时')); });
        socket.on('error', (error) => { this.message = `重试中：${error.message}`; });
        socket.on('connect', () => {
            socket.setTimeout(0);
            socket.setKeepAlive(true, 3000);
            this.connected = true;
            this.fields = {};
            this.updated = null;
            this.message = '已连接';
            this.event(`网络日志已连接：${this.host}:${this.port}`);
        });
        socket.on('data', (data) => this.consume(data));
        socket.on('close', () => {
            this.connected = false;
            if (!this.closing) {
                if (this.message === '已连接') this.message = '设备关闭连接，重试中';
                this.retry = setTimeout(() => this.connect(), 1000);
            }
        });
        socket.connect(this.port, this.host);
    }
    private consume(data: Buffer) {
        for (let start = 0, end; start < data.length; start = end + 1) {
            end = data.indexOf(10, start);
            const terminated = end >= 0;
            if (!terminated) end = data.length;
            const part = data.subarray(start, end);
            if (!this.discard) {
                if (this.buffer.length + part.length > 8192) {
                    this.buffer = Buffer.alloc(0);
                    this.discard = true;
                    this.dropped++;
                } else this.buffer = Buffer.concat([this.buffer, part]);
            }
            if (terminated) {
                if (!this.discard) {
                    const line = this.buffer.toString('utf8').replace(/\r$/, '');
                    if (line && !/^(C5CFG |BRIDGECFG )/.test(line)) {
                        this.log(line);
                        const fields = parseStats(line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
                        if (Object.keys(fields).length) {
                            Object.assign(this.fields, fields);
                            this.updated = Date.now();
                        }
                    }
                }
                this.buffer = Buffer.alloc(0);
                this.discard = false;
            }
        }
    }
    status() {
        return { host: this.host, port: this.port, connected: this.connected, message: this.message,
            fields: { ...this.fields }, dropped: this.dropped, closing: this.closing,
            age: this.updated === null ? null : (Date.now() - this.updated) / 1000 };
    }
    async close() {
        this.closing = true;
        clearTimeout(this.retry);
        this.connected = false;
        this.message = '已断开';
        const socket = this.socket;
        if (socket && !socket.closed) await new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
            socket.destroy();
        });
    }
}
