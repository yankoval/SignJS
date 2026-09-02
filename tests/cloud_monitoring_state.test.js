const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'CloudSignApp.js'), 'utf8');

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
}

function createApp(storage) {
    const listeners = {};
    const fetchCalls = [];
    const elements = {};
    const elementIds = [
        'innTableBody', 'wizardContainer', 'wizardList', 'apiUrl', 'apiKey',
        'startAutoBtn', 'stopAutoBtn', 'autoStatus', 'processedFiles'
    ];

    for (const id of elementIds) {
        elements[id] = {
            value: '',
            disabled: id === 'stopAutoBtn',
            className: '',
            textContent: id === 'autoStatus' ? 'Авто-режим выключен' : '',
            innerHTML: '',
            style: {},
            children: [],
            addEventListener(type, callback) {
                this[type] = callback;
            },
            insertAdjacentHTML() {},
            appendChild(child) {
                this.children.push(child);
            },
            prepend() {}
        };
    }

    const context = {
        console,
        TextEncoder,
        Uint8Array,
        localStorage: storage,
        alert() {},
        setTimeout() { return 1; },
        clearTimeout() {},
        fetch: async (url, options) => {
            fetchCalls.push({ url, options });
            return { ok: true, json: async () => ({ Messages: [] }) };
        },
        document: {
            getElementById(id) {
                return elements[id] || null;
            },
            createElement() {
                return { style: {}, textContent: '' };
            }
        },
        window: {
            addEventListener(type, callback) {
                listeners[type] = callback;
            },
            btoa(value) {
                return Buffer.from(value, 'binary').toString('base64');
            }
        }
    };

    vm.createContext(context);
    vm.runInContext(`${source}\n
        globalThis.__monitoringState = () => isMonitoring;
    `, context);

    return {
        context,
        elements,
        fetchCalls,
        load() {
            listeners.load();
        },
        clickStart() {
            elements.startAutoBtn.click();
        },
        clickStop() {
            elements.stopAutoBtn.click();
        }
    };
}

test('monitoring is off on the first page load', () => {
    const storage = createStorage({
        ymq_gw_url: 'https://gateway.test',
        ymq_api_key: 'key'
    });
    const app = createApp(storage);

    app.load();

    assert.equal(app.context.__monitoringState(), false);
    assert.equal(app.elements.autoStatus.textContent, 'Авто-режим выключен');
    assert.equal(app.fetchCalls.length, 0);
});

test('page reload restores the last user-selected monitoring state', () => {
    const storage = createStorage({
        ymq_gw_url: 'https://gateway.test',
        ymq_api_key: 'key'
    });

    const firstPage = createApp(storage);
    firstPage.load();
    firstPage.clickStart();
    assert.equal(storage.getItem('signjs_cloud_monitoring_enabled'), 'true');

    const reloadedRunningPage = createApp(storage);
    reloadedRunningPage.load();
    assert.equal(reloadedRunningPage.context.__monitoringState(), true);
    assert.equal(reloadedRunningPage.elements.autoStatus.textContent, 'Мониторинг облака активен');
    assert.equal(reloadedRunningPage.fetchCalls.length, 1);

    reloadedRunningPage.clickStop();
    assert.equal(storage.getItem('signjs_cloud_monitoring_enabled'), 'false');

    const reloadedStoppedPage = createApp(storage);
    reloadedStoppedPage.load();
    assert.equal(reloadedStoppedPage.context.__monitoringState(), false);
    assert.equal(reloadedStoppedPage.elements.autoStatus.textContent, 'Авто-режим выключен');
    assert.equal(reloadedStoppedPage.fetchCalls.length, 0);
});

test('missing API configuration does not overwrite the saved user choice', async () => {
    const storage = createStorage({
        signjs_cloud_monitoring_enabled: 'true'
    });
    const app = createApp(storage);

    app.load();
    await Promise.resolve();

    assert.equal(app.context.__monitoringState(), false);
    assert.equal(storage.getItem('signjs_cloud_monitoring_enabled'), 'true');
});
