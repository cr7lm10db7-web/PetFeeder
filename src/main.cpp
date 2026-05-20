#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <WebServer.h>
#include <WiFi.h>
#include <time.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);
// ══════════════════════════════════════════════════
//  🔧 CONFIGURARE PINI — Modifică dacă ai altfel!
// ══════════════════════════════════════════════════
#define SERVO_PIN 13
#define BUZZER_PIN 26
#define IR_SENSOR_PIN 4
#define TRIG_PIN 5
#define ECHO_PIN 18
#define LED_GREEN 25
#define LED_YELLOW 33
#define LED_RED 32

// ══════════════════════════════════════════════════
//  📶 WIFI — PUNE DATELE TALE AICI!
// ══════════════════════════════════════════════════
const char *WIFI_SSID = "CSAB";
const char *WIFI_PASS = "alinabotezat22";

// ══════════════════════════════════════════════════
//  ⚙️ CONSTANTE
// ══════════════════════════════════════════════════
#define FOOD_CONTAINER_DEPTH 20.0 // cm — adâncimea recipientului de mâncare
#define FOOD_MIN_DIST 2.0         // cm — distanța minimă (plin)
#define SERVO_OPEN_ANGLE 90       // unghiul servo când deschide
#define SERVO_CLOSE_ANGLE 0       // unghiul servo când închide
#define FEED_DURATION_MS 1500     // cât stă deschis (ms)
#define MAX_HISTORY 20
#define MAX_SCHEDULES 5

// NTP — Ora României (UTC+2 iarna, UTC+3 vara)
const char *NTP_SERVER = "pool.ntp.org";
const long GMT_OFFSET = 7200; // UTC+2
const int DST_OFFSET = 3600;  // +1h vara

// ══════════════════════════════════════════════════
//  📦 STRUCTURI DE DATE
// ══════════════════════════════════════════════════
struct FeedRecord {
  char timestamp[20];
  char method[12];
};

struct FeedSchedule {
  int hour;
  int minute;
  bool enabled;
  bool firedToday;
};

// ══════════════════════════════════════════════════
//  🌐 OBIECTE GLOBALE
// ══════════════════════════════════════════════════
WebServer server(80);
Servo feedServo;

// State
bool buzzerEnabled = true;
bool autoFeedEnabled = true; // implicit activat pentru a funcționa imediat
float foodLevel = 100.0;
bool petDetected = false;
int feedCount = 0;

// LED States (cached to avoid digitalRead issues)
bool stateGreen = false;
bool stateYellow = false;
bool stateRed = false;

// History (circular buffer)
FeedRecord feedHistory[MAX_HISTORY];
int historyIndex = 0;
int historyTotal = 0;

// Schedules
FeedSchedule schedules[MAX_SCHEDULES];
int scheduleCount = 0;
String lastFeedTime = "-"; // Aici salvăm ora pentru ecran

// ══════════════════════════════════════════════════
//  🛠️ FUNCȚII HELPER
// ══════════════════════════════════════════════════
void sendCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void handleOptions() {
  sendCORS();
  server.send(204);
}

String getTimeString() {
  struct tm t;
  if (!getLocalTime(&t))
    return "??:??";
  char buf[20];
  strftime(buf, sizeof(buf), "%H:%M:%S %d/%m", &t);
  return String(buf);
}

float measureFoodLevel() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0)
    return foodLevel; // keep last value on error

  float distance = duration * 0.034 / 2.0;
  float level = 100.0 - ((distance - FOOD_MIN_DIST) /
                         (FOOD_CONTAINER_DEPTH - FOOD_MIN_DIST) * 100.0);
  return constrain(level, 0, 100);
}

bool checkPetSensor() {
  return digitalRead(IR_SENSOR_PIN) == LOW; // Most IR sensors: LOW = detected
}

