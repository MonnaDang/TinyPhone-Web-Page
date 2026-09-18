# TinyPhone Web Companion

Last updated: 2026-09-18

This is the dependency-free companion website included with TinyPhone. Its
normal Vietnamese interface has two pages, **Ảnh** and **Nhạc**, with one shared
TinyPhone connection. Image/audio conversion and upload happen locally inside
the browser; source photos and songs are never sent to a server.

The recipient-facing interface hides storage filenames, RGB565, PCM16, CRC32,
TAR packaging, and SD paths. The same conversion engines remain available in
the collapsed **Công cụ nâng cao** section for development and maintenance.
The smaller portal embedded in firmware remains in `web/media_portal/` for the
separate phone/Wi-Fi workflow.

## Open the app

The published GitHub Pages site is the normal entry point:

```text
https://monnadang.github.io/TinyPhone-Web-Page/
```

Use desktop Chrome or Edge. Click **Kết nối TinyPhone**, choose **USB Serial
Device** the first time, then use **Ảnh** or **Nhạc**. Web Serial sends prepared
bytes directly to the firmware; no Python program, local server, browser
extension, or installed app is required.
The current firmware uses the ESP32-S3 native USB-OTG connector as a TinyUSB
CDC device. Web Serial requires a nominal baud value when opening the port, but
native USB CDC transfer speed is not controlled by that value.

The verified native device identifies as Espressif USB `303A:1001` and normally
appears in the picker as **USB Serial Device**. The first connection requires
the browser permission picker. On later visits, the companion reuses that
previously authorized TinyPhone port automatically when it is available.

The firmware acknowledges 16 KiB CDC blocks only after the preceding package
data has been consumed, and streams music entries directly into transactional
SD `.part` files. The shared TFT/SD wiring now uses a conservative 2 MHz SD
clock with 512-byte write slices. Before final apply, TinyPhone remounts the SD,
verifies staged WAV size/format, and then commits the tracks and playlist.

Website progress reserves 0-90% for USB transfer and 95% for SD verification
and apply. It reaches 100% only after TinyPhone returns `DONE`; receiving every
USB byte is therefore not shown as a successful SD installation.

Do not open `index.html` directly with a `file://` URL. Browser audio and folder
APIs require an HTTP or HTTPS origin. GitHub Pages provides the required HTTPS
origin. Close PlatformIO's serial monitor before connecting because only one
program can own the COM port. The browser performs crop, RGB565/WAV conversion,
metadata generation, TAR packaging, CRC32, and USB CDC transfer internally.

The legacy-named Python command-line uploader also uses native USB CDC and
remains an optional development fallback. Pass the Espressif CDC COM port:

```powershell
$tinyPhoneCdcPort = "COM7" # Example only; use the current USB Serial Device port.
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" tools\uart_media_upload.py TinyPhone-media.tar --port $tinyPhoneCdcPort
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" tools\uart_media_upload.py wallpaper.bin --wallpaper-slot 8 --port $tinyPhoneCdcPort
```

## Wallpaper output

- Input: JPG, PNG, or WebP supported by the browser.
- Interactive crop-to-fill or fit-with-border framing.
- Output: exactly 320 x 240 pixels.
- Encoding: LVGL 9 RGB565, little endian.
- Size: 153,612 bytes (12-byte header and 153,600-byte pixel payload).
- Filename: one of the 16 wallpaper slots recognized by the current
  firmware, or `lock.bin` for the fallback lock wallpaper.
- The normal **Ảnh** editor supports dragging, zooming, crop-to-fill, and
  fit-with-border before saving directly to TinyPhone.
- The 17 fixed targets are lock screen plus wallpaper slots 1–16. Friendly
  display names are stored in browser site data and never rename firmware files.

## Music output

- Input: audio formats supported by the current browser, normally MP3, M4A,
  WAV, AAC, and Ogg in current desktop browsers.
- Output: RIFF/WAVE, mono PCM16 little endian, 22,050 Hz.
- Maximum: 16 tracks per package or browser conversion batch; upload multiple
  packages to reach the firmware's 100-track installed catalog.
- Metadata: UTF-8 `playlist.csv` with editable filename, title, and artist.
- Filenames: lowercase ASCII with underscores and a `.wav` extension.

Chromium browsers expose **Save music folder**, which writes all converted WAV
files and `playlist.csv` into a selected `/music` directory. Other browsers can
download each WAV and the playlist separately.

The normal **Nhạc** action converts unfinished tracks, builds the package in
memory, and sends it directly over USB. Advanced tools can still download a
`TinyPhone-media.tar`, individual WAV files, and `playlist.csv` from the same
conversion results.

Songs already installed on TinyPhone include a confirmed **Xóa** action. The
website sends `UDELETE` over USB; firmware stages the playlist update, removes
the WAV and its metadata row, rescans the music library, and returns the
refreshed inventory.

## GitHub Pages

The public `MonnaDang/TinyPhone-Web-Page` repository publishes this website
with `.github/workflows/pages.yml`. Its source lives at the repository root,
while the firmware repository keeps a private development copy under `web/`.
The expected project URL is:

```text
https://monnadang.github.io/TinyPhone-Web-Page/
```

The deployed page can both prepare downloads and transfer directly through a
user-selected COM port with Web Serial. The separate Wi-Fi portal remains
available from TinyPhone at `http://192.168.4.1`.
