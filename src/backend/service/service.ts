import {
    Data,
    Device,
    assert,
    defaults,
    defaultConfig,
    fromDraft,
    toDraft,
    object,
    parseJSON,
    settingsPatch,
    runtimeSettings,
} from '../../shared/model';
import { Store, cleanState } from '../storage/state';
import { BridgeEngine } from '../bridge/engine';
import { USBMonitor } from '../usb/monitor';
import { ConfigClient, HTTPConfig, USBConfig } from '../config/client';
import { changedConfig, network, publicConfig } from '../config/schema';
import { ResetControl } from '../reset/control';
import { ports } from '../serial/ports';
export class Service {
    settings: Data = { ...defaults };
    drafts: Data = {};
    baseline: Data | null = null;
    epoch = 0;
    configBusy = false;
    busy = false;
    closing = false;
    status = '尚未读取设备';
    stateStatus = '设置会自动记住；连接需手动启动';
    logs: Data[] = [];
    cursor = 0;
    logGeneration = 0;
    logDropped = 0;
    engine: BridgeEngine;
    usbMonitor?: USBMonitor;
    reset = new ResetControl();
    client?: ConfigClient;
    private saveTimer?: NodeJS.Timeout;
    private persist = Promise.resolve();
    private sample = { time: Date.now(), bytes: [0, 0, 0] };
    private rates = [0, 0, 0];
    constructor(
        readonly store: Store,
        private createBridge = (log: (text: string) => void) => new BridgeEngine(log),
    ) {
        this.engine = this.createBridge((s) => this.log(s));
    }
    async init() {
        const saved = await this.store.load();
        this.settings = saved.settings;
        this.drafts = saved.drafts;
        this.stateStatus = saved.warning || '已恢复设置；连接尚未启动';
        this.log('TCP2COM 插件后端已就绪；桥接与 USB 需手动连接');
    }
    log(text: string, source = 'host') {
        text = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        this.logs.push({
            id: ++this.cursor,
            time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
            source,
            level: source === 'usb' ? (text.match(/^\s*([EWIDV])\s+\(\s*\d+\s*\)/)?.[1] ?? '') : '',
            text,
        });
        if (this.logs.length > 3000) {
            this.logs.shift();
            this.logDropped++;
        }
    }
    invalidate(message = '连接已改变，请重新读取设备') {
        this.epoch++;
        this.baseline = null;
        this.client = undefined;
        this.status = message;
    }
    private saveSoon() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), 500);
    }
    private save() {
        const settings = structuredClone(this.settings),
            drafts = structuredClone(this.drafts);
        this.persist = this.persist
            .then(() => this.store.save(settings, drafts))
            .then(
                () => {
                    this.stateStatus = '已记住界面设置';
                },
                () => {
                    this.stateStatus = '无法保存设置，请检查用户存储目录';
                },
            );
    }
    private currentUSB() {
        if (this.client instanceof USBConfig) {
            try {
                if (!this.usbMonitor || this.client.identity !== this.usbMonitor.identity())
                    this.invalidate('USB 已重连或配网会话已改变，请重新读取');
            } catch {
                this.invalidate('USB 已断开，请重新读取');
            }
        }
    }
    private context() {
        return JSON.stringify(
            ['device', 'config_transport', 'config_url', 'usb_port'].map((k) => this.settings[k]),
        );
    }
    initial() {
        return {
            settings: { ...this.settings },
            drafts: structuredClone(this.drafts),
            config: fromDraft(this.drafts[this.settings.device], this.settings.device),
            state_status: this.stateStatus,
        };
    }
    async execute(method: string, args: any[], owner = 'native'): Promise<any> {
        assert(!this.closing, '服务正在关闭');
        switch (method) {
            case 'initial':
                return this.initial();
            case 'ports':
                return ports();
            case 'poll':
                return this.poll(args[0]);
            case 'update_settings': {
                const patch = settingsPatch(args[0]);
                const old = this.context();
                const changed = ['device', 'config_transport', 'config_url', 'usb_port'].some(
                    (k) => k in patch && patch[k] !== this.settings[k],
                );
                assert(!this.configBusy || !changed, '配置请求进行中，请等待完成后切换连接');
                Object.assign(this.settings, patch);
                if (old !== this.context()) this.invalidate();
                this.saveSoon();
                return { epoch: this.epoch };
            }
            case 'bridge': {
                assert(!this.configBusy && !this.busy, '连接或配置操作进行中');
                assert(['start', 'restart', 'stop'].includes(args[0]), '未知桥接操作');
                if (args[0] !== 'stop') {
                    runtimeSettings(this.settings);
                    assert(
                        !this.usbMonitor ||
                            this.usbMonitor.port.toLowerCase() !== this.settings.com.toLowerCase(),
                        '业务 COM 正由 USB 诊断占用',
                    );
                }
                this.busy = true;
                try {
                    await this.engine.stop();
                    if (args[0] !== 'stop') {
                        // A fresh engine prevents callbacks from the old instance affecting a restart.
                        this.engine = this.createBridge((s) => this.log(s));
                        await this.engine.start({ ...this.settings });
                        this.sample = { time: Date.now(), bytes: [0, 0, 0] };
                    }
                    return true;
                } finally {
                    this.busy = false;
                }
            }
            case 'usb': {
                assert(typeof args[0] === 'boolean', 'USB 操作格式不正确');
                assert(!this.busy && (!this.configBusy || !args[0]), '连接或配置请求进行中');
                this.busy = true;
                try {
                    if (args[0]) {
                        assert(
                            this.settings.device !== 'esp01s' && this.settings.usb_port,
                            '请选择 C5/S3 原生 USB COM',
                        );
                        assert(
                            !this.engine.running ||
                                this.engine.settings?.com.toLowerCase() !==
                                    this.settings.usb_port.toLowerCase(),
                            'USB COM 正由业务桥接占用',
                        );
                        assert(
                            /^\d+$/.test(this.settings.usb_baud) &&
                                Number(this.settings.usb_baud) > 0 &&
                                Number(this.settings.usb_baud) <= 5000000,
                            'USB 波特率无效',
                        );
                    }
                    await this.usbMonitor?.close();
                    this.usbMonitor = undefined;
                    this.invalidate('USB 连接已改变；保存结果未知时请重新读取，勿直接重发');
                    if (args[0]) {
                        this.usbMonitor = new USBMonitor(
                            this.settings.usb_port,
                            Number(this.settings.usb_baud),
                            this.settings.device,
                            (s) => this.log(s, 'usb'),
                            this.settings.usb_log,
                        );
                        await this.usbMonitor.start();
                    }
                    return true;
                } finally {
                    this.busy = false;
                }
            }
            case 'remember_draft': {
                assert(['c5', 's3'].includes(args[0]) && object(args[1]), '设备草稿格式不正确');
                const doc = { version: 1, forms: {}, device_drafts: { [args[0]]: toDraft(args[1]) } };
                this.drafts[args[0]] = cleanState(doc).drafts[args[0]];
                this.saveSoon();
                return true;
            }
            case 'read_device':
                return this.readDevice();
            case 'preview_save': {
                assert(!this.configBusy, '配置请求进行中');
                const patch = this.patch(args[0], args[1], args[2]);
                const changes: Data[] = [];
                for (const [key, value] of Object.entries(patch)) {
                    for (const [field, item] of object(value) ? Object.entries(value) : [[null, value]]) {
                        const secret = field === 'password' || key === 'ap_password';
                        changes.push({
                            field: field ? `${key}.${field}` : key,
                            value: secret ? (item === '' ? '（清空密码）' : '（更新密码）') : String(item),
                        });
                    }
                }
                return {
                    changes,
                    needed: !!(
                        Object.keys(patch).length ||
                        this.baseline?.unsaved ||
                        this.baseline?.migration_requires_setup
                    ),
                    epoch: this.epoch,
                };
            }
            case 'save_device':
                return this.saveDevice(args);
            case 'import_config': {
                assert(typeof args[0] === 'string' && Buffer.byteLength(args[0]) <= 131072, '备份文件过大');
                const doc = parseJSON(args[0].replace(/^\uFEFF/, ''));
                assert(
                    object(doc) && ['c5-user-config-v1', 'wifi-bridge-user-config-v1'].includes(doc.format),
                    '不支持的设备备份格式',
                );
                return publicConfig(doc.config, this.settings.device, true);
            }
            case 'backup_config':
                return {
                    format: 'wifi-bridge-user-config-v1',
                    device: this.settings.device,
                    config: publicConfig(args[0], this.settings.device),
                };
            case 'clear_logs':
                this.logs = [];
                this.logGeneration++;
                return this.cursor;
            case 'export_logs':
                return (
                    this.logs
                        .map((r) => `${r.time} [${r.source === 'usb' ? 'USB / ESP' : '上位机'}] ${r.text}`)
                        .join('\n') + '\n'
                );
            case 'reset_click': {
                let [host = '', port = 8081] = args;
                if (this.settings.device === 'esp01s') {
                    assert(
                        this.engine.running &&
                            this.engine.settings?.device === 'esp01s' &&
                            !this.engine.settings.no_reset_ui,
                        '请启动 ESP-01S TCP 客户端桥接并启用复位入口',
                    );
                    host = this.engine.settings.host;
                    port = this.engine.settings.control_port;
                }
                return this.reset.click(this.settings.device, host, Number(port), owner);
            }
            default:
                throw new Error('未知操作');
        }
    }
    private async readDevice() {
        assert(!this.configBusy && !this.busy, '连接或配置操作进行中');
        const device = this.settings.device as Device;
        assert(device !== 'esp01s', 'ESP-01S 不支持配置接口');
        let client: ConfigClient;
        if (this.settings.config_transport === 'usb') {
            assert(
                this.usbMonitor &&
                    this.usbMonitor.port.toLowerCase() === this.settings.usb_port.toLowerCase(),
                '请先连接所选 USB COM',
            );
            client = new USBConfig(this.usbMonitor, device);
        } else client = new HTTPConfig(this.settings.config_url, device);
        this.invalidate('正在读取设备配置…');
        const epoch = this.epoch;
        this.configBusy = true;
        try {
            const doc = await client.read();
            assert(!this.closing && epoch === this.epoch, '连接已改变，已丢弃旧读取结果');
            if (client instanceof USBConfig)
                assert(client.identity === this.usbMonitor?.identity(), 'USB 已重连，请重新读取');
            this.client = client;
            this.baseline = structuredClone(doc);
            this.status = '已读取当前设备配置；修改后需明确保存';
            if (!this.drafts[device]) {
                this.drafts[device] = toDraft(doc);
                this.saveSoon();
            }
            return doc;
        } catch (e: any) {
            this.status = e.message;
            throw e;
        } finally {
            this.configBusy = false;
        }
    }
    private patch(edited: any, passwords: any, clear: any) {
        this.currentUSB();
        assert(this.baseline && this.client, '请先从当前连接读取设备，之后才能保存');
        assert(object(edited), '配置必须是对象');
        const candidate = structuredClone(edited);
        for (const key of [...network, 'flow_pin', 'reset_pin'])
            if (!(key in this.baseline)) delete candidate[key];
        return changedConfig(this.baseline, candidate, passwords, clear, this.settings.device);
    }
    private async saveDevice(args: any[]) {
        assert(!this.configBusy && args[3] === this.epoch, '读取依据已改变，请重新读取');
        const patch = this.patch(args[0], args[1], args[2]);
        if (!Object.keys(patch).length && !this.baseline?.unsaved && !this.baseline?.migration_requires_setup)
            return { saved: false };
        const client = this.client!;
        this.configBusy = true;
        this.invalidate('正在保存到 NVS，等待设备确认…');
        try {
            await client.save(patch);
            this.status = '已保存并请求重启；请重新进入配网读取核对';
            return { saved: true };
        } catch (e: any) {
            this.status = e.message;
            throw e;
        } finally {
            this.configBusy = false;
        }
    }
    poll(cursor = 0) {
        assert(Number.isInteger(cursor) && cursor >= 0, '日志游标无效');
        this.currentUSB();
        this.reset.expire();
        const e = this.engine,
            now = Date.now(),
            bytes = ['tcp_rx_bytes', 'tcp_to_com_bytes', 'com_to_tcp_bytes'].map((k) => e.stats[k] ?? 0);
        if (now - this.sample.time >= 100) {
            this.rates = bytes.map((n, i) =>
                Math.max(0, ((n - this.sample.bytes[i]) * 1000) / (now - this.sample.time)),
            );
            this.sample = { time: now, bytes };
        }
        let valid = true,
            applied = false;
        try {
            const current = runtimeSettings(this.settings);
            applied =
                !!e.settings &&
                e.running &&
                Object.keys(current)
                    .filter(
                        (k) =>
                            ![
                                'usb_port',
                                'usb_baud',
                                'usb_log',
                                'config_url',
                                'config_transport',
                                'stats_interval',
                            ].includes(k),
                    )
                    .every((k) => current[k] === e.settings![k]);
        } catch {
            valid = false;
        }
        return {
            state: this.busy ? '正在处理…' : e.running ? '运行中' : '已停止',
            running: e.running,
            connected: e.connected,
            busy: this.busy,
            running_settings: e.running ? e.settings : null,
            applied,
            valid,
            address: e.address,
            rates: e.running ? this.rates : [0, 0, 0],
            stats: e.snapshot(),
            queued: e.queued,
            peak: e.peak,
            usb: this.usbMonitor?.status() ?? null,
            config_busy: this.configBusy,
            config_status: this.status,
            baseline: structuredClone(this.baseline),
            epoch: this.epoch,
            state_status: this.stateStatus,
            log_dropped: this.logDropped,
            logs: this.logs.filter((r) => r.id > cursor),
            cursor: this.cursor,
            log_generation: this.logGeneration,
            reset: { count: this.reset.count, busy: this.reset.busy, message: this.reset.message },
        };
    }
    async importState(text: string) {
        assert(!this.engine.running && !this.usbMonitor && !this.configBusy, '请先停止桥接与 USB');
        const clean = cleanState(parseJSON(text.replace(/^\uFEFF/, '')));
        this.settings = clean.settings;
        this.drafts = clean.drafts;
        this.invalidate('已导入旧版设置；设备尚未连接');
        this.save();
        await this.persist;
    }
    async close() {
        if (this.closing) return;
        this.closing = true;
        clearTimeout(this.saveTimer);
        this.reset.close();
        await this.engine.stop();
        await this.usbMonitor?.close();
        this.save();
        await this.persist;
    }
}