void updateLCD() {
  lcd.clear();
  
  // Rândul 1: Afișăm procentul de mâncare
  lcd.setCursor(0, 0);
  lcd.print("Mancare: ");
  lcd.print(round(foodLevel * 10) / 10.0, 1);
  lcd.print("%");
  
  // Rândul 2: Afișăm ora ultimei mese
  lcd.setCursor(0, 1);
  lcd.print("Ultima: ");
  lcd.print(lastFeedTime);
}

void addHistory(const char *method) {
  String t = getTimeString();
  t.toCharArray(feedHistory[historyIndex].timestamp, 20);
  strncpy(feedHistory[historyIndex].method, method, 11);
  feedHistory[historyIndex].method[11] = '\0';
  historyIndex = (historyIndex + 1) % MAX_HISTORY;
  if (historyTotal < MAX_HISTORY)
    historyTotal++;
  if (t != "??:??") {
    lastFeedTime = t.substring(0, 5); 
  }
}

void doFeed(const char *method) {
  Serial.printf("🍽️ Feeding! Method: %s\n", method);

  // Deschide servo
  feedServo.write(SERVO_OPEN_ANGLE);
  delay(FEED_DURATION_MS);
  feedServo.write(SERVO_CLOSE_ANGLE);

  // Buzz dacă e activat (Active-Low logic)
  if (buzzerEnabled) {
    digitalWrite(BUZZER_PIN, LOW);  // PORNIT
    delay(300);
    digitalWrite(BUZZER_PIN, HIGH); // OPRIT
    delay(100);
    digitalWrite(BUZZER_PIN, LOW);  // PORNIT
    delay(150);
    digitalWrite(BUZZER_PIN, HIGH); // OPRIT
  }

  // Blink verde
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_GREEN, HIGH);
    delay(150);
    digitalWrite(LED_GREEN, LOW);
    delay(150);
  }

  addHistory(method);
  feedCount++;
  updateLCD(); // Actualizează ecranul instant când primește mâncare
}

void updateLEDs() {
  if (foodLevel > 60) {
    stateGreen = true;
    stateYellow = false;
    stateRed = false;
  } else if (foodLevel > 30) {
    stateGreen = false;
    stateYellow = true;
    stateRed = false;
  } else {
    stateGreen = false;
    stateYellow = false;
    stateRed = true;
  }

  digitalWrite(LED_GREEN, stateGreen ? HIGH : LOW);
  digitalWrite(LED_YELLOW, stateYellow ? HIGH : LOW);
  digitalWrite(LED_RED, stateRed ? HIGH : LOW);
}

void checkSchedules() {
  struct tm t;
  if (!getLocalTime(&t))
    return;

  for (int i = 0; i < scheduleCount; i++) {
    if (!schedules[i].enabled || schedules[i].firedToday)
      continue;
    if (t.tm_hour == schedules[i].hour && t.tm_min == schedules[i].minute) {
      doFeed("scheduled");
      schedules[i].firedToday = true;
    }
  }

  // Reset firedToday la miezul nopții
  static int lastDay = -1;
  if (t.tm_mday != lastDay) {
    lastDay = t.tm_mday;
    for (int i = 0; i < scheduleCount; i++)
      schedules[i].firedToday = false;
  }
}

