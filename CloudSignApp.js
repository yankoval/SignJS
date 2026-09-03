let elements = {};
let isMonitoring = false;
let autoTimeoutId = null;
let skippedKeys = new Set(); // To avoid log spam for files waiting for INN mapping
let innMap = JSON.parse(localStorage.getItem('innMap')) || {};
let cloudSettings = {
    apiUrl: localStorage.getItem('ymq_gw_url') || '',
    apiKey: localStorage.getItem('ymq_api_key') || ''
};
let certCache = [];
let monitoringRequested = false;
let isLeader = false;
let pollInFlight = false;
let pluginReady = false;
let localPluginError = '';
let coordinationChannel = null;
let leadershipRequest = null;
let leadershipAbort = null;
let releaseLeadership = null;
let pageActive = true;
let indicatorState = { status: 'stopped', activity: 'idle', text: 'Мониторинг выключен' };

const MONITORING_STATE_KEY = 'signjs_cloud_monitoring_enabled';
const EMBEDDED_LAYOUT_MESSAGE = 'signjs:layout';
// Same scope as the existing localStorage settings: one signer per origin/storage partition.
const LEADER_LOCK_NAME = 'signjs-cloud-monitor';
const CHANNEL_NAME = 'signjs-cloud-monitor-state';

const CONFIG = {
    attached: /\.txt$/,
    detached: /\.json$/,
    interval: 2000,
    maxMessages: 5
};

window.addEventListener('load', () => {
    elements = {
        innTableBody: document.getElementById('innTableBody'),
        wizardContainer: document.getElementById('wizardContainer'),
        wizardList: document.getElementById('wizardList'),
        apiUrl: document.getElementById('apiUrl'),
        apiKey: document.getElementById('apiKey'),
        startAutoBtn: document.getElementById('startAutoBtn'),
        stopAutoBtn: document.getElementById('stopAutoBtn'),
        autoStatus: document.getElementById('autoStatus'),
        logList: document.getElementById('processedFiles'),
        productionWidget: document.getElementById('productionWidget'),
        productionStatusText: document.getElementById('productionStatusText'),
        compactModeBtn: document.getElementById('compactModeBtn')
    };

    elements.apiUrl.value = cloudSettings.apiUrl;
    elements.apiKey.value = cloudSettings.apiKey;

    elements.startAutoBtn.addEventListener('click', () => startMonitoring());
    elements.stopAutoBtn.addEventListener('click', () => stopMonitoring());
    elements.productionWidget.addEventListener('click', () => setCompactMode(false));
    elements.compactModeBtn.addEventListener('click', () => setCompactMode(true));

    renderSettingsTable();
    setProductionIndicator('stopped', 'idle', 'Мониторинг выключен');
    if (isEmbeddedMode()) {
        setCompactMode(true);
    }
    initTabCoordination();
    initPlugin();
    addAutoLog("Приложение запущено. Версия: 1.3.0");
    restoreMonitoringState();
});

// --- SETTINGS ---

function saveApiSettings() {
    if (!canEditSettings()) return;
    cloudSettings.apiUrl = elements.apiUrl.value.trim();
    cloudSettings.apiKey = elements.apiKey.value.trim();
    localStorage.setItem('ymq_gw_url', cloudSettings.apiUrl);
    localStorage.setItem('ymq_api_key', cloudSettings.apiKey);
    addAutoLog("Настройки API сохранены");
}

function renderSettingsTable() {
    elements.innTableBody.innerHTML = '';
    for (const [inn, thumb] of Object.entries(innMap)) {
        const row = `<tr>
            <td>${inn}</td>
            <td style="font-family:monospace">${thumb.substring(0, 15)}...</td>
            <td><button class="btn-small" onclick="deleteMapping('${inn}')">Удалить</button></td>
        </tr>`;
        elements.innTableBody.insertAdjacentHTML('beforeend', row);
    }
}

function deleteMapping(inn) {
    if (!canEditSettings()) return;
    delete innMap[inn];
    saveSettings();
}

