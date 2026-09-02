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

function createApp(storage, options = {}) {
    const listeners = {};
    const fetchCalls = [];
    const parentMessages = [];
    const bodyClasses = new Set();
    const elements = {};
    const elementIds = [
        'innTableBody', 'wizardContainer', 'wizardList', 'apiUrl', 'apiKey',
        'startAutoBtn', 'stopAutoBtn', 'autoStatus', 'processedFiles',
        'productionWidget', 'productionStatusText', 'compactModeBtn'
    ];

    for (const id of elementIds) {
        elements[id] = {
            value: '',
            disabled: id === 'stopAutoBtn',
            className: '',
            textContent: id === 'autoStatus' ? 'Авто-режим выключен' : '',
            innerHTML: '',
            style: {},
            dataset: {},
            attributes: {},
            children: [],
            addEventListener(type, callback) {
                this[type] = callback;
            },
            insertAdjacentHTML() {},
            appendChild(child) {
                this.children.push(child);
            },
            setAttribute(name, value) {
                this.attributes[name] = String(value);
            },
            prepend() {}
        };
    }

    const windowObject = {
        location: { search: options.search || '' },
        addEventListener(type, callback) {
            listeners[type] = callback;
        },
        btoa(value) {
            return Buffer.from(value, 'binary').toString('base64');
        }
    };
    windowObject.parent = options.embeddedParent
        ? { postMessage(message) { parentMessages.push(message); } }
        : windowObject;

    const context = {
        console,
        TextEncoder,
        Uint8Array,
        URLSearchParams,
        localStorage: storage,
        cadesplugin: { then() {} },
        alert() {},
        setTimeout() { return 1; },
        clearTimeout() {},
        fetch: async (url, options) => {
            fetchCalls.push({ url, options });
            if (typeof context.__fetchImplementation === 'function') {
                return context.__fetchImplementation(url, options);
            }
            return { ok: true, json: async () => ({ Messages: [] }) };
        },
        document: {
            body: {
                classList: {
                    toggle(name, force) {
                        if (force) bodyClasses.add(name);
                        else bodyClasses.delete(name);
                    },
                    contains(name) {
                        return bodyClasses.has(name);
                    }
                }
            },
            getElementById(id) {
                return elements[id] || null;
            },
            createElement() {
                return { style: {}, textContent: '' };
            }
        },
        window: windowObject
    };

    vm.createContext(context);
    vm.runInContext(`${source}\n
        globalThis.__monitoringState = () => isMonitoring;
        globalThis.__setCoreSign = value => { coreSign = value; };
    `, context);
    context.__fetchImplementation = options.fetchImplementation;

    return {
        context,
        elements,
        fetchCalls,
        parentMessages,
        bodyClasses,
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

test('embedded mode starts compact and expands when the indicator is clicked', () => {
    const storage = createStorage();
    const app = createApp(storage, { search: '?mode=embedded', embeddedParent: true });

    app.load();

    assert.equal(app.bodyClasses.has('production-compact'), true);
    assert.equal(app.elements.productionWidget.attributes['aria-expanded'], 'false');
    assert.deepEqual(JSON.parse(JSON.stringify(app.parentMessages.at(-1))), {
        type: 'signjs:layout',
        compact: true,
        width: 72,
        height: 72
    });

    app.elements.productionWidget.click();

    assert.equal(app.bodyClasses.has('production-compact'), false);
    assert.equal(app.elements.productionWidget.attributes['aria-expanded'], 'true');
    assert.deepEqual(JSON.parse(JSON.stringify(app.parentMessages.at(-1))), {
        type: 'signjs:layout',
        compact: false,
        width: 760,
        height: 900
    });

    app.elements.compactModeBtn.click();
    assert.equal(app.bodyClasses.has('production-compact'), true);
    assert.equal(app.elements.productionWidget.attributes['aria-expanded'], 'false');
});

test('indicator animates while receiving and signing a message', async () => {
    let resolveQueueRequest;
    let resolveDownload;
    let requestNumber = 0;
    const queueRequest = new Promise(resolve => { resolveQueueRequest = resolve; });
    const downloadRequest = new Promise(resolve => { resolveDownload = resolve; });
    const storage = createStorage({
        ymq_gw_url: 'https://gateway.test',
        ymq_api_key: 'key',
        innMap: JSON.stringify({ '1234567890': 'thumbprint' }),
        signjs_cloud_monitoring_enabled: 'true'
    });
    const app = createApp(storage, {
        fetchImplementation: async () => {
            requestNumber += 1;
            if (requestNumber === 1) return queueRequest;
            if (requestNumber === 2) return downloadRequest;
            return { ok: true, status: 200, json: async () => ({}) };
        }
    });
    app.context.__setCoreSign(async () => 'signature');

    app.load();
    assert.equal(app.elements.productionWidget.dataset.status, 'active');
    assert.equal(app.elements.productionWidget.dataset.activity, 'receiving');

    resolveQueueRequest({
        ok: true,
        json: async () => ({
            Messages: [{
                MessageId: 'message-id',
                ReceiptHandle: 'receipt-handle',
                Body: '{}',
                S3Links: {
                    sigKey: 'sign/1234567890_task.txt.sig',
                    downloadUrl: 'https://storage.test/source',
                    uploadUrl: 'https://storage.test/signature'
                }
            }]
        })
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(app.elements.productionWidget.dataset.activity, 'signing');

    resolveDownload({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(app.elements.productionWidget.dataset.status, 'active');
    assert.equal(app.elements.productionWidget.dataset.activity, 'idle');
});

test('processing error keeps the indicator red until the next poll', async () => {
    const storage = createStorage({
        ymq_gw_url: 'https://gateway.test',
        ymq_api_key: 'key',
        signjs_cloud_monitoring_enabled: 'true'
    });
    const app = createApp(storage, {
        fetchImplementation: async () => ({
            ok: true,
            json: async () => ({
                Messages: [{ MessageId: 'broken-message', Body: '{' }]
            })
        })
    });

    app.load();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(app.elements.productionWidget.dataset.status, 'error');
    assert.equal(app.elements.productionWidget.dataset.activity, 'idle');
    assert.equal(app.elements.productionWidget.title, 'Ошибка разбора сообщения');
});