// ══════════════════════════════════════════════════
//  🌐 API HANDLERS
// ══════════════════════════════════════════════════
void handleStatus() {
  sendCORS();

  JsonDocument doc;
  doc["connected"] = true;
  doc["foodLevel"] = round(foodLevel * 10) / 10.0;
  doc["petDetected"] = petDetected;
  doc["buzzerEnabled"] = buzzerEnabled;
  doc["autoFeedEnabled"] = autoFeedEnabled;
  doc["ledGreen"] = stateGreen;
  doc["ledYellow"] = stateYellow;
  doc["ledRed"] = stateRed;
  doc["feedCount"] = feedCount;
  doc["time"] = getTimeString();
  doc["uptime"] = millis() / 1000;

  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleFeed() {
  sendCORS();

  if (foodLevel <= 30) {
    server.send(200, "application/json", "{\"success\":false,\"message\":\"Eroare: Rezervor gol!\"}");
    return;
  }

  doFeed("manual");
  server.send(200, "application/json",
              "{\"success\":true,\"message\":\"Hranire completa!\"}");
}

void handleBuzzer() {
  sendCORS();
  buzzerEnabled = !buzzerEnabled;
  String json =
      "{\"buzzerEnabled\":" + String(buzzerEnabled ? "true" : "false") + "}";
  server.send(200, "application/json", json);
}

void handleAutoFeed() {
  sendCORS();
  autoFeedEnabled = !autoFeedEnabled;
  JsonDocument doc;
  doc["autoFeedEnabled"] = autoFeedEnabled;
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleGetHistory() {
  sendCORS();
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  int count = min(historyTotal, MAX_HISTORY);
  for (int i = 0; i < count; i++) {
    int idx = (historyIndex - count + i + MAX_HISTORY) % MAX_HISTORY;
    JsonObject obj = arr.add<JsonObject>();
    obj["time"] = feedHistory[idx].timestamp;
    obj["method"] = feedHistory[idx].method;
  }
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleGetSchedules() {
  sendCORS();
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (int i = 0; i < scheduleCount; i++) {
    JsonObject obj = arr.add<JsonObject>();
    obj["hour"] = schedules[i].hour;
    obj["minute"] = schedules[i].minute;
    obj["enabled"] = schedules[i].enabled;
  }
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handlePostSchedule() {
  sendCORS();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  JsonDocument doc;
  deserializeJson(doc, server.arg("plain"));

  if (scheduleCount >= MAX_SCHEDULES) {
    server.send(400, "application/json", "{\"error\":\"Maximum 5 programe\"}");
    return;
  }

  schedules[scheduleCount].hour = doc["hour"];
  schedules[scheduleCount].minute = doc["minute"];
  schedules[scheduleCount].enabled = doc["enabled"] | true;
  schedules[scheduleCount].firedToday = false;
  scheduleCount++;

  server.send(200, "application/json", "{\"success\":true}");
}

void handleDeleteSchedule() {
  sendCORS();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  JsonDocument doc;
  deserializeJson(doc, server.arg("plain"));
  int idx = doc["index"];

  if (idx < 0 || idx >= scheduleCount) {
    server.send(400, "application/json", "{\"error\":\"Invalid index\"}");
    return;
  }

  // Shift schedules down
  for (int i = idx; i < scheduleCount - 1; i++)
    schedules[i] = schedules[i + 1];
  scheduleCount--;

  server.send(200, "application/json", "{\"success\":true}");
}

void handleToggleSchedule() {
  sendCORS();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No body\"}");
    return;
  }
  JsonDocument doc;
  deserializeJson(doc, server.arg("plain"));
  int idx = doc["index"];

  if (idx >= 0 && idx < scheduleCount) {
    schedules[idx].enabled = !schedules[idx].enabled;
  }
  server.send(200, "application/json", "{\"success\":true}");
}

// ══════════════════════════════════════════════════
//  🚀 SETUP
// ══════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  Serial.println("\nPetFeeder Starting...");
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("PetFeeder");
  lcd.setCursor(0, 1);
  lcd.print("Pornire...");

  // Pini
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH); // Oprește buzzerul inițial (Active-Low)
  pinMode(IR_SENSOR_PIN, INPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED, OUTPUT);

  // Servo
  feedServo.attach(SERVO_PIN);
  feedServo.write(SERVO_CLOSE_ANGLE);

  // Toate LED-urile OFF
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_YELLOW, LOW);
  digitalWrite(LED_RED, LOW);

  // ── Conectare WiFi ──
  Serial.printf("📶 Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(LED_YELLOW, !digitalRead(LED_YELLOW));
    delay(500);
    Serial.print(".");
  }

  digitalWrite(LED_YELLOW, LOW);
  digitalWrite(LED_GREEN, HIGH);
  Serial.println("\n✅ WiFi Connected!");
  Serial.print("🌐 IP: ");
  Serial.println(WiFi.localIP());

  // Beep de confirmare (Active-Low logic)
  if (buzzerEnabled) {
    digitalWrite(BUZZER_PIN, LOW);  // PORNIT
    delay(150);
    digitalWrite(BUZZER_PIN, HIGH); // OPRIT
  }

  // NTP
  configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);

  // ── Rute API ──
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/feed", HTTP_POST, handleFeed);
  server.on("/api/feed", HTTP_OPTIONS, handleOptions);
  server.on("/api/buzzer", HTTP_POST, handleBuzzer);
  server.on("/api/buzzer", HTTP_OPTIONS, handleOptions);
  server.on("/api/autofeed", HTTP_POST, handleAutoFeed);
  server.on("/api/autofeed", HTTP_OPTIONS, handleOptions);
  server.on("/api/history", HTTP_GET, handleGetHistory);
  server.on("/api/schedule", HTTP_GET, handleGetSchedules);
  server.on("/api/schedule", HTTP_POST, handlePostSchedule);
  server.on("/api/schedule", HTTP_OPTIONS, handleOptions);
  server.on("/api/schedule/delete", HTTP_POST, handleDeleteSchedule);
  server.on("/api/schedule/delete", HTTP_OPTIONS, handleOptions);
  server.on("/api/schedule/toggle", HTTP_POST, handleToggleSchedule);
  server.on("/api/schedule/toggle", HTTP_OPTIONS, handleOptions);

  server.begin();
  Serial.println("🚀 Web server pornit pe portul 80!");
  Serial.println("═══════════════════════════════════");
  Serial.println("Deschide website-ul și introdu IP-ul de sus.");
  Serial.println("═══════════════════════════════════");

  foodLevel = measureFoodLevel();
  updateLCD(); // Afișează datele corecte imediat ce a pornit
}