function saveSettings() {
    localStorage.setItem('innMap', JSON.stringify(innMap));
    renderSettingsTable();
}

function exportSettings() {
    const data = JSON.stringify(innMap, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SignJS_Settings.json';
    a.click();
}

function importSettings(input) {
    if (!canEditSettings()) return;
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            if (!canEditSettings()) return;
            const imported = JSON.parse(e.target.result);
            innMap = { ...innMap, ...imported };
            saveSettings();
            alert("Настройки успешно импортированы!");
        } catch(err) { alert("Ошибка в файле JSON"); }
    };
    reader.readAsText(file);
}

// --- WIZARD ---

function showWizard(inn) {
    if (document.getElementById(`wizard-${inn}`)) return;

    elements.wizardContainer.style.display = 'block';
    const div = document.createElement('div');
    div.className = 'wizard-item';
    div.id = `wizard-${inn}`;

    let options = certCache.map(c => `<option value="${c.thumb}">${c.name}</option>`).join('');

    div.innerHTML = `
        <strong>ИНН: ${inn}</strong>
        <select id="select-${inn}" style="width: 60%;">${options}</select>
        <button class="btn-primary" onclick="applyWizard('${inn}')" style="padding: 5px 15px;">Связать</button>
    `;
    elements.wizardList.appendChild(div);
}

function applyWizard(inn) {
    if (!canEditSettings()) return;
    const thumb = document.getElementById(`select-${inn}`).value;
    innMap[inn] = thumb;
    saveSettings();

    document.getElementById(`wizard-${inn}`).remove();
    if (elements.wizardList.children.length === 0) {
        elements.wizardContainer.style.display = 'none';
    }

    skippedKeys.clear();
    addAutoLog(`ИНН ${inn} привязан. Объекты будут обработаны в следующем цикле.`);
}

// --- CLOUD MONITORING ---

async function pollQueue() {
    if (!isMonitoring || !isLeader || pollInFlight) return;

    if (!cloudSettings.apiUrl) {
        addAutoLog("Ошибка: Не настроен Gateway URL", "error");
        stopMonitoring(false);
        setProductionIndicator('error', 'idle', 'Ошибка: не настроен Gateway URL');
        return;
    }

    pollInFlight = true;
    try {
        setProductionIndicator('active', 'receiving', 'Получение сообщений');
        const response = await fetch(cloudSettings.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': cloudSettings.apiKey
            },
            body: JSON.stringify({
                action: "ReceiveMessage",
                params: {
                    MaxNumberOfMessages: CONFIG.maxMessages,
                    WaitTimeSeconds: 0
                }
            })
        });

        if (!response.ok) {
            let errorDetail = "";
            try {
                const errData = await response.json();
                errorDetail = errData.error || JSON.stringify(errData);
            } catch (e) {
                try {
                    errorDetail = await response.text();
                } catch (e2) {
                    errorDetail = `Status: ${response.status}`;
                }
            }
            throw new Error(`Server Error (${response.status}): ${errorDetail.substring(0, 200)}`);
        }

        const data = await response.json();
        // A stop during ReceiveMessage leaves the batch for redelivery without signing it.
        if (!isMonitoring) return;
        const messages = data.Messages || [];
        let hasProcessingError = false;

        if (messages.length > 0) {
            addAutoLog(`Получено сообщений: ${messages.length}`);
            setProductionIndicator('active', 'signing', `Обработка сообщений: ${messages.length}`);
            // A malformed message must not let us release the lock while sibling tasks still sign.
            const results = await Promise.allSettled(messages.map(msg => processCloudMessage(msg)));
            hasProcessingError = results.some(result => result.status === 'rejected' || result.value === false);
            if (results.some(result => result.status === 'rejected')) {
                addAutoLog('Ошибка структуры сообщения в полученной партии', 'error');
                setProductionIndicator('error', 'idle', 'Ошибка структуры сообщения');
            }
        }
        if (isMonitoring && !hasProcessingError) {
            setProductionIndicator('active', 'idle', 'Мониторинг включен');
        }
    } catch (e) {
        addAutoLog(`Ошибка при опросе очереди: ${e.message}`, "error");
        setProductionIndicator('error', 'idle', `Ошибка мониторинга: ${e.message}`);
    } finally {
        pollInFlight = false;
        if (isMonitoring) {
            autoTimeoutId = setTimeout(pollQueue, CONFIG.interval);
        } else {
            if (!monitoringRequested && pageActive) elements.autoStatus.textContent = 'Мониторинг остановлен';
            releaseLeadership?.();
        }
    }
}

