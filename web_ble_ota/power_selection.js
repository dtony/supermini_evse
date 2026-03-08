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
    const navCharge = document.getElementById('nav-charge');
    const navSettings = document.getElementById('nav-settings');
    const navHistory = document.getElementById('nav-history');

    function setActiveNav(el) {
        const gray = '#9dabb9';
        [navCharge, navSettings, navHistory].forEach(a => {
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
        actionsPower?.classList.add('hidden'); actionsFirmware?.classList.add('hidden');
        if (name === 'firmware') {
            viewFirmware?.classList.remove('hidden'); actionsFirmware?.classList.remove('hidden'); titleEl.textContent = 'Mise à jour du firmware'; setActiveNav(navSettings); document.documentElement.style.setProperty('--cols','1');
        } else if (name === 'history') {
            viewHistory?.classList.remove('hidden'); titleEl.textContent = 'Historique'; setActiveNav(navHistory); document.documentElement.style.setProperty('--cols','1');
        } else {
            viewPower?.classList.remove('hidden'); actionsPower?.classList.remove('hidden'); titleEl.textContent = 'Puissance de charge'; setCols(); setActiveNav(navCharge);
        }
    }

    navSettings?.addEventListener('click', (e)=>{ e.preventDefault(); showView('firmware'); });
    navCharge?.addEventListener('click', (e)=>{ e.preventDefault(); showView('power'); });
    navHistory?.addEventListener('click', (e)=>{ e.preventDefault(); showView('history'); });

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
    const gridPower = document.querySelector('.grid-power');
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
            bleDevice = await navigator.bluetooth.requestDevice({ filters: [{ name: TARGET_NAME }], optionalServices: [EVSE_SERVICE_UUID] });
            if (!bleDevice || bleDevice.name !== TARGET_NAME) throw new Error('Device non conforme');
            bleDevice.addEventListener('gattserverdisconnected', () => { console.log('[BLE] Déconnecté'); setBLEState('disconnected'); });
            bleServer = await bleDevice.gatt.connect();
            console.log('[BLE] Connecté:', bleDevice.name || '(sans nom)');
            setBLEState('connected', bleDevice.name || 'inconnu');
            // Lecture initiale de la puissance pour pré-sélection
            await readAndApplyPower();
        } catch (err) {
            if (err?.name === 'NotFoundError') { setBLEState('disconnected'); console.log('[BLE] Sélection annulée'); }
            else { console.error('[BLE] Erreur connexion:', err); setBLEState('error', err?.message?.slice(0,40)); }
            bleDevice = null; bleServer = null;
        }
    }

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

    if (bleBtn) {
        bleBtn.addEventListener('click', () => {
            if (!bleDevice || !bleDevice.gatt || !bleDevice.gatt.connected) {
                if (bleText.textContent.startsWith('BLE: connexion')) setBLEState('disconnected'); else connectBLE();
            } else { disconnectBLE(); }
        });
    }

    setBLEState('disconnected');
})();