// Funcție pentru sunetul de eroare (Alerta: Rezervor gol / Mâncare insuficientă)
void triggerErrorAlert() {
  if (buzzerEnabled) {
    // Generăm 4 bipuri rapide și stridente pentru a semnala o eroare
    for (int i = 0; i < 4; i++) {
      digitalWrite(BUZZER_PIN, LOW);  // PORNIT (Active-Low logic)
      delay(100);                     // Sunet foarte scurt
      digitalWrite(BUZZER_PIN, HIGH); // OPRIT
      delay(100);                     // Pauză scurtă între bipuri
    }
  }
}

// ══════════════════════════════════════════════════
//  🔄 LOOP
// ══════════════════════════════════════════════════
void loop() {
  server.handleClient();

  static unsigned long lastAutoFeedTime = 0;
  static bool lastPetDetected = false;

  // Citire senzori la fiecare 2 secunde
  static unsigned long lastSensor = 0;
  if (millis() - lastSensor > 2000) {
    lastSensor = millis();
    foodLevel = measureFoodLevel();
    petDetected = checkPetSensor();
    updateLEDs();
    updateLCD();

   if (autoFeedEnabled && petDetected && !lastPetDetected) {
      
      // 2. Dacă a apărut, verificăm starea rezervorului
      if (foodLevel > 30) {
        // 3. Verificăm cooldown-ul de 30 de secunde
        if (millis() - lastAutoFeedTime > 30000) {
          doFeed("auto");
          lastAutoFeedTime = millis();
        }
      } else {
        triggerErrorAlert();
        Serial.println("⚠️ Alertă: Nu se poate hrăni automat, nivelul de mâncare este prea scăzut!");
      }
    }
    
    // FOARTE IMPORTANT: Această linie trebuie să fie în afara blocurilor "if" de mai sus,
    // rulând mereu la finalul citirii senzorului pentru a preveni blocarea!
    lastPetDetected = petDetected;
  }
  // Verifică programul la fiecare 30 secunde
  static unsigned long lastSchedule = 0;
  if (millis() - lastSchedule > 30000) {
    lastSchedule = millis();
    checkSchedules();
  }
}