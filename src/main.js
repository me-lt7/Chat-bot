import { ESPLoader, Transport } from 'esptool-js';
import './style.css';

const app = document.querySelector('#app');
const state = { page: 'chat', boardUrl: localStorage.getItem('boardUrl') || 'http://192.168.4.1', usbPort: null, connection: 'network', serialRequestId: 0, chatMessages: [], chatBusy: false, progressTimer: null };

app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <a class="brand" href="#" aria-label="ESP32 Web AI home"><span class="brand-mark">A</span><span>ESP32 <b>Web AI</b></span></a>
      <p class="side-label">PERANGKAT</p>
      <label class="field-label" for="board-url">Alamat ESP32</label>
      <div class="address-control"><input id="board-url" value="${escapeAttr(state.boardUrl)}" spellcheck="false"><button id="save-url" class="icon-button" title="Simpan alamat">↵</button></div>
      <div id="connection" class="connection"><i></i><span>Mengecek Wi-Fi…</span></div>
      <div id="usb-connection" class="connection usb-connection"><i></i><span>Mengecek USB…</span></div>
      <button id="detect-usb" class="usb-detect">Deteksi board via USB</button>
      <nav class="navigation" aria-label="Navigasi utama">
        <button class="nav-item active" data-page="chat"><span>◉</span> Chat AI</button>
        <button class="nav-item" data-page="wifi"><span>⌁</span> Wi-Fi</button>
        <button class="nav-item" data-page="flash"><span>⇧</span> Flash firmware</button>
      </nav>
      <div class="sidebar-note"><span class="note-icon">i</span><p>Jawaban dimuat dari kamus JSON GitHub. Pencocokan kata membantu mengenali salah ketik.</p></div>
      <div class="sidebar-footer"><span class="pulse"></span> ESP32-S3 · kamus online</div>
    </aside>
    <main class="main">
      <header class="topbar"><div class="crumb">Workspace <span>/</span> <strong id="page-name">Chat AI</strong></div><span class="top-status">KAMUS GITHUB <b></b></span></header>
      <section id="page-content"></section>
    </main>
  </div>`;

const content = document.querySelector('#page-content');
const connection = document.querySelector('#connection');
const usbConnection = document.querySelector('#usb-connection');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function setPage(page) {
  state.page = page;
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const labels = { chat: 'Chat AI', wifi: 'Konfigurasi Wi-Fi', flash: 'Flash firmware' };
  document.querySelector('#page-name').textContent = labels[page];
  if (page === 'chat') renderChat();
  if (page === 'wifi') renderWifi();
  if (page === 'flash') renderFlash();
}

function apiUrl(path) {
  return `${state.boardUrl.replace(/\/+$/, '')}${path}`;
}

async function request(path, options = {}, baseUrl = state.boardUrl, timeoutMs = 12000) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `Perangkat membalas HTTP ${response.status}`);
  return data;
}

function acceptDeviceAddress(address, data) {
  state.boardUrl = address;
  localStorage.setItem('boardUrl', address);
  document.querySelector('#board-url').value = address;
  connection.classList.add('online');
  connection.querySelector('span').textContent = data.connected
    ? `Wi-Fi · ${data.ssid || data.station_ip}`
    : 'ESP32 ditemukan · Wi-Fi belum terhubung';
  if (state.page === 'wifi') {
    const wifiState = document.querySelector('#wifi-state');
    if (wifiState) {
      wifiState.textContent = data.connected ? 'Terhubung' : 'ESP32 ditemukan';
      wifiState.classList.toggle('connected', data.connected);
    }
    const ssid = document.querySelector('#ssid');
    if (ssid && data.ssid) {
      ssid.dataset.savedSsid = data.ssid;
      addWifiOption(data.ssid, true);
    }
  }
}

async function discoverEspDevice() {
  const candidates = [...new Set([
    state.boardUrl,
    'http://esp32-github-ai.local',
    'http://192.168.4.1',
  ])];
  let lastError;
  for (const candidate of candidates) {
    try {
      const data = await request('/api/status', {}, candidate, 700);
      acceptDeviceAddress(candidate, data);
      return { address: candidate, data };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Perangkat ESP32 tidak ditemukan.');
}

async function checkConnection() {
  if (state.usbPort && state.connection === 'usb') {
    connection.classList.add('online');
    connection.querySelector('span').textContent = 'ESP32 terdeteksi lewat USB';
    return;
  }
  try {
    await discoverEspDevice();
  } catch {
    if (state.usbPort) {
      connection.classList.add('online');
      connection.querySelector('span').textContent = 'ESP32 terdeteksi via USB · jaringan belum terhubung';
    } else {
      connection.classList.remove('online');
      connection.querySelector('span').textContent = 'Mencari ESP32 di jaringan…';
    }
  }
}

function serialDeviceName(port) {
  const { usbVendorId, usbProductId } = port.getInfo();
  if (usbVendorId === 0x303a) return 'ESP32 USB terdeteksi';
  if ([0x10c4, 0x1a86, 0x0403, 0x067b].includes(usbVendorId)) return 'Board USB terdeteksi';
  if (usbVendorId) return `Perangkat USB ${usbVendorId.toString(16).toUpperCase()}${usbProductId ? `:${usbProductId.toString(16).toUpperCase()}` : ''}`;
  return 'Port USB serial terdeteksi';
}

function showUsbConnection(port) {
  state.usbPort = port;
  state.connection = 'usb';
  usbConnection.classList.add('online');
  usbConnection.querySelector('span').textContent = `${serialDeviceName(port)} · siap flash`;
  document.querySelector('#detect-usb').textContent = 'Board USB terhubung';
}

function clearUsbConnection(port) {
  if (port && state.usbPort !== port) return;
  state.usbPort = null;
  usbConnection.classList.remove('online');
  usbConnection.querySelector('span').textContent = 'USB belum dipilih';
  document.querySelector('#detect-usb').textContent = 'Deteksi board via USB';
  if (state.connection === 'usb') state.connection = 'network';
}

async function sendUsbCommand(command, expectedType, timeoutMs = 30000) {
  if (!state.usbPort) throw new Error('Board belum dipilih. Klik Deteksi board via USB terlebih dahulu.');
  const port = state.usbPort;
  const openedHere = !port.readable || !port.writable;
  if (openedHere) {
    await port.open({ baudRate: 115200 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  const id = ++state.serialRequestId;
  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    const writer = port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(`${JSON.stringify({ ...command, id })}\n`));
    } finally {
      writer.releaseLock();
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let timer;
      let result;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Board tidak membalas melalui USB. Coba lepas lalu sambungkan kabel USB.')), deadline - Date.now());
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) throw new Error('Koneksi serial ESP32 terputus.');
      buffer += decoder.decode(result.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        let data;
        try { data = JSON.parse(line); } catch { continue; }
        if (data.id !== id) continue;
        if (data.type === 'error' || data.error) throw new Error(data.error || 'Perintah USB gagal.');
        if (data.type !== expectedType) throw new Error(`Respons board tidak sesuai: ${data.type || 'tidak diketahui'}.`);
        return data;
      }
    }
    throw new Error('Waktu tunggu respons ESP32 melalui USB habis.');
  } catch (error) {
    if (!port.readable.locked) throw error;
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (port.readable.locked) reader.releaseLock();
    if (openedHere && port.readable && port.writable) await port.close().catch(() => {});
  }
}

async function scanUsbPorts() {
  if (!('serial' in navigator)) {
    clearUsbConnection();
    usbConnection.querySelector('span').textContent = window.isSecureContext
      ? 'Web Serial perlu Chrome/Edge desktop'
      : 'USB perlu localhost atau HTTPS';
    document.querySelector('#detect-usb').disabled = true;
    return;
  }
  try {
    const ports = await navigator.serial.getPorts();
    if (state.usbPort && ports.includes(state.usbPort)) {
      showUsbConnection(state.usbPort);
    } else if (ports.length) {
      showUsbConnection(ports[0]);
    } else {
      clearUsbConnection();
    }
  } catch (error) {
    usbConnection.querySelector('span').textContent = `Gagal mendeteksi USB: ${error.message}`;
  }
}

async function detectUsb() {
  if (!('serial' in navigator)) {
    showToast(window.isSecureContext
      ? 'Gunakan Chrome atau Edge desktop untuk mendeteksi board USB.'
      : 'Buka alamat localhost pada komputer yang terhubung ke board untuk mendeteksi USB.', true);
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    showUsbConnection(port);
    showToast('Board terdeteksi lewat USB. Anda bisa lanjut ke Flash firmware.');
  } catch (error) {
    if (error.name === 'NotFoundError') {
      showToast('Port USB belum dipilih. Sambungkan board dengan kabel USB data, lalu coba lagi.', true);
      return;
    }
    showToast(error.message || 'Gagal mendeteksi board USB.', true);
  }
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
document.querySelector('#detect-usb').addEventListener('click', detectUsb);
document.querySelector('#save-url').addEventListener('click', () => {
  const value = document.querySelector('#board-url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[a-z0-9.:[\]-]+$/i.test(value)) {
    showToast('Masukkan alamat lengkap, contoh: http://192.168.1.20', true);
    return;
  }
  state.boardUrl = value;
  localStorage.setItem('boardUrl', value);
  showToast('Alamat ESP32 tersimpan');
  checkConnection();
});

function renderChat() {
  content.innerHTML = `
    <div class="chat-shell">
      <div class="chat-toolbar"><span><i></i> Kamus pengetahuan online · GitHub</span><button id="new-chat" type="button" title="Mulai percakapan baru">＋ Percakapan baru</button></div>
      <div id="chat-messages" class="chat-messages" aria-live="polite"></div>
      <form id="chat-form" class="chat-composer">
        <textarea id="question" rows="1" maxlength="300" placeholder="Tanya dari kamus pengetahuan" aria-label="Tulis pertanyaan" required></textarea>
        <div class="composer-bottom"><span>Perlu internet · typo ringan dicocokkan otomatis</span><button id="ask-button" class="send-button" type="submit" aria-label="Kirim pertanyaan" title="Kirim"><span>↑</span></button></div>
      </form>
      <p class="chat-footnote">Jawaban berasal dari entri kamus JSON; pertanyaan yang belum ada dapat ditambahkan di repositori GitHub.</p>
    </div>`;
  renderChatMessages();
  document.querySelector('#chat-form').addEventListener('submit', sendQuestion);
  document.querySelector('#new-chat').addEventListener('click', () => {
    if (state.chatBusy) return;
    state.chatMessages = [];
    renderChatMessages();
    document.querySelector('#question').focus();
  });
  document.querySelector('#chat-messages').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-message]');
    if (!button) return;
    const message = state.chatMessages[Number(button.dataset.copyMessage)];
    if (!message?.answer) return;
    try {
      await navigator.clipboard.writeText(message.answer);
      showToast('Jawaban disalin.');
    } catch (error) {
      showToast('Tidak dapat menyalin jawaban dari browser ini.', true);
    }
  });
  document.querySelector('#question').addEventListener('input', (event) => {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
  });
  document.querySelector('#question').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      document.querySelector('#chat-form').requestSubmit();
    }
  });
}

function renderChatMessages() {
  const messages = document.querySelector('#chat-messages');
  if (!messages) return;
  if (!state.chatMessages.length) {
    messages.innerHTML = '<div class="chat-welcome"><div class="welcome-mark">AI</div><h1>Ada yang bisa saya bantu?</h1><p>Tanya dengan bahasa sehari-hari. ESP32 mengunduh kamus JSON dari GitHub, lalu mencoba mencocokkan kata kunci termasuk typo ringan.</p></div>';
    return;
  }
  messages.innerHTML = state.chatMessages.map((message, index) => {
    if (message.role === 'user') {
      return `<div class="message-row user-message"><div class="user-bubble">${escapeHtml(message.text)}</div></div>`;
    }
    if (message.pending) {
      const keywordTokens = message.text.match(/[\p{L}\p{N}]+/gu) || [];
      const keywordContent = keywordTokens.length
        ? keywordTokens.map((word) => `<span>${escapeHtml(word)}</span>`).join('')
        : `<span>${escapeHtml(message.text)}</span>`;
      return `<div class="message-row assistant-message"><div class="assistant-mark">AI</div><div class="assistant-body">
        <div class="assistant-status"><span class="spinner"></span> Mengunduh kamus dan mencocokkan pertanyaan…</div>
        <div class="process-log">
          <div class="process-log-heading"><span class="process-log-pulse"></span><strong>Log proses</strong><span class="process-log-running">BERJALAN</span></div>
          <div class="process-keywords"><span class="process-label">KATA KUNCI</span><div class="process-keyword-window"><div class="process-keyword-track">${keywordContent}${keywordContent}</div></div></div>
          <div class="process-log-window"><div class="process-log-list" data-process-log="${index}"></div></div>
        </div>
      </div></div>`;
    }
    if (message.error) {
      return `<div class="message-row assistant-message"><div class="assistant-mark">AI</div><div class="assistant-body">
        <div class="assistant-answer">${escapeHtml(message.errorReply)}</div>
        <p class="assistant-error-detail">${escapeHtml(message.error)}</p>
        ${message.technicalError ? `<details class="assistant-technical"><summary>Detail teknis</summary><p>${escapeHtml(message.technicalError)}</p></details>` : ''}
      </div></div>`;
    }
    const sources = (message.results || []).map((item, sourceIndex) => `
      <a class="source" href="${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">
        <span class="source-number">${sourceIndex + 1}</span>
        <span class="source-content"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.excerpt || 'Buka sumber untuk membaca selengkapnya')}</small></span>
        <span class="external">↗</span>
      </a>`).join('');
    const warnings = (message.warnings || []).map((warning) => `<p class="assistant-warning">${escapeHtml(warning)}</p>`).join('');
    return `<div class="message-row assistant-message"><div class="assistant-mark">AI</div><div class="assistant-body">
      <div class="assistant-answer">${escapeHtml(message.answer)}</div>
      ${message.sourceLabel ? `<div class="sources-label">${escapeHtml(message.sourceLabel)}</div>` : ''}
      ${sources ? `<div class="answer-sources"><div class="sources-label">Sumber web · ${escapeHtml(message.sourceLabel)}</div>${sources}</div>` : ''}
      ${warnings}
      ${message.answer ? `<button class="copy-answer" type="button" data-copy-message="${index}" title="Salin jawaban">▢ <span>Salin</span></button>` : ''}
    </div></div>`;
  }).join('');
  messages.scrollTop = messages.scrollHeight;
}

async function sendQuestion(event) {
  event.preventDefault();
  if (state.chatBusy) return;
  const input = document.querySelector('#question');
  const question = input.value.trim();
  if (!question) return;
  const button = document.querySelector('#ask-button');
  const messageIndex = state.chatMessages.length + 1;
  state.chatMessages.push({ role: 'user', text: question }, { role: 'assistant', pending: true, text: question });
  state.chatBusy = true;
  input.value = '';
  input.disabled = true;
  input.style.height = 'auto';
  button.disabled = true;
  document.querySelector('#new-chat').disabled = true;
  renderChatMessages();
  startChatProgress(messageIndex);
  try {
    const data = await request('/api/chat', { method: 'POST', body: JSON.stringify({ question }) }, state.boardUrl, 45000);
    const warnings = [data.model_warning, data.language_warning, data.translation_warning, data.query_adjustment, ...(data.results || []).map((item) => item.translation_error)].filter(Boolean);
    state.chatMessages[messageIndex] = {
      role: 'assistant',
      answer: data.answer,
      results: data.results || [],
      sourceLabel: data.source_label || 'Kamus JSON online · GitHub',
      warnings: [...new Set(warnings)],
    };
  } catch (error) {
    const timedOut = error.name === 'TimeoutError';
    const connectionFailed = error.name === 'TypeError';
    const friendlyError = timedOut
      ? 'Permintaan ini terlalu lama diproses. Coba kirim lagi sebentar lagi.'
      : connectionFailed
        ? 'Saya tidak bisa menghubungi ESP32. Pastikan perangkat menyala dan ponsel atau komputer terhubung ke jaringan yang sama.'
        : 'Kamus online belum berhasil diperiksa. Pastikan ESP32 tersambung ke Wi-Fi dengan internet, lalu coba lagi.';
    state.chatMessages[messageIndex] = {
      role: 'assistant',
      error: friendlyError,
      errorReply: timedOut || connectionFailed
        ? 'Maaf, saya belum bisa mendapatkan jawaban kali ini.'
        : 'Maaf, saya belum bisa memeriksa kamus online kali ini.',
      technicalError: timedOut ? 'ESP32 tidak memberi respons dalam 45 detik.' : (connectionFailed ? error.message : ''),
    };
  } finally {
    stopChatProgress();
    state.chatBusy = false;
    renderChatMessages();
    button.disabled = false;
    input.disabled = false;
    document.querySelector('#new-chat')?.removeAttribute('disabled');
    input.focus();
  }
}

function startChatProgress(messageIndex) {
  stopChatProgress();
  const log = document.querySelector(`[data-process-log="${messageIndex}"]`);
  if (!log) return;
  const startedAt = Date.now();
  const stages = [
    'Pertanyaan diterima; memeriksa koneksi internet ESP32.',
    'Mengunduh kamus JSON dari repositori GitHub bila belum tersimpan di cache.',
    'Mencocokkan kata-kata pertanyaan dengan variasi ejaan di kamus.',
    'Memilih jawaban dengan kecocokan tertinggi.',
  ];
  let stageIndex = 0;
  let waitingTicks = 0;
  const appendLog = (text, active = false) => {
    if (!log.isConnected) return;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const line = document.createElement('div');
    line.className = `process-log-line${active ? ' active' : ''}`;
    line.innerHTML = `<time>${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}</time><span class="process-log-dot"></span><span>${escapeHtml(text)}</span>`;
    log.append(line);
    while (log.childElementCount > 8) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  };
  appendLog(stages[stageIndex++]);
  state.progressTimer = setInterval(() => {
    if (stageIndex < stages.length) {
      appendLog(stages[stageIndex++], true);
      return;
    }
    waitingTicks += 1;
    if (waitingTicks % 4 === 0) appendLog('ESP32 masih menunggu respons GitHub atau memeriksa kamus.', true);
  }, 1800);
}

function stopChatProgress() {
  if (state.progressTimer !== null) {
    clearInterval(state.progressTimer);
    state.progressTimer = null;
  }
}

function renderWifi() {
  content.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">PENGATURAN PERANGKAT</p><h1>Hubungkan ke Wi-Fi.</h1><p class="subtitle">ESP32 perlu akses internet untuk mengunduh kamus jawaban dari GitHub.</p></div></div>
    <div class="settings-card"><div class="card-header"><span class="card-icon">⌁</span><div><h2>Kredensial jaringan</h2><p>Disimpan di memori NVS perangkat.</p></div><span id="wifi-state" class="state-pill">Mendeteksi ESP32…</span></div>
    <div class="wifi-network-tools"><button id="detect-wifi-device" class="secondary-button" type="button">Deteksi ESP32</button><button id="scan-wifi-networks" class="secondary-button" type="button">Pindai Wi-Fi dengan ESP32</button><button id="use-pc-wifi" class="secondary-button" type="button">Ambil SSID Wi-Fi PC</button><span id="scan-state" class="scan-state">Mencari perangkat…</span></div>
    <form id="wifi-form" class="settings-form"><label for="ssid">SSID Wi-Fi</label><select id="ssid" name="ssid" required><option value="">Pilih Wi-Fi dari hasil scan atau PC</option></select><label for="password">Kata sandi</label><div class="password-control"><input id="password" type="password" maxlength="64" autocomplete="new-password" placeholder="Kata sandi Wi-Fi"><button id="toggle-password" type="button" aria-label="Tampilkan kata sandi" aria-pressed="false">Tampilkan</button></div><label class="checkbox-label"><input id="open-network" type="checkbox"> Jaringan ini tidak memakai kata sandi</label><p class="helper">Pindai jaringan langsung lewat kabel USB; atau ambil SSID Wi-Fi PC melalui localhost, lalu isi kata sandinya. ESP32-S3 hanya mendukung Wi-Fi 2,4 GHz. Jika SSID PC tidak muncul saat scan ESP32, kemungkinan PC tersambung ke jaringan 5 GHz.</p><p id="wifi-save-status" class="wifi-save-status" role="status" aria-live="polite"></p><button id="wifi-save" class="primary-button" type="submit">Simpan &amp; hubungkan <span>→</span></button></form>
    </div><div class="info-card"><span>i</span><p>Hubungkan komputer/ponsel ke Wi-Fi yang sama dengan ESP32 setelah konfigurasi. Alamat perangkat akan tampil di bagian kiri atas.</p></div>`;
  document.querySelector('#detect-wifi-device').addEventListener('click', detectWifiDevice);
  document.querySelector('#scan-wifi-networks').addEventListener('click', scanWifiNetworks);
  document.querySelector('#use-pc-wifi').addEventListener('click', usePcWifi);
  document.querySelector('#wifi-form').addEventListener('submit', saveWifi);
  document.querySelector('#toggle-password').addEventListener('click', () => {
    const password = document.querySelector('#password');
    const toggle = document.querySelector('#toggle-password');
    const reveal = password.type === 'password';
    password.type = reveal ? 'text' : 'password';
    toggle.textContent = reveal ? 'Sembunyikan' : 'Tampilkan';
    toggle.setAttribute('aria-label', reveal ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
    toggle.setAttribute('aria-pressed', String(reveal));
    password.focus();
  });
  document.querySelector('#open-network').addEventListener('change', (event) => {
    const password = document.querySelector('#password');
    password.disabled = event.target.checked;
    document.querySelector('#toggle-password').disabled = event.target.checked;
    if (event.target.checked) password.value = '';
  });
  document.querySelector('#ssid').addEventListener('change', (event) => {
    const isOpen = event.target.selectedOptions[0]?.dataset.open === 'true';
    document.querySelector('#open-network').checked = isOpen;
    document.querySelector('#password').disabled = isOpen;
    document.querySelector('#toggle-password').disabled = isOpen;
  });
  loadWifi();
}

