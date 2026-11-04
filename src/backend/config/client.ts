import http from 'node:http';
import https from 'node:https';
import { Data, Device, assert, labels, object, parseJSON } from '../../shared/model';
import { OutcomeUnknown, publicConfig } from './schema';
import { USBMonitor } from '../usb/monitor';
export interface ConfigClient {
    identity: string;
    baseline: Data | null;
    read(): Promise<Data>;
    save(patch: Data): Promise<Data>;
}
export class HTTPConfig implements ConfigClient {
    identity: string;
    baseline: Data | null = null;
    session = '';
    private url: URL;
    constructor(
        address: string,
        private device: Device,
    ) {
        this.url = new URL(address);
        assert(
            ['http:', 'https:'].includes(this.url.protocol) &&
                !this.url.username &&
                !this.url.password &&
                !this.url.search &&
                !this.url.hash &&
                ['/', '/api/config'].includes(this.url.pathname),
            '配置地址应为 http://设备IP/',
        );
        this.url.pathname = '/api/config';
        this.identity = this.url.origin;
    }
    private request(method: string, patch?: Data): Promise<Data> {
        const body = patch ? JSON.stringify(patch) : undefined;
        assert(!body || Buffer.byteLength(body) <= 2048, '请求体超过 2048 字节');
        return new Promise((resolve, reject) => {
            let sent = false,
                settled = false;
            const fail = (message: string, unknown = false) => {
                if (settled) return;
                settled = true;
                reject(unknown ? new OutcomeUnknown(message) : new Error(message));
            };
            const req = (this.url.protocol === 'https:' ? https : http).request(
                this.url,
                {
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        Connection: 'close',
                        ...(body
                            ? {
                                  'Content-Length': Buffer.byteLength(body),
                                  [this.baseline?.config_api === 'bridge-1'
                                      ? 'X-Bridge-Session'
                                      : 'X-C5-Session']: this.session,
                              }
                            : {}),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    res.on('data', (chunk) => {
                        size += chunk.length;
                        if (size > 8192) {
                            req.destroy();
                            fail('设备响应过大；请重新读取确认', sent);
                        } else chunks.push(chunk);
                    });
                    res.on('end', () => {
                        if (settled) return;
                        const status = res.statusCode ?? 0;
                        if (status !== 200) {
                            fail(
                                status === 403
                                    ? '403：请长按配网按钮进入配置模式'
                                    : status === 503
                                      ? '503：配置修订号或会话已变化，请重新读取'
                                      : `HTTP ${status}：设备拒绝配置请求`,
                                method === 'POST' && status >= 500 && status !== 503,
                            );
                            return;
                        }
                        try {
                            const result = parseJSON(Buffer.concat(chunks).toString('utf8'));
                            assert(object(result), '设备响应不是对象');
                            settled = true;
                            resolve(result);
                        } catch {
                            fail('设备响应格式不正确，请重新读取确认', sent);
                        }
                    });
                    res.on('error', () => fail('设备响应中断，请重新读取确认', sent));
                },
            );
            req.setTimeout(4000, () => req.destroy());
            req.on('socket', (socket) => {
                const mark = () => {
                    sent = method === 'POST';
                };
                if (!socket.connecting) mark();
                else socket.once(this.url.protocol === 'https:' ? 'secureConnect' : 'connect', mark);
            });
            req.on('error', () =>
                fail(
                    sent
                        ? '保存结果待确认：请求可能已写入 NVS，请重新读取，勿直接重发'
                        : '无法读取配置：连接超时或断开',
                    sent,
                ),
            );
            req.end(body);
        });
    }
    async read() {
        this.baseline = null;
        this.session = '';
        this.identity = this.url.origin;
        const doc = await this.request('GET');
        const result = publicConfig(doc, this.device);
        assert(
            typeof doc.http_session === 'string' && /^[0-9a-f]{16}-[1-9][0-9]{0,9}$/.test(doc.http_session),
            '缺少有效的 HTTP 配网会话，请更新固件并重新读取',
        );
        this.session = doc.http_session;
        this.identity = this.url.origin + '|' + this.session;
        result.config_source = String(doc.config_source ?? 'unknown');
        this.baseline = structuredClone(result);
        return result;
    }
    async save(patch: Data) {
        assert(this.session && this.baseline, '请先读取当前设备');
        const result = await this.request('POST', {
            ...patch,
            ...('revision' in this.baseline ? { revision: this.baseline.revision } : {}),
        });
        if (result.saved !== true || result.restart !== true)
            throw new OutcomeUnknown('保存结果待确认：缺少 saved/restart 确认，请重新读取');
        return result;
    }
}
export class USBConfig implements ConfigClient {
    identity: string;
    baseline: Data | null = null;
    constructor(
        private monitor: USBMonitor,
        private device: Device,
    ) {
        assert(monitor.device === device, 'USB 型号选择已改变，请重新连接');
        this.identity = monitor.identity();
    }
    private async request(op: string, patch?: Data) {
        const frame = await this.monitor.request(op, patch, this.identity);
        if (!frame.ok) {
            if (
                frame.code === 'save_unknown' ||
                (op === 'save' && !['invalid', 'busy', 'stale'].includes(frame.code))
            )
                throw new OutcomeUnknown('保存结果待确认，请重新读取核对');
            throw new Error(
                (
                    {
                        busy: '配置修订号已变化或设备正在重启，请重新读取',
                        stale: '设备会话已改变，请重新读取',
                        invalid: '设备拒绝配置参数',
                        memory: '设备内存不足',
                    } as Data
                )[frame.code] ?? '设备拒绝 USB 配置请求',
            );
        }
        if (!object(frame.result)) {
            if (op === 'save') throw new OutcomeUnknown('保存结果待确认：缺少有效结果');
            throw new Error('USB 配置回复格式不正确');
        }
        const old = JSON.parse(this.identity);
        if (op !== 'hello' && (frame.boot !== old[3] || frame.session !== old[4])) {
            if (op === 'save') throw new OutcomeUnknown('保存结果待确认：设备会话已改变');
            throw new Error('设备会话已改变，请重新读取');
        }
        return frame;
    }
    async read() {
        this.baseline = null;
        const hello = await this.request('hello');
        assert(
            hello.result.device === labels[this.device] && hello.result.protocol === 2,
            'USB 设备型号或 v2 配置协议不匹配',
        );
        this.identity = this.monitor.identity();
        const frame = await this.request('read');
        const result = publicConfig(frame.result, this.device);
        result.config_source = String(frame.result.config_source ?? 'unknown');
        this.identity = this.monitor.identity();
        this.baseline = structuredClone(result);
        return result;
    }
    async save(patch: Data) {
        assert(
            this.baseline &&
                this.monitor.identity() === this.identity &&
                this.monitor.model === labels[this.device],
            'USB 连接或型号已改变，请重新读取',
        );
        const body = {
            ...patch,
            ...('revision' in this.baseline ? { revision: this.baseline.revision } : {}),
        };
        const validation = await this.request('validate', body);
        assert(validation.result.valid === true, '设备未确认校验通过，未发送保存命令');
        const saved = await this.request('save', body);
        if (saved.result.saved !== true || saved.result.restart !== true)
            throw new OutcomeUnknown('保存结果待确认：缺少保存及重启确认，请重新读取');
        return saved.result;
    }
}
