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
        logList: document.getElementById('processedFiles')
    };

    elements.apiUrl.value = cloudSettings.apiUrl;
    elements.apiKey.value = cloudSettings.apiKey;

    elements.startAutoBtn.addEventListener('click', startMonitoring);
    elements.stopAutoBtn.addEventListener('click', stopMonitoring);

    renderSettingsTable();
    initPlugin();
});

// --- SETTINGS ---

function saveApiSettings() {
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
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
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
    if (!isMonitoring) return;

    if (!cloudSettings.apiUrl) {
        addAutoLog("Ошибка: Не настроен Gateway URL", "error");
        stopMonitoring();
        return;
    }

    try {
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
        const messages = data.Messages || [];

        if (messages.length > 0) {
            addAutoLog(`Получено сообщений: ${messages.length}`);
            await Promise.all(messages.map(msg => processCloudMessage(msg)));
        }
    } catch (e) {
        addAutoLog(`Ошибка при опросе очереди: ${e.message}`, "error");
    } finally {
        if (isMonitoring) {
            autoTimeoutId = setTimeout(pollQueue, CONFIG.interval);
        }
    }
}

async function processCloudMessage(msg) {
    let body;
    try {
        body = JSON.parse(msg.Body);
    } catch (e) {
        addAutoLog(`Ошибка парсинга тела сообщения ${msg.MessageId}`, "error");
        return;
    }

    const s3Links = msg.S3Links || body.S3Links;
    if (!s3Links) {
        return;
    }

    const sigKey = s3Links.sigKey;
    const filename = sigKey.split('/').pop();
    const innMatch = filename.match(/^(\d{10,12})_/);

    if (!innMatch) {
        if (!skippedKeys.has(sigKey)) {
            addAutoLog(`Не удалось извлечь ИНН из sigKey: ${sigKey}`, "error");
            skippedKeys.add(sigKey);
        }
        return;
    }

    const inn = innMatch[1];
    const thumbprint = innMap[inn];

    if (!thumbprint) {
        if (!skippedKeys.has(sigKey)) {
            showWizard(inn);
            addAutoLog(`Объект ${sigKey} пропущен: ИНН ${inn} не настроен`, "error");
            skippedKeys.add(sigKey);
        }
        return;
    }

    const originalName = sigKey.replace(/\.sig$/, '');
    let isDetached = null;
    if (CONFIG.attached.test(originalName)) isDetached = false;
    else if (CONFIG.detached.test(originalName)) isDetached = true;
    if (isDetached === null) isDetached = true;

    try {
        const downloadRes = await fetch(s3Links.downloadUrl);
        if (!downloadRes.ok) throw new Error(`Ошибка скачивания: ${downloadRes.status}`);
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

    } catch (e) {
        if (!skippedKeys.has(sigKey)) {
            addAutoLog(`Ошибка обработки ${sigKey}: ${e.message}`, "error");
            skippedKeys.add(sigKey);
        }
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
            addAutoLog("Плагин готов. Сертификатов: " + certCache.length);
        } catch (err) {
            addAutoLog("Ошибка плагина: " + err, "error");
        }
    }, (err) => {
        addAutoLog("Ошибка загрузки плагина: " + err, "error");
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
    elements.logList.prepend(li);
    console.log(text);
}

function startMonitoring() {
    if (!cloudSettings.apiUrl) {
        alert("Настройте API Gateway URL");
        return;
    }
    elements.startAutoBtn.disabled = true;
    elements.stopAutoBtn.disabled = false;
    elements.autoStatus.className = "status success";
    elements.autoStatus.textContent = "Мониторинг облака активен";

    isMonitoring = true;
    pollQueue();
}

function stopMonitoring() {
    isMonitoring = false;
    if (autoTimeoutId) {
        clearTimeout(autoTimeoutId);
        autoTimeoutId = null;
    }
    elements.startAutoBtn.disabled = false;
    elements.stopAutoBtn.disabled = true;
    elements.autoStatus.className = "status info";
    elements.autoStatus.textContent = "Мониторинг остановлен";
}