async function detectWifiDevice() {
  if (state.page !== 'wifi') return;
  const wifiState = document.querySelector('#wifi-state');
  const scanState = document.querySelector('#scan-state');
  const detectButton = document.querySelector('#detect-wifi-device');
  detectButton.disabled = true;
  wifiState.textContent = 'Mendeteksi…';
  scanState.textContent = state.usbPort
    ? 'Mengecek ESP32 lewat kabel USB…'
    : 'Mencoba alamat perangkat dan hotspot ESP32…';

  if (state.usbPort) {
    try {
      const data = await sendUsbCommand({ cmd: 'status' }, 'status', 3000);
      state.connection = 'usb';
      wifiState.textContent = data.connected ? 'Wi-Fi tersambung' : 'ESP32 ditemukan via USB';
      wifiState.classList.toggle('connected', data.connected);
      scanState.textContent = 'ESP32 ditemukan lewat USB. Siap memindai jaringan Wi-Fi.';
      connection.classList.add('online');
      connection.querySelector('span').textContent = data.connected
        ? `USB · Wi-Fi ${data.ssid || data.station_ip}`
        : 'ESP32 terdeteksi via USB · Wi-Fi belum terhubung';
      if (data.ssid) addWifiOption(data.ssid, true);
      detectButton.disabled = false;
      await scanWifiNetworks();
      return data;
    } catch (usbError) {
      scanState.textContent = `USB tidak merespons (${usbError.message}); mencoba koneksi Wi-Fi…`;
    }
  }

  try {
    const { address, data } = await discoverEspDevice();
    state.connection = 'network';
    wifiState.textContent = data.connected ? 'Terhubung' : 'ESP32 ditemukan';
    wifiState.classList.toggle('connected', data.connected);
    scanState.textContent = `ESP32 ditemukan otomatis · ${address}`;
    detectButton.disabled = false;
    await scanWifiNetworks();
    return data;
  } catch (error) {
    if (state.usbPort) {
      state.connection = 'usb';
      wifiState.textContent = 'ESP32 terdeteksi via USB';
      scanState.textContent = `Board terdeteksi lewat kabel USB, tetapi firmware belum membalas perintah Wi-Fi (${error.message}). Flash firmware terbaru melalui halaman Flash firmware.`;
      connection.classList.add('online');
      connection.querySelector('span').textContent = 'ESP32 terdeteksi via USB · belum tersambung ke Wi-Fi';
    } else {
      wifiState.textContent = 'ESP32 tidak ditemukan';
      scanState.textContent = `${error.message} Sambungkan board ke USB atau hubungkan komputer dan board ke Wi-Fi yang sama.`;
      connection.classList.remove('online');
      connection.querySelector('span').textContent = 'ESP32 tidak ditemukan di jaringan';
    }
    detectButton.disabled = false;
    return null;
  }
}

