#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <esp32-hal-rgb-led.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

namespace {
constexpr char kApName[] = "ESP32-GitHub-AI";
constexpr char kApPassword[] = "esp32setup";
constexpr size_t kMaxQuestionLength = 300;
constexpr uint8_t kRgbLedPin = PIN_NEOPIXEL;
constexpr uint8_t kRgbBrightness = 28;
constexpr uint32_t kWifiConnectIndicatorMs = 12000;
constexpr size_t kSerialCommandLimit = 512;
constexpr char kKnowledgeUrl[] =
  "https://raw.githubusercontent.com/me-lt7/Chat-bot/main/data/knowledge_id.json";

WebServer server(80);
Preferences preferences;
JsonDocument knowledgeBase;
String savedSsid;
const char* requestHeaders[] = {"Origin"};
String serialCommandBuffer;
bool knowledgeLoaded = false;
volatile bool processingRequest = false;
volatile bool wifiConnecting = false;
volatile uint32_t wifiConnectingSince = 0;

bool isAllowedAppOrigin(const String& origin) {
  const int schemeEnd = origin.indexOf("://");
  if (schemeEnd < 0) return false;
  const String scheme = origin.substring(0, schemeEnd);
  if (scheme != "http" && scheme != "https") return false;

  String host = origin.substring(schemeEnd + 3);
  const int portStart = host.indexOf(':');
  if (portStart >= 0) host.remove(portStart);
  host.toLowerCase();
  if (host == "localhost") return true;

  IPAddress address;
  if (!address.fromString(host)) return false;
  const uint8_t first = address[0];
  const uint8_t second = address[1];
  return first == 10 || first == 127 ||
         (first == 172 && second >= 16 && second <= 31) ||
         (first == 192 && second == 168) ||
         (first == 169 && second == 254);
}

struct ProcessingIndicator {
  ProcessingIndicator() { processingRequest = true; }
  ~ProcessingIndicator() { processingRequest = false; }
};

void rgbStatusTask(void*) {
  uint8_t lastRed = 0;
  uint8_t lastGreen = 0;
  uint8_t lastBlue = 0;
  bool blinkOn = false;

  for (;;) {
    const bool connected = WiFi.status() == WL_CONNECTED;
    if (connected) {
      wifiConnecting = false;
    } else if (wifiConnecting && millis() - wifiConnectingSince >= kWifiConnectIndicatorMs) {
      wifiConnecting = false;
    }

    const bool blinking = processingRequest || wifiConnecting;
    uint8_t red = 0;
    uint8_t green = 0;
    uint8_t blue = 0;
    if (blinking) {
      blinkOn = ((millis() / 350) % 2) == 0;
      blue = blinkOn ? kRgbBrightness : 0;
    } else if (connected) {
      green = kRgbBrightness;
    } else {
      red = kRgbBrightness;
    }

    if (red != lastRed || green != lastGreen || blue != lastBlue) {
      neopixelWrite(kRgbLedPin, red, green, blue);
      lastRed = red;
      lastGreen = green;
      lastBlue = blue;
    }
    vTaskDelay(pdMS_TO_TICKS(80));
  }
}

void addCorsHeaders() {
  const String origin = server.header("Origin");
  if (isAllowedAppOrigin(origin)) {
    server.sendHeader("Access-Control-Allow-Origin", origin);
    server.sendHeader("Vary", "Origin");
  }
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
}

void sendJson(int status, JsonDocument& document) {
  String response;
  serializeJson(document, response);
  addCorsHeaders();
  server.send(status, "application/json; charset=utf-8", response);
}

void sendSerialJson(JsonDocument& document) {
  serializeJson(document, Serial);
  Serial.println();
}

void sendError(int status, const String& message) {
  JsonDocument response;
  response["error"] = message;
  sendJson(status, response);
}

void handleOptions() {
  addCorsHeaders();
  server.send(204);
}

void handleStatus() {
  JsonDocument response;
  response["connected"] = WiFi.status() == WL_CONNECTED;
  response["ssid"] = WiFi.status() == WL_CONNECTED ? WiFi.SSID() : savedSsid;
  response["station_ip"] = WiFi.localIP().toString();
  response["setup_ip"] = WiFi.softAPIP().toString();
  sendJson(200, response);
}

void appendWifiNetworks(JsonArray networks, int networkCount) {
  for (int index = 0; index < networkCount; ++index) {
    const String ssid = WiFi.SSID(index);
    if (ssid.isEmpty()) continue;

    bool duplicate = false;
    for (JsonObject network : networks) {
      if (network["ssid"].as<String>() == ssid) {
        if (WiFi.RSSI(index) > network["rssi"].as<int>()) {
          network["rssi"] = WiFi.RSSI(index);
          network["open"] = WiFi.encryptionType(index) == WIFI_AUTH_OPEN;
        }
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    JsonObject network = networks.add<JsonObject>();
    network["ssid"] = ssid;
    network["rssi"] = WiFi.RSSI(index);
    network["open"] = WiFi.encryptionType(index) == WIFI_AUTH_OPEN;
  }
}

void handleWifiScan() {
  const int networkCount = WiFi.scanNetworks(false, true, false, 250);
  if (networkCount < 0) {
    sendError(503, "Pemindaian Wi-Fi gagal. Coba pindai lagi.");
    return;
  }
  JsonDocument response;
  JsonArray networks = response["networks"].to<JsonArray>();
  appendWifiNetworks(networks, networkCount);
  WiFi.scanDelete();
  sendJson(200, response);
}

void handleWifi() {
  JsonDocument request;
  DeserializationError parseError = deserializeJson(request, server.arg("plain"));
  if (parseError) {
    sendError(400, "JSON Wi-Fi tidak valid.");
    return;
  }

  String ssid = request["ssid"] | "";
  String password = request["password"] | "";
  const bool openNetwork = request["open_network"] | false;
  ssid.trim();
  if (ssid.isEmpty() || ssid.length() > 32 || password.length() > 64) {
    sendError(400, "SSID wajib diisi (maksimum 32 karakter), kata sandi maksimum 64 karakter.");
    return;
  }

  preferences.begin("wifi", false);
  if (!openNetwork && password.isEmpty() && preferences.getString("ssid", "") == ssid) {
    password = preferences.getString("password", "");
  }
  preferences.putString("ssid", ssid);
  preferences.putString("password", password);
  preferences.end();
  savedSsid = ssid;
  wifiConnectingSince = millis();
  wifiConnecting = true;
  WiFi.disconnect(false, false);
  WiFi.begin(ssid.c_str(), password.c_str());

  JsonDocument response;
  response["connected"] = WiFi.status() == WL_CONNECTED;
  response["connecting"] = !response["connected"].as<bool>();
  response["ssid"] = savedSsid;
  response["station_ip"] = WiFi.localIP().toString();
  sendJson(200, response);
}

bool isIgnoredMatchWord(const String& word) {
  static const char* ignored[] = {
    "apa", "apakah", "itu", "yang", "dan", "untuk", "dengan", "dari",
    "ke", "di", "ini", "saya", "kamu", "tolong", "jelaskan", "sebutkan",
    "bagaimana", "gimana", "cara", "fungsi", "tentang", "dong", "kah"
  };
  for (const char* candidate : ignored) {
    if (word == candidate) return true;
  }
  return false;
}

void tokenizeForMatch(String text, String* tokens, size_t& tokenCount, size_t capacity) {
  text.toLowerCase();
  String word;
  tokenCount = 0;
  auto flushWord = [&]() {
    if (word.isEmpty()) return;
    if (!isIgnoredMatchWord(word) && tokenCount < capacity) tokens[tokenCount++] = word;
    word = "";
  };
  for (size_t index = 0; index < text.length(); ++index) {
    const uint8_t character = static_cast<uint8_t>(text[index]);
    if ((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')) {
      word += static_cast<char>(character);
    } else {
      flushWord();
    }
  }
  flushWord();
}

uint8_t wordEditDistance(const String& left, const String& right) {
  if (left.length() > 64 || right.length() > 64) return 64;
  uint8_t previous[65];
  uint8_t current[65];
  for (size_t column = 0; column <= right.length(); ++column) previous[column] = column;
  for (size_t row = 1; row <= left.length(); ++row) {
    current[0] = row;
    for (size_t column = 1; column <= right.length(); ++column) {
      const uint8_t substitution = previous[column - 1] + (left[row - 1] == right[column - 1] ? 0 : 1);
      const uint8_t insertion = current[column - 1] + 1;
      const uint8_t deletion = previous[column] + 1;
      current[column] = min(substitution, min(insertion, deletion));
    }
    memcpy(previous, current, right.length() + 1);
  }
  return previous[right.length()];
}

float wordSimilarity(const String& left, const String& right, uint8_t& distance) {
  distance = wordEditDistance(left, right);
  const size_t longest = max(left.length(), right.length());
  if (longest == 0) return 1.0f;
  if (distance == 0) return 1.0f;
  if (longest < 4 || distance > (longest >= 8 ? 2 : 1)) return 0.0f;
  return 1.0f - static_cast<float>(distance) / longest;
}

bool loadKnowledgeBase(String& errorMessage) {
  if (WiFi.status() != WL_CONNECTED) {
    errorMessage = "Sambungkan ESP32 ke Wi-Fi yang memiliki akses internet agar kamus GitHub dapat diunduh.";
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();
  client.setHandshakeTimeout(8);
  client.setTimeout(10);
  HTTPClient http;
  http.setTimeout(15000);
  http.setUserAgent("ESP32-Chat-bot/1.0");
  if (!http.begin(client, kKnowledgeUrl)) {
    errorMessage = "Tidak dapat memulai koneksi ke kamus GitHub.";
    return false;
  }
  const int status = http.GET();
  if (status != HTTP_CODE_OK) {
    errorMessage = status < 0
      ? "Tidak dapat mengunduh kamus GitHub. Periksa internet ESP32."
      : "Kamus GitHub membalas HTTP " + String(status) + ". Pastikan data/knowledge_id.json sudah di-push ke branch main.";
    http.end();
    return false;
  }
  const int contentLength = http.getSize();
  if (contentLength > 180000) {
    errorMessage = "Berkas kamus melebihi batas aman memori ESP32 (180 KB).";
    http.end();
    return false;
  }

  knowledgeBase.clear();
  const DeserializationError parseError = deserializeJson(knowledgeBase, http.getStream());
  http.end();
  if (parseError || !knowledgeBase["entries"].is<JsonArrayConst>()) {
    knowledgeBase.clear();
    errorMessage = "Format JSON kamus GitHub tidak valid atau tidak memiliki daftar entri.";
    return false;
  }
  if (knowledgeBase["entries"].as<JsonArrayConst>().size() == 0) {
    knowledgeBase.clear();
    errorMessage = "Kamus GitHub belum berisi entri jawaban.";
    return false;
  }
  knowledgeLoaded = true;
  return true;
}

bool findKnowledgeAnswer(const String& question, String& answer, String& correction, String& errorMessage) {
  if (!knowledgeLoaded && !loadKnowledgeBase(errorMessage)) return false;

  String queryTokens[32];
  size_t queryCount = 0;
  tokenizeForMatch(question, queryTokens, queryCount, 32);
  if (queryCount == 0) {
    errorMessage = "Pertanyaan belum berisi kata yang bisa dicocokkan.";
    return false;
  }

  float bestScore = 0.0f;
  JsonObjectConst bestEntry;
  String bestCorrections[32];
  bool bestHasCorrection = false;
  for (JsonObjectConst entry : knowledgeBase["entries"].as<JsonArrayConst>()) {
    for (JsonVariantConst phraseValue : entry["questions"].as<JsonArrayConst>()) {
      const String phrase = phraseValue.as<String>();
      String phraseTokens[32];
      size_t phraseCount = 0;
      tokenizeForMatch(phrase, phraseTokens, phraseCount, 32);
      if (phraseCount == 0) continue;

      float queryCoverage = 0.0f;
      bool hasCorrection = false;
      String corrections[32];
      for (size_t queryIndex = 0; queryIndex < queryCount; ++queryIndex) {
        float bestSimilarity = 0.0f;
        uint8_t bestDistance = 0;
        String nearestWord = queryTokens[queryIndex];
        for (size_t phraseIndex = 0; phraseIndex < phraseCount; ++phraseIndex) {
          uint8_t distance = 0;
          const float similarity = wordSimilarity(queryTokens[queryIndex], phraseTokens[phraseIndex], distance);
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestDistance = distance;
            nearestWord = phraseTokens[phraseIndex];
          }
        }
        queryCoverage += bestSimilarity;
        corrections[queryIndex] = nearestWord;
        if (bestDistance > 0 && bestSimilarity >= 0.65f) hasCorrection = true;
      }
      queryCoverage /= queryCount;
      if (queryCoverage < 0.55f) continue;

      size_t matchedPhraseWords = 0;
      for (size_t phraseIndex = 0; phraseIndex < phraseCount; ++phraseIndex) {
        float bestSimilarity = 0.0f;
        for (size_t queryIndex = 0; queryIndex < queryCount; ++queryIndex) {
          uint8_t distance = 0;
          bestSimilarity = max(bestSimilarity, wordSimilarity(phraseTokens[phraseIndex], queryTokens[queryIndex], distance));
        }
        if (bestSimilarity >= 0.65f) ++matchedPhraseWords;
      }
      const float phraseCoverage = static_cast<float>(matchedPhraseWords) / phraseCount;
      const float score = queryCoverage * 0.8f + phraseCoverage * 0.2f;
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
        bestHasCorrection = hasCorrection;
        for (size_t index = 0; index < queryCount; ++index) bestCorrections[index] = corrections[index];
      }
    }
  }

  if (bestEntry.isNull() || bestScore < 0.62f) {
    answer = "Saya belum menemukan kecocokan yang cukup di kamus. Coba tulis ulang dengan kata kunci yang lebih spesifik; kamus ini bisa diperluas melalui GitHub.";
    return true;
  }
  answer = bestEntry["answer"] | "Jawaban untuk entri ini belum tersedia.";
  if (bestHasCorrection) {
    String corrected;
    for (size_t index = 0; index < queryCount; ++index) {
      if (!corrected.isEmpty()) corrected += ' ';
      corrected += bestCorrections[index];
    }
    correction = "Kata kunci disesuaikan menjadi: " + corrected;
  }
  return true;
}

void handleChat() {
  JsonDocument request;
  DeserializationError parseError = deserializeJson(request, server.arg("plain"));
  if (parseError) {
    sendError(400, "JSON pertanyaan tidak valid.");
    return;
  }
  String question = request["question"] | "";
  question.trim();
  if (question.isEmpty() || question.length() > kMaxQuestionLength) {
    sendError(400, "Pertanyaan wajib diisi dan maksimum 300 karakter.");
    return;
  }

  ProcessingIndicator processingIndicator;
  JsonDocument response;
  String answer;
  String correction;
  String errorMessage;
  if (!findKnowledgeAnswer(question, answer, correction, errorMessage)) {
    sendError(502, errorMessage);
    return;
  }
  response["answer"] = answer;
  response["source"] = "github-json-knowledge";
  response["source_label"] = "Kamus JSON online ? GitHub";
  if (!correction.isEmpty()) response["query_adjustment"] = correction;
  sendJson(200, response);
}

void connectSavedWifi() {
  preferences.begin("wifi", true);
  savedSsid = preferences.getString("ssid", "");
  String password = preferences.getString("password", "");
  preferences.end();
  if (!savedSsid.isEmpty()) {
    wifiConnectingSince = millis();
    wifiConnecting = true;
    WiFi.begin(savedSsid.c_str(), password.c_str());
  }
}

void handleSerialCommand(const String& commandLine) {
  JsonDocument command;
  JsonDocument response;
  DeserializationError error = deserializeJson(command, commandLine);
  if (error) {
    response["type"] = "error";
    response["error"] = "Invalid serial command JSON.";
    sendSerialJson(response);
    return;
  }

  response["id"] = command["id"];
  const String action = command["cmd"] | "";
  if (action == "status") {
    response["type"] = "status";
    response["connected"] = WiFi.status() == WL_CONNECTED;
    response["ssid"] = WiFi.status() == WL_CONNECTED ? WiFi.SSID() : savedSsid;
    response["station_ip"] = WiFi.localIP().toString();
  } else if (action == "scan") {
    response["type"] = "scan";
    const int count = WiFi.scanNetworks(false, true, false, 250);
    if (count < 0) {
      response["error"] = "Wi-Fi scan failed.";
    } else {
      appendWifiNetworks(response["networks"].to<JsonArray>(), count);
      WiFi.scanDelete();
    }
  } else if (action == "set_wifi") {
    String ssid = command["ssid"] | "";
    String password = command["password"] | "";
    const bool openNetwork = command["open_network"] | false;
    ssid.trim();
    if (ssid.isEmpty() || ssid.length() > 32 || password.length() > 64) {
      response["type"] = "error";
      response["error"] = "SSID must be 1-32 characters; password maximum is 64 characters.";
    } else {
      preferences.begin("wifi", false);
      if (!openNetwork && password.isEmpty() && preferences.getString("ssid", "") == ssid) {
        password = preferences.getString("password", "");
      }
      preferences.putString("ssid", ssid);
      preferences.putString("password", password);
      preferences.end();
      savedSsid = ssid;
      wifiConnectingSince = millis();
      wifiConnecting = true;
      WiFi.disconnect(false, false);
      WiFi.begin(ssid.c_str(), password.c_str());
      response["type"] = "wifi_saved";
      response["ssid"] = savedSsid;
    }
  } else {
    response["type"] = "error";
    response["error"] = "Unknown serial command.";
  }
  sendSerialJson(response);
}

void processSerialCommands() {
  while (Serial.available() > 0) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\n') {
      serialCommandBuffer.trim();
      if (!serialCommandBuffer.isEmpty()) handleSerialCommand(serialCommandBuffer);
      serialCommandBuffer = "";
    } else if (character != '\r') {
      if (serialCommandBuffer.length() < kSerialCommandLimit) {
        serialCommandBuffer += character;
      } else {
        serialCommandBuffer = "";
        Serial.println("{\"type\":\"error\",\"error\":\"Serial command too long.\"}");
      }
    }
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  neopixelWrite(kRgbLedPin, 0, 0, 0);
  if (xTaskCreate(rgbStatusTask, "rgb-status", 2048, nullptr, 1, nullptr) != pdPASS) {
    Serial.println("ERROR: Gagal memulai indikator RGB.");
  }
  preferences.begin("wifi", true);
  savedSsid = preferences.getString("ssid", "");
  preferences.end();

  WiFi.mode(WIFI_AP_STA);
  if (!WiFi.softAP(kApName, kApPassword)) {
    Serial.println("ERROR: Gagal memulai access point pengaturan.");
  }
  Serial.printf("Setup Wi-Fi: %s (kata sandi: %s), alamat %s\n", kApName, kApPassword, WiFi.softAPIP().toString().c_str());
  connectSavedWifi();

  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/status", HTTP_OPTIONS, handleOptions);
  server.on("/api/wifi/scan", HTTP_GET, handleWifiScan);
  server.on("/api/wifi/scan", HTTP_OPTIONS, handleOptions);
  server.on("/api/wifi", HTTP_POST, handleWifi);
  server.on("/api/wifi", HTTP_OPTIONS, handleOptions);
  server.on("/api/chat", HTTP_POST, handleChat);
  server.on("/api/chat", HTTP_OPTIONS, handleOptions);
  server.onNotFound([]() {
    addCorsHeaders();
    sendError(404, "Endpoint tidak ditemukan.");
  });
  server.collectHeaders(requestHeaders, 1);
  if (!MDNS.begin("esp32-github-ai")) {
    Serial.println("WARNING: mDNS tidak tersedia; alamat IP tetap dapat digunakan.");
  } else {
    MDNS.addService("http", "tcp", 80);
  }
  server.begin();
  Serial.println("Web API siap pada port 80.");
}

void loop() {
  server.handleClient();
  processSerialCommands();
  delay(2);
}
