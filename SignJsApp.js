let elements = {};
let directoryHandle = null;
let autoInterval = null;
let processedFiles = new Set();
let innMap = JSON.parse(localStorage.getItem('innMap')) || {}; // { "ИНН": "Thumbprint" }
let certCache = []; // Список доступных сертификатов в системе

const CONFIG = {
    attached: /\.txt$/, 
    detached: /\.json$/,
    interval: 2000
};

window.addEventListener('load', () => {
    elements = {
        innTableBody: document.getElementById('innTableBody'),
        wizardContainer: document.getElementById('wizardContainer'),
        wizardList: document.getElementById('wizardList'),
        certList: document.getElementById('certList'), // Скрытый список
        startAutoBtn: document.getElementById('startAutoBtn'),
        stopAutoBtn: document.getElementById('stopAutoBtn'),
        autoStatus: document.getElementById('autoStatus'),
        logList: document.getElementById('processedFiles')
    };

    elements.startAutoBtn.addEventListener('click', startMonitoring);
    elements.stopAutoBtn.addEventListener('click', stopMonitoring);

    renderSettingsTable();
    initPlugin();
});

// --- РАБОТА С НАСТРОЙКАМИ ---

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
            innMap = { ...innMap, ...imported }; // Мержим старые и новые
            saveSettings();
            alert("Настройки успешно импортированы!");
        } catch(err) { alert("Ошибка в файле JSON"); }
    };
    reader.readAsText(file);
}

// --- МАСТЕР НАСТРОЙКИ (WIZARD) ---

function showWizard(inn) {
    if (document.getElementById(`wizard-${inn}`)) return;

    elements.wizardContainer.style.display = 'block';
    const div = document.createElement('div');
    div.className = 'wizard-item';
    div.id = `wizard-${inn}`;
    
    // Создаем селект с выбором сертификатов
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
    
    // Удаляем элемент из интерфейса мастера
    document.getElementById(`wizard-${inn}`).remove();
    if (elements.wizardList.children.length === 0) {
        elements.wizardContainer.style.display = 'none';
    }

    // МАГИЯ ЗДЕСЬ: Очищаем список обработанных файлов, 
    // чтобы скрипт перепроверил папку и подписал те, что ждали настройки
    processedFiles.clear(); 
    
    addAutoLog(`ИНН ${inn} привязан. Файлы в очереди будут подписаны при следующем сканировании.`);
}

// --- МОНИТОРИНГ И ПОДПИСЬ ---

async function checkFolder() {
    try {
        const entries = [];
        const fileNames = new Set();

        // Первый проход: собираем все файлы
        for await (const entry of directoryHandle.values()) {
            if (entry.kind === 'file') {
                entries.push(entry);
                fileNames.add(entry.name);
            }
        }

        // Второй проход: анализируем собранные данные
        for (const entry of entries) {
            if (entry.name.endsWith('.sig')) continue;

            const sigName = `${entry.name}.sig`;
            if (fileNames.has(sigName)) {
                // Если подпись уже есть, удаляем из временного списка игнорирования,
                // чтобы при удалении .sig файл снова был подхвачен
                processedFiles.delete(entry.name);
                continue;
            }

            // Если файла .sig нет, проверяем не в игноре ли он (ошибка или ожидание ИНН)
            if (processedFiles.has(entry.name)) continue;

            const innMatch = entry.name.match(/^(\d{10,12})_/);
            if (!innMatch) continue;

            const inn = innMatch[1];
            const thumbprint = innMap[inn];

            if (!thumbprint) {
                if (!document.getElementById(`wizard-${inn}`)) {
                    showWizard(inn);
                    addAutoLog(`Файл ${entry.name} пропущен: ИНН ${inn} не настроен`, "error");
                }
                processedFiles.add(entry.name); 
                continue;
            }

            let isDetached = null;
            if (CONFIG.attached.test(entry.name)) isDetached = false;
            else if (CONFIG.detached.test(entry.name)) isDetached = true;

            if (isDetached !== null) {
                await autoSignProcess(entry, thumbprint, isDetached);
            }
        }
    } catch (e) {
        console.warn("Ошибка при чтении папки", e);
    } finally {
        if (autoInterval) {
            autoInterval = setTimeout(checkFolder, CONFIG.interval);
        }
    }
}
async function autoSignProcess(entry, thumbprint, isDetached) {
    try {
        const file = await entry.getFile();
        const content = await file.arrayBuffer();
        
        const signature = await coreSign(content, thumbprint, isDetached);
        
        const sigName = `${entry.name}.sig`;
        const newFileHandle = await directoryHandle.getFileHandle(sigName, { create: true });
        const writable = await newFileHandle.createWritable();
        await writable.write(signature);
        await writable.close();

        addAutoLog(`ПОДПИСАНО (${isDetached ? 'Det' : 'Att'}): ${entry.name}`);
        // Мы НЕ добавляем в processedFiles при успехе, так как теперь ориентируемся на наличие .sig
    } catch (e) {
        addAutoLog(`Ошибка подписи ${entry.name}: ${e}`, "error");
        processedFiles.add(entry.name); // Добавляем в игнор при ошибке, чтобы не спамить
    }
}