async function loadWifi() {
  if (state.page !== 'wifi') return;
  document.querySelector('#scan-state').textContent = 'Mendeteksi ESP32…';
  usePcWifi(true);
  try {
    const data = await detectWifiDevice();
    if (!data || state.page !== 'wifi') return;
    if (data.ssid) addWifiOption(data.ssid, true);
    document.querySelector('#wifi-state').textContent = data.connected ? 'Terhubung' : 'Belum terhubung';
    document.querySelector('#wifi-state').classList.toggle('connected', data.connected);
  } catch (error) {
    const wifiState = document.querySelector('#wifi-state');
    const scanState = document.querySelector('#scan-state');
    if (wifiState) wifiState.textContent = 'Gagal mendeteksi';
    if (scanState) scanState.textContent = error.message;
  }
}

function addWifiOption(ssid, select = false, isOpen = false, isPcWifi = false) {
  const selectElement = document.querySelector('#ssid');
  if (!selectElement) return;
  let option = [...selectElement.options].find((item) => item.value === ssid);
  if (!option) {
    option = document.createElement('option');
    option.value = ssid;
    selectElement.append(option);
  }
  if (isPcWifi) option.dataset.pcWifi = 'true';
  option.textContent = `${ssid}${option.dataset.pcWifi === 'true' ? ' · Wi-Fi PC' : ''}${isOpen ? ' · terbuka' : ''}`;
  if (isOpen || option.dataset.open === undefined) option.dataset.open = String(isOpen);
  if (select) selectElement.value = ssid;
}

