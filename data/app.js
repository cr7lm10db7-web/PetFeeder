/* ═══════════════════════════════════════════
   🐾 PetFeeder — App Logic
   ═══════════════════════════════════════════ */

let ESP_IP = localStorage.getItem('esp_ip') || '';
let pollInterval = null;
let selectedEmoji = '🐱';
let lastFeedCount = -1;

// ─── Init ───
window.addEventListener('DOMContentLoaded', () => {
    loadPetProfile();
    if (ESP_IP) {
        showDashboard();
        startPolling();
    }
});

// ─── Connection ───
function connectToESP() {
    const input = document.getElementById('esp-ip');
    const ip = input.value.trim();
    if (!ip) { input.focus(); return; }

    ESP_IP = ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
    localStorage.setItem('esp_ip', ESP_IP);

    showDashboard();
    startPolling();
    showToast('Conectare în curs...');
}

function disconnect() {
    stopPolling();
    localStorage.removeItem('esp_ip');
    ESP_IP = '';
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('setup-screen').classList.remove('hidden');
    showToast('Deconectat');
}

function showDashboard() {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    document.getElementById('device-ip').textContent = ESP_IP;
}

// ─── API Calls ───
async function apiGet(endpoint) {
    try {
        const res = await fetch(`http://${ESP_IP}${endpoint}`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(res.statusText);
        return await res.json();
    } catch (e) {
        console.warn('API GET error:', e.message);
        return null;
    }
}

async function apiPost(endpoint, body = {}) {
    try {
        const res = await fetch(`http://${ESP_IP}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) throw new Error(res.statusText);
        return await res.json();
    } catch (e) {
        console.warn('API POST error:', e.message);
        return null;
    }
}

// ─── Polling ───
function startPolling() {
    fetchStatus();
    fetchHistory();
    fetchSchedules();
    pollInterval = setInterval(fetchStatus, 1500);
}

function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function fetchStatus() {
    const data = await apiGet('/api/status');
    if (!data) {
        setOnline(false);
        return;
    }
    setOnline(true);
    updateFoodLevel(data.foodLevel);
    updateDetection(data.petDetected);
    updateBuzzer(data.buzzerEnabled);
    updateAutoFeed(data.autoFeedEnabled);
    updateLEDs(data);
    updateDeviceInfo(data);

    // Afișează eroarea de la senzor/hrănire dacă există
    if (data.lastError) {
        showToast(data.lastError);
    }
}

async function fetchHistory() {
    const data = await apiGet('/api/history');
    if (data) renderHistory(data);
}

async function fetchSchedules() {
    const data = await apiGet('/api/schedule');
    if (data) renderSchedules(data);
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

    // Folosim starea reală trimisă de ESP32
    g.classList.toggle('active', data.ledGreen === true);
    y.classList.toggle('active', data.ledYellow === true);
    r.classList.toggle('active', data.ledRed === true);
}

function updateDeviceInfo(data) {
    document.getElementById('device-uptime').textContent = formatUptime(data.uptime || 0);
    document.getElementById('device-feed-count').textContent = data.feedCount || 0;
    document.getElementById('device-time').textContent = data.time || '—';

    // Dacă feedCount a crescut (hrănire de la senzor), actualizăm automat istoricul
    if (lastFeedCount !== -1 && data.feedCount > lastFeedCount) {
        fetchHistory();
    }
    lastFeedCount = data.feedCount;
}

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'min';
    return m + ' min';
}

// ─── Actions ───
async function feedNow() {
    const btn = document.getElementById('feed-btn');
    btn.classList.add('feeding');
    btn.querySelector('.feed-label').textContent = 'Se hrănește...';

    const result = await apiPost('/api/feed');

    setTimeout(async () => {
        btn.classList.remove('feeding');
        btn.querySelector('.feed-label').textContent = 'Hrănește Acum';
        if (result && result.success) {
            showToast('✅ Hrănire completă!');
            document.getElementById('last-feed-text').textContent = 'Tocmai acum';
        } else if (result && !result.success) {
            showToast(result.message || '⛔ Hrănire blocată');
        } else {
            showToast('❌ Eroare de conexiune');
        }
        // Așteptăm suficient ca ESP32 să termine doFeed, apoi actualizăm
        await fetchStatus();
        await fetchHistory();
    }, 2500);
}

async function toggleBuzzer() {
    const result = await apiPost('/api/buzzer');
    if (result) {
        showToast(result.buzzerEnabled ? '🔔 Alertă activată' : '🔕 Alertă dezactivată');
    }
}

async function toggleAutoFeed() {
    const result = await apiPost('/api/autofeed');
    if (result) {
        showToast(result.autoFeedEnabled ? '🤖 Senzor hrănire ACTIVAT' : '🚫 Senzor hrănire DEZACTIVAT');
    }
}

// ─── Schedule ───
function addSchedule() {
    document.getElementById('schedule-time').value = '08:00';
    document.getElementById('schedule-modal').classList.remove('hidden');
}

async function saveSchedule() {
    const time = document.getElementById('schedule-time').value;
    if (!time) return;
    const [hour, minute] = time.split(':').map(Number);

    const result = await apiPost('/api/schedule', { hour, minute, enabled: true });
    closeModalById('schedule-modal');
    if (result) {
        showToast('⏰ Program adăugat: ' + time);
        fetchSchedules();
    }
}

async function deleteSchedule(index) {
    const result = await apiPost('/api/schedule/delete', { index });
    if (result) {
        showToast('Program șters');
        fetchSchedules();
    }
}

function renderSchedules(schedules) {
    const list = document.getElementById('schedule-list');
    if (!schedules.length) {
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

async function toggleSchedule(index) {
    await apiPost('/api/schedule/toggle', { index });
    fetchSchedules();
}

// ─── History ───
function renderHistory(history) {
    const list = document.getElementById('history-list');
    if (!history.length) {
        list.innerHTML = '<div class="empty-state"><span class="empty-icon">📝</span><p>Nicio hrănire înregistrată</p></div>';
        return;
    }
    const methodLabels = { manual: 'Manual', scheduled: 'Programat', auto: 'Senzor IR' };
    list.innerHTML = history.reverse().map(h => `
        <div class="history-item">
            <span class="history-time">${h.time}</span>
            <span class="history-method method-${h.method}">${methodLabels[h.method] || h.method}</span>
        </div>
    `).join('');

    if (history.length > 0) {
        document.getElementById('last-feed-text').textContent = 'Ultima: ' + history[0].time;
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
    const ip = prompt('IP ESP32 curent: ' + ESP_IP + '\n\nIntrodu un IP nou (sau lasă gol pentru a păstra):', ESP_IP);
    if (ip && ip.trim()) {
        ESP_IP = ip.trim();
        localStorage.setItem('esp_ip', ESP_IP);
        document.getElementById('device-ip').textContent = ESP_IP;
        showToast('IP actualizat: ' + ESP_IP);
        stopPolling();
        startPolling();
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
