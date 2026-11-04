/* Device drafts belong to this page. Passwords and read receipts never enter persisted state. */
window.createHomeConfig = (host) => {
    const $ = (id) => document.getElementById(id);
    const clone = (value) => structuredClone(value);
    const optional = new Set(
        'flow_pin reset_pin net_role auto_reconnect remote_ip remote_port local_port reconnect_ms connect_timeout_ms up_kb down_kb'.split(
            ' ',
        ),
    );
    const titles = {};
    const definitions = {
        common: [
            ['link_mode', 'MCU 接口', []],
            ['baud', '设备 UART 波特率', 'number'],
            ['flow_pin', 'GPIO 流控引脚', []],
            ['reset_pin', '复位引脚', []],
            [
                'mode',
                '设备 Wi-Fi 模式',
                [
                    [0, 'AP 热点'],
                    [1, '电脑 STA'],
                    [2, '共享 STA'],
                ],
            ],
            ['band', 'Wi-Fi 频段', []],
            ['tcp_port', '设备 TCP 服务端端口', 'number'],
            [
                'net_role',
                '设备网络角色',
                [
                    [0, 'TCP 服务端'],
                    [1, 'TCP 客户端'],
                    [2, 'UDP'],
                ],
            ],
            ['auto_reconnect', '自动重连', 'boolean'],
            ['remote_ip', '设备对端 IPv4', 'text'],
            ['remote_port', '设备对端端口', 'number'],
            ['local_port', '设备 UDP 本地端口', 'number'],
            ['reconnect_ms', '重连间隔（毫秒）', 'number'],
            ['connect_timeout_ms', '连接超时（毫秒）', 'number'],
            ['up_kb', '上行缓冲（KB）', 'number'],
            ['down_kb', '下行缓冲（KB）', 'number'],
        ],
        ap: [
            ['ap_ssid', 'AP 名称', 'text'],
            ['ap_channel', 'AP 信道', 'number'],
            ['ap_ip', 'AP IPv4', 'text'],
            ['ap_gateway', 'AP 网关', 'text'],
            ['ap_netmask', 'AP 子网掩码', 'text'],
        ],
    };
    for (const group of ['pc', 'shared'])
        definitions[group] = [
            ['ssid', 'Wi-Fi 名称', 'text'],
            ['static_ip', '使用静态 IPv4', 'boolean'],
            ['ip', '静态 IPv4', 'text'],
            ['gateway', '网关', 'text'],
            ['netmask', '子网掩码', 'text'],
            ['dns', 'DNS', 'text'],
        ];
    const inputs = [];
    for (const [group, defs] of Object.entries(definitions)) {
        const panel = document.createElement('div');
        panel.className = 'fields';
        panel.id = 'config-group-' + group;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute(
            'aria-label',
            { common: '接口与网络', ap: 'AP 热点', pc: '电脑 STA', shared: '共享 STA' }[group],
        );
        for (const [key, title, type] of defs) {
            const path = ['pc', 'shared'].includes(group) ? `${group}.${key}` : key;
            titles[path] = title;
            const label = document.createElement('label');
            label.textContent = title;
            const field = document.createElement(Array.isArray(type) ? 'select' : 'input');
            field.dataset.config = path;
            field.id = 'cfg-' + path.replace('.', '-');
            if (Array.isArray(type))
                for (const [value, text] of type) field.add(new Option(text, String(value)));
            else if (type === 'boolean') {
                field.type = 'checkbox';
                label.classList.add('config-check');
            } else {
                field.type = 'text';
                field.spellcheck = false;
                if (type === 'number') field.inputMode = 'numeric';
            }
            field.setAttribute('aria-label', title);
            label.append(field);
            panel.append(label);
            inputs.push({ field, label, path, key, group, type });
        }
        if (group !== 'common') {
            const label = document.createElement('label');
            label.textContent = '新密码';
            const password = document.createElement('input');
            password.type = 'password';
            password.id = `cfg-password-${group}`;
            password.autocomplete = 'new-password';
            password.placeholder = '留空保留原密码';
            label.append(password);
            panel.append(label);
            if (group !== 'ap') {
                const row = document.createElement('label');
                row.className = 'config-check';
                row.textContent = '明确清空此 STA 密码';
                const clear = document.createElement('input');
                clear.type = 'checkbox';
                clear.id = 'cfg-clear-' + group;
                row.prepend(clear);
                panel.append(row);
            }
        }
        $('config-groups').append(panel);
    }
    let device,
        context,
        model,
        baseline,
        readEpoch = null,
        selectedGroup = 'common',
        confirmation,
        working = false;
    const drafts = host.savedState.deviceDrafts || {};
    function secrets() {
        for (const group of ['ap', 'pc', 'shared']) {
            $(`cfg-password-${group}`).value = '';
            if (group !== 'ap') $(`cfg-clear-${group}`).checked = false;
        }
    }
    function invalidate() {
        readEpoch = null;
        baseline = null;
        confirmation = undefined;
        secrets();
    }
    function keepDraft() {
        if (!model || !device) return;
        drafts[device] = clone(model);
        host.saveState({ deviceDrafts: drafts });
    }
    function options(path, values) {
        const field = inputs.find((i) => i.path === path).field;
        field.replaceChildren(...values.map(([value, text]) => new Option(text, String(value))));
    }
    function contextChanged() {
        const settings = host.settings();
        const next = JSON.stringify(
            ['device', 'config_transport', 'config_url', 'usb_port', 'usb_baud'].map((k) => settings[k]),
        );
        if (context !== next) {
            context = next;
            invalidate();
        }
        if (device !== settings.device && settings.device) {
            device = settings.device;
            const defaults = host.current()?.device_config_defaults;
            // An unsaved device switch has no matching host defaults yet; wait until applied/read.
            model = clone(drafts[device] || (host.current()?.settings.device === device ? defaults : null));
            options(
                'link_mode',
                device === 'c5'
                    ? [
                          [-1, '请选择接口'],
                          [0, 'UART 原始透传'],
                          [3, 'UART GPIO 流控透传'],
                          [4, 'SPI传输'],
                      ]
                    : [
                          [0, 'UART 原始透传'],
                          [1, 'SPI WBR/1'],
                          [2, 'UART WBR/1'],
                      ],
            );
            options(
                'band',
                device === 'c5'
                    ? [
                          [0, '2.4 GHz'],
                          [1, '5 GHz'],
                          [2, '双频自动'],
                      ]
                    : [[0, '2.4 GHz']],
            );
            options('flow_pin', [
                [0, '未设置'],
                [1, 'GPIO23'],
                [2, 'GPIO10'],
                [3, 'GPIO9'],
                [4, 'GPIO5'],
            ]);
            options('reset_pin', [
                [0, '关闭'],
                [1, device === 'c5' ? 'GPIO23' : 'GPIO18'],
                [2, 'GPIO10'],
                [3, 'GPIO9'],
                [4, 'GPIO5'],
            ]);
            secrets();
        }
        if (!model && host.current()?.settings.device === device)
            model = clone(host.current().device_config_defaults);
    }
    function render() {
        const state = host.current();
        if (!state) return;
        contextChanged();
        const settings = host.settings(),
            supported = device !== 'esp01s';
        const locked = !!host.locked() || working;
        const readable = supported && !locked;
        $('config-device').textContent = { c5: 'ESP32-C5', s3: 'ESP32-S3', esp01s: 'ESP-01S' }[device] || '';
        $('config-editor').hidden = !supported;
        $('config-read-actions').hidden = !supported;
        $('config-usb').hidden = !supported || settings.config_transport !== 'usb';
        $('config-http').hidden = !supported || settings.config_transport !== 'http';
        $('config-usb-status').textContent =
            `USB：${settings.usb_port || '尚未选择串口'} · ${state.snapshot.usb?.connected ? '已连接' : '未连接'}`;
        $('config-status').textContent = !supported
            ? 'ESP-01S 不支持设备配置接口。'
            : readEpoch !== null
              ? '已在本页读取；修改后需确认保存。'
              : state.snapshot.config_status || '请在本页读取当前设备后保存；切换连接需重新读取。';
        for (const i of inputs) {
            const source = ['pc', 'shared'].includes(i.group) ? model?.[i.group] : model;
            const value = source?.[i.key];
            if (i.type === 'boolean') i.field.checked = !!value;
            else if (document.activeElement !== i.field) i.field.value = value ?? '';
            const spi = device === 'c5' ? Number(model?.link_mode) === 4 : Number(model?.link_mode) === 1;
            i.label.hidden =
                (baseline && optional.has(i.path) && !(i.path in baseline)) ||
                (i.path === 'flow_pin' && (device !== 'c5' || Number(model?.link_mode) !== 3)) ||
                (['baud', 'reset_pin'].includes(i.path) && spi) ||
                (['pc', 'shared'].includes(i.group) &&
                    ['ip', 'gateway', 'netmask', 'dns'].includes(i.key) &&
                    !source?.static_ip);
            i.field.disabled = locked || !model || i.label.hidden;
        }
        for (const tab of document.querySelectorAll('[data-group]')) {
            tab.disabled = locked;
            tab.setAttribute('aria-selected', String(tab.dataset.group === selectedGroup));
            tab.tabIndex = tab.dataset.group === selectedGroup ? 0 : -1;
            $('config-group-' + tab.dataset.group).hidden = tab.dataset.group !== selectedGroup;
        }
        for (const group of ['ap', 'pc', 'shared']) {
            const clear = $(`cfg-clear-${group}`);
            if (clear) clear.disabled = locked;
            $(`cfg-password-${group}`).disabled = locked || !!clear?.checked;
        }
        for (const id of ['read', 'import']) $('config-' + id).disabled = !readable;
        $('config-undo').disabled = locked || !baseline;
        $('config-restore').disabled = locked || !drafts[device];
        $('config-export').disabled = locked || !model;
        $('config-preview').disabled = locked || readEpoch === null;
        $('config-usb-connect').disabled = locked || !!state.snapshot.usb || !supported;
        $('config-usb-disconnect').disabled = locked || !state.snapshot.usb;
        $('config-usb-settings').disabled = locked;
        $('config-confirmation').hidden = !confirmation;
        $('config-confirm').disabled = locked || !confirmation || confirmation.revision !== state.revision;
        $('config-cancel').disabled = locked;
        window.HomePickers.refresh();
    }
    async function call(operation, args = [], extra = {}) {
        return host.request('config', { operation, args, revision: host.current()?.revision, ...extra });
    }
    async function run(fn) {
        working = true;
        render();
        try {
            await fn();
        } catch (error) {
            host.notice(error.message, true);
        } finally {
            working = false;
            render();
        }
    }
    function replace(value) {
        model = clone(value);
        confirmation = undefined;
        secrets();
        render();
    }
    for (const i of inputs)
        i.field.addEventListener('input', () => {
            if (!model) return;
            const target = ['pc', 'shared'].includes(i.group) ? model[i.group] : model;
            target[i.key] =
                i.type === 'boolean'
                    ? i.field.checked
                    : (i.type === 'number' || Array.isArray(i.type)) && /^\d+$/.test(i.field.value)
                      ? Number(i.field.value)
                      : i.field.value;
            confirmation = undefined;
            keepDraft();
            render();
        });
    for (const group of ['ap', 'pc', 'shared'])
        for (const field of [$(`cfg-password-${group}`), $(`cfg-clear-${group}`)].filter(Boolean))
            field.addEventListener('input', () => {
                confirmation = undefined;
                if ($(`cfg-clear-${group}`)?.checked) $(`cfg-password-${group}`).value = '';
                render();
            });
    const tabs = [...document.querySelectorAll('[data-group]')];
    for (const tab of tabs) {
        tab.addEventListener('click', () => {
            selectedGroup = tab.dataset.group;
            render();
        });
        tab.addEventListener('keydown', (e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const index =
                    e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? tabs.length - 1
                          : (tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
                            tabs.length;
                selectedGroup = tabs[index].dataset.group;
                render();
                tabs[index].focus();
            }
        });
    }
    $('config-read').onclick = () =>
        run(async () => {
            const reply = await call('read_device', [], { patch: host.patch(), revision: host.revision() });
            replace(reply.data);
            baseline = clone(reply.data);
            readEpoch = reply.epoch;
            host.notice('已读取当前设备配置；可以修改并预览保存。');
        });
    $('config-preview').onclick = () =>
        run(async () => {
            const edited = clone(model),
                passwords = {},
                clear = [];
            for (const group of ['ap', 'pc', 'shared']) {
                passwords[group] = $(`cfg-password-${group}`).value;
                if ($(`cfg-clear-${group}`)?.checked) clear.push(group);
            }
            const reply = await call('preview_save', [edited, passwords, clear]);
            if (!reply.data.needed) {
                host.notice('没有需要保存的设备修改。');
                return;
            }
            confirmation = { edited, passwords, clear, epoch: reply.data.epoch, revision: reply.revision };
            $('config-changes').replaceChildren(
                ...reply.data.changes.map((change) => {
                    const li = document.createElement('li');
                    li.textContent = `${titles[change.field] || change.field}：${change.value}`;
                    return li;
                }),
            );
            if (!reply.data.changes.length) $('config-changes').textContent = '提交设备待保存的配置并重启';
            host.notice('请核对修改，再确认保存。');
        });
    $('config-confirm').onclick = () =>
        run(async () => {
            const c = confirmation;
            if (!c) return;
            confirmation = undefined;
            try {
                const reply = await call('save_device', [c.edited, c.passwords, c.clear, c.epoch], {
                    revision: c.revision,
                });
                host.notice(
                    reply.data.saved ? '设备已确认保存并请求重启；请重新读取核对。' : '没有需要保存的修改。',
                );
            } finally {
                invalidate();
            }
        });
    $('config-cancel').onclick = () => {
        confirmation = undefined;
        render();
    };
    $('config-undo').onclick = () => {
        if (baseline) replace(baseline);
        host.notice('已撤销本页修改。');
    };
    $('config-restore').onclick = () => {
        if (drafts[device]) replace(drafts[device]);
        host.notice('已恢复本页草稿；保存仍需本页有效读取。');
    };
    $('config-import').onclick = () =>
        run(async () => {
            const reply = await call('import_config');
            if (reply) {
                replace(reply.data);
                keepDraft();
                host.notice('备份已载入表单，尚未写入设备。');
            }
        });
    $('config-export').onclick = () =>
        run(async () => {
            await call('backup_config', [clone(model)]);
            host.notice('已处理不含密码的设备备份。');
        });
    for (const action of ['connect', 'disconnect'])
        $('config-usb-' + action).onclick = () =>
            run(async () => {
                await host.request('control', {
                    operation: 'usb-' + action,
                    patch: action === 'connect' ? host.patch() : {},
                    revision: action === 'connect' ? host.revision() : host.current()?.revision,
                });
                host.notice(action === 'connect' ? 'USB 已连接，请读取设备。' : 'USB 已断开。');
            });
    $('config-usb-settings').onclick = () => {
        host.expandPanel('usb');
        $('usb-settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.querySelector('[data-setting=usb_port]').focus();
    };
    return {
        render,
        contextChanged,
        stateChanged() {
            const state = host.current();
            if (readEpoch !== null && state.snapshot.epoch !== readEpoch) invalidate();
            if (confirmation && confirmation.revision !== state.revision) {
                confirmation = undefined;
                host.notice('其他操作更新了状态，请重新预览保存。');
            }
        },
    };
};
