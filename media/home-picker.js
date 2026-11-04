// Keep the original form values as the data model; draw the trigger and popup with IDE theme tokens.
(() => {
    let serial = 0,
        opened;
    const pickers = [];
    function close(restore = false) {
        if (!opened) return;
        const p = opened;
        opened = undefined;
        p.popup.hidden = true;
        p.control.setAttribute('aria-expanded', 'false');
        p.control.removeAttribute('aria-activedescendant');
        if (restore) p.control.focus();
    }
    class Picker {
        constructor(field) {
            this.field = field;
            this.editable = field.tagName === 'INPUT';
            this.active = -1;
            this.label =
                field.getAttribute('aria-label') ||
                [...field.closest('label').childNodes]
                    .filter((n) => n.nodeType === Node.TEXT_NODE)
                    .map((n) => n.textContent)
                    .join('')
                    .trim();
            const wrapper = document.createElement('span');
            wrapper.className = 'picker';
            field.before(wrapper);
            this.wrapper = wrapper;
            if (this.editable) {
                this.list = document.getElementById(field.getAttribute('list'));
                field.removeAttribute('list');
                wrapper.append(field);
                this.control = field;
                field.classList.add('picker-input');
                field.setAttribute('aria-autocomplete', 'list');
            } else {
                field.hidden = true;
                field.tabIndex = -1;
                field.setAttribute('aria-hidden', 'true');
                wrapper.append(field);
                this.control = document.createElement('button');
                this.control.type = 'button';
                this.control.className = 'picker-trigger';
                this.title = document.createElement('span');
                this.title.className = 'picker-value';
                this.detail = document.createElement('span');
                this.detail.className = 'picker-detail';
                const text = document.createElement('span');
                text.className = 'picker-text';
                text.append(this.title, this.detail);
                this.control.append(text);
                wrapper.append(this.control);
            }
            this.control.setAttribute('role', 'combobox');
            this.control.setAttribute('aria-label', this.label);
            this.control.setAttribute('aria-haspopup', 'listbox');
            this.control.setAttribute('aria-expanded', 'false');
            this.popup = document.createElement('div');
            this.popup.className = 'picker-popup';
            this.popup.id = `picker-list-${++serial}`;
            this.popup.setAttribute('role', 'listbox');
            this.popup.setAttribute('aria-label', `${this.label}选项`);
            this.popup.hidden = true;
            this.control.setAttribute('aria-controls', this.popup.id);
            document.body.append(this.popup);
            const arrow = document.createElement('span');
            arrow.className = 'picker-arrow';
            arrow.setAttribute('aria-hidden', 'true');
            if (this.editable) {
                this.toggle = document.createElement('button');
                this.toggle.type = 'button';
                this.toggle.className = 'picker-toggle';
                this.toggle.setAttribute('aria-label', `选择${this.label}`);
                this.toggle.append(arrow);
                wrapper.append(this.toggle);
                this.toggle.addEventListener('click', (e) => {
                    e.preventDefault();
                    opened === this ? close(true) : this.open(false);
                });
                field.addEventListener('input', () => this.open(true));
            } else {
                this.control.append(arrow);
                this.control.addEventListener('click', (e) => {
                    e.preventDefault();
                    opened === this ? close(true) : this.open(false);
                });
            }
            this.control.addEventListener('keydown', (e) => this.key(e));
            this.popup.addEventListener('pointerdown', (e) => e.preventDefault());
            this.observer = new MutationObserver(() => this.refresh());
            this.observer.observe(field, {
                attributes: true,
                attributeFilter: ['disabled'],
                childList: true,
                subtree: true,
            });
            if (this.list) this.observer.observe(this.list, { childList: true, subtree: true });
            this.refresh();
        }
        options(filtered = false) {
            const source = this.editable ? this.list : this.field;
            const query = filtered ? this.field.value.trim().toLocaleLowerCase() : '';
            return [...(source?.options || [])]
                .filter((o) => !o.disabled && o.value !== '')
                .map((o) => ({
                    value: o.value,
                    title: this.editable ? o.value : o.textContent.trim(),
                    detail: this.editable ? (o.label === o.value ? '' : o.label) : o.dataset.detail || '',
                }))
                .filter((o) => !query || (o.title + ' ' + o.detail).toLocaleLowerCase().includes(query));
        }
        refresh() {
            const rows = this.options();
            const disabled = this.field.disabled || (!this.editable && !rows.length);
            if (this.control.disabled !== disabled) this.control.disabled = disabled;
            if (this.toggle && this.toggle.disabled !== (this.field.disabled || !rows.length))
                this.toggle.disabled = this.field.disabled || !rows.length;
            if (!this.editable) {
                const selected = this.field.selectedOptions[0];
                this.title.textContent = selected?.textContent.trim() || '请选择';
                this.detail.textContent = selected?.dataset.detail || '';
                this.detail.hidden = !this.detail.textContent;
            }
            if (opened === this) {
                if (this.control.disabled) {
                    close();
                    return;
                }
                const next = this.options(this.filtered);
                const signature = JSON.stringify(next);
                if (signature !== this.signature) this.draw(next);
                else this.highlight(this.active, false);
            }
        }
        open(filtered) {
            if (this.field.disabled) return;
            if (opened && opened !== this) close();
            this.filtered = filtered;
            this.control.focus();
            this.control.setAttribute('aria-expanded', 'true');
            this.popup.hidden = false;
            opened = this;
            this.draw(this.options(filtered));
        }
        draw(rows) {
            const wasOpen = opened === this,
                previous = this.rows?.[this.active]?.value;
            this.rows = rows;
            this.signature = JSON.stringify(rows);
            this.popup.replaceChildren();
            rows.forEach((row, index) => {
                const item = document.createElement('div');
                item.className = 'picker-option';
                item.id = `${this.popup.id}-${index}`;
                item.dataset.value = row.value;
                item.setAttribute('role', 'option');
                const title = document.createElement('span');
                title.className = 'picker-option-title';
                title.textContent = row.title;
                item.append(title);
                if (row.detail) {
                    const detail = document.createElement('span');
                    detail.className = 'picker-option-detail';
                    detail.textContent = row.detail;
                    item.append(detail);
                }
                item.addEventListener('pointermove', () => this.highlight(index, false));
                item.addEventListener('click', () => this.commit(index));
                this.popup.append(item);
            });
            if (!rows.length) {
                const empty = document.createElement('div');
                empty.className = 'picker-empty';
                empty.textContent = '没有匹配的选项，可直接输入';
                this.popup.append(empty);
            }
            let index = rows.findIndex(
                (r) => r.value === (wasOpen && previous ? previous : this.field.value),
            );
            if (index < 0) index = this.editable ? -1 : rows.length ? 0 : -1;
            this.position();
            this.highlight(index, true);
        }
        position() {
            const rect = this.wrapper.getBoundingClientRect(),
                gap = 4,
                pad = 8;
            const width = Math.min(Math.max(rect.width, 180), innerWidth - pad * 2);
            const below = innerHeight - rect.bottom - gap - pad,
                above = rect.top - gap - pad,
                up = below < 140 && above > below;
            const height = Math.max(40, Math.min(260, up ? above : below));
            this.popup.style.width = `${width}px`;
            this.popup.style.maxHeight = `${height}px`;
            this.popup.style.left = `${Math.max(pad, Math.min(rect.left, innerWidth - width - pad))}px`;
            this.popup.style.top = up
                ? `${Math.max(pad, rect.top - gap - Math.min(this.popup.scrollHeight, height))}px`
                : `${rect.bottom + gap}px`;
        }
        highlight(index, scroll) {
            this.active = index;
            [...this.popup.querySelectorAll('[role=option]')].forEach((item, i) => {
                item.classList.toggle('active', i === index);
                item.setAttribute('aria-selected', String(this.rows[i].value === this.field.value));
            });
            const item = this.popup.querySelectorAll('[role=option]')[index];
            if (item) {
                this.control.setAttribute('aria-activedescendant', item.id);
                if (scroll) item.scrollIntoView({ block: 'nearest' });
            } else this.control.removeAttribute('aria-activedescendant');
        }
        commit(index) {
            const row = this.rows[index];
            if (!row || this.field.disabled) return;
            this.field.value = row.value;
            // Close before input dispatch: editable input handlers otherwise open a new popup.
            close();
            this.committing = true;
            this.field.dispatchEvent(new Event('input', { bubbles: true }));
            this.field.dispatchEvent(new Event('change', { bubbles: true }));
            this.committing = false;
            close();
            this.refresh();
            this.control.focus();
        }
        key(e) {
            if (e.key === 'Escape') {
                if (opened === this) {
                    e.preventDefault();
                    e.stopPropagation();
                    close(true);
                }
                return;
            }
            if (e.key === 'Tab') {
                close();
                return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (opened !== this) {
                    this.open(false);
                    if (this.editable && this.rows.length)
                        this.highlight(e.key === 'ArrowDown' ? 0 : this.rows.length - 1, true);
                    return;
                }
                if (this.rows.length)
                    this.highlight(
                        (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.rows.length) %
                            this.rows.length,
                        true,
                    );
                return;
            }
            if ((e.key === 'Home' || e.key === 'End') && opened === this && !this.editable) {
                e.preventDefault();
                this.highlight(e.key === 'Home' ? 0 : this.rows.length - 1, true);
                return;
            }
            if (e.key === 'Enter' || (e.key === ' ' && !this.editable)) {
                if (opened === this) {
                    e.preventDefault();
                    this.active >= 0 ? this.commit(this.active) : close(true);
                } else if (!this.editable) {
                    e.preventDefault();
                    this.open(false);
                }
                return;
            }
            if (!this.editable && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                this.open(false);
                const i = this.rows.findIndex((r) =>
                    r.title.toLocaleLowerCase().startsWith(e.key.toLocaleLowerCase()),
                );
                if (i >= 0) this.highlight(i, true);
            }
        }
    }
    window.HomePickers = {
        init() {
            document
                .querySelectorAll('select, input[list]')
                .forEach((field) => pickers.push(new Picker(field)));
        },
        refresh() {
            pickers.forEach((p) => p.refresh());
        },
        close,
    };
    document.addEventListener('pointerdown', (e) => {
        if (opened && !opened.wrapper.contains(e.target) && !opened.popup.contains(e.target)) close();
    });
    document.addEventListener('focusin', (e) => {
        if (opened && !opened.wrapper.contains(e.target) && !opened.popup.contains(e.target)) close();
    });
    document.addEventListener(
        'scroll',
        (e) => {
            if (opened && e.target !== opened.popup && !opened.popup.contains(e.target)) {
                const rect = opened.wrapper.getBoundingClientRect();
                if (rect.bottom <= 0 || rect.top >= innerHeight) close();
                else opened.position();
            }
        },
        true,
    );
    window.addEventListener('resize', () => close());
})();
