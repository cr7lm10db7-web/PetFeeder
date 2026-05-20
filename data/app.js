let DEVICE_ID = localStorage.getItem('device_id') || 'petfeeder-cr7lm10db7-8f9a';
let mqttClient = null;
let selectedEmoji = '🐱';
let lastFeedCount = -1;

// ─── Init ───
window.addEventListener('DOMContentLoaded', () => {
    loadPetProfile();
    if (DEVICE_ID) {
        showDashboard();
        startMQTT();
    }
});

// ─── Connection ───
function connectToESP() {
    const input = document.getElementById('esp-ip');
    const id = input.value.trim();
    if (!id) { input.focus(); return; }

    DEVICE_ID = id;
    localStorage.setItem('device_id', DEVICE_ID);

    showDashboard();
    startMQTT();
    showToast('Conectare în curs...');
}

function disconnect() {
    stopMQTT();
    localStorage.removeItem('device_id');
    DEVICE_ID = '';
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('setup-screen').classList.remove('hidden');
    showToast('Deconectat');
}

function showDashboard() {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    document.getElementById('device-ip').textContent = DEVICE_ID;
}

// ─── MQTT Communication ───
function startMQTT() {
    stopMQTT();
    setOnline(false);

    // Conectare la brokerul public HiveMQ prin WebSockets securizate (port 8884)
    const brokerUrl = 'wss://broker.hivemq.com:8884/mqtt';
    console.log('[MQTT] Conectare la broker:', brokerUrl, 'cu ID-ul:', DEVICE_ID);
    
    mqttClient = mqtt.connect(brokerUrl, {
        clientId: 'web-' + Math.random().toString(16).substr(2, 8),
        keepalive: 60,
        reconnectPeriod: 3000
    });

    mqttClient.on('connect', () => {
        console.log('[MQTT] Conectat cu succes!');
        setOnline(true);

        // Abonare la topicuri pentru a primi date de la ESP32
        mqttClient.subscribe(`${DEVICE_ID}/status`);
        mqttClient.subscribe(`${DEVICE_ID}/history`);
        mqttClient.subscribe(`${DEVICE_ID}/schedule`);

        // Cere sincronizare initiala imediat după conectare
        mqttPublish('request_sync');
    });

    mqttClient.on('close', () => {
        console.log('[MQTT] Conexiune închisă');
        setOnline(false);
    });

    mqttClient.on('error', (err) => {
        console.error('[MQTT] Eroare:', err);
        setOnline(false);
    });

    mqttClient.on('message', (topic, payload) => {
        const messageStr = payload.toString();
        
        try {
            const data = JSON.parse(messageStr);
            if (topic.endsWith('/status')) {
                handleStatusMessage(data);
            } else if (topic.endsWith('/history')) {
                renderHistory(data);
            } else if (topic.endsWith('/schedule')) {
                renderSchedules(data);
            }
        } catch (e) {
            console.warn('[MQTT] Eroare parsare payload JSON:', e);
        }
    });
}

function stopMQTT() {
    if (mqttClient) {
        try {
            mqttClient.end();
            console.log('[MQTT] Client oprit');
        } catch (e) {}
        mqttClient = null;
    }
}

function mqttPublish(commandName, extraArgs = {}) {
    if (!mqttClient || !mqttClient.connected) {
        showToast('Eroare: Deconectat de la broker!');
        return false;
    }
    const topic = `${DEVICE_ID}/control`;
    const payload = JSON.stringify({ command: commandName, ...extraArgs });
    mqttClient.publish(topic, payload);
    console.log(`[MQTT] Publicat pe ${topic}:`, payload);
    return true;
}

function handleStatusMessage(data) {
    updateFoodLevel(data.foodLevel);
    updateDetection(data.petDetected);
    updateBuzzer(data.buzzerEnabled);
    updateAutoFeed(data.autoFeedEnabled);
    updateLEDs(data);
    updateDeviceInfo(data);

    if (data.lastError) {
        showToast(data.lastError);
    }
}

