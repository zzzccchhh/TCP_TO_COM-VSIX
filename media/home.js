(() => {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const fields = [...document.querySelectorAll('[data-setting]')];
    let state,
        network,
        busy = false,
        sequence = 0,
        baseRevision,
        qrPending = false;
    const dirty = new Set(),
        pending = new Map();
    const savedState = vscode.getState?.() || {};
    function saveState(patch) {
        Object.assign(savedState, patch);
        vscode.setState?.(savedState);
    }
    const panels = initPanels();
    const config = window.createHomeConfig({
        request,
        notice,
        vscode,
        savedState,
        saveState,
        expandPanel: panels.expand,
        current: () => state,
        settings: () => Object.fromEntries(fields.map((f) => [f.dataset.setting, f.value])),
        patch,
        revision: () => (dirty.size ? baseRevision : state?.revision),
        locked: () => busy || state?.snapshot.busy || state?.snapshot.config_busy,
    });
    function initPanels() {
        const entries = new Map();
        const collapsed = {};
        function set(key, value, persist = true) {
            const panel = entries.get(key);
            if (!panel) return;
            if (value) {
                window.HomePickers.close();
                if (panel.body.contains(document.activeElement)) panel.toggle.focus();
            }
            panel.body.hidden = value;
            panel.section.dataset.collapsed = String(value);
            panel.toggle.setAttribute('aria-expanded', String(!value));
            collapsed[key] = value;
            if (persist) saveState({ collapsedPanels: { ...collapsed } });
        }
        for (const section of document.querySelectorAll('[data-panel]')) {
            const key = section.dataset.panel;
            const toggle = section.querySelector('[data-panel-toggle]');
            const body = document.getElementById(toggle.getAttribute('aria-controls'));
            entries.set(key, { section, toggle, body });
            set(key, savedState.collapsedPanels?.[key] === true, false);
            toggle.addEventListener('click', () => set(key, !body.hidden));
        }
        return { expand: (key) => set(key, false) };
    }
    function notice(text, error = false) {
        $('notice').textContent = text;
        $('notice').classList.toggle('error', error);
    }
    function request(action, extra = {}, silent = false) {
        const id = String(++sequence);
        if (!silent) {
            busy = true;
            notice('正在处理…');
            render();
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                if (!silent) {
                    busy = false;
                    render();
                    notice('操作响应超时，请先核对状态，勿重复保存设备配置', true);
                }
                reject(Error('操作响应超时'));
            }, 45000);
            pending.set(id, { resolve, reject, timer, silent });
            vscode.postMessage({ id, action, ...extra });
        });
    }
    function render() {
        if (!state) return;
        const s = state.snapshot;
        const locked = busy || s.busy || s.config_busy;
        $('backend-state').textContent = state.backend ? '运行中' : '已停止';
        $('backend-state').classList.toggle('active', state.backend);
        $('bridge-state').textContent = s.running
            ? s.connected
                ? '已连接'
                : s.running_settings?.mode === 'udp'
                  ? 'UDP 已绑定'
                  : '运行中 · 等待连接'
            : '已停止';
        $('bridge-state').classList.toggle('active', s.running);
        $('usb-state').textContent = s.usb ? (s.usb.connected ? '已连接' : '连接中') : '未连接';
        $('usb-state').classList.toggle('active', !!s.usb?.connected);
        $('netlog-state').textContent = s.net_log?.connected ? '已连接' : s.net_log ? '重试中' : '未连接';
        $('netlog-state').classList.toggle('active', !!s.net_log?.connected);
        $('netlog-detail').textContent = s.net_log ? `${s.net_log.host}:${s.net_log.port} · ${s.net_log.message} · 丢弃 ${s.net_log.dropped} 条` : '无需选择业务 COM；与 USB 同时可用。';
        $('listen-address').textContent = `${state.listen}:${state.port}`;
        $('bridge-address').textContent = s.address;
        for (const f of fields) {
            if (!dirty.has(f.dataset.setting) && document.activeElement !== f)
                f.value = state.settings[f.dataset.setting] ?? '';
            f.disabled = locked;
        }
        for (const b of document.querySelectorAll('button:not([data-panel-toggle])')) b.disabled = locked;
        if (!locked) {
            $('backend-start').disabled = state.backend;
            $('backend-stop').disabled = !state.backend && !s.running && !s.usb && !s.net_log;
            $('bridge-start').disabled = s.running;
            $('bridge-stop').disabled = !s.running;
            $('bridge-restart').disabled = !s.running;
            $('usb-connect').disabled =
                !!s.usb || document.querySelector('[data-setting=device]').value === 'esp01s';
            $('usb-disconnect').disabled = !s.usb;
            $('net-connect').disabled = !!s.net_log;
            $('net-disconnect').disabled = !s.net_log;
            $('net-use-port').disabled = !s.baseline?.log_port;
            $('save-settings').disabled = !dirty.size;
            $('sync-settings').disabled = !dirty.size;
        }
        $('adapter-select').disabled = locked || !network;
        $('peer-field').hidden = document.querySelector('[data-setting=mode]').value !== 'udp';
        $('dirty-state').textContent = dirty.size ? '有未保存参数' : '';
        window.HomePickers.refresh();
        config.render();
        renderQR();
    }
    function renderQR() {
        const image = $('share-qrcode'),
            message = $('qr-message');
        const qr = network?.qr;
        const current =
            state?.backend && network?.running && network.share_id === state.share_id && !qrPending;
        const source = current && qr?.image && /^data:image\/png;base64,/.test(qr.image) ? qr.image : '';
        if (source) {
            if (image.getAttribute('src') !== source) image.src = source;
            image.hidden = false;
            message.textContent = qr.message;
        } else {
            image.hidden = true;
            image.removeAttribute('src');
            message.textContent = !state?.backend
                ? '开启后端后自动显示连接二维码'
                : qrPending || !current
                  ? '正在更新连接二维码…'
                  : qr?.message || '请选择可用的局域网网卡';
        }
    }
    function renderNetwork() {
        if (!network) return;
        const select = $('adapter-select');
        select.replaceChildren();
        $('adapter-list').replaceChildren();
        for (const [index, row] of network.addresses.entries()) {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = row.name;
            option.dataset.detail = `${row.ip}${row.id === 'loopback' ? ' · 仅限本机访问' : ''}`;
            option.dataset.ip = row.ip;
            option.selected = network.selected?.id === row.id && network.selected?.ip === row.ip;
            if (row.shareable) select.append(option);
            const item = document.createElement('li'),
                title = document.createElement('strong'),
                detail = document.createElement('span');
            title.textContent = row.name;
            detail.textContent = `${row.ip || '无地址'} · ${row.kind || '网络接口'} · ${row.reason || '可分享'}`;
            item.append(title, detail);
            $('adapter-list').append(item);
        }
        if (!select.options.length) {
            const option = new Option('暂无可用网卡', '', true, true);
            option.disabled = true;
            select.prepend(option);
        }
        $('adapter-count').textContent = `全部网卡与地址（${network.addresses.length} 条）`;
        $('network-warning').textContent = network.warning || '';
        $('share-address').textContent = network.address || '请选择可用网卡或调整监听设置';
        render();
    }
    function patch() {
        return Object.fromEntries(
            fields.filter((f) => dirty.has(f.dataset.setting)).map((f) => [f.dataset.setting, f.value]),
        );
    }
    async function act(action, extra = {}) {
        try {
            await request(action, extra);
            notice('操作已完成');
        } catch (error) {
            notice(error.message, true);
        }
    }
    for (const f of fields)
        f.addEventListener('input', () => {
            if (!dirty.size) baseRevision = state?.revision;
            dirty.add(f.dataset.setting);
            config.contextChanged();
            render();
        });
    for (const b of document.querySelectorAll('button[data-action], button[data-control]'))
        b.addEventListener('click', () => {
            if (b.dataset.control) {
                const operation = b.dataset.control;
                const apply = !['bridge-stop', 'usb-disconnect', 'net-disconnect'].includes(operation);
                void act('control', {
                    operation,
                    patch: apply ? patch() : {},
                    revision: dirty.size && apply ? baseRevision : state?.revision,
                });
            } else if (b.dataset.action === 'sync') {
                dirty.clear();
                void act('refresh');
            } else if (b.dataset.action === 'network') {
                void act('network', { force: true });
            } else {
                void act(b.dataset.action).then(() => {
                    if (['backend-start', 'backend-stop', 'listener'].includes(b.dataset.action))
                        void request('network', {}, true).catch(() => {});
                });
            }
        });
    $('net-use-port').addEventListener('click', () => {
        if (!state?.snapshot.baseline?.log_port) return;
        const input = fields.find((f) => f.dataset.setting === 'net_log_port');
        input.value = String(state.snapshot.baseline.log_port);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        notice('已填写设备日志端口，点击连接网络日志生效。');
    });
    $('adapter-select').addEventListener('change' , () => {
        const row = network?.addresses[Number($('adapter-select').value)];
        if (row?.shareable) {
            qrPending = true;
            renderQR();
            void act('choose', { adapter: row.id, ip: row.ip })
                .then(() => request('network', {}, true))
                .catch(() => {});
        }
    });
    window.addEventListener('message', (event) => {
        const m = event.data;
        if (m.kind === 'state') {
            const changed = state && (state.share_id !== m.data.share_id || state.backend !== m.data.backend);
            state = m.data;
            config.stateChanged();
            if (changed) {
                qrPending = true;
                void request('network', {}, true).catch(() => {});
            }
            if (
                dirty.size &&
                fields
                    .filter((f) => dirty.has(f.dataset.setting))
                    .every((f) => f.value === String(state.settings[f.dataset.setting] ?? ''))
            ) {
                dirty.clear();
                baseRevision = state.revision;
            }
            render();
        } else if (m.kind === 'network') {
            network = m.data;
            qrPending = false;
            renderNetwork();
        } else if (m.kind === 'ports') {
            $('ports').replaceChildren(
                ...m.data.map((p) => {
                    const o = document.createElement('option');
                    o.value = p.device;
                    o.label = p.description;
                    return o;
                }),
            );
        } else if (m.kind === 'error') notice(m.error, true);
        else if (m.kind === 'result') {
            const p = pending.get(m.id);
            if (!p) return;
            clearTimeout(p.timer);
            pending.delete(m.id);
            if (!p.silent) {
                busy = false;
                render();
            }
            m.error ? p.reject(Error(m.error)) : p.resolve(m.data);
        }
    });
    window.HomePickers.init();
    void request('ready', {}, true)
        .then(() => Promise.all([request('network', {}, true), request('ports', {}, true)]))
        .catch((e) => notice(e.message, true));
    setInterval(() => {
        if (!document.hidden) void request('network', {}, true).catch(() => {});
    }, 15000);
})();
