/**
 * SignJsApp.js
 * Логика взаимодействия с КриптоПро ЭЦП Browser Plug-in
 */

const elements = {
    certList: document.getElementById('certList'),
    fileInput: document.getElementById('fileInput'),
    signBtn: document.getElementById('signBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    status: document.getElementById('status'),
    result: document.getElementById('result')
};

let currentFileName = "";

function log(msg, type = 'info') {
    elements.status.textContent = msg;
    elements.status.className = `status ${type}`;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
}

window.onload = () => {
    if (typeof cadesplugin === 'undefined') {
        log("Ошибка: Библиотека cadesplugin_api.js не загружена", "error");
        return;
    }
    
    cadesplugin.then(() => {
        log("Плагин готов к работе");
        loadCertificates();
    }, (err) => {
        log("Ошибка: Плагин не найден. Проверьте установку расширения.", "error");
    });
};

async function loadCertificates() {
    try {
        const oStore = await cadesplugin.CreateObjectAsync("CAdESCOM.Store");
        // Проверка обоих хранилищ (Машина и Пользователь)
        try { await oStore.Open(2, "My", 0); } 
        catch (e) { await oStore.Open(1, "My", 0); }

        const certs = await oStore.Certificates;
        const count = await certs.Count;
        
        elements.certList.innerHTML = '';
        if (count === 0) {
            log("Сертификаты не найдены. Установите их через КриптоПро CSP.", "error");
            return;
        }

        for (let i = 1; i <= count; i++) {
            const cert = await certs.Item(i);
            const opt = document.createElement('option');
            opt.value = await cert.Thumbprint;
            opt.text = await cert.SubjectName;
            elements.certList.add(opt);
        }
        log(`Сертификаты загружены (${count})`, "success");
        await oStore.Close();
    } catch (e) {
        log("Ошибка хранилища: " + cadesplugin.getLastError(e), "error");
    }
}

async function signData() {
    const file = elements.fileInput.files[0];
    const thumbprint = elements.certList.value;

    if (!file) return log("Файл не выбран", "error");
    if (!thumbprint) return log("Сертификат не выбран", "error");

    currentFileName = file.name;
    const reader = new FileReader();

    reader.onload = async (e) => {
        try {
            log("Подписывание...");
            const base64Data = arrayBufferToBase64(e.target.result);

            const oStore = await cadesplugin.CreateObjectAsync("CAdESCOM.Store");
            try { await oStore.Open(2, "My", 0); } catch(e) { await oStore.Open(1, "My", 0); }

            const certs = await (await oStore.Certificates).Find(cadesplugin.CAPICOM_CERTIFICATE_FIND_SHA1_HASH, thumbprint);
            const cert = await certs.Item(1);

            const oSigner = await cadesplugin.CreateObjectAsync("CAdESCOM.CPSigner");
            await oSigner.propset_Certificate(cert);
            await oSigner.propset_CheckCertificate(true);

            const oSignedData = await cadesplugin.CreateObjectAsync("CAdESCOM.CadesSignedData");
            await oSignedData.propset_ContentEncoding(1); // CADESCOM_BASE64_IN_RAW_CONTENT
            await oSignedData.propset_Content(base64Data);

            // Detached = true
            const signature = await oSignedData.SignCades(oSigner, 1, true);

            elements.result.value = signature.replace(/\s+/g, '');
            elements.downloadBtn.disabled = false;
            log("Файл успешно подписан", "success");
            
            await oStore.Close();
        } catch (err) {
            log("Ошибка подписи: " + cadesplugin.getLastError(err), "error");
        }
    };
    reader.readAsArrayBuffer(file);
}

function saveFile() {
    const signature = elements.result.value;
    if (!signature) return;

    const blob = new Blob([signature], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${currentFileName}.sig`;
    link.click();
    URL.revokeObjectURL(link.href);
}

elements.signBtn.addEventListener('click', signData);
elements.downloadBtn.addEventListener('click', saveFile);