// ─── UI Updates ───
function setOnline(online) {
    const badge = document.getElementById('connection-badge');
    const text = document.getElementById('badge-text');
    badge.className = 'badge ' + (online ? 'badge-online' : 'badge-offline');
    text.textContent = online ? 'Conectat' : 'Deconectat';
}

function updateFoodLevel(level) {
    const fill = document.getElementById('food-level-fill');
    const pct = document.getElementById('food-level-percent');
    const label = document.getElementById('food-level-label');

    level = Math.max(0, Math.min(100, level));
    fill.style.height = level + '%';
    pct.textContent = Math.round(level) + '%';

    fill.classList.remove('medium', 'low');
    if (level > 60) {
        label.textContent = 'Nivel bun';
    } else if (level > 30) {
        fill.classList.add('medium');
        label.textContent = 'Nivel mediu';
    } else {
        fill.classList.add('low');
        label.textContent = level < 10 ? 'Aproape gol!' : 'Nivel scăzut';
    }
}

function updateDetection(detected) {
    const indicator = document.getElementById('detection-indicator');
    const text = document.getElementById('detection-text');
    indicator.classList.toggle('active', detected);
    text.textContent = detected ? 'Animal detectat! 🐾' : 'Niciun animal detectat';
}

function updateBuzzer(enabled) {
    document.getElementById('buzzer-toggle').checked = enabled;
    document.getElementById('buzzer-label').textContent = enabled ? 'Activat' : 'Dezactivat';
}

function updateAutoFeed(enabled) {
    const toggle = document.getElementById('autofeed-toggle');
    const label = document.getElementById('autofeed-label');
    if (toggle) toggle.checked = enabled;
    if (label) label.textContent = enabled ? 'Activat' : 'Dezactivat';
}

function updateLEDs(data) {
    const g = document.getElementById('led-green');
    const y = document.getElementById('led-yellow');
    const r = document.getElementById('led-red');

    g.classList.toggle('active', data.ledGreen === true);
    y.classList.toggle('active', data.ledYellow === true);
    r.classList.toggle('active', data.ledRed === true);
}

function updateDeviceInfo(data) {
    document.getElementById('device-uptime').textContent = formatUptime(data.uptime || 0);
    document.getElementById('device-feed-count').textContent = data.feedCount || 0;
    document.getElementById('device-time').textContent = data.time || '—';

    lastFeedCount = data.feedCount;
}

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'min';
    return m + ' min';
}

// ─── Actions ───
function feedNow() {
    const btn = document.getElementById('feed-btn');
    if (btn.classList.contains('feeding')) return;

    btn.classList.add('feeding');
    btn.querySelector('.feed-label').textContent = 'Se hrănește...';

    const success = mqttPublish('feed');

    setTimeout(() => {
        btn.classList.remove('feeding');
        btn.querySelector('.feed-label').textContent = 'Hrănește Acum';
        if (success) {
            showToast('🍽️ Comandă de hrănire trimisă!');
        } else {
            showToast('❌ Eroare trimitere comandă');
        }
    }, 2500);
}

function toggleBuzzer() {
    mqttPublish('toggle_buzzer');
}

function toggleAutoFeed() {
    mqttPublish('toggle_autofeed');
}

// ─── Schedule ───
function addSchedule() {
    document.getElementById('schedule-time').value = '08:00';
    document.getElementById('schedule-modal').classList.remove('hidden');
}

function saveSchedule() {
    const time = document.getElementById('schedule-time').value;
    if (!time) return;
    const [hour, minute] = time.split(':').map(Number);

    const success = mqttPublish('add_schedule', { hour, minute, enabled: true });
    closeModalById('schedule-modal');
    if (success) {
        showToast('⏰ Trimitere program: ' + time);
    }
}

function deleteSchedule(index) {
    const success = mqttPublish('delete_schedule', { index });
    if (success) {
        showToast('Se trimite cererea de ștergere...');
    }
}

