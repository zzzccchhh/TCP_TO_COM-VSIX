import { assert, Data, Device, labels, object } from '../../shared/model';
export class OutcomeUnknown extends Error {}
export const top = [
    'link_mode',
    'mode',
    'band',
    'baud',
    'tcp_port',
    'ap_channel',
    'ap_ssid',
    'ap_ip',
    'ap_gateway',
    'ap_netmask',
];
export const network = [
    'net_role',
    'auto_reconnect',
    'remote_ip',
    'remote_port',
    'local_port',
    'reconnect_ms',
    'connect_timeout_ms',
    'up_kb',
    'down_kb',
];
export const station = ['ssid', 'static_ip', 'ip', 'gateway', 'netmask', 'dns'];
const integer = (v: any, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
function text(v: any, label: string, max: number, min = 0) {
    assert(
        typeof v === 'string' &&
            !v.includes('\0') &&
            Buffer.byteLength(v) >= min &&
            Buffer.byteLength(v) <= max,
        `${label} 长度应为 ${min}～${max} 个 UTF-8 字节`,
    );
}
export function ipv4(value: any): number {
    assert(
        typeof value === 'string' &&
            /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value) &&
            value.split('.').every((s: string) => Number(s) <= 255),
        '请输入合法 IPv4 地址',
    );
    return value.split('.').reduce((a: number, s: string) => (a * 256 + Number(s)) >>> 0, 0);
}
function subnet(ip: any, gateway: any, mask: any, ap = false) {
    const a = ipv4(ip),
        g = ipv4(gateway),
        m = ipv4(mask),
        h = ~m >>> 0,
        host = (a & h) >>> 0,
        gh = (g & h) >>> 0;
    assert(m && h >= 3 && (h & (h + 1)) === 0, '子网掩码必须连续，并保留足够主机地址');
    assert(
        ![0, 127].includes(a >>> 24) && a >>> 24 < 224 && host !== 0 && host !== h,
        'IP 不能为网络、广播、回环或组播地址',
    );
    assert((a & m) === (g & m) && gh !== 0 && gh !== h, '网关必须为同子网有效主机地址');
    if (ap) {
        assert(![0, 127].includes(g >>> 24) && g >>> 24 < 224, 'AP 网关无效');
        assert(
            [1, 2, 3, 4, 5].some((x) => x + 1 < h && ![host, gh].includes(x) && ![host, gh].includes(x + 1)),
            'AP 子网需为 DHCP 留出两个连续可用地址',
        );
    } else assert(a !== g, 'STA IP 不能与网关相同');
}
export function validateConfig(c: Data, device: Device) {
    assert(device !== 'esp01s', 'ESP-01S 不支持此配置接口');
    assert((device === 'c5' ? [0, 3, 4] : [0, 1, 2]).includes(c.link_mode), '请选择当前设备支持的业务接口');
    for (const [key, lo, hi] of [
        ['mode', 0, 2],
        ['band', 0, 2],
        ['baud', 9600, 5000000],
        ['tcp_port', 1024, 65535],
        ['ap_channel', 1, 165],
    ] as const)
        assert(integer(c[key], lo, hi), `${key} 必须为 ${lo}～${hi} 的整数`);
    if ('flow_pin' in c)
        assert(device === 'c5' && integer(c.flow_pin, 0, 4), '流控线必须为 0～4，且仅适用于 C5');
    if ('reset_pin' in c) assert(integer(c.reset_pin, 0, 4), '复位线必须为 0～4');
    if (c.link_mode === 3)
        assert(
            device === 'c5' && c.flow_pin && c.flow_pin !== (c.reset_pin ?? 0),
            'GPIO 流控模式需要选择流控线，且不能与复位线相同',
        );
    if (c.reset_pin && c.link_mode !== (device === 'c5' ? 4 : 1))
        assert(
            !((c.net_role ?? 0) === 0 && c.tcp_port === 8081) && !(c.net_role === 1 && c.local_port === 8081),
            '复位控制 TCP 端口 8081 与业务端口冲突',
        );
    for (const [key, lo, hi] of [
        ['net_role', 0, 2],
        ['remote_port', 1, 65535],
        ['local_port', 0, 65535],
        ['reconnect_ms', 100, 60000],
        ['connect_timeout_ms', 100, 60000],
        ['up_kb', 64, 6144],
        ['down_kb', 64, 2048],
    ] as const)
        if (key in c) assert(integer(c[key], lo, hi), `${key} 范围错误`);
    if ('auto_reconnect' in c) assert(typeof c.auto_reconnect === 'boolean', 'auto_reconnect 必须为布尔值');
    if ('remote_ip' in c) {
        const a = ipv4(c.remote_ip);
        assert(![0, 127].includes(a >>> 24) && a >>> 24 < 224, '目标 IP 无效');
    }
    assert((c.up_kb ?? 64) + (c.down_kb ?? 64) <= 6144, '缓冲总容量不得超过 6144 KiB');
    text(c.ap_ssid, 'AP SSID', 32, 1);
    assert(device === 'c5' || c.band === 0, `${labels[device]} 仅支持 2.4 GHz`);
    if ('ap_password' in c) text(c.ap_password, 'AP 密码', 63, 8);
    assert(
        (c.band === 1
            ? [36, 40, 44, 48, 149, 153, 157, 161, 165]
            : Array.from({ length: 13 }, (_, i) => i + 1)
        ).includes(c.ap_channel),
        '信道与频段不匹配',
    );
    subnet(c.ap_ip, c.ap_gateway, c.ap_netmask, true);
    for (const [i, name] of ['pc', 'shared'].entries()) {
        const s = c[name];
        assert(object(s) && typeof s.static_ip === 'boolean', `${name}.static_ip 必须是布尔值`);
        text(s.ssid, `${name} SSID`, 32, Number(c.mode === i + 1));
        if ('password' in s) {
            text(s.password, `${name} 密码`, 63);
            assert(!s.password || Buffer.byteLength(s.password) >= 8, '密码应为空或 8～63 字节');
        }
        for (const key of ['ip', 'gateway', 'netmask', 'dns']) text(s[key], `${name}.${key}`, 15);
        if (s.static_ip) {
            subnet(s.ip, s.gateway, s.netmask);
            ipv4(s.dns);
        }
    }
}
export function publicConfig(input: any, device: Device, draft = false): Data {
    assert(object(input), '配置必须是 JSON 对象');
    let legacy = false;
    if (draft && device === 'c5' && [1, 2].includes(input.link_mode)) {
        legacy = true;
        input = { ...input, link_mode: input.link_mode === 1 ? 4 : 0 };
    }
    const c: Data = {};
    for (const key of top) {
        assert(Object.hasOwn(input, key), '配置缺少必要字段');
        c[key] = structuredClone(input[key]);
    }
    for (const name of ['pc', 'shared']) {
        assert(object(input[name]), '配置缺少站点字段');
        c[name] = {};
        for (const key of station) {
            assert(Object.hasOwn(input[name], key), '配置缺少站点字段');
            c[name][key] = structuredClone(input[name][key]);
        }
    }
    for (const key of [...network, 'reset_pin', ...(device === 'c5' ? ['flow_pin'] : [])])
        if (Object.hasOwn(input, key)) c[key] = structuredClone(input[key]);
    if ('config_api' in input) {
        assert(
            (device === 'c5' ? ['c5-config-2', 'c5-wbr-1'] : ['bridge-1']).includes(input.config_api),
            '设备配置接口与所选型号不匹配',
        );
        assert('revision' in input && network.every((k) => k in input), '新固件缺少修订号或网络字段');
        c.config_api = input.config_api;
    }
    for (const key of ['revision', 'saved_revision'])
        if (key in input) {
            assert(integer(input[key], 0, 0xffffffff), '配置修订号无效');
            c[key] = input[key];
        }
    for (const key of ['unsaved', 'migration_requires_setup'])
        if (key in input) {
            assert(typeof input[key] === 'boolean', '设备配置状态格式不正确');
            c[key] = input[key];
        }
    validateConfig(c, device);
    if (legacy) c.link_mode = -1;
    return c;
}
export function changedConfig(
    baseline: Data,
    edited: Data,
    passwords: Data = {},
    clear: string[] = [],
    device: Device,
): Data {
    assert(
        object(passwords) && Array.isArray(clear) && clear.every((k) => ['ap', 'pc', 'shared'].includes(k)),
        '密码修改格式不正确',
    );
    const base = publicConfig(baseline, device),
        candidate = publicConfig(edited, device);
    for (const name of ['ap', 'pc', 'shared']) {
        let value = passwords[name] ?? '';
        assert(typeof value === 'string', '密码格式不正确');
        if (clear.includes(name)) {
            assert(name !== 'ap' && !value, '只能明确清空 STA 密码');
            value = '';
        } else if (!value) continue;
        if (name === 'ap') candidate.ap_password = value;
        else candidate[name].password = value;
    }
    validateConfig(candidate, device);
    assert(
        !(device === 'c5' && candidate.link_mode === 4 && base.config_api !== 'c5-config-2'),
        'SPI传输需要升级 C5 固件并重新读取',
    );
    assert(
        !(device === 's3' && candidate.link_mode === 0 && base.link_mode !== 0 && !('reset_pin' in base)),
        '请更新 S3 固件并重新读取',
    );
    assert(!(device === 'c5' && 'flow_pin' in candidate && !('flow_pin' in base)), '设备未报告流控配置');
    const patch: Data = {};
    for (const key of [...top, ...network, 'reset_pin', 'flow_pin'])
        if (key in candidate && candidate[key] !== base[key]) patch[key] = candidate[key];
    if (base.migration_requires_setup && device === 'c5' && 'flow_pin' in base) {
        patch.link_mode = candidate.link_mode;
        if (candidate.link_mode === 3) patch.flow_pin = candidate.flow_pin;
    }
    if ('ap_password' in candidate) patch.ap_password = candidate.ap_password;
    for (const name of ['pc', 'shared']) {
        const delta: Data = {};
        for (const [key, value] of Object.entries(candidate[name]))
            if (base[name][key] !== value) delta[key] = value;
        if (Object.keys(delta).length) patch[name] = delta;
    }
    assert(Buffer.byteLength(JSON.stringify(patch)) <= 2048, '修改内容超过固件 2048 字节限制');
    return patch;
}