// --- ЯДРО И ПЛАГИН ---

async function initPlugin() {
    cadesplugin.then(async () => {
        // Подгружаем кэш сертификатов для мастера
        const oStore = await cadesplugin.CreateObjectAsync("CAdESCOM.Store");
        try { await oStore.Open(2, "My", 0); } catch(e) { await oStore.Open(1, "My", 0); }
        const certs = await oStore.Certificates;
        const count = await certs.Count;
        
        certCache = [];
        for (let i = 1; i <= count; i++) {
            const cert = await certs.Item(i);
            certCache.push({
                thumb: await cert.Thumbprint,
                name: (await cert.SubjectName).match(/CN=([^,]+)/)[1] // Достаем только имя
            });
        }
        await oStore.Close();
    });
}

async function coreSign(arrayBuffer, thumbprint, isDetached) {
    const base64Data = arrayBufferToBase64(arrayBuffer);
    const oSignedData = await cadesplugin.CreateObjectAsync("CAdESCOM.CadesSignedData");
    await oSignedData.propset_ContentEncoding(1);
    await oSignedData.propset_Content(base64Data);

    const oSigner = await cadesplugin.CreateObjectAsync("CAdESCOM.CPSigner");
    const oStore = await cadesplugin.CreateObjectAsync("CAdESCOM.Store");
    try { await oStore.Open(2, "My", 0); } catch(e) { await oStore.Open(1, "My", 0); }
    
    const certs = await (await oStore.Certificates).Find(cadesplugin.CAPICOM_CERTIFICATE_FIND_SHA1_HASH, thumbprint);
    if (await certs.Count === 0) throw "Сертификат не найден в системе";
    
    await oSigner.propset_Certificate(await certs.Item(1));
    const sig = await oSignedData.SignCades(oSigner, 1, isDetached);
    
    await oStore.Close();
    return sig.replace(/\s+/g, '');
}

// Вспомогательные функции (base64, logs, monitoring) те же...
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
}

function addAutoLog(text, type = "info") {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    if(type === "error") li.style.color = "red";
    elements.logList.prepend(li);
}

async function startMonitoring() {
    try {
        directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        elements.startAutoBtn.disabled = true;
        elements.stopAutoBtn.disabled = false;
        elements.autoStatus.className = "status success";
        elements.autoStatus.textContent = "Мониторинг активен";

        // Используем флаг для управления циклом вместо setInterval
        autoInterval = true;
        checkFolder();
    } catch (err) { console.error(err); }
}

function stopMonitoring() {
    clearTimeout(autoInterval);
    autoInterval = null;
    elements.startAutoBtn.disabled = false;
    elements.stopAutoBtn.disabled = true;
    elements.autoStatus.className = "status info";
    elements.autoStatus.textContent = "Мониторинг остановлен";
}