async function processCloudMessage(msg) {
    let body;
    try {
        body = JSON.parse(msg.Body);
    } catch (e) {
        addAutoLog(`Ошибка парсинга тела сообщения ${msg.MessageId}`, "error");
        setProductionIndicator('error', 'idle', 'Ошибка разбора сообщения');
        return false;
    }

    const s3Links = msg.S3Links || body.S3Links;
    if (!s3Links) {
        setProductionIndicator('error', 'idle', 'В сообщении отсутствуют ссылки S3');
        return false;
    }

    const sigKey = s3Links.sigKey;
    const filename = sigKey.split('/').pop();
    const innMatch = filename.match(/^(\d{10,12})_/);

    if (!innMatch) {
        if (!skippedKeys.has(sigKey)) {
            addAutoLog(`Не удалось извлечь ИНН из sigKey: ${sigKey}`, "error");
            skippedKeys.add(sigKey);
        }
        setProductionIndicator('error', 'idle', 'Не удалось определить ИНН сообщения');
        return false;
    }

    const inn = innMatch[1];
    const thumbprint = innMap[inn];

    if (!thumbprint) {
        if (!skippedKeys.has(sigKey)) {
            showWizard(inn);
            addAutoLog(`Объект ${sigKey} пропущен: ИНН ${inn} не настроен`, "error");
            skippedKeys.add(sigKey);
        }
        return true;
    }

    const originalName = sigKey.replace(/\.sig$/, '');
    let isDetached = null;
    if (CONFIG.attached.test(originalName)) isDetached = false;
    else if (CONFIG.detached.test(originalName)) isDetached = true;
    if (isDetached === null) isDetached = true;

    try {
        const downloadRes = await fetch(s3Links.downloadUrl);
        if (!downloadRes.ok) {
            const status = parseInt(downloadRes.status);
            // S3 returns 404 or 403 if the file is missing (depending on bucket permissions)
            if (status === 404 || status === 403) {
                addAutoLog(`WARNING: Ошибка обработки ${sigKey}: Ошибка скачивания: ${status}`, "warning");
                await deleteCloudMessage(msg.ReceiptHandle);
                skippedKeys.delete(sigKey);
                return true;
            }
            throw new Error(`Ошибка скачивания: ${status}`);
        }
        const content = await downloadRes.arrayBuffer();

        const signature = await coreSign(content, thumbprint, isDetached);

        const uploadRes = await fetch(s3Links.uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            body: stringToUint8Array(signature)
        });

        if (!uploadRes.ok) throw new Error(`Ошибка загрузки: ${uploadRes.status}`);

        addAutoLog(`ПОДПИСАНО И ВЫГРУЖЕНО: ${sigKey}`);

        await deleteCloudMessage(msg.ReceiptHandle);
        skippedKeys.delete(sigKey);
        return true;

    } catch (e) {
        setProductionIndicator('error', 'idle', `Ошибка подписи: ${e.message}`);
        if (!skippedKeys.has(sigKey)) {
            addAutoLog(`Ошибка обработки ${sigKey}: ${e.message}`, "error");
            skippedKeys.add(sigKey);
        }
        return false;
    }
}

