const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'CloudSignApp.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'cloud-sign.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const clusters = new WeakMap();

function createCluster() {
    const queued = [];
    const channels = new Set();
    let held = false;
    const cluster = { grants: 0, broadcasts: [] };
    function grantNext() {
        if (held || !queued.length) return;
        const next = queued.shift();
        held = true;
        next.signal.removeEventListener('abort', next.abort);
        cluster.grants++;
        Promise.resolve().then(() => next.callback({ name: 'signjs-cloud-monitor' }))
            .then(next.resolve, next.reject).finally(() => { held = false; grantNext(); });
    }
    cluster.locks = {
        request(name, { signal, mode }, callback) {
            assert.equal(name, 'signjs-cloud-monitor');
            assert.equal(mode, 'exclusive');
            return new Promise((resolve, reject) => {
                const entry = { signal, callback, resolve, reject };
                entry.abort = () => {
                    const index = queued.indexOf(entry);
                    if (index >= 0) queued.splice(index, 1);
                    const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
                };
                if (signal.aborted) { entry.abort(); return; }
                signal.addEventListener('abort', entry.abort, { once: true });
                queued.push(entry);
                grantNext();
            });
        }
    };
    cluster.BroadcastChannel = class {
        constructor(name) { this.name = name; channels.add(this); }
        postMessage(data) {
            const copy = JSON.parse(JSON.stringify(data));
            cluster.broadcasts.push(copy);
            for (const channel of channels) {
                if (channel !== this && channel.name === this.name) {
                    queueMicrotask(() => channel.onmessage?.({ data: copy }));
                }
            }
        }
    };
    return cluster;
}

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
    if (!clusters.has(storage)) clusters.set(storage, createCluster());
    const cluster = clusters.get(storage);
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
        console: { log() {} },
        TextEncoder,
        Uint8Array,
        URLSearchParams,
        localStorage: storage,
        cadesplugin: options.noPlugin ? undefined : {
            then(ready) { if (!options.delayPlugin) queueMicrotask(ready); },
            async CreateObjectAsync() { return { async Open() {}, async Close() {}, Certificates: { Count: 0 } }; }
        },
        navigator: options.noLocks ? {} : { locks: cluster.locks },
        BroadcastChannel: options.noChannel ? undefined : cluster.BroadcastChannel,
        AbortController,
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
        globalThis.__requestedState = () => monitoringRequested;
        globalThis.__leaderState = () => isLeader;
        globalThis.__pluginReady = () => { pluginReady = true; requestLeadership(); };
        globalThis.__setCoreSign = value => { coreSign = value; };
    `, context);
    context.__fetchImplementation = options.fetchImplementation;

    return {
        context,
        elements,
        fetchCalls,
        parentMessages,
        bodyClasses,
        cluster,
        async load() {
            listeners.load();
            await flush();
        },
        async clickStart() {
            elements.startAutoBtn.click();
            await flush();
        },
        async clickStop() {
            elements.stopAutoBtn.click();
            await flush();
        },
        async unload() { listeners.pagehide(); await flush(); },
        async restore() { listeners.pageshow({ persisted: true }); await flush(); },
        async storageChanged(key) {
            listeners.storage({ key }); await flush();
        }
    };
}

test('monitoring is off on the first page load', async () => {
    const storage = createStorage({
        ymq_gw_url: 'https://gateway.test',
        ymq_api_key: 'key'
    });
    const app = createApp(storage);

    await app.load();

    assert.equal(app.context.__monitoringState(), false);
    assert.equal(app.elements.autoStatus.textContent, 'Авто-режим выключен');
    assert.equal(app.fetchCalls.length, 0);
});

test('page reload restores the last user-selected monitoring state', async () => {
    const storage = createStorage({
        ymq_gw_url: 'https://gateway.test',
        ymq_api_key: 'key'
    });

    const firstPage = createApp(storage);
    await firstPage.load();
    await firstPage.clickStart();
    assert.equal(storage.getItem('signjs_cloud_monitoring_enabled'), 'true');

    await firstPage.unload();
    const reloadedRunningPage = createApp(storage);
    await reloadedRunningPage.load();
    assert.equal(reloadedRunningPage.context.__monitoringState(), true);
    assert.match(reloadedRunningPage.elements.autoStatus.textContent, /ведущая вкладка/);
    assert.equal(reloadedRunningPage.fetchCalls.length, 1);

    await reloadedRunningPage.clickStop();
    assert.equal(storage.getItem('signjs_cloud_monitoring_enabled'), 'false');

    const reloadedStoppedPage = createApp(storage);
    await reloadedStoppedPage.load();
    assert.equal(reloadedStoppedPage.context.__monitoringState(), false);
    assert.equal(reloadedStoppedPage.elements.autoStatus.textContent, 'Авто-режим выключен');
    assert.equal(reloadedStoppedPage.fetchCalls.length, 0);
});

test('missing API configuration does not overwrite the saved user choice', async () => {
    const storage = createStorage({
        signjs_cloud_monitoring_enabled: 'true'
    });
    const app = createApp(storage);

    await app.load();
    await Promise.resolve();

    assert.equal(app.context.__monitoringState(), false);
    assert.equal(storage.getItem('signjs_cloud_monitoring_enabled'), 'true');
});

test('embedded mode starts compact and expands when the indicator is clicked', async () => {
    const storage = createStorage();
    const app = createApp(storage, { search: '?mode=embedded', embeddedParent: true });

    await app.load();

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

test('production interface has a collapse control and signing-themed artwork', () => {
    assert.match(html, /aria-label="Свернуть в промышленный режим"/);
    assert.match(html, /<span>Свернуть<\/span>/);
    assert.match(html, /production-widget-hand/);
    assert.match(html, /production-widget-quill/);
    assert.match(html, /production-widget-feather/);
    assert.match(html, /production-widget-inkwell/);
    assert.match(html, /style\.css\?v=1\.3\.0/);
    assert.match(html, /CloudSignApp\.js\?v=1\.3\.0/);
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

    await app.load();
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

    await app.load();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(app.elements.productionWidget.dataset.status, 'error');
    assert.equal(app.elements.productionWidget.dataset.activity, 'idle');
    assert.equal(app.elements.productionWidget.title, 'Ошибка разбора сообщения');
});

function runningStorage() {
    return createStorage({
        ymq_gw_url: 'https://gateway.test', ymq_api_key: 'secret-api-key',
        innMap: JSON.stringify({ '1234567890': 'private-thumbprint' }),
        signjs_cloud_monitoring_enabled: 'true'
    });
}

test('simultaneous standalone and embedded tabs elect exactly one leader', async () => {
    const storage = runningStorage();
    const a = createApp(storage);
    const b = createApp(storage, { search: '?mode=embedded', embeddedParent: true });
    await Promise.all([a.load(), b.load()]);
    assert.equal(a.fetchCalls.length + b.fetchCalls.length, 1);
    assert.equal(a.context.__leaderState(), true);
    assert.equal(b.context.__leaderState(), false);
    assert.equal(b.elements.productionWidget.dataset.role, 'observer');
    assert.match(b.elements.autoStatus.textContent, /другой вкладке/);
    await a.clickStart(); // repeated Start must not create a second poll loop
    assert.equal(a.fetchCalls.length, 1);
});

test('stop/start from observer controls all tabs and persists user choice', async () => {
    const storage = runningStorage();
    const a = createApp(storage); const b = createApp(storage);
    await a.load(); await b.load();
    await b.clickStop();
    assert.equal(storage.getItem('signjs_cloud_monitoring_enabled'), 'false');
    for (const tab of [a, b]) {
        assert.equal(tab.context.__monitoringState(), false);
        assert.equal(tab.context.__requestedState(), false);
        assert.equal(tab.elements.productionWidget.dataset.status, 'stopped');
    }
    await b.clickStart();
    assert.equal(Number(a.context.__leaderState()) + Number(b.context.__leaderState()), 1);
    assert.equal(a.fetchCalls.length + b.fetchCalls.length, 2);
});

test('leader unload transfers the lock and BFCache restoration remains an observer', async () => {
    const storage = runningStorage();
    const a = createApp(storage); const b = createApp(storage);
    await a.load(); await b.load(); await a.unload();
    assert.equal(b.context.__leaderState(), true);
    assert.equal(b.fetchCalls.length, 1);
    assert.equal(storage.getItem('signjs_cloud_monitoring_enabled'), 'true');
    await a.restore();
    assert.equal(a.context.__leaderState(), false);
    assert.equal(a.elements.productionWidget.dataset.role, 'observer');
});

test('stop during ReceiveMessage does not sign the returned batch', async () => {
    let finishReceive;
    const storage = runningStorage();
    const a = createApp(storage, { fetchImplementation: () => new Promise(resolve => { finishReceive = resolve; }) });
    let signatures = 0;
    a.context.__setCoreSign(async () => { signatures++; return 'sig'; });
    await a.load(); await a.clickStop();
    finishReceive({ ok: true, json: async () => ({ Messages: [{ Body: '{}' }] }) });
    await flush();
    assert.equal(signatures, 0);
    assert.equal(a.context.__leaderState(), false);
    assert.equal(a.elements.productionWidget.dataset.status, 'stopped');
});

test('lock remains held until signing, PUT and Delete finish after stop/restart', async () => {
    const storage = runningStorage();
    let finishSign;
    const signed = new Promise(resolve => { finishSign = resolve; });
    const a = createApp(storage, { fetchImplementation: async (url, options) => {
        if (options?.method === 'POST' && JSON.parse(options.body).action === 'ReceiveMessage') {
            return { ok: true, json: async () => ({ Messages: [{ Body: '{}', S3Links: {} }, {
                MessageId: 'm1', ReceiptHandle: 'private-handle', Body: '{}',
                S3Links: { sigKey: 'sign/1234567890_private.txt.sig', downloadUrl: 'source', uploadUrl: 'signature' }
            }] }) };
        }
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) };
    } });
    a.context.__setCoreSign(() => signed);
    const b = createApp(storage);
    await a.load(); await b.load();
    assert.equal(b.elements.productionWidget.dataset.activity, 'signing');
    assert.equal(b.elements.productionWidget.dataset.status, 'active');
    await b.clickStop(); await b.clickStart();
    assert.equal(b.fetchCalls.length, 0);
    assert.equal(a.context.__leaderState(), true);
    finishSign('signature'); await flush(); await flush();
    assert.equal(a.context.__leaderState(), false);
    assert.equal(b.context.__leaderState(), true);
    assert.equal(b.fetchCalls.length, 1);
    assert.ok(a.fetchCalls.some(call => call.options?.method === 'PUT'));
    assert.ok(a.fetchCalls.some(call => call.options?.body?.includes('DeleteMessage')));
    const broadcastJson = JSON.stringify(a.cluster.broadcasts);
    for (const secret of ['secret-api-key', 'private-thumbprint', 'private-handle', '1234567890']) {
        assert.equal(broadcastJson.includes(secret), false);
    }
});

test('pending observer can stop and close without later acquiring the lock', async () => {
    const storage = runningStorage();
    const a = createApp(storage); const b = createApp(storage);
    await a.load(); await b.load(); await b.unload(); await a.unload();
    assert.equal(b.fetchCalls.length, 0);
    assert.equal(b.context.__leaderState(), false);
});

test('unsupported coordination fails closed; no independent polling fallback', async () => {
    for (const options of [{ noLocks: true }, { noChannel: true }]) {
        const a = createApp(runningStorage(), options); await a.load();
        assert.equal(a.fetchCalls.length, 0);
        assert.equal(a.context.__requestedState(), false);
        assert.equal(a.elements.productionWidget.dataset.status, 'error');
        assert.match(a.elements.autoStatus.textContent, /заблокирован/);
    }
});

test('plugin must be ready before a tab becomes leader', async () => {
    const a = createApp(runningStorage(), { delayPlugin: true });
    await a.load();
    assert.equal(a.fetchCalls.length, 0);
    a.context.__pluginReady(); await flush();
    assert.equal(a.fetchCalls.length, 1);
});

test('tab without a plugin can observe a healthy leader without making it red', async () => {
    const storage = runningStorage();
    const a = createApp(storage, { noPlugin: true }); const b = createApp(storage);
    await a.load(); await b.load();
    assert.equal(a.fetchCalls.length, 0);
    assert.equal(b.context.__leaderState(), true);
    assert.equal(a.elements.productionWidget.dataset.status, 'active');
    assert.equal(a.elements.productionWidget.dataset.role, 'observer');
});

test('storage events reconcile latest monitoring choice and settings', async () => {
    const storage = runningStorage(); const a = createApp(storage); await a.load();
    storage.setItem('signjs_cloud_monitoring_enabled', 'false');
    await a.storageChanged('signjs_cloud_monitoring_enabled');
    assert.equal(a.context.__monitoringState(), false);
    storage.setItem('ymq_gw_url', 'https://new-gateway.test');
    await a.storageChanged('ymq_gw_url');
    assert.equal(a.elements.apiUrl.value, 'https://new-gateway.test');
    storage.setItem('signjs_cloud_monitoring_enabled', 'true');
    await a.storageChanged('signjs_cloud_monitoring_enabled');
    assert.equal(a.fetchCalls.at(-1).url, 'https://new-gateway.test');
});

test('error is mirrored to observers, not generated by activity animation', async () => {
    const storage = runningStorage();
    const a = createApp(storage, { fetchImplementation: async () => ({
        ok: true, json: async () => ({ Messages: [{ Body: '{' }] })
    }) });
    const b = createApp(storage); await a.load(); await b.load();
    assert.equal(b.elements.productionWidget.dataset.status, 'error');
    assert.match(b.elements.productionWidget.title, /Ошибка в ведущей/);
    for (const match of css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)(?=\n\})/g)) {
        assert.doesNotMatch(match[1], /background|color|fill|stroke:/);
    }
    assert.match(css, /transform-origin: 54px 77px/);
    assert.match(css, /prefers-reduced-motion/);
});

test('rejected lock request fails closed without retry loop or polling', async () => {
    const storage = runningStorage(); const a = createApp(storage);
    a.cluster.locks.request = async () => { throw new Error('not allowed'); };
    await a.load();
    assert.equal(a.fetchCalls.length, 0);
    assert.equal(a.context.__requestedState(), false);
    assert.equal(a.elements.productionWidget.dataset.status, 'error');
});

test('observer cannot change API settings while leader processes messages', async () => {
    const storage = runningStorage(); const a = createApp(storage); const b = createApp(storage);
    await a.load(); await b.load();
    b.elements.apiUrl.value = 'https://changed.test';
    b.context.saveApiSettings();
    assert.equal(storage.getItem('ymq_gw_url'), 'https://gateway.test');
    await b.clickStop();
    b.elements.apiUrl.value = 'https://changed.test';
    b.context.saveApiSettings();
    assert.equal(storage.getItem('ymq_gw_url'), 'https://changed.test');
});
