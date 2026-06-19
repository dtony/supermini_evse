(function() {
    function setCols() {
        const cssWidth = window.innerWidth;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const inches = (cssWidth / 96) * (1 / Math.sqrt(dpr));
        const cm = inches * 2.54;
        let cols = 2;
        if (cm < 6) cols = 1; else if (cm >= 12) cols = 3;
        document.documentElement.style.setProperty('--cols', cols);
    }
    let currentPower = parseInt(localStorage.getItem('currentPower') || '6', 10);
    let powerControlsEnabled = false; // sera activé quand BLE connecté

    function onPowerSelected(amps) {
        console.log(`[PowerSelection] Puissance confirmée: ${amps} A`);
    }

    function refreshStates() {
        document.querySelectorAll('.grid-power label').forEach(l => {
            l.classList.remove('is-current','is-selected');
            const badge = l.querySelector('.state-badge'); if (badge) badge.remove();
        });
        const selected = document.querySelector('input[name="charge-power"]:checked');
        if (selected) {
            const labSel = selected.closest('label');
            if (labSel) labSel.classList.add('is-selected');
        }
        document.querySelectorAll(`input[name="charge-power"][value="${currentPower}"]`).forEach(inp => {
            const lab = inp.closest('label');
            if (lab) lab.classList.add('is-current');
        });
        document.querySelectorAll('.grid-power label.is-current').forEach(l => {
            const b=document.createElement('span'); b.className='state-badge'; b.textContent='Actuel'; l.appendChild(b);
        });
        document.querySelectorAll('.grid-power label.is-selected:not(.is-current)').forEach(l => {
            const b=document.createElement('span'); b.className='state-badge'; b.textContent='Choix'; l.appendChild(b);
        });
    }
    function bind() {
        document.querySelectorAll('input[name="charge-power"]').forEach(inp => {
            inp.addEventListener('change', () => {
                refreshStates();
            }, { passive: true });
        });
        const confirm = document.querySelector('#btn-confirm-power');
        if (confirm) {
            confirm.addEventListener('click', async () => {
                if (confirm.disabled) return; // safety
                const sel = document.querySelector('input[name="charge-power"]:checked');
                if (!sel) return;
                currentPower = parseInt(sel.value,10);
                localStorage.setItem('currentPower', String(currentPower));
                refreshStates();
                onPowerSelected(currentPower);
                await writePower(currentPower);
                confirm.classList.add('animate-pulse');
                setTimeout(()=>confirm.classList.remove('animate-pulse'), 600);
            });
        }
    }
    window.addEventListener('resize', setCols, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(()=>{ setCols(); refreshStates(); }, 150));
    setCols();
    bind();
    // Au démarrage: aucune sélection tant que BLE pas connecté
    refreshStates();

    const titleEl = document.querySelector('h1');
    const viewPower = document.getElementById('view-power');
    const viewFirmware = document.getElementById('view-firmware');
    const viewHistory = document.getElementById('view-history');
    const actionsPower = document.getElementById('actions-power');
    const actionsFirmware = document.getElementById('actions-firmware');
    const actionsParam = document.getElementById('actions-param');
    const navCharge = document.getElementById('nav-charge');
    const navOta = document.getElementById('nav-settings');
    const navParam = document.getElementById('nav-param');

    const pwmOffsetInput = document.getElementById('pwm-offset');
    const pwmOffsetDisplay = document.getElementById('pwm-offset-display');
    const btnConfirmParam = document.getElementById('btn-confirm-param');

    function setActiveNav(el) {
        const gray = '#9dabb9';
        [navCharge, navOta, navParam].forEach(a => {
            if (!a) return;
            a.classList.remove('font-bold'); a.style.color = gray;
            a.querySelectorAll('p').forEach(p=>{ p.classList.remove('font-bold'); p.style.color = gray; });
            a.querySelectorAll('.material-symbols-outlined').forEach(i=> { i.style.fontVariationSettings = "'FILL' 0"; i.style.color = gray; });
        });
        if (el) {
            const icon = el.querySelector('.material-symbols-outlined');
            el.style.color = 'var(--primary-color)';
            el.querySelectorAll('p').forEach(p=>{ p.classList.add('font-bold'); p.style.color = 'var(--primary-color)'; });
            if (icon) { icon.style.fontVariationSettings = "'FILL' 1"; icon.style.color = 'var(--primary-color)'; }
        }
    }

    function showView(name) {
        [viewPower, viewFirmware, viewHistory].forEach(v=> v && v.classList.add('hidden'));
        actionsPower?.classList.add('hidden'); 
        actionsFirmware?.classList.add('hidden');
        actionsParam?.classList.add('hidden');

        if (name === 'firmware') {
            viewFirmware?.classList.remove('hidden'); actionsFirmware?.classList.remove('hidden'); titleEl.textContent = 'Mise à jour du firmware'; setActiveNav(navOta); document.documentElement.style.setProperty('--cols','1');
            fetchLatestRelease();
        } else if (name === 'param') {
            viewHistory?.classList.remove('hidden'); actionsParam?.classList.remove('hidden'); titleEl.textContent = 'Paramètres'; setActiveNav(navParam); document.documentElement.style.setProperty('--cols','1');
        } else {
            viewPower?.classList.remove('hidden'); actionsPower?.classList.remove('hidden'); titleEl.textContent = 'Puissance de charge'; setCols(); setActiveNav(navCharge);
        }
    }

    // Slider display logic
    if (pwmOffsetInput && pwmOffsetDisplay) {
        pwmOffsetInput.addEventListener('input', () => {
            pwmOffsetDisplay.textContent = pwmOffsetInput.value;
        });
    }

    navOta?.addEventListener('click', (e)=>{ e.preventDefault(); showView('firmware'); });
    navCharge?.addEventListener('click', (e)=>{ e.preventDefault(); showView('power'); });
    navParam?.addEventListener('click', (e)=>{ e.preventDefault(); showView('param'); });

    setActiveNav(navCharge);

    /* ===================== BLE LOGIC ===================== */
    const bleBtn = document.getElementById('ble-connect-btn');
    const bleDot = document.getElementById('ble-status-dot');
    const bleText = document.getElementById('ble-status-text');
    const confirmBtn = document.getElementById('btn-confirm-power');
    let bleDevice = null; let bleServer = null; let powerChar = null; const TARGET_NAME = 'Super Mini EVSE';
    // UUIDs fournis pour service EVSE et caractéristique power
    const EVSE_SERVICE_UUID = 'de8305b5-4e28-4953-8eee-b81e7fa03e39';
    const POWER_CHAR_UUID = '594fdcf8-aa5f-4a05-9ecd-5777c57d700c';
    const DEVICE_INFO_SERVICE_UUID = '0000180a-0000-1000-8000-00805f9b34fb';
    const FW_REVISION_CHAR_UUID = '00002a26-0000-1000-8000-00805f9b34fb';
    const OTA_SERVICE_UUID = 'd6f1d96d-594c-4c53-b1c6-144a1dfde6d8';
    const OTA_DATA_UUID = '23408888-1f40-4cd8-9b89-ca8d45f8a5b0';
    const OTA_CONTROL_UUID = '7ad671aa-21c0-46a4-b722-270e3ae3d830';

    const GITHUB_API_URL = 'https://api.github.com/repos/dtony/supermini_evse/releases/latest';

    // Detect base URL to handle both localhost and GitHub Pages
    // If on GitHub Pages, base will be https://dtony.github.io/supermini_evse/
    // If on localhost, base will be http://localhost:8080/
    const getBaseUrl = () => {
        const path = window.location.pathname;
        // Check if we are in a subfolder (GitHub Pages typically uses the repo name)
        if (path.includes('/supermini_evse/')) {
            return window.location.origin + path.substring(0, path.lastIndexOf('/') + 1);
        }
        return window.location.origin + '/';
    };
    const BASE_URL = getBaseUrl();

    const gridPower = document.querySelector('.grid-power');
    const updateSectionContainer = document.getElementById('update-section-container');
    const updateAvailableMsg = document.getElementById('update-available-msg');
    const updateUpToDateMsg = document.getElementById('update-up-to-date-msg');
    const btnStartFirmware = document.getElementById('btn-start-firmware');
    const fwCurrentEl = document.getElementById('fw-current');
    const fwAvailableEl = document.getElementById('fw-available');
    const fwProgressText = document.getElementById('fw-progress-text');
    const fwProgressRing = document.getElementById('fw-progress-ring');
    const loaderEl = document.getElementById('power-loader');
    const loaderText = document.getElementById('power-loader-text');
    let loaderCount = 0;

    function showPowerLoader(text) {
        loaderCount++;
        if (loaderText && text) loaderText.textContent = text;
        if (loaderEl) loaderEl.classList.remove('hidden');
    }
    function hidePowerLoader() {
        loaderCount = Math.max(0, loaderCount-1);
        if (loaderCount === 0 && loaderEl) loaderEl.classList.add('hidden');
    }

    function setPowerControlsEnabled(enabled) {
        powerControlsEnabled = enabled;
        if (gridPower) {
            if (!enabled) {
                gridPower.classList.add('power-disabled');
                document.querySelectorAll('input[name="charge-power"]').forEach(r=>{ r.checked = false; r.disabled = true; });
                // Pas d'états affichés quand disabled
                document.querySelectorAll('.grid-power label').forEach(l => { l.classList.remove('is-current','is-selected'); const b=l.querySelector('.state-badge'); if (b) b.remove(); });
            } else {
                gridPower.classList.remove('power-disabled');
                document.querySelectorAll('input[name="charge-power"]').forEach(r=>{ r.disabled = false; });
                const currentInput = document.querySelector(`input[name="charge-power"][value="${currentPower}"]`);
                if (currentInput) { currentInput.checked = true; }
                refreshStates();
            }
        }
    }

    function toggleConfirm(enabled) {
        if (!confirmBtn) return;
        confirmBtn.disabled = !enabled;
        if (confirmBtn.disabled) {
            confirmBtn.classList.add('opacity-50','cursor-not-allowed');
        } else {
            confirmBtn.classList.remove('opacity-50','cursor-not-allowed');
        }
    }

    function setBLEState(state, extra) {
        const map = {
            disconnected: { dot:'#666', text:'BLE: non connecté', btn:'Connecter', enable:false },
            connecting:   { dot:'#f59e0b', text:'BLE: connexion en cours…', btn:'Annuler', enable:false },
            connected:    { dot:'#16a34a', text:'BLE: connecté' + (extra?` (${extra})`:''), btn:'Déconnecter', enable:true },
            error:        { dot:'#dc2626', text:'BLE: erreur' + (extra?` (${extra})`:''), btn:'Réessayer', enable:false }
        };
        const cfg = map[state] || map.disconnected;
        if (bleDot) bleDot.style.background = cfg.dot;
        if (bleText) bleText.textContent = cfg.text;
        if (bleBtn) bleBtn.querySelector('.label').textContent = cfg.btn;
        toggleConfirm(cfg.enable);
        // Activer/désactiver la grille de puissance selon état
        setPowerControlsEnabled(cfg.enable);

        if (state === 'connected') {
            readFirmwareVersion();
            // We'll trigger the update check inside readFirmwareVersion or after
        } else {
            // On hide update elements if disconnected
            if (updateSectionContainer) updateSectionContainer.classList.add('hidden');
            if (btnStartFirmware) btnStartFirmware.classList.add('hidden');
        }
    }

    async function readFirmwareVersion() {
        if (!fwCurrentEl) return;

        let currentVersion = '???';
        try {
            const service = await bleServer.getPrimaryService(DEVICE_INFO_SERVICE_UUID);
            const char = await service.getCharacteristic(FW_REVISION_CHAR_UUID);
            const val = await char.readValue();
            console.log('[BLE] Raw firmware version value:', val);
            const decoder = new TextDecoder('utf-8');
            currentVersion = decoder.decode(val).replace(/\0/g, '').trim();
            console.log('[BLE] Version firmware lue:', currentVersion);
            fwCurrentEl.textContent = currentVersion || '???';
            fwCurrentEl.classList.remove('text-gray-500');
            fwCurrentEl.classList.add('text-white');
        } catch (e) {
            console.warn('[BLE] Lecture version firmware échouée:', e?.message || e);
            fwCurrentEl.textContent = '???';
            fwCurrentEl.classList.remove('text-gray-500');
            fwCurrentEl.classList.add('text-white');
        }

        // After reading current version, ensure we have the latest version from GitHub to compare
        await checkUpdateStatus(currentVersion);
    }

    async function fetchLatestRelease() {
        if (!fwAvailableEl) return;

        try {
            const response = await fetch(GITHUB_API_URL);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            const tagName = data.tag_name;
            console.log('[GitHub] Dernière release trouvée:', tagName);
            fwAvailableEl.textContent = tagName || '???';
            fwAvailableEl.classList.remove('text-gray-500');
            fwAvailableEl.classList.add('text-white');
            
            // Trigger status check in case version was already read
            const currentVal = fwCurrentEl.textContent;
            if (currentVal !== '-' && currentVal !== '???') {
                await checkUpdateStatus(currentVal);
            }
        } catch (e) {
            console.error('[GitHub] Erreur lors de la récupération de la release:', e);
            fwAvailableEl.textContent = '???';
            fwAvailableEl.classList.remove('text-gray-500');
            fwAvailableEl.classList.add('text-white');
        }
    }

    async function checkUpdateStatus(currentVersion) {
        if (!updateSectionContainer || !fwAvailableEl) return;
        
        const latestVersion = fwAvailableEl.textContent;
        if (latestVersion === '-' || latestVersion === '???') return;

        try {
            // Semver comparison
            const isUpToDate = isVersionAtLeast(currentVersion, latestVersion);

            // Always show the container if connected (logic handled by setBLEState showing it)
            updateSectionContainer.classList.remove('hidden');

            if (isUpToDate && currentVersion !== '???') {
                // Up to date: hide progress and show "up to date" message
                const progressDiv = updateSectionContainer.querySelector('.mb-6.flex.justify-center');
                if (progressDiv) progressDiv.classList.add('hidden');
                
                updateAvailableMsg?.classList.add('hidden');
                updateUpToDateMsg?.classList.remove('hidden');
                btnStartFirmware?.classList.add('hidden');
            } else {
                // Update available: show progress, show "update available" message, and start button
                const progressDiv = updateSectionContainer.querySelector('.mb-6.flex.justify-center');
                if (progressDiv) progressDiv.classList.remove('hidden');

                updateAvailableMsg?.classList.remove('hidden');
                updateUpToDateMsg?.classList.add('hidden');
                btnStartFirmware?.classList.remove('hidden');
            }
        } catch (e) {
            console.error('[UpdateCheck] Erreur:', e);
            updateSectionContainer.classList.add('hidden');
        }
    }

    // Simple semver comparison (v1.2.3 -> 1.2.3)
    function isVersionAtLeast(v1, v2) {
        const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
        const a = parse(v1);
        const b = parse(v2);
        
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const numA = a[i] || 0;
            const numB = b[i] || 0;
            if (numA > numB) return true;
            if (numA < numB) return false;
        }
        return true; // equal
    }

    async function readAndApplyPower(withLoader = true) {
        if (!bleServer) return;
        try {
            if (withLoader) showPowerLoader('Lecture puissance…');
            const service = await bleServer.getPrimaryService(EVSE_SERVICE_UUID);
            powerChar = await service.getCharacteristic(POWER_CHAR_UUID);
            const val = await powerChar.readValue();
            const amps = val.getUint8(0);
            console.log('[BLE] Puissance lue:', amps, 'A');
            currentPower = amps;
            localStorage.setItem('currentPower', String(currentPower));
            // Cocher la radio correspondante si elle existe
            const radio = document.querySelector(`input[name="charge-power"][value="${currentPower}"]`);
            // Si la valeur n'est pas dans la liste, on ne sélectionne rien
            document.querySelectorAll('input[name="charge-power"]').forEach(r=> r.checked = false);
            if (radio) radio.checked = true;
            refreshStates();
        } catch (e) {
            console.warn('[BLE] Lecture puissance échouée:', e?.message || e);
        } finally { hidePowerLoader(); }
    }

    async function connectBLE() {
        if (!navigator.bluetooth) { setBLEState('error','API non dispo'); console.warn('Web Bluetooth non supporté'); return; }
        try {
            setBLEState('connecting');
            bleDevice = await navigator.bluetooth.requestDevice({ 
                filters: [{ name: TARGET_NAME }], 
                optionalServices: [EVSE_SERVICE_UUID, DEVICE_INFO_SERVICE_UUID, OTA_SERVICE_UUID] 
            });
            if (!bleDevice || bleDevice.name !== TARGET_NAME) throw new Error('Device non conforme');
            bleDevice.addEventListener('gattserverdisconnected', () => { console.log('[BLE] Déconnecté'); setBLEState('disconnected'); });
            bleServer = await bleDevice.gatt.connect();
            console.log('[BLE] Connecté:', bleDevice.name || '(sans nom)');

            // Get OTA characteristics if possible
            try {
                const otaService = await bleServer.getPrimaryService(OTA_SERVICE_UUID);
                otaDataChar = await otaService.getCharacteristic(OTA_DATA_UUID);
                otaControlChar = await otaService.getCharacteristic(OTA_CONTROL_UUID);
                
                // Set up notifications for OTA Control
                await otaControlChar.startNotifications();
                otaControlChar.addEventListener('characteristicvaluechanged', handleOTAControlNotification);
            } catch (e) {
                console.warn('[BLE] OTA services non disponibles:', e.message);
            }

            setBLEState('connected', bleDevice.name || 'inconnu');
            // Lecture initiale de la puissance pour pré-sélection
            await readAndApplyPower();
        } catch (err) {
            if (err?.name === 'NotFoundError') { setBLEState('disconnected'); console.log('[BLE] Sélection annulée'); }
            else { console.error('[BLE] Erreur connexion:', err); setBLEState('error', err?.message?.slice(0,40)); }
            bleDevice = null; bleServer = null;
        }
    }

    let otaDataChar = null;
    let otaControlChar = null;
    const OPCODES = {
        REQUEST: new Uint8Array([0x01]),
        DONE: new Uint8Array([0x04]),
        REQUEST_ACK: 0x02,
        REQUEST_NAK: 0x03,
        DONE_ACK: 0x05,
        DONE_NAK: 0x06,
    };

    function handleOTAControlNotification(event) {
        const value = event.target.value;
        const code = value.getUint8(0);
        const map = {
            [OPCODES.REQUEST_ACK]: 'OTA request ACK',
            [OPCODES.REQUEST_NAK]: 'OTA request NAK',
            [OPCODES.DONE_ACK]: 'OTA done ACK',
            [OPCODES.DONE_NAK]: 'OTA done NAK'
        };
        console.log('[BLE] OTA Notification:', map[code] || `Code ${code}`);
    }

    async function startOTAUpdate() {
        const targetVersion = fwAvailableEl.textContent;
        if (targetVersion === '-' || targetVersion === '???') return;
        
        try {
            // 1. Fetch release info and the asset via GitHub API
            showPowerLoader('Recherche du firmware...');
            
            const releaseRes = await fetch(GITHUB_API_URL, {
                headers: { "Accept": "application/vnd.github+json" }
            });
            if (!releaseRes.ok) throw new Error('Erreur lors de la récupération de la release');
            const release = await releaseRes.json();

            const version = release.tag_name.replace(/^v/, '');
            
            // 2. Download the binary from the appropriate directory
            showPowerLoader('Téléchargement du firmware...');
            
            let arrayBuffer;
            try {
                // Use the dynamic BASE_URL to ensure the path is correct in both environments
                const localUrl = `${BASE_URL}firmwares/supermini_evse_${version}.bin`;
                console.log(`[OTA] Tentative de téléchargement: ${localUrl}`);
                
                const binResponse = await fetch(localUrl);
                if (!binResponse.ok) throw new Error(`Fichier introuvable (HTTP ${binResponse.status})`);
                arrayBuffer = await binResponse.arrayBuffer();
                console.log('[OTA] Téléchargement réussi');
            } catch (fetchError) {
                console.warn('[OTA] Échec du téléchargement local, passage au mode sélection manuelle', fetchError);
                
                // Fallback: Prompt user to select the file manually
                arrayBuffer = await promptUserForFile();
                
                if (!arrayBuffer) {
                    throw new Error('Échec du téléchargement. Veuillez sélectionner le fichier .bin manuellement.');
                }
            }
            
            // 3. Perform the OTA streaming
            await performOTAStreaming(arrayBuffer);
            
            // Success
            hidePowerLoader();
            alert('Mise à jour réussie ! Le device va redémarrer.');
            location.reload();
        } catch (e) {
            console.error('[OTA] Erreur:', e);
            alert(`Erreur de mise à jour: ${e.message}`);
        } finally {
            btnStartFirmware.disabled = false;
            btnStartFirmware.classList.remove('opacity-50', 'cursor-not-allowed');
            hidePowerLoader();
        }
    }

    function updateOTAProgress(percent) {
        if (fwProgressText) fwProgressText.textContent = `${Math.round(percent)}%`;
        if (fwProgressRing) {
            // SVG circle circumference: 2 * π * 92 ≈ 578
            const circumference = 2 * Math.PI * 92;
            const strokeDasharray = (percent / 100) * circumference;
            fwProgressRing.style.strokeDasharray = `${strokeDasharray}, ${circumference}`;
        }
    }

    async function performOTAStreaming(arrayBuffer) {
        if (!otaDataChar || !otaControlChar) throw new Error('Service OTA non disponible');
        
        const packetSize = 256;
        const totalPackets = Math.ceil(arrayBuffer.byteLength / packetSize);
        console.log(`[OTA] Démarrage streaming: ${arrayBuffer.byteLength} octets, ${totalPackets} paquets`);
        
        showPowerLoader('Initialisation OTA...');
        // Clean progress
        updateOTAProgress(0);

        // Envoyer la taille du paquet
        await otaDataChar.writeValue(new Uint16Array([packetSize]));
        // Envoyer la requête OTA
        await otaControlChar.writeValue(OPCODES.REQUEST);
        
        // Attendre l'ACK
        await new Promise(r => setTimeout(r, 1000));

        for (let i = 0; i < totalPackets; i++) {
            const start = i * packetSize;
            const end = Math.min(start + packetSize, arrayBuffer.byteLength);
            const chunk = arrayBuffer.slice(start, end);
            
            await otaDataChar.writeValue(new Uint8Array(chunk));
            
            const percent = ((i + 1) / totalPackets) * 100;
            updateOTAProgress(percent);
            
            // Petit délai entre les paquets pour éviter la surcharge (comme dans ota.html)
            if (i % 10 === 0) {
                await new Promise(r => setTimeout(r, 50));
            }
        }

        // Envoyer le DONE
        await otaControlChar.writeValue(OPCODES.DONE);
        console.log('[OTA] Streaming terminé');
    }

    btnStartFirmware?.addEventListener('click', startOTAUpdate);

    async function writePower(amps) {
        if (!powerChar) { console.warn('[BLE] Caractéristique power non disponible pour écriture'); return; }
        try {
            showPowerLoader('Envoi nouvelle puissance…');
            const data = new Uint8Array([amps]);
            if (powerChar.writeValueWithResponse) {
                await powerChar.writeValueWithResponse(data);
            } else if (powerChar.writeValue) {
                await powerChar.writeValue(data);
            } else {
                throw new Error('Méthode d\'écriture non supportée');
            }
            console.log('[BLE] Puissance écrite avec succès:', amps, 'A');
            // Relecture pour confirmation visuelle réelle côté device
            await readAndApplyPower(false); // loader déjà affiché
        } catch (e) {
            console.error('[BLE] Echec écriture puissance:', e?.message || e);
        } finally { hidePowerLoader(); }
    }

    async function disconnectBLE() {
        if (bleDevice?.gatt?.connected) { try { bleDevice.gatt.disconnect(); } catch(e) { } }
        bleDevice = null; bleServer = null; setBLEState('disconnected');
    }

    async function promptUserForFile() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.bin';
            input.style.display = 'none';
            document.body.appendChild(input);

            input.onchange = async () => {
                if (input.files && input.files[0]) {
                    const file = input.files[0];
                    console.log(`[OTA] Fichier sélectionné : ${file.name} (${file.size} octets)`);
                    resolve(await file.arrayBuffer());
                } else {
                    resolve(null);
                }
                document.body.removeChild(input);
            };

            // Handle cancel/timeout
            setTimeout(() => {
                if (document.body.contains(input)) {
                    document.body.removeChild(input);
                    resolve(null);
                }
            }, 30000); // 30s timeout for user selection

            input.click();
        });
    }

    if (bleBtn) {
        bleBtn.addEventListener('click', () => {
            if (!bleDevice || !bleDevice.gatt || !bleDevice.gatt.connected) {
                if (bleText.textContent.startsWith('BLE: connexion')) setBLEState('disconnected'); else connectBLE();
            } else { disconnectBLE(); }
        });
    }

    setBLEState('disconnected');
})();
