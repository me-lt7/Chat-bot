# ESP32 Chat-bot

Firmware ESP32-S3 dan antarmuka web chat yang mengambil jawaban dari kamus JSON publik di GitHub. Jawaban dan variasi pertanyaan disimpan di `data/knowledge_id.json`, bukan di firmware. Firmware mengunduh kamus ketika pertanyaan pertama dikirim, menyimpannya di RAM sampai board dimulai ulang, lalu mencocokkan kata pertanyaan dengan variasi yang ada. Pencocokan kata memakai jarak edit untuk membantu typo ringan.

Kamus saat ini berisi entri pengetahuan umum berbahasa Indonesia dan variasi pertanyaan. Kamus bukan AI generatif dan tidak dapat menjawab semua pertanyaan; perluas dengan kontribusi entri baru yang ditulis dan diperiksa manusia. Jangan menyalin kumpulan data pihak lain tanpa memastikan lisensi dan atribusinya.

## Perangkat

- ESP32-S3 DevKitC-1-N8, flash 8 MB tanpa PSRAM.
- PlatformIO Core.
- Node.js 20+ untuk UI.
- Chrome atau Edge desktop untuk Web Serial saat flashing.

ESP32 perlu terhubung ke Wi-Fi dengan akses internet agar dapat mengunduh kamus dari GitHub. Setelah unduhan berhasil, salinan kamus disimpan di RAM sampai board dimulai ulang. Mulai ulang ESP32 setelah memperbarui JSON di GitHub agar versi baru diunduh.

## Menambah pengetahuan

Edit `data/knowledge_id.json` pada branch `main`. Setiap item berisi beberapa variasi cara bertanya dan satu jawaban:

```json
{
  "questions": ["apa itu contoh", "jelaskan contoh", "contoh adalah apa"],
  "answer": "Tulis jawaban ringkas, jelas, dan sudah diperiksa."
}
```

Tambahkan variasi ejaan atau cara bertanya yang lazim. Jaga JSON valid, jangan masukkan kredensial atau data pribadi, lalu commit/push perubahan. Firmware membaca berkas publik:

`https://raw.githubusercontent.com/me-lt7/Chat-bot/main/data/knowledge_id.json`

Koreksi typo membandingkan kata pertanyaan dengan kata pada variasi kamus menggunakan jarak edit. Kata yang sangat pendek tidak dikoreksi secara fuzzy untuk mengurangi kecocokan keliru. Algoritme ini tidak mengerti konteks; jawaban yang muncul berasal dari entri dengan skor kecocokan tertinggi. Jika tak ada skor yang cukup, bot akan menyarankan kata kunci yang lebih spesifik.

## Build firmware

```sh
pio run
```

Build menghasilkan `firmware-esp32s3.bin` di folder proyek. Bin gabungan berisi bootloader, tabel partisi, `boot_app0`, dan aplikasi untuk flash mulai dari `0x0`. Flash firmware melalui halaman **Flash firmware** di UI. Flash gabungan menghapus NVS, sehingga kredensial Wi-Fi perlu diatur kembali.

## Jalankan antarmuka web

```sh
npm install
npm run dev
```

Buka URL localhost yang ditampilkan Vite. Sambungkan ke access point `ESP32-GitHub-AI` (kata sandi `esp32setup`) dan gunakan alamat board awal `http://192.168.4.1`. Atur Wi-Fi ESP32 melalui halaman **Wi-Fi**; chat memerlukan koneksi internet pada board.

## Tata letak repository

- `data/knowledge_id.json` — kamus jawaban dan variasi pertanyaan yang diunduh ESP32.
- `src/main.cpp` — firmware, pengunduh JSON, cache RAM, dan pencocokan typo.
- `src/main.js` — UI chat, flashing, dan konfigurasi Wi-Fi.
- `platformio.ini` — konfigurasi build PlatformIO.
