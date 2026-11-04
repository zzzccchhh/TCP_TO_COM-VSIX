import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    Data,
    defaults,
    draftFields,
    formFields,
    object,
    settingsPatch,
    parseJSON,
} from '../../shared/model';
export async function atomicJSON(path: string, data: unknown) {
    await mkdir(dirname(path), { recursive: true });
    const temp = path + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
}
export function cleanState(doc: any): Data {
    if (!object(doc) || doc.version !== 1) throw new Error('上次设置的版本或格式不支持');
    const settings: Data = {};
    for (const [group, keys] of Object.entries(formFields))
        for (const key of keys as string[])
            if (Object.hasOwn(doc.forms?.[group] ?? {}, key)) settings[key] = doc.forms[group][key];
    for (const key of ['config_transport', 'config_url']) if (key in doc) settings[key] = doc[key];
    settingsPatch(settings);
    const drafts: Data = {};
    for (const device of ['c5', 's3'])
        if (object(doc.device_drafts?.[device])) {
            drafts[device] = {};
            for (const [group, keys] of Object.entries(draftFields)) {
                drafts[device][group] = {};
                for (const key of keys as string[]) {
                    const value = doc.device_drafts[device]?.[group]?.[key];
                    if (
                        ['string', 'number', 'boolean'].includes(typeof value) &&
                        String(value).length <= 4096
                    )
                        drafts[device][group][key] = value;
                }
            }
        }
    return { settings: { ...defaults, ...settings }, drafts };
}
export function stateDocument(settings: Data, drafts: Data) {
    const forms: Data = {};
    for (const [group, keys] of Object.entries(formFields))
        forms[group] = Object.fromEntries((keys as string[]).map((key) => [key, settings[key]]));
    return {
        version: 1,
        forms,
        config_transport: settings.config_transport,
        config_url: settings.config_url,
        device_drafts: drafts,
    };
}
export class Store {
    constructor(readonly directory: string) {}
    async load() {
        try {
            return cleanState(parseJSON(await readFile(join(this.directory, 'state.json'), 'utf8')));
        } catch (error: any) {
            if (error.code === 'ENOENT') return { settings: { ...defaults }, drafts: {}, warning: '' };
            return { settings: { ...defaults }, drafts: {}, warning: '无法恢复上次设置，请检查状态文件' };
        }
    }
    save(settings: Data, drafts: Data) {
        return atomicJSON(join(this.directory, 'state.json'), stateDocument(settings, drafts));
    }
}