async function usePcWifi(automatic = false) {
  const button = document.querySelector('#use-pc-wifi');
  const scanState = document.querySelector('#scan-state');
  button.disabled = true;
  scanState.textContent = 'Membaca SSID Wi-Fi PC…';
  try {
    const response = await fetch('/api/host-wifi', { signal: AbortSignal.timeout(6000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `PC membalas HTTP ${response.status}`);
    if (!data.ssid) {
      scanState.textContent = data.error || 'SSID Wi-Fi PC tidak tersedia.';
      if (!automatic) showToast(scanState.textContent, true);
      return null;
    }
    addWifiOption(data.ssid, true, false, true);
    const selectedOption = document.querySelector('#ssid').selectedOptions[0];
    document.querySelector('#open-network').checked = false;
    document.querySelector('#password').disabled = false;
    document.querySelector('#password').focus();
    scanState.textContent = `SSID PC dipilih: ${data.ssid}. Masukkan sandi Wi-Fi di bawah.`;
    return selectedOption;
  } catch (error) {
    scanState.textContent = error.message;
    if (!automatic) showToast(error.message, true);
    return null;
  } finally {
    button.disabled = false;
  }
}

async function scanWifiNetworks() {
  if (state.page !== 'wifi') return;
  const button = document.querySelector('#scan-wifi-networks');
  const scanState = document.querySelector('#scan-state');
  if (!button || !scanState) return;
  button.disabled = true;
  scanState.textContent = 'ESP32 sedang memindai jaringan…';
  try {
    let data;
    if (state.connection === 'usb' && state.usbPort) {
      data = await sendUsbCommand({ cmd: 'scan' }, 'scan');
    } else {
      try {
        data = await request('/api/wifi/scan');
        state.connection = 'network';
      } catch (networkError) {
        if (!state.usbPort) throw networkError;
        state.connection = 'usb';
        data = await sendUsbCommand({ cmd: 'scan' }, 'scan');
      }
    }
    if (state.page !== 'wifi') return;
    const selected = document.querySelector('#ssid').value;
    for (const network of data.networks || []) addWifiOption(network.ssid, network.ssid === selected, network.open);
    const select = document.querySelector('#ssid');
    const savedSsid = select.dataset.savedSsid;
    if (savedSsid && [...select.options].some((option) => option.value === savedSsid)) select.value = savedSsid;
    scanState.textContent = data.networks?.length
      ? `${data.networks.length} jaringan ditemukan oleh ESP32`
      : 'Tidak ada SSID yang terlihat. Coba pindai lagi.';
  } catch (error) {
    scanState.textContent = `Pemindaian gagal: ${error.message}`;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function saveWifi(event) {
  event.preventDefault();
  const button = document.querySelector('#wifi-save');
  const wifiState = document.querySelector('#wifi-state');
  const scanState = document.querySelector('#scan-state');
  const saveStatus = document.querySelector('#wifi-save-status');
  const passwordInput = document.querySelector('#password');
  const ssid = document.querySelector('#ssid').value.trim();
  const openNetwork = document.querySelector('#open-network').checked ||
    document.querySelector('#ssid').selectedOptions[0]?.dataset.open === 'true';
  if (!ssid) {
    showToast('Pilih jaringan Wi-Fi terlebih dahulu.', true);
    return;
  }
  const networkAddress = state.boardUrl;
  const usingUsb = state.connection === 'usb' && state.usbPort;
  button.disabled = true;
  wifiState.textContent = 'Menyambungkan…';
  wifiState.classList.remove('connected');
  scanState.textContent = 'Mengirim pengaturan Wi-Fi ke ESP32…';
  saveStatus.textContent = `Menghubungkan ke “${ssid}”…`;
  button.innerHTML = '<span class="spinner"></span> Menyambungkan…';
  try {
    const wifiCredentials = {
      ssid,
      password: passwordInput.value,
      open_network: openNetwork,
    };
    let savedSsid = ssid;
    if (usingUsb) {
      const saved = await sendUsbCommand({ cmd: 'set_wifi', ...wifiCredentials }, 'wifi_saved', 8000);
      savedSsid = saved.ssid || ssid;
    } else {
      const saved = await request(
        '/api/wifi',
        { method: 'POST', body: JSON.stringify(wifiCredentials) },
        networkAddress,
        8000,
      );
      savedSsid = saved.ssid || ssid;
    }
    let connectedStatus = null;
    const attempts = 12;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      scanState.textContent = `Menunggu ESP32 tersambung ke “${savedSsid}”… (${attempt + 1}/${attempts})`;
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const status = usingUsb
          ? await sendUsbCommand({ cmd: 'status' }, 'status', 2500)
          : await request('/api/status', {}, networkAddress, 3000);
        if (status.connected) {
          connectedStatus = status;
          break;
        }
      } catch (error) {
        if (usingUsb && !state.usbPort) throw new Error('Koneksi USB ke ESP32 terputus saat menyambungkan Wi-Fi.');
      }
    }
    if (!connectedStatus) {
      wifiState.textContent = 'Belum terhubung';
      scanState.textContent = `Pengaturan untuk “${savedSsid}” sudah disimpan, tetapi ESP32 belum tersambung. Periksa kata sandi dan pastikan jaringan 2,4 GHz. Anda dapat mencoba lagi.`;
      saveStatus.textContent = 'Belum berhasil tersambung. Periksa kata sandi, dukungan 2,4 GHz, lalu coba lagi.';
      showToast('ESP32 belum tersambung. Periksa SSID, kata sandi, dan jaringan 2,4 GHz.', true);
      return;
    }
    const stationIp = connectedStatus.station_ip;
    if (stationIp && stationIp !== '0.0.0.0') {
      state.boardUrl = `http://${stationIp}`;
      document.querySelector('#board-url').value = state.boardUrl;
      localStorage.setItem('boardUrl', state.boardUrl);
    }
    wifiState.textContent = 'Wi-Fi tersambung';
    wifiState.classList.add('connected');
    scanState.textContent = `ESP32 berhasil tersambung ke “${connectedStatus.ssid || savedSsid}”.`;
    saveStatus.textContent = `Berhasil tersambung ke “${connectedStatus.ssid || savedSsid}”.`;
    showToast(`Wi-Fi tersambung${stationIp && stationIp !== '0.0.0.0' ? ` · ${stationIp}` : ''}`);
    checkConnection();
  } catch (error) {
    wifiState.textContent = 'Gagal menyambungkan';
    scanState.textContent = `Penyambungan gagal: ${error.message}`;
    saveStatus.textContent = `Penyambungan gagal: ${error.message}`;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Simpan &amp; hubungkan <span>→</span>';
  }
}

function renderFlash() {
  content.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">PEMASANGAN FIRMWARE</p><h1>Flash ESP32-S3.</h1><p class="subtitle">Hubungkan board melalui USB dan pilih berkas hasil build PlatformIO.</p></div></div>
    <div class="flash-card">
      <div class="flash-steps"><div class="step active"><span>1</span><div><strong>Pilih firmware</strong><small>Satu berkas gabungan</small></div></div><div class="step-line"></div><div class="step"><span>2</span><div><strong>Hubungkan board</strong><small>USB · browser Chromium</small></div></div><div class="step-line"></div><div class="step"><span>3</span><div><strong>Flash perangkat</strong><small>Jangan cabut kabel USB</small></div></div></div>
      <label class="file-row" for="firmware-file"><span class="file-symbol">BIN</span><span class="file-text"><strong>Firmware lengkap ESP32-S3</strong><small id="firmware-name">Pilih firmware-esp32s3.bin (bootloader + partisi + aplikasi)</small></span><span class="file-action">Pilih file</span><input id="firmware-file" type="file" accept=".bin,application/octet-stream"></label>
      <div id="flash-progress" class="progress-area" hidden><div class="progress-label"><span id="flash-message">Menyiapkan flash…</span><b id="flash-percent">0%</b></div><div class="progress-track"><i id="progress-value"></i></div><pre id="flash-log"></pre></div>
      <button id="flash-button" class="primary-button flash-button"><span>⇧</span> Hubungkan &amp; flash</button><p class="flash-hint">Sambungkan board ke komputer yang membuka halaman ini dengan kabel USB data. Setelah klik tombol, pilih port COM/USB ESP32-S3 di dialog browser.</p>
      <div id="flash-origin-help" class="origin-help" hidden><strong>Browser memblokir akses USB dari alamat IP ini.</strong><p>Buka aplikasi melalui localhost di komputer yang terhubung langsung ke board.</p><a id="localhost-link" class="localhost-link">Buka halaman flash di komputer ini ↗</a></div>
    </div>
    <div class="info-card"><span>i</span><p>Web Serial memerlukan Chrome/Edge desktop dan origin aman. Untuk penggunaan lokal, buka <code>http://localhost:5173</code> di komputer yang terhubung langsung ke board; alamat IP LAN HTTP tidak dapat membuka koneksi USB. Alternatifnya, buka halaman ini melalui HTTPS yang sertifikatnya dipercaya browser. Build dengan <code>pio run</code>; pilih <code>firmware-esp32s3.bin</code>. Flash menghapus NVS, jadi atur ulang Wi-Fi sesudahnya.</p></div>`;
  const originHelp = document.querySelector('#flash-origin-help');
  if (!window.isSecureContext || !('serial' in navigator)) {
    originHelp.hidden = false;
    const localhostLink = document.querySelector('#localhost-link');
    localhostLink.href = `${location.protocol}//localhost${location.port ? `:${location.port}` : ''}/`;
    localhostLink.target = '_blank';
    localhostLink.rel = 'noopener noreferrer';
  }
  document.querySelector('#firmware-file').addEventListener('change', (event) => {
    const file = event.target.files[0];
    document.querySelector('#firmware-name').textContent = file
      ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`
      : 'Pilih firmware-esp32s3.bin (bootloader + partisi + aplikasi)';
  });
  document.querySelector('#flash-button').addEventListener('click', flashBoard);
}

async function flashBoard() {
  if (!('serial' in navigator)) {
    const message = window.isSecureContext
      ? 'Koneksi serial tidak tersedia. Gunakan Chrome atau Edge desktop, lalu pastikan board terhubung lewat USB data.'
      : 'USB diblokir pada alamat IP HTTP ini. Di komputer yang terhubung ke board, buka localhost menggunakan tautan pada halaman flash.';
    showToast(message, true);
    return;
  }
  const firmware = document.querySelector('#firmware-file').files[0];
  if (!firmware) {
    showToast('Pilih berkas firmware-esp32s3.bin terlebih dahulu.', true);
    return;
  }
  const button = document.querySelector('#flash-button');
  const progress = document.querySelector('#flash-progress');
  const log = document.querySelector('#flash-log');
  button.disabled = true;
  progress.hidden = false;
  log.textContent = '';
  const terminal = {
    clean() { log.textContent = ''; },
    writeLine(message) { log.textContent += `${message}\n`; log.scrollTop = log.scrollHeight; },
    write(message) { log.textContent += message; log.scrollTop = log.scrollHeight; },
  };
  let transport;
  try {
    const port = state.usbPort || await navigator.serial.requestPort();
    transport = new Transport(port, true);
    const loader = new ESPLoader({ transport, baudrate: 460800, romBaudrate: 115200, terminal });
    document.querySelector('#flash-message').textContent = 'Menghubungkan ke ESP32…';
    await loader.main();
    const image = await toBinaryString(firmware);
    document.querySelector('#flash-message').textContent = 'Menulis firmware ke flash…';
    await loader.writeFlash({
      fileArray: [{ data: image, address: 0x0 }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex, written, total) => {
        const percent = total ? Math.min(100, Math.round((written / total) * 100)) : 0;
        document.querySelector('#flash-percent').textContent = `${percent}%`;
        document.querySelector('#progress-value').style.width = `${percent}%`;
      },
    });
    document.querySelector('#flash-message').textContent = 'Flash berhasil. Board sedang reboot…';
    document.querySelector('#flash-percent').textContent = 'Selesai';
    showToast('Firmware berhasil dipasang.');
  } catch (error) {
    document.querySelector('#flash-message').textContent = 'Flash gagal';
    terminal.writeLine(`\nERROR: ${error.message}`);
    showToast(error.message || 'Proses flash gagal.', true);
  } finally {
    if (transport) {
      try { await transport.disconnect(); } catch (error) { console.warn('Serial disconnect:', error); }
    }
    button.disabled = false;
  }
}

async function toBinaryString(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return binary;
}

let toastTimer;
function showToast(message, isError = false) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' toast-error' : ''}`;
  toast.textContent = message;
  document.body.append(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 5000);
}

setPage('chat');
checkConnection();
setInterval(checkConnection, 10000);
scanUsbPorts();
if ('serial' in navigator) {
  navigator.serial.addEventListener('connect', (event) => {
    scanUsbPorts();
  });
  navigator.serial.addEventListener('disconnect', (event) => {
    clearUsbConnection(event.port);
    scanUsbPorts();
  });
}