async function deleteCloudMessage(receiptHandle) {
    try {
        const response = await fetch(cloudSettings.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': cloudSettings.apiKey
            },
            body: JSON.stringify({
                action: "DeleteMessage",
                params: {
                    ReceiptHandle: receiptHandle
                }
            })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (e) {
        addAutoLog(`Не удалось удалить сообщение: ${e.message}`, "error");
    }
}

// --- CORE CRYPTO ---

async function initPlugin() {
    if (typeof cadesplugin === 'undefined') {
        addAutoLog("КриптоПро плагин не найден (cadesplugin_api.js)", "error");
        showLocalPluginError('КриптоПро плагин не найден');
        return;
    }
    cadesplugin.then(async () => {
        try {
            const oStore = await cadesplugin.CreateObjectAsync("CAdESCOM.Store");
            try { await oStore.Open(2, "My", 0); } catch(e) { await oStore.Open(1, "My", 0); }
            const certs = await oStore.Certificates;
            const count = await certs.Count;

            certCache = [];
            for (let i = 1; i <= count; i++) {
                const cert = await certs.Item(i);
                certCache.push({
                    thumb: await cert.Thumbprint,
                    name: (await cert.SubjectName).match(/CN=([^,]+)/)?.[1] || await cert.SubjectName
                });
            }
            await oStore.Close();
            pluginReady = true;
            addAutoLog("Плагин готов. Сертификатов: " + certCache.length);
            if (monitoringRequested) {
                requestLeadership();
            } else if (!isMonitoring && indicatorState.status !== 'error') {
                setProductionIndicator('stopped', 'idle', 'Мониторинг выключен');
            }
        } catch (err) {
            addAutoLog("Ошибка плагина: " + err, "error");
            showLocalPluginError(`Ошибка КриптоПро: ${err}`);
        }
    }, (err) => {
        addAutoLog("Ошибка загрузки плагина: " + err, "error");
        showLocalPluginError(`Ошибка загрузки КриптоПро: ${err}`);
    });
}

async function coreSign(arrayBuffer, thumbprint, isDetached) {
    const base64Data = arrayBufferToBase64(arrayBuffer);
    const oSignedData = await cadesplugin.CreateObjectAsync("CAdESCOM.CadesSignedData");
    await oSignedData.propset_ContentEncoding(1); // CADESCOM_BASE64_TO_BINARY
    await oSignedData.propset_Content(base64Data);

    const oSigner = await cadesplugin.CreateObjectAsync("CAdESCOM.CPSigner");
    const oStore = await cadesplugin.CreateObjectAsync("CAdESCOM.Store");
    try { await oStore.Open(2, "My", 0); } catch(e) { await oStore.Open(1, "My", 0); }

    const certs = await (await oStore.Certificates).Find(cadesplugin.CAPICOM_CERTIFICATE_FIND_SHA1_HASH, thumbprint);
    if (await certs.Count === 0) {
        await oStore.Close();
        throw new Error("Сертификат не найден");
    }

    await oSigner.propset_Certificate(await certs.Item(1));
    const sig = await oSignedData.SignCades(oSigner, 1, isDetached);

    await oStore.Close();
    return sig.replace(/\s+/g, '');
}

// --- HELPERS ---

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
}

function stringToUint8Array(str) {
    return new TextEncoder().encode(str);
}

function addAutoLog(text, type = "info") {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    if(type === "error") li.style.color = "red";
    else if(type === "warning") li.style.color = "orange";
    elements.logList.prepend(li);
    console.log(text);
}

function isEmbeddedMode() {
    const params = new URLSearchParams(window.location.search);
    return params.get('mode') === 'embedded' || params.get('mode') === 'production' || params.get('embedded') === '1';
}

function setCompactMode(compact) {
    document.body.classList.toggle('production-compact', compact);
    elements.productionWidget.setAttribute('aria-expanded', String(!compact));
    notifyParentLayout(compact);
}

function notifyParentLayout(compact) {
    if (window.parent && window.parent !== window && typeof window.parent.postMessage === 'function') {
        window.parent.postMessage({
            type: EMBEDDED_LAYOUT_MESSAGE,
            compact,
            width: compact ? 72 : 760,
            height: compact ? 72 : 900
        }, '*');
    }
}

