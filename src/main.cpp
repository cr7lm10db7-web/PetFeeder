#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <PubSubClient.h>
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
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// Configuration MQTT
const char *MQTT_SERVER = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char *MQTT_CLIENT_ID = "petfeeder-cr7lm10db7-8f9a";

// Topics MQTT
const char *TOPIC_CONTROL = "petfeeder-cr7lm10db7-8f9a/control";
const char *TOPIC_STATUS = "petfeeder-cr7lm10db7-8f9a/status";
const char *TOPIC_HISTORY = "petfeeder-cr7lm10db7-8f9a/history";
const char *TOPIC_SCHEDULE = "petfeeder-cr7lm10db7-8f9a/schedule";

// Forward declarations
void publishStatus();
void publishHistory();
void publishSchedules();
void triggerErrorAlert();

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
  publishStatus();
  publishHistory();
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
//  🌐 MQTT PUBLISHERS & HANDLERS
// ══════════════════════════════════════════════════
void publishStatus() {
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
  mqttClient.publish(TOPIC_STATUS, json.c_str(), true); // retained
}

void publishHistory() {
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
  mqttClient.publish(TOPIC_HISTORY, json.c_str(), true); // retained
}

void publishSchedules() {
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
  mqttClient.publish(TOPIC_SCHEDULE, json.c_str(), true); // retained
}

void mqttCallback(char *topic, byte *payload, unsigned int length) {
  Serial.print("Message arrived on topic: ");
  Serial.println(topic);

  // Buffer payload
  char message[length + 1];
  memcpy(message, payload, length);
  message[length] = '\0';
  Serial.print("Payload: ");
  Serial.println(message);

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.print("JSON Deserialization failed: ");
    Serial.println(error.c_str());
    return;
  }

  const char *command = doc["command"];
  if (command == nullptr) return;

  if (strcmp(command, "feed") == 0) {
    if (foodLevel <= 30) {
      triggerErrorAlert();
      Serial.println("⚠️ Alertă: Nu se poate hrăni manual, nivelul de mâncare este prea scăzut!");
    } else {
      doFeed("manual");
    }
    publishStatus();
  } 
  else if (strcmp(command, "toggle_buzzer") == 0) {
    buzzerEnabled = !buzzerEnabled;
    publishStatus();
  } 
  else if (strcmp(command, "toggle_autofeed") == 0) {
    autoFeedEnabled = !autoFeedEnabled;
    publishStatus();
  } 
  else if (strcmp(command, "add_schedule") == 0) {
    if (scheduleCount < MAX_SCHEDULES) {
      schedules[scheduleCount].hour = doc["hour"];
      schedules[scheduleCount].minute = doc["minute"];
      schedules[scheduleCount].enabled = doc["enabled"] | true;
      schedules[scheduleCount].firedToday = false;
      scheduleCount++;
      publishSchedules();
    }
  } 
  else if (strcmp(command, "delete_schedule") == 0) {
    int idx = doc["index"];
    if (idx >= 0 && idx < scheduleCount) {
      for (int i = idx; i < scheduleCount - 1; i++) {
        schedules[i] = schedules[i + 1];
      }
      scheduleCount--;
      publishSchedules();
    }
  } 
  else if (strcmp(command, "toggle_schedule") == 0) {
    int idx = doc["index"];
    if (idx >= 0 && idx < scheduleCount) {
      schedules[idx].enabled = !schedules[idx].enabled;
      publishSchedules();
    }
  } 
  else if (strcmp(command, "request_sync") == 0) {
    publishStatus();
    publishHistory();
    publishSchedules();
  }
}

void connectMQTT() {
  static unsigned long lastReconnectAttempt = 0;
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt > 5000 || lastReconnectAttempt == 0) {
      lastReconnectAttempt = now;
      Serial.print("Attempting MQTT connection to ");
      Serial.print(MQTT_SERVER);
      Serial.print("...");
      if (mqttClient.connect(MQTT_CLIENT_ID)) {
        Serial.println("connected");
        mqttClient.subscribe(TOPIC_CONTROL);
        publishStatus();
        publishHistory();
        publishSchedules();
      } else {
        Serial.print("failed, rc=");
        Serial.println(mqttClient.state());
      }
    }
  }
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

  // ── Configurare MQTT ──
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1500); // Mărim buffer-ul pentru istoricul JSON

  Serial.println("🚀 Configurare MQTT finalizată!");
  Serial.println("═══════════════════════════════════");
  Serial.printf("Abonat la topicul: %s\n", TOPIC_CONTROL);
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
      publishStatus(); // actualizează status instant
    }
  }
}

// ══════════════════════════════════════════════════
//  🔄 LOOP
// ══════════════════════════════════════════════════
void loop() {
  connectMQTT();
  mqttClient.loop();

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
    publishStatus(); // Trimite status nou pe MQTT la fiecare 2s

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