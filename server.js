const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const DATA_DIR = path.join(__dirname, 'data');

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

// Helper to format date similar to ESP32 getTimeString(): "%H:%M:%S %d/%m"
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
}

// SIMULATOR LOOP
// Simulates pet visits and schedule matches
setInterval(() => {
  state.uptime = Math.floor((Date.now() - startTime) / 1000);
  
  // 1. Simulate pet detection (15% chance every 10 seconds if not currently detected)
  if (!state.petDetected && Math.random() < 0.15) {
    state.petDetected = true;
    console.log('\x1b[35m[Simulatoare] 🐾 Un animal a fost detectat în fața hrănitorului!\x1b[0m');
    
    // Auto-feed mechanism
    if (state.autoFeedEnabled) {
      if (state.foodLevel > 30) {
        console.log('\x1b[33m[Simulatoare] 🤖 Auto-hrănirea automată a fost declanșată de senzorul IR!\x1b[0m');
        triggerFeed('auto');
      } else {
        console.log('\x1b[31m[Simulatoare] ⚠️ Auto-hrănire eșuată: Mâncare insuficientă (sub 30%)!\x1b[0m');
      }
    }
    
    // Pet leaves after 5 seconds
    setTimeout(() => {
      state.petDetected = false;
      console.log('\x1b[35m[Simulatoare] 🐾 Animalul a plecat.\x1b[0m');
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
        console.log(`\x1b[36m[Simulatoare] ⏰ Programul de la ${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')} s-a declanșat!\x1b[0m`);
        if (state.foodLevel > 30) {
          triggerFeed('scheduled');
        } else {
          console.log('\x1b[31m[Simulatoare] ⚠️ Hrănire programată eșuată: Rezervor gol/scăzut!\x1b[0m');
        }
        s.firedToday = true;
      }
    }
  });

  // Reset schedule fired status at midnight
  if (currentHour === 0 && currentMinute === 0 && currentSecond < 10) {
    state.schedules.forEach(s => s.firedToday = false);
  }

}, 10000);

// Helper to parse JSON body from incoming requests
function getJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

// Helper to send JSON responses with CORS headers
function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Web Server handling both API endpoints and static files from /data
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Handle CORS OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // ── API ROUTES ──
  if (pathname.startsWith('/api/')) {
    console.log(`\x1b[90m[API Request] ${req.method} ${pathname}\x1b[0m`);
    
    // GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, {
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
      return;
    }

    // POST /api/feed
    if (pathname === '/api/feed' && req.method === 'POST') {
      if (state.foodLevel <= 30) {
        sendJson(res, { success: false, message: 'Eroare: Rezervor gol!' });
      } else {
        triggerFeed('manual');
        sendJson(res, { success: true, message: 'Hranire completa!' });
      }
      return;
    }

    // POST /api/buzzer
    if (pathname === '/api/buzzer' && req.method === 'POST') {
      state.buzzerEnabled = !state.buzzerEnabled;
      console.log(`[Config] 🔔 Buzzer toggled: ${state.buzzerEnabled ? 'ENABLED' : 'DISABLED'}`);
      sendJson(res, { buzzerEnabled: state.buzzerEnabled });
      return;
    }

    // POST /api/autofeed
    if (pathname === '/api/autofeed' && req.method === 'POST') {
      state.autoFeedEnabled = !state.autoFeedEnabled;
      console.log(`[Config] 🤖 Auto-Feed toggled: ${state.autoFeedEnabled ? 'ENABLED' : 'DISABLED'}`);
      sendJson(res, { autoFeedEnabled: state.autoFeedEnabled });
      return;
    }

    // GET /api/history
    if (pathname === '/api/history' && req.method === 'GET') {
      sendJson(res, state.history);
      return;
    }

    // GET /api/schedule
    if (pathname === '/api/schedule' && req.method === 'GET') {
      sendJson(res, state.schedules.map(s => ({
        hour: s.hour,
        minute: s.minute,
        enabled: s.enabled
      })));
      return;
    }

    // POST /api/schedule
    if (pathname === '/api/schedule' && req.method === 'POST') {
      const body = await getJsonBody(req);
      if (state.schedules.length >= 5) {
        sendJson(res, { error: 'Maximum 5 programe' }, 400);
        return;
      }
      if (body.hour === undefined || body.minute === undefined) {
        sendJson(res, { error: 'Parametri invalizi' }, 400);
        return;
      }
      
      const newSchedule = {
        hour: parseInt(body.hour),
        minute: parseInt(body.minute),
        enabled: body.enabled !== false,
        firedToday: false
      };
      state.schedules.push(newSchedule);
      console.log(`[Config] ⏰ Added schedule at ${String(newSchedule.hour).padStart(2,'0')}:${String(newSchedule.minute).padStart(2,'0')}`);
      sendJson(res, { success: true });
      return;
    }

    // POST /api/schedule/delete
    if (pathname === '/api/schedule/delete' && req.method === 'POST') {
      const body = await getJsonBody(req);
      const idx = parseInt(body.index);
      if (isNaN(idx) || idx < 0 || idx >= state.schedules.length) {
        sendJson(res, { error: 'Invalid index' }, 400);
        return;
      }
      const deleted = state.schedules.splice(idx, 1)[0];
      console.log(`[Config] ⏰ Deleted schedule at ${String(deleted.hour).padStart(2,'0')}:${String(deleted.minute).padStart(2,'0')}`);
      sendJson(res, { success: true });
      return;
    }

    // POST /api/schedule/toggle
    if (pathname === '/api/schedule/toggle' && req.method === 'POST') {
      const body = await getJsonBody(req);
      const idx = parseInt(body.index);
      if (isNaN(idx) || idx < 0 || idx >= state.schedules.length) {
        sendJson(res, { error: 'Invalid index' }, 400);
        return;
      }
      state.schedules[idx].enabled = !state.schedules[idx].enabled;
      console.log(`[Config] ⏰ Toggled schedule at index ${idx}: ${state.schedules[idx].enabled ? 'ENABLED' : 'DISABLED'}`);
      sendJson(res, { success: true });
      return;
    }

    // Unknown API endpoint
    sendJson(res, { error: 'Not Found' }, 404);
    return;
  }

  // ── STATIC FILE SERVING ──
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
  console.log('2. Introdu \x1b[1mlocalhost:8080\x1b[0m ca adresă IP ESP32 pe ecranul de setup.');
  console.log('3. Apasă pe "Conectează".');
  console.log('===================================================');
  console.log('\x1b[90mSe rulează simularea în fundal...\x1b[0m');
});