function setProductionIndicator(status, activity, text) {
    // In-flight operations may finish after Stop; do not turn the stopped UI green/red again.
    if (pollInFlight && !isMonitoring) return;
    indicatorState = { status, activity, text };
    elements.productionWidget.dataset.status = status;
    elements.productionWidget.dataset.activity = activity;
    elements.productionWidget.title = text;
    elements.productionStatusText.textContent = text;
    if (isLeader) broadcastLeaderState();
}

function initTabCoordination() {
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            coordinationChannel = new BroadcastChannel(CHANNEL_NAME);
            coordinationChannel.onmessage = ({ data }) => {
                if (!pageActive || !data) return;
                if (data.type === 'control') syncMonitoringChoice();
                if (data.type === 'hello' && isLeader) broadcastLeaderState();
                if (data.type === 'state' && !isLeader && monitoringRequested &&
                    localStorage.getItem(MONITORING_STATE_KEY) === 'true' &&
                    ['active', 'error'].includes(data.status) &&
                    ['idle', 'receiving', 'signing'].includes(data.activity)) {
                    elements.autoStatus.textContent = 'Режим наблюдения — обработчик работает в другой вкладке';
                    elements.productionWidget.dataset.role = 'observer';
                    const text = data.status === 'error' ? 'Ошибка в ведущей вкладке' :
                        data.activity === 'signing' ? 'Подписание в ведущей вкладке' :
                        data.activity === 'receiving' ? 'Получение сообщений в ведущей вкладке' :
                        'Мониторинг включён в другой вкладке';
                    setProductionIndicator(data.status, data.activity, text);
                }
            };
        } catch (error) {
            addAutoLog(`Недоступна связь между вкладками: ${error.message}`, 'error');
        }
    }
    window.addEventListener('storage', event => {
        if (!pageActive) return;
        if (event.key === MONITORING_STATE_KEY || event.key === null) syncMonitoringChoice();
        if (!isMonitoring && !pollInFlight) reloadSharedSettings();
    });
    window.addEventListener('pagehide', () => {
        pageActive = false;
        stopMonitoring(false);
    });
    window.addEventListener('pageshow', event => {
        if (event.persisted) {
            pageActive = true;
            syncMonitoringChoice();
        }
    });
}

function reloadSharedSettings() {
    cloudSettings = {
        apiUrl: localStorage.getItem('ymq_gw_url') || '',
        apiKey: localStorage.getItem('ymq_api_key') || ''
    };
    innMap = JSON.parse(localStorage.getItem('innMap')) || {};
    elements.apiUrl.value = cloudSettings.apiUrl;
    elements.apiKey.value = cloudSettings.apiKey;
    renderSettingsTable();
}

function syncMonitoringChoice() {
    if (localStorage.getItem(MONITORING_STATE_KEY) === 'true') startMonitoring(false);
    else stopMonitoring(false);
}

function restoreMonitoringState() {
    if (localStorage.getItem(MONITORING_STATE_KEY) === 'true') startMonitoring(false);
}

function showLocalPluginError(text) {
    localPluginError = text;
    // A follower's missing plugin must not replace the leader's healthy status.
    if (elements.productionWidget.dataset.role !== 'observer') {
        setProductionIndicator('error', 'idle', text);
    }
}

function canEditSettings() {
    if (localStorage.getItem(MONITORING_STATE_KEY) === 'true' || pollInFlight) {
        alert('Остановите мониторинг перед изменением настроек');
        return false;
    }
    // Merge edits with the latest shared configuration, not a stale per-tab copy.
    innMap = JSON.parse(localStorage.getItem('innMap')) || {};
    return true;
}

function broadcastLeaderState() {
    // Never broadcast credentials, receipt handles, document names, or raw error details.
    coordinationChannel?.postMessage({ type: 'state', status: indicatorState.status, activity: indicatorState.activity });
}