function renderSchedules(schedules) {
    const list = document.getElementById('schedule-list');
    if (!schedules || !schedules.length) {
        list.innerHTML = '<div class="empty-state"><span class="empty-icon">⏰</span><p>Niciun program setat</p><p class="empty-hint">Adaugă ore la care să se hrănească automat</p></div>';
        return;
    }
    list.innerHTML = schedules.map((s, i) => `
        <div class="schedule-item">
            <span class="schedule-time">${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')}</span>
            <div class="schedule-actions">
                <label class="apple-toggle">
                    <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleSchedule(${i})">
                    <span class="apple-toggle-slider"></span>
                </label>
                <button class="schedule-delete" onclick="deleteSchedule(${i})">✕</button>
            </div>
        </div>
    `).join('');
}

function toggleSchedule(index) {
    mqttPublish('toggle_schedule', { index });
}

// ─── History ───
function renderHistory(history) {
    const list = document.getElementById('history-list');
    if (!history || !history.length) {
        list.innerHTML = '<div class="empty-state"><span class="empty-icon">📝</span><p>Nicio hrănire înregistrată</p></div>';
        return;
    }
    const methodLabels = { manual: 'Manual', scheduled: 'Programat', auto: 'Senzor IR' };
    
    // Sort reverse for UI (newest first)
    const displayHistory = [...history].reverse();
    
    list.innerHTML = displayHistory.map(h => `
        <div class="history-item">
            <span class="history-time">${h.time}</span>
            <span class="history-method method-${h.method}">${methodLabels[h.method] || h.method}</span>
        </div>
    `).join('');

    if (displayHistory.length > 0) {
        document.getElementById('last-feed-text').textContent = 'Ultima: ' + displayHistory[0].time;
    }
}

// ─── Pet Profile ───
function editPetProfile() {
    const name = localStorage.getItem('pet_name') || '';
    document.getElementById('pet-name-input').value = name;
    selectedEmoji = localStorage.getItem('pet_emoji') || '🐱';
    highlightEmoji();
    document.getElementById('pet-modal').classList.remove('hidden');
}

function selectEmoji(emoji) {
    selectedEmoji = emoji;
    highlightEmoji();
}

function highlightEmoji() {
    document.querySelectorAll('.emoji-option').forEach(btn => {
        btn.classList.toggle('selected', btn.textContent.trim() === selectedEmoji);
    });
}

function savePetProfile() {
    const name = document.getElementById('pet-name-input').value.trim() || 'Animalul meu';
    localStorage.setItem('pet_name', name);
    localStorage.setItem('pet_emoji', selectedEmoji);
    loadPetProfile();
    closeModalById('pet-modal');
    showToast('Profil salvat! ' + selectedEmoji);
}

function loadPetProfile() {
    const name = localStorage.getItem('pet_name') || 'Animalul meu';
    const emoji = localStorage.getItem('pet_emoji') || '🐱';
    document.getElementById('pet-name').textContent = name;
    document.getElementById('pet-avatar').textContent = emoji;
}

// ─── Modals ───
function closeModal(event, id) {
    if (event.target === event.currentTarget) closeModalById(id);
}

function closeModalById(id) {
    document.getElementById(id).classList.add('hidden');
}

function showSettings() {
    const id = prompt('ID Dispozitiv curent: ' + DEVICE_ID + '\n\nIntrodu un ID nou (sau lasă gol pentru a păstra):', DEVICE_ID);
    if (id && id.trim()) {
        DEVICE_ID = id.trim();
        localStorage.setItem('device_id', DEVICE_ID);
        document.getElementById('device-ip').textContent = DEVICE_ID;
        showToast('ID actualizat: ' + DEVICE_ID);
        startMQTT();
    }
}

// ─── Toast ───
function showToast(message) {
    const toast = document.getElementById('toast');
    const text = document.getElementById('toast-text');
    text.textContent = message;
    toast.classList.remove('hidden');
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 350);
    }, 2500);
}
