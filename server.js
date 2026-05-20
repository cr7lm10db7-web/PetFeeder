const http = require('http');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const DEVICE_ID = 'petfeeder-cr7lm10db7-8f9a';

// Topics
const TOPIC_CONTROL = `${DEVICE_ID}/control`;
const TOPIC_STATUS = `${DEVICE_ID}/status`;
const TOPIC_HISTORY = `${DEVICE_ID}/history`;
const TOPIC_SCHEDULE = `${DEVICE_ID}/schedule`;

// Simulated ESP32 hardware state
const state = {
  connected: true,
  foodLevel: 85.0,
  petDetected: false,
  buzzerEnabled: true,
  autoFeedEnabled: true,
  ledGreen: true,
  ledYellow: false,
  ledRed: false,
  feedCount: 1,
  uptime: 0,
  schedules: [
    { hour: 8, minute: 0, enabled: true },
    { hour: 18, minute: 30, enabled: true }
  ],
  history: [
    { time: '08:00:00 20/05', method: 'scheduled' }
  ]
};

// Start time to calculate uptime
const startTime = Date.now();

// Helper to format date similar to ESP32: "%H:%M:%S %d/%m"
function getFormattedTime() {
  const now = new Date();
  const hrs = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const secs = String(now.getSeconds()).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${hrs}:${mins}:${secs} ${day}/${month}`;
}

// Function to trigger a feeding event
function triggerFeed(method) {
  state.feedCount++;
  
  // Decrease food level (simulation of consumption)
  state.foodLevel = Math.max(0, parseFloat((state.foodLevel - 15.0).toFixed(1)));
  
  // Update LEDs based on foodLevel
  if (state.foodLevel > 60) {
    state.ledGreen = true;
    state.ledYellow = false;
    state.ledRed = false;
  } else if (state.foodLevel > 30) {
    state.ledGreen = false;
    state.ledYellow = true;
    state.ledRed = false;
  } else {
    state.ledGreen = false;
    state.ledYellow = false;
    state.ledRed = true;
  }
  
  // Add to history
  const timeStr = getFormattedTime();
  state.history.push({ time: timeStr, method: method });
  if (state.history.length > 20) {
    state.history.shift();
  }
  
  console.log(`\x1b[32m[Hrănire] 🍽️ Dispense completă (${method}) | Nivel mâncare: ${state.foodLevel}% | Total hrăniri: ${state.feedCount}\x1b[0m`);
  
  // Publish updates immediately
  publishStatus();
  publishHistory();
}

// MQTT Client connection
const mqttClient = mqtt.connect('mqtt://broker.hivemq.com', {
  clientId: 'simulator-' + Math.random().toString(16).substr(2, 8),
  keepalive: 60
});

mqttClient.on('connect', () => {
  console.log(`\x1b[32m[MQTT Simulator] Conectat la broker. HiveMQ topic: ${TOPIC_CONTROL}\x1b[0m`);
  mqttClient.subscribe(TOPIC_CONTROL, (err) => {
    if (!err) {
      console.log(`[MQTT Simulator] Abonare reușită la topicul de control.`);
      // Initial publish
      publishStatus();
      publishHistory();
      publishSchedules();
    }
  });
});

mqttClient.on('message', (topic, payload) => {
  const messageStr = payload.toString();
  console.log(`[MQTT Simulator] Comandă primită pe ${topic}:`, messageStr);
  
  try {
    const data = JSON.parse(messageStr);
    const command = data.command;
    
    if (command === 'feed') {
      if (state.foodLevel <= 30) {
        console.log('\x1b[31m[MQTT Simulator] ⚠️ Hrănire eșuată: Rezervor gol!\x1b[0m');
      } else {
        triggerFeed('manual');
      }
    } else if (command === 'toggle_buzzer') {
      state.buzzerEnabled = !state.buzzerEnabled;
      console.log(`[Config] 🔔 Buzzer toggled: ${state.buzzerEnabled ? 'ENABLED' : 'DISABLED'}`);
      publishStatus();
    } else if (command === 'toggle_autofeed') {
      state.autoFeedEnabled = !state.autoFeedEnabled;
      console.log(`[Config] 🤖 Auto-Feed toggled: ${state.autoFeedEnabled ? 'ENABLED' : 'DISABLED'}`);
      publishStatus();
    } else if (command === 'add_schedule') {
      if (state.schedules.length >= 5) return;
      state.schedules.push({
        hour: parseInt(data.hour),
        minute: parseInt(data.minute),
        enabled: data.enabled !== false,
        firedToday: false
      });
      console.log(`[Config] ⏰ Added schedule: ${data.hour}:${data.minute}`);
      publishSchedules();
    } else if (command === 'delete_schedule') {
      const idx = parseInt(data.index);
      if (idx >= 0 && idx < state.schedules.length) {
        state.schedules.splice(idx, 1);
        console.log(`[Config] ⏰ Deleted schedule at index ${idx}`);
        publishSchedules();
      }
    } else if (command === 'toggle_schedule') {
      const idx = parseInt(data.index);
      if (idx >= 0 && idx < state.schedules.length) {
        state.schedules[idx].enabled = !state.schedules[idx].enabled;
        console.log(`[Config] ⏰ Toggled schedule at index ${idx}: ${state.schedules[idx].enabled ? 'ENABLED' : 'DISABLED'}`);
        publishSchedules();
      }
    } else if (command === 'request_sync') {
      publishStatus();
      publishHistory();
      publishSchedules();
    }
  } catch (e) {
    console.error('Error handling MQTT command:', e);
  }
});

function publishStatus() {
  const payload = JSON.stringify({
    connected: state.connected,
    foodLevel: state.foodLevel,
    petDetected: state.petDetected,
    buzzerEnabled: state.buzzerEnabled,
    autoFeedEnabled: state.autoFeedEnabled,
    ledGreen: state.ledGreen,
    ledYellow: state.ledYellow,
    ledRed: state.ledRed,
    feedCount: state.feedCount,
    time: getFormattedTime(),
    uptime: state.uptime
  });
  mqttClient.publish(TOPIC_STATUS, payload, { retain: true });
}

function publishHistory() {
  mqttClient.publish(TOPIC_HISTORY, JSON.stringify(state.history), { retain: true });
}

function publishSchedules() {
  const list = state.schedules.map(s => ({
    hour: s.hour,
    minute: s.minute,
    enabled: s.enabled
  }));
  mqttClient.publish(TOPIC_SCHEDULE, JSON.stringify(list), { retain: true });
}

// SIMULATOR LOOP
// Simulates pet visits and schedule matches
setInterval(() => {
  state.uptime = Math.floor((Date.now() - startTime) / 1000);
  
  // 1. Simulate pet detection (15% chance every 10 seconds if not currently detected)
  if (!state.petDetected && Math.random() < 0.15) {
    state.petDetected = true;
    console.log('\x1b[35m[Simulator] 🐾 Un animal a fost detectat în fața hrănitorului!\x1b[0m');
    publishStatus();
    
    // Auto-feed mechanism
    if (state.autoFeedEnabled) {
      if (state.foodLevel > 30) {
        console.log('\x1b[33m[Simulator] 🤖 Auto-hrănirea automată a fost declanșată de senzorul IR!\x1b[0m');
        triggerFeed('auto');
      } else {
        console.log('\x1b[31m[Simulator] ⚠️ Auto-hrănire eșuată: Mâncare insuficientă (sub 30%)!\x1b[0m');
      }
    }
    
    // Pet leaves after 5 seconds
    setTimeout(() => {
      state.petDetected = false;
      console.log('\x1b[35m[Simulator] 🐾 Animalul a plecat.\x1b[0m');
      publishStatus();
    }, 5000);
  }

  // 2. Check schedules (match hour and minute)
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentSecond = now.getSeconds();
  
  state.schedules.forEach(s => {
    if (s.enabled && s.hour === currentHour && s.minute === currentMinute && currentSecond < 10) {
      if (!s.firedToday) {
        console.log(`\x1b[36m[Simulator] ⏰ Programul de la ${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')} s-a declanșat!\x1b[0m`);
        if (state.foodLevel > 30) {
          triggerFeed('scheduled');
        } else {
          console.log('\x1b[31m[Simulator] ⚠️ Hrănire programată eșuată: Rezervor gol/scăzut!\x1b[0m');
        }
        s.firedToday = true;
      }
    }
  });

  // Reset schedule fired status at midnight
  if (currentHour === 0 && currentMinute === 0 && currentSecond < 10) {
    state.schedules.forEach(s => s.firedToday = false);
  }

  // Periodically publish status to keep uptime fresh
  publishStatus();

}, 10000);

// Web Server to serve static files from /data
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Default to index.html if pointing to root
  let relativePath = pathname === '/' ? 'index.html' : pathname;
  
  // Strip leading slash
  if (relativePath.startsWith('/')) {
    relativePath = relativePath.slice(1);
  }

  const filePath = path.join(DATA_DIR, relativePath);

  // Security check: ensure filePath is inside DATA_DIR
  if (!filePath.startsWith(DATA_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Determine Content-Type
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('===================================================');
  console.log(`🐾 \x1b[36mPetFeeder Mock Server rules at http://localhost:${PORT}\x1b[0m`);
  console.log('===================================================');
  console.log('Mod de utilizare:');
  console.log('1. Deschide \x1b[4mhttp://localhost:8080\x1b[0m în browser.');
  console.log('2. Introdu \x1b[1mpetfeeder-cr7lm10db7-8f9a\x1b[0m ca Device ID.');
  console.log('3. Apasă pe "Conectează".');
  console.log('===================================================');
  console.log('\x1b[90mSe rulează simulatorul MQTT în fundal...\x1b[0m');
});