function requestLeadership() {
    if (!monitoringRequested || !pluginReady || leadershipRequest || !pageActive) return;
    leadershipAbort = new AbortController();
    leadershipRequest = Promise.resolve().then(() => navigator.locks.request(
        LEADER_LOCK_NAME, { mode: 'exclusive', signal: leadershipAbort.signal }, async () => {
            if (!monitoringRequested || !pageActive) return;
            if (localStorage.getItem(MONITORING_STATE_KEY) !== 'true') {
                stopMonitoring(false);
                return;
            }
            reloadSharedSettings();
            isLeader = true;
            isMonitoring = true;
            elements.productionWidget.dataset.role = 'leader';
            elements.autoStatus.textContent = 'Мониторинг облака активен — ведущая вкладка';
            const held = new Promise(resolve => { releaseLeadership = resolve; });
            try {
                setProductionIndicator('active', 'idle', 'Мониторинг включён — ведущая вкладка');
                pollQueue();
                // Keep the lock until Stop AND completion of the current batch, including PUT/Delete.
                await held;
            } finally {
                isLeader = false;
                releaseLeadership = null;
            }
        }
    )).catch(error => {
        if (error.name !== 'AbortError') {
            stopMonitoring(false);
            setProductionIndicator('error', 'idle', `Ошибка блокировки вкладки: ${error.message}`);
        }
    }).finally(() => {
        leadershipRequest = null;
        leadershipAbort = null;
        if (monitoringRequested && pageActive) requestLeadership();
    });
}

function startMonitoring(rememberUserChoice = true) {
    if (!pageActive || monitoringRequested) return;
    if (!pollInFlight) reloadSharedSettings();
    if (!cloudSettings.apiUrl) {
        alert('Настройте API Gateway URL');
        return;
    }
    if (typeof navigator === 'undefined' || !navigator.locks || !coordinationChannel) {
        setProductionIndicator('error', 'idle', 'Для безопасной работы нужны HTTPS, Web Locks и BroadcastChannel');
        elements.autoStatus.textContent = 'Мониторинг заблокирован: недоступна координация вкладок';
        return;
    }
    if (rememberUserChoice) {
        localStorage.setItem(MONITORING_STATE_KEY, 'true');
        coordinationChannel.postMessage({ type: 'control' });
    }
    monitoringRequested = true;
    elements.startAutoBtn.disabled = true;
    elements.stopAutoBtn.disabled = false;
    elements.autoStatus.className = 'status info';
    elements.autoStatus.textContent = 'Ожидание ведущей вкладки / готовности КриптоПро';
    elements.productionWidget.dataset.role = 'waiting';
    setProductionIndicator('stopped', 'idle', 'Ожидание ведущей вкладки / готовности КриптоПро');
    if (localPluginError) showLocalPluginError(localPluginError);
    coordinationChannel.postMessage({ type: 'hello' });
    requestLeadership();
}

function stopMonitoring(rememberUserChoice = true) {
    monitoringRequested = false;
    isMonitoring = false;
    leadershipAbort?.abort();
    if (autoTimeoutId) {
        clearTimeout(autoTimeoutId);
        autoTimeoutId = null;
    }
    if (rememberUserChoice) {
        localStorage.setItem(MONITORING_STATE_KEY, 'false');
        coordinationChannel?.postMessage({ type: 'control' });
    }
    elements.startAutoBtn.disabled = false;
    elements.stopAutoBtn.disabled = true;
    elements.autoStatus.className = "status info";
    elements.autoStatus.textContent = pollInFlight ? 'Остановка — завершение текущей операции' : 'Мониторинг остановлен';
    elements.productionWidget.dataset.role = 'stopped';
    // Set the stopped state directly while the leader drains its in-flight batch.
    indicatorState = { status: 'stopped', activity: 'idle', text: 'Мониторинг выключен' };
    elements.productionWidget.dataset.status = 'stopped';
    elements.productionWidget.dataset.activity = 'idle';
    elements.productionWidget.title = indicatorState.text;
    elements.productionStatusText.textContent = indicatorState.text;
    if (!pollInFlight) releaseLeadership?.();
}
