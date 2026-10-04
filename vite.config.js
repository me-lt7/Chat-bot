import { execFile } from 'node:child_process';
import os from 'node:os';
import { defineConfig } from 'vite';

function hostWifiPlugin() {
  function sendJson(response, statusCode, body) {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  }

  return {
    name: 'local-host-wifi',
    configureServer(server) {
      server.middlewares.use('/api/host-wifi', (request, response, next) => {
        const hostHeader = String(request.headers.host || '');
        const host = (hostHeader.startsWith('[')
          ? hostHeader.slice(1, hostHeader.indexOf(']'))
          : hostHeader.split(':')[0]).toLowerCase();
        if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
          sendJson(response, 403, { error: 'Baca SSID PC hanya diizinkan melalui localhost.' });
          return;
        }
        if (request.method !== 'GET') return next();
        if (os.platform() !== 'win32') {
          sendJson(response, 501, { error: 'Deteksi SSID otomatis PC saat ini hanya tersedia di Windows.' });
          return;
        }

        execFile('netsh', ['wlan', 'show', 'interfaces'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
          if (error) {
            sendJson(response, 503, { error: 'Tidak dapat membaca jaringan Wi-Fi PC. Pastikan Wi-Fi PC sedang tersambung.' });
            return;
          }
          const match = stdout.match(/^\s*SSID\s*:\s*(.+?)\s*$/im);
          const ssid = match?.[1]?.trim();
          if (!ssid) {
            sendJson(response, 200, {
              ssid: null,
              error: 'SSID PC tidak tersedia (tidak ada adapter Wi-Fi atau PC belum tersambung). Wi-Fi tetap bisa dipindai langsung oleh ESP32 melalui USB.',
            });
            return;
          }
          sendJson(response, 200, { ssid });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [hostWifiPlugin()],
  server: {
    watch: {
      ignored: ['**/.pio/**', '**/dist/**'],
    },
  },
});
