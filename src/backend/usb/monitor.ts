import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { Data, Device, assert, parseJSON } from '../../shared/model';
import { Port, OpenPort, openPort, closePort, writePort } from '../serial/ports';
import { OutcomeUnknown } from '../config/schema';
export function parseStats(line: string): Data {
    const at = line.indexOf('stats:');
    if (at < 0) return {};
    const record = line.slice(at + 6).trim();
    const fields: Data = {};
    if (record.startsWith('IP=')) {
        const names: Data = {
            IP: 'IP',
            ch: 'ch',
            RSSI: 'RSSI',
            session: 'session',
            'local->net': 'rate.local_to_net',
            'net->local': 'rate.net_to_local',
        };
        for (const m of record.matchAll(/(?:^|\s)(IP|ch|RSSI|session|local->net|net->local)=([^\s]+)/g))
            fields[names[m[1]]] = m[2];
        return fields;
    }
    const patterns: [RegExp, string[]][] = [
        [
            /^queues local->net=(\S+) peak=(\d+) net->local=(\S+) peak=(\d+)$/,
            [
                'queue.local_to_net',
                'queue.local_to_net.peak',
                'queue.net_to_local',
                'queue.net_to_local.peak',
            ],
        ],
        [
            /^drops offline=(\d+) stage=(\d+) full=(\d+) session=(\d+) uart_errors=(\d+)$/,
            ['drops.offline', 'drops.stage', 'drops.full', 'drops.session', 'drops.uart_errors'],
        ],
        [
            /^link=(\S+) SPI rx\/tx=(\d+)\/(\d+) protocol_errors=(\d+)(?: .*)?$/,
            ['link', 'spi.rx', 'spi.tx', 'protocol_errors'],
        ],
        [
            /^totals UART rx\/tx=(\d+)\/(\d+) TCP rx\/tx=(\d+)\/(\d+)$/,
            ['uart.rx', 'uart.tx', 'network.rx', 'network.tx'],
        ],
        [/^UART backlog equivalent=(\d+)\/(\d+) ms$/, ['backlog.local_to_net_ms', 'backlog.net_to_local_ms']],
        [
            /^internal free\/min=(\d+)\/(\d+) PSRAM free=(\d+) stacks free RX\/TX\/TCP=(\d+)\/(\d+)\/(\d+) bytes$/,
            [
                'heap.internal.free',
                'heap.internal.min',
                'heap.psram.free',
                'stack.rx',
                'stack.tx',
                'stack.tcp',
            ],
        ],
    ];
    for (const [re, names] of patterns) {
        const m = record.match(re);
        if (m) {
            names.forEach((name, i) => (fields[name] = m[i + 1]));
            break;
        }
    }
    return fields;
}
type Pending = {
    id: string;
    op: string;
    resolve: (d: Data) => void;
    reject: (e: Error) => void;
    sent: boolean;
    timer: NodeJS.Timeout;
    probe?: NodeJS.Timeout;
};
export class USBMonitor {
    serial?: Port;
    connected = false;
    generation = '';
    boot: string | null = null;
    session: number | null = null;
    model: string | null = null;
    prefix = 'C5CFG ';
    fields: Data = {};
    updated = 0;
    private buffer = Buffer.alloc(0);
    private discard = false;
    private pending?: Pending;
    private retry?: NodeJS.Timeout;
    private closing = false;
    private fileWrites = Promise.resolve();
    constructor(
        readonly port: string,
        readonly baud: number,
        readonly device: Device,
        private log: (s: string) => void,
        private logfile = '',
        private opener: OpenPort = openPort,
    ) {}
    async start() {
        this.closing = false;
        await this.connect();
    }
    private async connect() {
        if (this.closing) return;
        try {
            const port = await this.opener({
                path: this.port,
                baudRate: this.baud,
                rtscts: false,
                dsrdtr: false,
                hupcl: false,
                dtr: false,
                rts: false,
            });
            if (this.closing) {
                await closePort(port);
                return;
            }
            this.serial = port;
            this.connected = true;
            this.generation = randomBytes(16).toString('hex');
            this.buffer = Buffer.alloc(0);
            this.discard = false;
            port.on('error', () => {
                this.disconnected();
                void closePort(port);
            });
            port.on('close', () => this.disconnected());
            port.on('data', (data: Buffer) => this.consume(data));
            this.log(`USB 日志 / 配置已连接：${this.port}`);
        } catch {
            this.disconnected();
        }
    }
    private disconnected() {
        this.connected = false;
        this.boot = null;
        this.session = null;
        this.model = null;
        this.prefix = 'C5CFG ';
        this.failPending();
        if (!this.closing && !this.retry)
            this.retry = setTimeout(() => {
                this.retry = undefined;
                void this.connect();
            }, 1000);
    }
    private failPending() {
        const p = this.pending;
        if (!p) return;
        this.pending = undefined;
        clearTimeout(p.timer);
        clearTimeout(p.probe);
        p.reject(
            p.op === 'save' && p.sent
                ? new OutcomeUnknown('保存结果待确认：USB 超时或断开，请重新读取核对，勿直接重发')
                : new Error('USB 请求超时或断开，请检查 COM 与配网状态'),
        );
    }
    identity() {
        assert(this.connected && !this.closing, 'USB 未连接，请先连接原生 USB COM');
        return JSON.stringify(['usb', this.port.toLowerCase(), this.generation, this.boot, this.session]);
    }
    request(op: string, patch?: Data, identity?: string): Promise<Data> {
        assert(this.connected && this.serial && !this.pending, 'USB 未连接或请求进行中');
        if (identity) assert(JSON.parse(identity)[2] === this.generation, 'USB 连接已改变，请重新读取');
        const id = randomBytes(16).toString('hex');
        const envelope: Data = { v: 2, id, op };
        if (identity) {
            const old = JSON.parse(identity);
            if (old[3]) envelope.boot = old[3];
            if (old[4]) envelope.session = old[4];
        }
        if (patch) {
            assert(Buffer.byteLength(JSON.stringify(patch)) <= 2048, '修改内容超过 2048 字节');
            envelope.patch = patch;
        }
        const text = JSON.stringify(envelope);
        assert(Buffer.byteLength(text) + this.prefix.length <= 2304, 'USB 配置报文过长');
        return new Promise((resolve, reject) => {
            const p: Pending = {
                id,
                op,
                resolve,
                reject,
                sent: false,
                timer: setTimeout(() => this.failPending(), 4000),
            };
            this.pending = p;
            const send = (prefix: string) => {
                if (this.pending !== p) return;
                p.sent = true;
                void writePort(this.serial!, Buffer.from('\n' + prefix + text + '\n'), 500).catch(() =>
                    this.failPending(),
                );
            };
            send(this.prefix);
            if (op === 'hello' && this.device === 's3')
                p.probe = setTimeout(() => send(this.prefix === 'C5CFG ' ? 'BRIDGECFG ' : 'C5CFG '), 2000);
        });
    }
    private consume(data: Buffer) {
        let start = 0;
        while (start < data.length) {
            const newline = data.indexOf(10, start),
                end = newline < 0 ? data.length : newline;
            const part = data.subarray(start, end);
            if (!this.discard) {
                if (this.buffer.length + part.length > 8192) {
                    this.buffer = Buffer.alloc(0);
                    this.discard = true;
                } else this.buffer = Buffer.concat([this.buffer, part]);
            }
            if (newline < 0) break;
            if (!this.discard) this.line(this.buffer);
            this.buffer = Buffer.alloc(0);
            this.discard = false;
            start = newline + 1;
        }
    }
    private line(raw: Buffer) {
        const text = raw.toString('utf8').replace(/\r$/, '');
        const prefix = ['C5CFG ', 'BRIDGECFG '].find((p) => text.startsWith(p));
        if (prefix) {
            try {
                const f = parseJSON(text.slice(prefix.length));
                if (
                    !f ||
                    f.v !== 2 ||
                    !Number.isInteger(f.session) ||
                    f.session < 1 ||
                    f.session > 0xffffffff ||
                    typeof f.ok !== 'boolean' ||
                    !/^[0-9a-f]{16}$/.test(f.boot)
                )
                    return;
                const p = this.pending;
                if (!p || !p.sent || f.id !== p.id) return;
                if (p.op === 'hello') {
                    this.prefix = prefix;
                    this.model = f.ok ? f.result?.device : null;
                }
                this.boot = f.boot;
                this.session = f.session;
                clearTimeout(p.timer);
                clearTimeout(p.probe);
                this.pending = undefined;
                p.resolve(f);
            } catch {}
            return;
        }
        const cleaned = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        this.log(cleaned);
        Object.assign(this.fields, parseStats(cleaned));
        this.updated = Date.now();
        if (this.logfile)
            this.fileWrites = this.fileWrites
                .then(() => appendFile(this.logfile, cleaned + '\n', 'utf8'))
                .catch(() => {
                    this.logfile = '';
                    this.log('USB 日志文件无法写入，已停止文件记录');
                });
    }
    status() {
        return {
            connected: this.connected,
            age: this.updated ? (Date.now() - this.updated) / 1000 : null,
            fields: { ...this.fields },
            port: this.port,
            closing: this.closing,
        };
    }
    async close() {
        this.closing = true;
        clearTimeout(this.retry);
        this.failPending();
        this.connected = false;
        await closePort(this.serial);
        await this.fileWrites;
    }
}
