import { isIP } from 'node:net';
export type Data = Record<string, any>;
export type Device = 'c5' | 's3' | 'esp01s';
export const labels = { c5: 'ESP32-C5', s3: 'ESP32-S3', esp01s: 'ESP-01S' };
export const defaults: Data = {
    device: 'c5',
    mode: 'tcp-server',
    host: '',
    listen: '0.0.0.0',
    port: '8080',
    peer_port: '6060',
    udp_payload: '1200',
    com: 'COM1',
    baud: '1152000',
    bytesize: '8',
    parity: 'N',
    stopbits: '1',
    flow: 'none',
    timeout: '0.02',
    write_timeout: '2',
    reconnect: '2',
    connect_timeout: '4',
    keepalive_idle: '3',
    keepalive_interval: '1',
    keepalive_count: '5',
    bufsize: '65536',
    stats_interval: '0.25',
    control_port: '8081',
    no_reset_ui: false,
    verbose: false,
    net_log_host: '',
    net_log_port: '8082',
    usb_port: '',
    usb_baud: '115200',
    usb_log: '',
    config_transport: 'usb',
    config_url: 'http://192.168.4.1/',
};
export const formFields: Data = {
    network: ['device', 'mode', 'host', 'listen', 'port', 'peer_port', 'udp_payload'],
    local: ['com', 'baud', 'bytesize', 'parity', 'stopbits', 'flow'],
    advanced: [
        'timeout',
        'write_timeout',
        'reconnect',
        'connect_timeout',
        'keepalive_idle',
        'keepalive_interval',
        'keepalive_count',
        'bufsize',
        'stats_interval',
        'control_port',
        'no_reset_ui',
        'verbose',
    ],
    usb_form: ['usb_port', 'usb_baud', 'usb_log'],
    net_log_form: ['net_log_host', 'net_log_port'],
};
export const draftFields: Data = {
    common: [
        'link_mode',
        'flow_pin',
        'reset_pin',
        'mode',
        'band',
        'baud',
        'tcp_port',
        'log_enabled',
        'log_port',
        'net_role',
        'auto_reconnect',
        'remote_ip',
        'remote_port',
        'local_port',
        'reconnect_ms',
        'connect_timeout_ms',
        'up_kb',
        'down_kb',
    ],
    ap: ['ap_ssid', 'ap_channel', 'ap_ip', 'ap_gateway', 'ap_netmask'],
    pc: ['ssid', 'static_ip', 'ip', 'gateway', 'netmask', 'dns'],
    shared: ['ssid', 'static_ip', 'ip', 'gateway', 'netmask', 'dns'],
};
const choices: Data = {
    device: ['esp01s', 'c5', 's3'],
    mode: ['tcp-client', 'tcp-server', 'udp'],
    bytesize: ['5', '6', '7', '8'],
    parity: ['N', 'E', 'O', 'M', 'S'],
    stopbits: ['1', '1.5', '2'],
    flow: ['none', 'rtscts', 'dsrdtr'],
    config_transport: ['usb', 'http'],
};
export const object = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v);
export function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
export function settingsPatch(input: unknown): Data {
    assert(object(input), '设置必须为对象');
    const out: Data = {};
    for (const [key, value] of Object.entries(input)) {
        assert(Object.hasOwn(defaults, key), '未知设置字段');
        assert(
            typeof value === typeof defaults[key] &&
                (typeof value !== 'string' || (value.length <= 4096 && !value.includes('\0'))),
            '设置包含无效字段或类型',
        );
        if (choices[key]) assert(choices[key].includes(value), '设置选项无效');
        out[key] = value;
    }
    return out;
}
export function runtimeSettings(input: Data): Data {
    const out = { ...input };
    settingsPatch(input);
    for (const [key, low, high] of [
        ['port', 1, 65535],
        ['peer_port', 1, 65535],
        ['control_port', 1, 65535],
        ['baud', 1, 5000000],
        ['usb_baud', 1, 5000000],
        ['udp_payload', 1, 65507],
        ['bufsize', 256, 1048576],
        ['keepalive_count', 1, 1000],
    ] as const) {
        assert(
            /^\d+$/.test(input[key]) &&
                Number.isSafeInteger(Number(input[key])) &&
                Number(input[key]) >= low &&
                Number(input[key]) <= high,
            `${key} 范围为 ${low}～${high}`,
        );
        out[key] = Number(input[key]);
    }
    for (const key of [
        'timeout',
        'write_timeout',
        'reconnect',
        'connect_timeout',
        'keepalive_idle',
        'keepalive_interval',
        'stats_interval',
    ]) {
        const value = Number(input[key]);
        assert(
            String(input[key]).trim() !== '' &&
                Number.isFinite(value) &&
                value >= 0 &&
                value <= 86400 &&
                (['timeout', 'reconnect', 'keepalive_idle'].includes(key) || value > 0),
            `${key} 超时参数无效`,
        );
        out[key] = value;
    }
    assert(isIP(out.listen) === 4, '监听地址必须为 IPv4');
    assert(out.com.trim(), '请选择业务 COM');
    assert(out.mode === 'tcp-server' || out.host.trim(), 'TCP 客户端和 UDP 需要目标地址');
    if (out.device !== 'esp01s' || out.mode !== 'tcp-client') out.no_reset_ui = true;
    assert(out.no_reset_ui || out.port !== out.control_port, '复位端口与业务端口冲突');
    return out;
}
export function defaultConfig(device: Device): Data {
    const station = {
        ssid: '',
        static_ip: false,
        ip: '192.168.137.200',
        gateway: '192.168.137.1',
        netmask: '255.255.255.0',
        dns: '192.168.137.1',
    };
    return {
        link_mode: 0,
        mode: 0,
        band: 0,
        baud: 1152000,
        tcp_port: 8080,
        ap_channel: 1,
        ap_ssid: `ESP32-${device.toUpperCase()}-Bridge`,
        ap_ip: '192.168.4.1',
        ap_gateway: '192.168.4.1',
        ap_netmask: '255.255.255.0',
        net_role: 0,
        auto_reconnect: true,
        remote_ip: '192.168.137.1',
        remote_port: 8080,
        local_port: 6060,
        reconnect_ms: 1000,
        connect_timeout_ms: 10000,
        up_kb: 4096,
        down_kb: 1024,
        ...(device !== 'esp01s' ? { reset_pin: 0 } : {}),
        ...(device === 'c5' ? { flow_pin: 1 } : {}),
        pc: { ...station },
        shared: { ...station },
    };
}
export function toDraft(config: Data): Data {
    const out: Data = {};
    for (const [group, keys] of Object.entries(draftFields)) {
        out[group] = {};
        for (const key of keys as string[]) {
            const source = ['pc', 'shared'].includes(group) ? config[group] : config;
            if (source && Object.hasOwn(source, key)) out[group][key] = source[key];
        }
    }
    return out;
}
export function fromDraft(draft: Data, device: Device): Data {
    const out = defaultConfig(device);
    for (const [group, keys] of Object.entries(draftFields))
        for (const key of keys as string[]) {
            const value = draft?.[group]?.[key];
            if (value === undefined) continue;
            const target = ['pc', 'shared'].includes(group) ? out[group] : out;
            target[key] = (key === 'log_port' || typeof target[key] === 'number') && /^\d+$/.test(value) ? Number(value) : value;
        }
    if (device === 'c5' && [1, 2].includes(out.link_mode)) out.link_mode = -1;
    return out;
}
// Reject duplicate keys just as the Python protocol parser does.
export function parseJSON(text: string): any {
    const stack: (Set<string> | null)[] = [];
    let expectingKey = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            const start = i++;
            for (; i < text.length; i++) {
                if (text[i] === '\\') i++;
                else if (text[i] === '"') break;
            }
            if (expectingKey && stack.at(-1)) {
                const key = JSON.parse(text.slice(start, i + 1));
                const seen = stack.at(-1)!;
                assert(!seen.has(key), 'JSON 含重复字段');
                seen.add(key);
            }
            expectingKey = false;
        } else if (c === '{') {
            stack.push(new Set());
            expectingKey = true;
        } else if (c === '[') {
            stack.push(null);
            expectingKey = false;
        } else if (c === '}' || c === ']') {
            stack.pop();
            expectingKey = false;
        } else if (c === ',') {
            expectingKey = stack.at(-1) !== null;
        } else if (c === ':') {
            expectingKey = false;
        }
    }
    const value = JSON.parse(text);
    const check = (v: any) => {
        if (object(v)) {
            for (const k of Object.keys(v)) {
                assert(!['__proto__', 'constructor', 'prototype'].includes(k), '不允许的 JSON 字段');
                check(v[k]);
            }
        } else if (Array.isArray(v)) v.forEach(check);
    };
    check(value);
    return value;
}
