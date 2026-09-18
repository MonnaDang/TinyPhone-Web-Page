"use strict";

const TARGET_WIDTH = 320;
const TARGET_HEIGHT = 240;
const PREVIEW_SCALE = 2;
const MAX_PACKAGE_TRACKS = 16;
const AUDIO_SAMPLE_RATE = 22050;
const PACKAGE_PLAYLIST_MAX_BYTES = 4095;
const MAX_MUSIC_FILE_BYTES = 50 * 1024 * 1024;
const PACKAGE_MARKER = "TINYPHONE_MEDIA_PACKAGE_V1\n";
const TINYPHONE_USB_VENDOR_ID = 0x303a;
const TINYPHONE_USB_PRODUCT_ID = 0x1001;
const TINYPHONE_CDC_OPEN_OPTIONS = {
  // Web Serial requires this value. Native USB CDC does not use it as a
  // physical UART baud rate.
  baudRate: 115200,
  bufferSize: 32768,
};

const wallpaperNames = [
  "01_nuibaden.bin",
  "02_dianvoit.bin",
  "03_nhintudinhnui.bin",
  "04_tuyensiudepgai.bin",
  "05_tuyendepppgaiii.bin",
  "06_tuyenncuteee.bin",
  "07_tuyennghiemmtucc.bin",
  "08_tuyenvoikesach.bin",
  "09_wallpaper.bin",
  "10_wallpaper.bin",
  "11_wallpaper.bin",
  "12_wallpaper.bin",
  "13_wallpaper.bin",
  "14_wallpaper.bin",
  "15_wallpaper.bin",
  "16_wallpaper.bin",
  "lock.bin",
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let toastTimer;
function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "chưa rõ thời lượng";
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Tabs
for (const tab of $$(".tab-button")) {
  tab.addEventListener("click", () => {
    for (const candidate of $$(".tab-button")) {
      const active = candidate === tab;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-selected", String(active));
      $(`#${candidate.dataset.tab}`).hidden = !active;
    }
  });
}

// Shared drag-and-drop setup.
function setupDropZone(zone, handleFiles) {
  for (const eventName of ["dragenter", "dragover"]) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragging");
    });
  }
  zone.addEventListener("drop", (event) => handleFiles([...event.dataTransfer.files]));
}

// Wallpaper tool
const cropCanvas = $("#crop-canvas");
const cropContext = cropCanvas.getContext("2d", { alpha: false });
const imageState = {
  source: null,
  sourceName: "",
  mode: "cover",
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  background: "#fff7fa",
  dragging: false,
  pointerX: 0,
  pointerY: 0,
};
let selectedPhotoSlot = 0;
let selectedPhotoFile = null;
let photoNameTouched = false;

async function decodeImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Hãy chọn ảnh JPG, PNG hoặc WebP.");
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (_error) {
      return await createImageBitmap(file);
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadImageFile(file) {
  if (!file) return false;
  try {
    const decoded = await decodeImage(file);
    if (imageState.source?.close) imageState.source.close();
    imageState.source = decoded;
    imageState.sourceName = file.name;
    selectedPhotoFile = file;
    resetImagePosition();
    $("#preview-placeholder").hidden = true;
    $("#download-bin").disabled = false;
    $("#download-preview").disabled = false;
    if (!photoNameTouched) {
      $("#photo-display-name").value =
        file.name.replace(/\.[^.]+$/, "").trim() || defaultPhotoLabel(selectedPhotoSlot);
    }
    renderImagePreview();
    updateTransferButtons();
    setFriendlyStatus("photo", "idle", "Ảnh đã sẵn sàng", "Kéo ảnh hoặc thu phóng nếu cậu muốn.");
    return true;
  } catch (error) {
    setFriendlyStatus("photo", "error", "Chưa thể mở ảnh này", "Hãy thử một ảnh JPG, PNG hoặc WebP khác.", error);
    return false;
  }
}

function baseImageScale() {
  if (!imageState.source) return 1;
  const widthScale = TARGET_WIDTH / imageState.source.width;
  const heightScale = TARGET_HEIGHT / imageState.source.height;
  return imageState.mode === "cover" ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale);
}

function clampImageOffsets() {
  if (!imageState.source) return;
  const scale = baseImageScale() * imageState.zoom;
  const drawnWidth = imageState.source.width * scale;
  const drawnHeight = imageState.source.height * scale;
  const maxX = Math.abs(drawnWidth - TARGET_WIDTH) / 2;
  const maxY = Math.abs(drawnHeight - TARGET_HEIGHT) / 2;
  imageState.offsetX = Math.max(-maxX, Math.min(maxX, imageState.offsetX));
  imageState.offsetY = Math.max(-maxY, Math.min(maxY, imageState.offsetY));
}

function drawPreparedImage(context, outputWidth, outputHeight) {
  context.save();
  context.fillStyle = imageState.background;
  context.fillRect(0, 0, outputWidth, outputHeight);
  if (imageState.source) {
    const outputScale = outputWidth / TARGET_WIDTH;
    const scale = baseImageScale() * imageState.zoom * outputScale;
    const drawWidth = imageState.source.width * scale;
    const drawHeight = imageState.source.height * scale;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      imageState.source,
      (outputWidth - drawWidth) / 2 + imageState.offsetX * outputScale,
      (outputHeight - drawHeight) / 2 + imageState.offsetY * outputScale,
      drawWidth,
      drawHeight,
    );
  }
  context.restore();
}

function renderImagePreview() {
  cropContext.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  drawPreparedImage(cropContext, cropCanvas.width, cropCanvas.height);
}

function resetImagePosition() {
  imageState.zoom = 1;
  imageState.offsetX = 0;
  imageState.offsetY = 0;
  $("#zoom-range").value = "1";
  $("#zoom-output").value = "100%";
  renderImagePreview();
}

$("#image-input").addEventListener("change", (event) => loadImageFile(event.target.files[0]));
setupDropZone($("#image-drop-zone"), (files) => loadImageFile(files.find((file) => file.type.startsWith("image/"))));

$("#fit-mode").addEventListener("change", (event) => {
  imageState.mode = event.target.value;
  $("#border-color-field").hidden = imageState.mode !== "contain";
  $("#fit-help").textContent = imageState.mode === "cover"
    ? "Ảnh sẽ lấp đầy màn hình; một phần nhỏ ở cạnh có thể được cắt."
    : "Toàn bộ ảnh sẽ hiện ra, phần còn trống được lấp bằng màu viền.";
  resetImagePosition();
});

$("#zoom-range").addEventListener("input", (event) => {
  imageState.zoom = Number(event.target.value);
  $("#zoom-output").value = `${Math.round(imageState.zoom * 100)}%`;
  clampImageOffsets();
  renderImagePreview();
});

$("#border-color").addEventListener("input", (event) => {
  imageState.background = event.target.value;
  $("#border-color-value").textContent = event.target.value.toUpperCase();
  renderImagePreview();
});

$("#reset-position").addEventListener("click", resetImagePosition);

cropCanvas.addEventListener("pointerdown", (event) => {
  if (!imageState.source) return;
  imageState.dragging = true;
  imageState.pointerX = event.clientX;
  imageState.pointerY = event.clientY;
  cropCanvas.setPointerCapture(event.pointerId);
});

cropCanvas.addEventListener("pointermove", (event) => {
  if (!imageState.dragging) return;
  const rect = cropCanvas.getBoundingClientRect();
  imageState.offsetX += (event.clientX - imageState.pointerX) * TARGET_WIDTH / rect.width;
  imageState.offsetY += (event.clientY - imageState.pointerY) * TARGET_HEIGHT / rect.height;
  imageState.pointerX = event.clientX;
  imageState.pointerY = event.clientY;
  clampImageOffsets();
  renderImagePreview();
});

function endImageDrag(event) {
  imageState.dragging = false;
  if (cropCanvas.hasPointerCapture?.(event.pointerId)) cropCanvas.releasePointerCapture(event.pointerId);
}
cropCanvas.addEventListener("pointerup", endImageDrag);
cropCanvas.addEventListener("pointercancel", endImageDrag);

function makeOutputCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = TARGET_WIDTH;
  canvas.height = TARGET_HEIGHT;
  drawPreparedImage(canvas.getContext("2d", { alpha: false }), TARGET_WIDTH, TARGET_HEIGHT);
  return canvas;
}

function makeLvglRgb565Blob() {
  const outputCanvas = makeOutputCanvas();
  const rgba = outputCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, TARGET_WIDTH, TARGET_HEIGHT).data;
  const buffer = new ArrayBuffer(12 + TARGET_WIDTH * TARGET_HEIGHT * 2);
  const view = new DataView(buffer);
  view.setUint32(0, 0x19 | (0x12 << 8), true);
  view.setUint32(4, TARGET_WIDTH | (TARGET_HEIGHT << 16), true);
  view.setUint32(8, TARGET_WIDTH * 2, true);
  let outputOffset = 12;
  for (let inputOffset = 0; inputOffset < rgba.length; inputOffset += 4) {
    const value = ((rgba[inputOffset] & 0xf8) << 8)
      | ((rgba[inputOffset + 1] & 0xfc) << 3)
      | (rgba[inputOffset + 2] >> 3);
    view.setUint16(outputOffset, value, true);
    outputOffset += 2;
  }
  return new Blob([buffer], { type: "application/octet-stream" });
}

$("#download-bin").addEventListener("click", () => {
  if (!imageState.source) return;
  const filename = $("#wallpaper-slot").value;
  if (!wallpaperNames.includes(filename)) return;
  downloadBlob(makeLvglRgb565Blob(), filename);
  showToast(`Đã chuẩn bị ${filename}.`);
});

$("#download-preview").addEventListener("click", () => {
  if (!imageState.source) return;
  makeOutputCanvas().toBlob((blob) => {
    if (!blob) return;
    const sourceStem = imageState.sourceName.replace(/\.[^.]+$/, "") || "wallpaper";
    downloadBlob(blob, `${sourceStem}_320x240.png`);
  }, "image/png");
});

renderImagePreview();

// Music tool
let tracks = [];
let trackSequence = 0;
let conversionRunning = false;
let sdRefreshBusy = false;
let transferBusy = false;
let serialSession = null;
let serialConnectBusy = false;
let sdInventory = {
  wallpapers: [],
  music: [],
  playlist: { present: false, size: 0, name: "playlist.csv" },
};

function parseTrackName(filename) {
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  const parts = stem.split(/\s*[-–—]\s*/).filter(Boolean);
  return {
    title: parts[0] || stem || "Chưa có tên",
    artist: parts.slice(1).join(" - "),
  };
}

function asciiSlug(value, maxLength = 76) {
  return value
    .replace(/[đĐ]/g, (character) => character === "đ" ? "d" : "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength) || "track";
}

function normalizedWavFilename(value, fallback = "track") {
  const withoutExtension = value.replace(/\.wav$/i, "");
  return `${asciiSlug(withoutExtension || fallback, 76)}.wav`;
}

function assignAutomaticFilenames() {
  const reserved = new Set(sdInventory.music.map((file) => file.name.toLowerCase()));
  const usedNumbers = new Set(
    sdInventory.music
      .map((file) => /^(\d{2,3})_/.exec(file.name)?.[1])
      .filter(Boolean)
      .map(Number),
  );
  let sequence = 1;
  tracks.forEach((track) => {
    const label = [track.title, track.artist].filter(Boolean).join("_");
    while (usedNumbers.has(sequence) && sequence <= 100) sequence++;
    let filename;
    do {
      filename = `${String(sequence).padStart(2, "0")}_${asciiSlug(label, 72)}.wav`;
      usedNumbers.add(sequence++);
    } while (reserved.has(filename.toLowerCase()) && sequence <= 999);
    track.filename = filename;
    reserved.add(filename.toLowerCase());
  });
}

function addAudioFiles(files) {
  const audioFiles = files.filter((file) => file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name));
  const room = MAX_PACKAGE_TRACKS - tracks.length;
  if (room <= 0) {
    showToast("Mỗi lần có thể thêm tối đa 16 bài hát.", true);
    return;
  }
  const accepted = audioFiles.slice(0, room);
  if (accepted.length) $("#music-status").hidden = true;
  for (const file of accepted) {
    const guessed = parseTrackName(file.name);
    tracks.push({
      id: ++trackSequence,
      file,
      filename: "",
      title: guessed.title,
      artist: guessed.artist,
      duration: null,
      wavBlob: null,
      state: "queued",
      status: "Đang chờ",
    });
  }
  assignAutomaticFilenames();
  renderTrackList();
  if (audioFiles.length > accepted.length) showToast(`Đã chọn đủ ${MAX_PACKAGE_TRACKS} bài cho lần thêm này.`, true);
  else if (accepted.length) showToast(`Đã chọn ${accepted.length} bài hát.`);
}

$("#audio-input").addEventListener("change", (event) => {
  addAudioFiles([...event.target.files]);
  event.target.value = "";
});
setupDropZone($("#audio-drop-zone"), addAudioFiles);

function duplicateFilenames() {
  const counts = new Map();
  for (const track of tracks) {
    const key = track.filename.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function playlistCsv() {
  const cleanField = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  const quote = (value) => {
    const clean = cleanField(value);
    return /[",]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
  };
  const rows = ["file,title,artist", ...tracks.map((track) => [track.filename, track.title, track.artist].map(quote).join(","))];
  return `${rows.join("\r\n")}\r\n`;
}

function writeTarText(target, offset, text, length = text.length) {
  const encoded = new TextEncoder().encode(text);
  target.set(encoded.subarray(0, length), offset);
}

function writeTarOctal(target, offset, length, value) {
  const encoded = Math.floor(value).toString(8).padStart(length - 1, "0");
  writeTarText(target, offset, encoded.slice(-(length - 1)));
  target[offset + length - 1] = 0;
}

function makeTarHeader(name, size) {
  if (!/^[\x20-\x7e]+$/.test(name) || new TextEncoder().encode(name).length > 100) {
    throw new Error(`Đường dẫn trong gói TAR không hợp lệ: ${name}`);
  }
  const header = new Uint8Array(512);
  writeTarText(header, 0, name, 100);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, "ustar\0", 6);
  writeTarText(header, 263, "00", 2);
  writeTarText(header, 265, "TinyPhone", 32);
  writeTarText(header, 297, "TinyPhone", 32);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeTarText(header, 148, checksum.toString(8).padStart(6, "0"), 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function appendTarEntry(parts, name, blob) {
  parts.push(makeTarHeader(name, blob.size), blob);
  const padding = (512 - (blob.size % 512)) % 512;
  if (padding) parts.push(new Uint8Array(padding));
}

function makeMediaPackage() {
  const parts = [];
  appendTarEntry(
    parts,
    "tinyphone-package.txt",
    new Blob([PACKAGE_MARKER], { type: "text/plain" }),
  );
  appendTarEntry(
    parts,
    "music/playlist_append.csv",
    new Blob([playlistCsv()], { type: "text/csv;charset=utf-8" }),
  );
  tracks.forEach((track) => {
    appendTarEntry(parts, `music/${track.filename}`, track.wavBlob);
  });
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: "application/x-tar" });
}

function validateMusicProject(requireConverted = false) {
  if (!tracks.length) return "Hãy thêm ít nhất một bài hát trước.";
  const duplicates = duplicateFilenames();
  if (duplicates.size) return `Tên tệp bị trùng: ${[...duplicates][0]}`;
  for (const track of tracks) {
    if (!/^[a-z0-9][a-z0-9_]*\.wav$/.test(track.filename)) return `Tên tệp TinyPhone không hợp lệ: ${track.filename}`;
    if (track.filename.length > 80) return `Tên tệp quá dài: ${track.filename}`;
    if (!track.title.trim()) return `Hãy thêm tên bài hát cho ${track.filename}.`;
    if (new TextEncoder().encode(track.title).length >= 96) return `Tên bài hát quá dài: ${track.filename}.`;
    if (new TextEncoder().encode(track.artist).length >= 64) return `Tên ca sĩ quá dài: ${track.filename}.`;
    if (requireConverted && !track.wavBlob) return `${track.filename} chưa được chuyển đổi.`;
  }
  const installed = installedMusicNames();
  const newCount = tracks.filter((track) => !installed.has(track.filename.toLowerCase())).length;
  if (sdInventory.music.length + newCount > 100) return "Lần thêm này sẽ vượt quá giới hạn 100 bài hát trên TinyPhone.";
  if (new TextEncoder().encode(playlistCsv()).length > PACKAGE_PLAYLIST_MAX_BYTES) return "Thông tin danh sách phát trong gói lớn hơn 4 KiB.";
  return "";
}

function renderTrackList() {
  const list = $("#track-list");
  const advancedList = $("#advanced-track-list");
  list.replaceChildren();
  advancedList.replaceChildren();

  tracks.forEach((track, index) => {
    const card = document.createElement("article");
    card.className = "track-card";
    card.dataset.trackId = String(track.id);

    const number = document.createElement("span");
    number.className = "track-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const main = document.createElement("div");
    main.className = "track-main";
    const copy = document.createElement("div");
    copy.className = "track-copy";
    const title = document.createElement("strong");
    title.textContent = track.title || "Chưa có tên";
    const artist = document.createElement("span");
    artist.textContent = track.artist || "Chưa rõ ca sĩ";
    copy.append(title, artist);
    main.append(copy);

    if (track.editing) {
      const editor = document.createElement("div");
      editor.className = "track-edit";
      const titleLabel = document.createElement("label");
      titleLabel.textContent = "Tên bài hát";
      const titleInput = document.createElement("input");
      titleInput.value = track.title;
      titleInput.maxLength = 95;
      const artistLabel = document.createElement("label");
      artistLabel.textContent = "Ca sĩ";
      const artistInput = document.createElement("input");
      artistInput.value = track.artist;
      artistInput.maxLength = 63;
      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.textContent = "Lưu tên";
      const saveEdit = () => {
        track.title = titleInput.value.trim() || "Chưa có tên";
        track.artist = artistInput.value.trim();
        track.editing = false;
        track.wavBlob = null;
        track.state = "queued";
        track.status = "Đang chờ";
        assignAutomaticFilenames();
        renderTrackList();
      };
      saveButton.addEventListener("click", saveEdit);
      titleLabel.append(titleInput);
      artistLabel.append(artistInput);
      editor.append(titleLabel, artistLabel, saveButton);
      main.append(editor);
    }

    const menu = document.createElement("details");
    menu.className = "track-menu";
    const menuButton = document.createElement("summary");
    menuButton.textContent = "⋯";
    menuButton.setAttribute("aria-label", `Tùy chọn cho ${track.title}`);
    const menuPanel = document.createElement("div");
    menuPanel.className = "track-menu-panel";
    const menuAction = (label, handler, disabled = false, className = "") => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = disabled;
      button.className = className;
      button.addEventListener("click", handler);
      return button;
    };
    menuPanel.append(
      menuAction("Di chuyển lên", () => moveTrack(index, -1), index === 0 || conversionRunning),
      menuAction("Di chuyển xuống", () => moveTrack(index, 1), index === tracks.length - 1 || conversionRunning),
      menuAction("Đổi tên", () => { track.editing = true; renderTrackList(); }, conversionRunning),
      menuAction("Xóa khỏi danh sách này", () => removeTrack(track.id), conversionRunning, "danger"),
    );
    menu.append(menuButton, menuPanel);

    const technical = document.createElement("article");
    technical.className = "advanced-track-row";
    const technicalSummary = document.createElement("strong");
    technicalSummary.textContent = `${String(index + 1).padStart(2, "0")} · ${track.title}`;
    const technicalCopy = document.createElement("p");
    technicalCopy.textContent = `${formatBytes(track.file.size)} · ${formatDuration(track.duration)} · ${track.status}`;
    const filenameLabel = document.createElement("label");
    filenameLabel.textContent = "Tên tệp SD ";
    const filenameInput = document.createElement("input");
    filenameInput.value = track.filename;
    filenameInput.maxLength = 80;
    filenameInput.disabled = conversionRunning;
    filenameInput.addEventListener("change", () => {
      track.filename = normalizedWavFilename(filenameInput.value, track.title);
      renderTrackList();
    });
    filenameLabel.append(filenameInput);
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Tải WAV";
    download.disabled = !track.wavBlob || conversionRunning;
    download.addEventListener("click", () => downloadBlob(track.wavBlob, track.filename));
    technical.append(technicalSummary, technicalCopy, filenameLabel, download);

    card.append(number, main, menu);
    list.append(card);
    advancedList.append(technical);
  });

  const hasTracks = tracks.length > 0;
  if (!hasTracks) {
    const emptyAdvanced = document.createElement("p");
    emptyAdvanced.className = "field-help";
    emptyAdvanced.textContent = "Chọn nhạc ở trang Nhạc để xem tên tệp và tải WAV.";
    advancedList.append(emptyAdvanced);
  }
  const statusVisible = !$("#music-status").hidden;
  $("#music-empty-state").hidden = hasTracks;
  $("#music-output").hidden = !hasTracks;
  $("#music-save-area").hidden = !hasTracks && !statusVisible;
  $("#save-music").hidden = !hasTracks;
  $("#track-count").textContent = `${tracks.length} bài hát mới`;
  $("#conversion-size").textContent = hasTracks
    ? "Kiểm tra tên bài hát và ca sĩ trước khi thêm."
    : "Sẵn sàng khi cậu chọn nhạc";
  $("#auto-filenames").disabled = !hasTracks || conversionRunning;
  $("#clear-tracks").disabled = !hasTracks || conversionRunning;
  $("#convert-all").disabled = !hasTracks || conversionRunning;
  $("#download-package").disabled = !hasTracks || conversionRunning;
  $("#download-playlist").disabled = !hasTracks || conversionRunning;
  $("#save-folder").disabled = !hasTracks || conversionRunning || tracks.some((track) => !track.wavBlob);
  updateTransferButtons();
}

function makeTrackField(label, value, property, track, maxLength) {
  const wrapper = document.createElement("div");
  wrapper.className = "track-field";
  const labelElement = document.createElement("label");
  const input = document.createElement("input");
  input.id = `track-${track.id}-${property}`;
  labelElement.htmlFor = input.id;
  labelElement.textContent = label;
  input.value = value;
  input.maxLength = maxLength;
  input.disabled = conversionRunning;
  input.addEventListener("change", () => {
    track[property] = property === "filename"
      ? normalizedWavFilename(input.value, track.title)
      : input.value.trim();
    renderTrackList();
  });
  wrapper.append(labelElement, input);
  return wrapper;
}

function makeIconButton(text, label, handler, disabled, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${extraClass}`.trim();
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}

function moveTrack(index, direction) {
  const destination = index + direction;
  if (destination < 0 || destination >= tracks.length) return;
  [tracks[index], tracks[destination]] = [tracks[destination], tracks[index]];
  renderTrackList();
}

function removeTrack(id) {
  tracks = tracks.filter((track) => track.id !== id);
  renderTrackList();
}

$("#auto-filenames").addEventListener("click", () => {
  assignAutomaticFilenames();
  renderTrackList();
  showToast("Đã tạo lại tên tệp an toàn.");
});

$("#clear-tracks").addEventListener("click", () => {
  tracks = [];
  $("#music-status").hidden = true;
  renderTrackList();
});

async function resampleToMono(decodedBuffer) {
  const frameCount = Math.max(1, Math.ceil(decodedBuffer.duration * AUDIO_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frameCount, AUDIO_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decodedBuffer;
  source.connect(offline.destination);
  source.start(0);
  return await offline.startRendering();
}

async function encodeMonoPcm16Wav(samples) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, AUDIO_SAMPLE_RATE, true);
  view.setUint32(28, AUDIO_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  const yieldEvery = 262144;
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    if (index > 0 && index % yieldEvery === 0) await nextPaint();
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function convertTrack(track, index, total) {
  track.state = "working";
  track.status = "Đang chuẩn bị";
  $("#progress-title").textContent = `Đang chuẩn bị bài ${index + 1} / ${total}`;
  $("#progress-detail").textContent = track.title;
  $("#conversion-progress").value = index / total;
  setFriendlyStatus("music", "working", "Đang chuẩn bị nhạc...", track.title, null, index / total);
  renderTrackList();
  await nextPaint();

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !window.OfflineAudioContext) throw new Error("Trình duyệt này không hỗ trợ chuyển đổi âm thanh.");
  const decoder = new AudioContextClass();
  try {
    const sourceBytes = await track.file.arrayBuffer();
    const decoded = await decoder.decodeAudioData(sourceBytes.slice(0));
    track.duration = decoded.duration;
    track.status = "Đang chuyển đổi";
    renderTrackList();
    await nextPaint();
    const rendered = await resampleToMono(decoded);
    track.status = "Sắp xong";
    renderTrackList();
    await nextPaint();
    track.wavBlob = await encodeMonoPcm16Wav(rendered.getChannelData(0));
    track.state = "ready";
    track.status = "Đã sẵn sàng";
  } finally {
    await decoder.close().catch(() => {});
  }
}

async function runConversions(selectedTracks) {
  const validationError = validateMusicProject(false);
  if (validationError) {
    showToast(validationError, true);
    return;
  }
  conversionRunning = true;
  renderTrackList();
  try {
    for (let index = 0; index < selectedTracks.length; index++) {
      const track = selectedTracks[index];
      try {
        await convertTrack(track, index, selectedTracks.length);
      } catch (error) {
        track.state = "error";
        track.status = "Không thể đọc tệp này";
        track.wavBlob = null;
        showToast(`Không thể chuẩn bị ${track.title}.`, true);
      }
    }
  } finally {
    conversionRunning = false;
    $("#conversion-progress").value = 1;
    const ready = tracks.filter((track) => track.wavBlob).length;
    $("#progress-title").textContent = `${ready} / ${tracks.length} bài đã sẵn sàng`;
    $("#progress-detail").textContent = ready === tracks.length
      ? "Có thể tải gói xuống hoặc thêm trực tiếp vào TinyPhone."
      : "Một tệp nhạc chưa được trình duyệt hỗ trợ.";
    renderTrackList();
    if (ready === tracks.length) setFriendlyStatus("music", "working", "Nhạc đã được chuẩn bị", "Đang tạo gói an toàn...", null, 0.72);
  }
}

async function convertSingleTrack(id) {
  const track = tracks.find((candidate) => candidate.id === id);
  if (track) await runConversions([track]);
}

$("#convert-all").addEventListener("click", () => runConversions(tracks));

$("#download-package").addEventListener("click", async () => {
  let error = validateMusicProject(false);
  if (error) return showToast(error, true);

  const pending = tracks.filter((track) => !track.wavBlob);
  if (pending.length) await runConversions(pending);

  error = validateMusicProject(true);
  if (error) return showToast(error, true);
  const oversized = tracks.find(
    (track) => track.wavBlob.size > MAX_MUSIC_FILE_BYTES,
  );
  if (oversized) {
    return showToast(
      `${oversized.filename} vượt quá giới hạn 50 MiB cho mỗi bài hát.`,
      true,
    );
  }

  try {
    const mediaPackage = makeMediaPackage();
    downloadBlob(mediaPackage, "TinyPhone-media.tar");
    $("#progress-title").textContent = "Gói nhạc đã sẵn sàng";
    $("#progress-detail").textContent =
      `${tracks.length} tệp WAV và thông tin danh sách phát · ${formatBytes(mediaPackage.size)}`;
    showToast("Đã tải TinyPhone-media.tar.");
  } catch (packageError) {
    showToast(
      packageError.message || "Không thể tạo gói nhạc.",
      true,
    );
  }
});

$("#download-playlist").addEventListener("click", () => {
  const error = validateMusicProject(false);
  if (error) return showToast(error, true);
  downloadBlob(new Blob([playlistCsv()], { type: "text/csv;charset=utf-8" }), "playlist.csv");
});

async function writeBlobToDirectory(directory, filename, blob) {
  const handle = await directory.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function existingFilenames(directory, filenames) {
  const existing = [];
  for (const filename of filenames) {
    try {
      await directory.getFileHandle(filename);
      existing.push(filename);
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
  }
  return existing;
}

if ("showDirectoryPicker" in window) {
  $("#save-folder").hidden = false;
  $("#save-note").textContent = "Có thể tạo TinyPhone-media.tar, lưu toàn bộ thư mục /music hoặc tải từng tệp riêng lẻ.";
}

$("#save-folder").addEventListener("click", async () => {
  const error = validateMusicProject(true);
  if (error) return showToast(error, true);
  try {
    const root = await window.showDirectoryPicker({ mode: "readwrite" });
    const musicDirectory = await root.getDirectoryHandle("music", { create: true });
    const filenames = [...tracks.map((track) => track.filename), "playlist.csv"];
    const conflicts = await existingFilenames(musicDirectory, filenames);
    if (conflicts.length) {
      const preview = conflicts.slice(0, 3).join(", ");
      const remainder = conflicts.length > 3 ? ` và ${conflicts.length - 3} tệp khác` : "";
      const confirmed = window.confirm(`Thay thế các tệp đã có trong /music?\n\n${preview}${remainder}`);
      if (!confirmed) return;
    }
    for (let index = 0; index < tracks.length; index++) {
      $("#progress-title").textContent = `Đang lưu ${index + 1} / ${tracks.length}`;
      $("#progress-detail").textContent = tracks[index].filename;
      $("#conversion-progress").value = index / tracks.length;
      await writeBlobToDirectory(musicDirectory, tracks[index].filename, tracks[index].wavBlob);
    }
    await writeBlobToDirectory(musicDirectory, "playlist.csv", new Blob([playlistCsv()], { type: "text/csv;charset=utf-8" }));
    $("#conversion-progress").value = 1;
    $("#progress-title").textContent = "Đã lưu thư mục nhạc";
    $("#progress-detail").textContent = "Thư mục đã có đầy đủ tệp WAV và playlist.csv.";
    showToast("Đã lưu thư mục nhạc TinyPhone.");
  } catch (error) {
    if (error.name !== "AbortError") showToast(error.message || "Không thể ghi thư mục nhạc.", true);
  }
});

renderTrackList();

// Shared native USB CDC service. Both recipient-facing pages use the same
// conversion engines and transfer session as the advanced export tools.

function isTinyPhoneCdcPort(port) {
  if (!port?.getInfo) return false;
  const { usbVendorId, usbProductId } = port.getInfo();
  return usbVendorId === TINYPHONE_USB_VENDOR_ID &&
    usbProductId === TINYPHONE_USB_PRODUCT_ID;
}

function friendlySerialError(error) {
  if (error?.name === "NotFoundError") return "Đã hủy kết nối";
  if (error?.name === "SecurityError") {
    return "Hãy mở trang này bằng Chrome hoặc Edge trên máy tính.";
  }
  if (error?.name === "NetworkError" || error?.name === "InvalidStateError") {
    return "Kết nối USB đang được ứng dụng khác sử dụng. Hãy đóng Serial Monitor rồi thử lại.";
  }
  return "Không thể kết nối TinyPhone.";
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

async function crc32Blob(blob) {
  let crc = 0xffffffff;
  const sliceSize = 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += sliceSize) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + sliceSize).arrayBuffer());
    for (const byte of bytes) crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function installedMusicNames() {
  return new Set(sdInventory.music.map((file) => file.name.toLowerCase()));
}

function replacementNames() {
  const installed = installedMusicNames();
  return tracks
    .map((track) => track.filename.toLowerCase())
    .filter((name) => installed.has(name));
}

const PHOTO_LABELS_STORAGE_KEY = "tinyphone.photo-labels.v1";

function defaultPhotoLabel(slot) {
  return slot === 0 ? "Màn hình khóa" : `Ảnh ${slot}`;
}

function readPhotoLabels() {
  try {
    const value = JSON.parse(localStorage.getItem(PHOTO_LABELS_STORAGE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (_error) {
    return {};
  }
}

function photoDisplayName(slot) {
  return readPhotoLabels()[slot] || defaultPhotoLabel(slot);
}

function savePhotoDisplayName(slot, name) {
  const labels = readPhotoLabels();
  const clean = String(name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 60);
  if (clean && clean !== defaultPhotoLabel(slot)) labels[slot] = clean;
  else delete labels[slot];
  try { localStorage.setItem(PHOTO_LABELS_STORAGE_KEY, JSON.stringify(labels)); } catch (_error) {}
}

function setFriendlyStatus(scope, state, title, detail, error = null, progress = null) {
  const container = $(`#${scope}-status`);
  if (!container) return;
  container.hidden = false;
  container.dataset.state = state;
  $(`#${scope}-status-title`).textContent = title;
  $(`#${scope}-status-detail`).textContent = detail || "";
  const progressElement = $(`#${scope}-progress`);
  progressElement.hidden = progress === null && state !== "working";
  if (progress === null) progressElement.removeAttribute("value");
  else progressElement.value = Math.max(0, Math.min(1, progress));
  const technical = $(`#${scope}-error-detail`);
  technical.textContent = error?.message || String(error || "");
  technical.closest("details").hidden = !technical.textContent;
  const action = scope === "photo" ? $("#save-photo") : $("#save-music");
  if (action) {
    action.textContent = state === "error"
      ? "Thử lại"
      : (scope === "photo" ? "Lưu vào TinyPhone" : "Thêm vào TinyPhone");
  }
}

function readableInstalledTrackName(filename) {
  const stem = filename
    .replace(/\.wav$/i, "")
    .replace(/^\d{2,3}_/, "")
    .replace(/_+/g, " ")
    .trim();
  return stem ? stem.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Bài hát";
}

function setInstalledMusicStatus(message, isError = false) {
  const status = $("#installed-music-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
  if (!isError) status.removeAttribute("title");
  status.hidden = !message;
}

async function deleteInstalledTrack(file) {
  if (!serialSession?.ready || transferBusy) return;
  const title = readableInstalledTrackName(file.name);
  if (!window.confirm(`Xóa “${title}” khỏi TinyPhone?`)) return;

  transferBusy = true;
  updateTransferButtons();
  setInstalledMusicStatus(`Đang xóa “${title}”...`);
  renderInstalledMusic();
  try {
    await serialSession.deleteMusic(file.name);
    sdInventory.music = sdInventory.music.filter(
      (item) => item.name.toLowerCase() !== file.name.toLowerCase(),
    );
    renderInstalledMusic();
    $("#summary-music").textContent = `${sdInventory.music.length} / 100`;
    $("#summary-music-progress").value = sdInventory.music.length;
    await refreshSdInventory(false);
    setInstalledMusicStatus(`✓ Đã xóa “${title}” khỏi TinyPhone.`);
    showToast(`Đã xóa “${title}” khỏi TinyPhone.`);
  } catch (error) {
    setInstalledMusicStatus(
      `Chưa thể xóa “${title}”. Kiểm tra kết nối rồi thử lại.`,
      true,
    );
    $("#installed-music-status").title = error?.message || "";
    showToast(`Chưa thể xóa “${title}”.`, true);
  } finally {
    transferBusy = false;
    updateTransferButtons();
    renderInstalledMusic();
  }
}

function makeSdFileRow(name, size, present, onReplace) {
  const row = document.createElement("div");
  row.className = `sd-file${present ? "" : " is-empty"}`;
  const filename = document.createElement("span");
  filename.className = "sd-file-name";
  filename.textContent = name;
  filename.title = name;
  const fileSize = document.createElement("span");
  fileSize.className = "sd-file-size";
  fileSize.textContent = present ? formatBytes(size) : "Còn trống";
  row.append(filename, fileSize);
  if (onReplace) {
    const replace = document.createElement("button");
    replace.type = "button";
    replace.textContent = present ? "Thay thế" : "Sử dụng";
    replace.addEventListener("click", onReplace);
    row.append(replace);
  }
  return row;
}

function selectPhotoSlot(slot) {
  selectedPhotoSlot = slot;
  selectedPhotoFile = null;
  photoNameTouched = false;
  if (imageState.source?.close) imageState.source.close();
  imageState.source = null;
  imageState.sourceName = "";
  $("#image-input").value = "";
  $("#preview-placeholder").hidden = false;
  $("#download-bin").disabled = true;
  $("#download-preview").disabled = true;
  $("#photo-display-name").value = photoDisplayName(slot);
  $("#photo-editor-title").textContent = photoDisplayName(slot);
  $("#photo-slot-label").textContent = slot === 0 ? "Màn hình khóa" : `Vị trí ảnh ${slot}`;
  $("#photo-status").hidden = true;
  $("#photo-editor").hidden = false;
  resetImagePosition();
  updateTransferButtons();
  $("#photo-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPhotoGallery() {
  const gallery = $("#photo-gallery");
  gallery.replaceChildren();
  const inventoryBySlot = new Map(sdInventory.wallpapers.map((item) => [item.slot, item]));
  const connected = Boolean(serialSession?.ready);
  let presentCount = 0;
  for (let slot = 0; slot <= 16; slot++) {
    const item = inventoryBySlot.get(slot);
    const present = Boolean(item?.present);
    if (present) presentCount++;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `photo-card${present ? " is-present" : ""}`;
    const art = document.createElement("span");
    art.className = "photo-card-art";
    art.innerHTML = `<span aria-hidden="true">${slot === 0 ? "♡" : "▧"}</span><i aria-hidden="true"></i>`;
    const copy = document.createElement("span");
    copy.className = "photo-card-copy";
    const title = document.createElement("strong");
    title.textContent = photoDisplayName(slot);
    const status = document.createElement("small");
    status.textContent = connected ? (present ? "Đã có ảnh" : "Còn trống") : "Chọn để thay ảnh";
    copy.append(title, status);
    card.append(art, copy);
    card.addEventListener("click", () => selectPhotoSlot(slot));
    gallery.append(card);
  }
  $("#photo-count").textContent = connected ? String(presentCount) : "—";
}

function renderInstalledMusic() {
  const list = $("#installed-music-list");
  list.replaceChildren();
  const connected = Boolean(serialSession?.ready);
  if (!connected || sdInventory.music.length === 0) {
    const empty = document.createElement("div");
    empty.className = "installed-empty";
    empty.textContent = connected ? "TinyPhone chưa có bài hát nào." : "Kết nối TinyPhone để xem danh sách nhạc.";
    list.append(empty);
  } else {
    sdInventory.music.forEach((file, index) => {
      const row = document.createElement("article");
      row.className = "music-row";
      const number = document.createElement("span");
      number.className = "music-number";
      number.textContent = String(index + 1).padStart(2, "0");
      const copy = document.createElement("div");
      copy.className = "music-copy";
      const title = document.createElement("strong");
      title.textContent = readableInstalledTrackName(file.name);
      const detail = document.createElement("span");
      detail.textContent = "Đã có trên TinyPhone";
      copy.append(title, detail);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-installed-button";
      remove.textContent = "Xóa";
      remove.disabled = transferBusy;
      remove.setAttribute("aria-label", `Xóa ${title.textContent} khỏi TinyPhone`);
      remove.addEventListener("click", () => deleteInstalledTrack(file));
      row.append(number, copy, remove);
      list.append(row);
    });
  }
  $("#music-installed-count").textContent = connected ? String(sdInventory.music.length) : "—";
  $("#installed-music-summary").textContent = connected
    ? `${sdInventory.music.length} bài hát · Chọn Xóa để gỡ bài hát.`
    : "Kết nối TinyPhone để xem danh sách.";
}

function renderSdInventory() {
  const wallpaperList = $("#sd-wallpaper-list");
  const musicList = $("#sd-music-list");
  wallpaperList.replaceChildren();
  musicList.replaceChildren();

  const presentWallpapers = sdInventory.wallpapers.filter((file) => file.present).length;
  $("#sd-browser-summary").textContent =
    `${presentWallpapers}/${sdInventory.wallpapers.length} ảnh · ${sdInventory.music.length}/100 bài hát`;
  $("#sd-layout").hidden = false;

  for (const file of sdInventory.wallpapers) {
    wallpaperList.append(makeSdFileRow(file.name, file.size, file.present, null));
  }

  musicList.append(makeSdFileRow(
    sdInventory.playlist.name,
    sdInventory.playlist.size,
    sdInventory.playlist.present,
    null,
  ));
  for (const file of sdInventory.music) {
    musicList.append(makeSdFileRow(file.name, file.size, true, null));
  }

  renderPhotoGallery();
  renderInstalledMusic();
  $("#summary-lock").textContent = sdInventory.wallpapers.find((file) => file.slot === 0)?.present ? "1 / 1" : "0 / 1";
  const normalPhotoCount = sdInventory.wallpapers.filter((file) => file.slot > 0 && file.present).length;
  $("#summary-photos").textContent = `${normalPhotoCount} / 16`;
  $("#summary-photo-progress").value = normalPhotoCount;
  $("#summary-music").textContent = `${sdInventory.music.length} / 100`;
  $("#summary-music-progress").value = sdInventory.music.length;
  $("#summary-good").textContent = "✓ Mọi thứ đều ổn";
}

async function refreshSdInventory(showErrors = true) {
  if (!serialSession?.ready || sdRefreshBusy) return false;
  sdRefreshBusy = true;
  $("#sd-refresh").disabled = true;
  $("#sd-browser-summary").textContent = "Đang đọc nội dung TinyPhone...";
  try {
    sdInventory = await serialSession.listFiles();
    if (tracks.length) assignAutomaticFilenames();
    renderTrackList();
    renderSdInventory();
    return true;
  } catch (error) {
    $("#sd-browser-summary").textContent = "Chưa thể đọc nội dung TinyPhone.";
    if (showErrors) showToast("Chưa thể đọc nội dung TinyPhone. Hãy kiểm tra kết nối rồi thử lại.", true);
    return false;
  } finally {
    sdRefreshBusy = false;
    $("#sd-refresh").disabled = !serialSession?.ready || transferBusy;
  }
}

class TinyPhoneSerialSession {
  constructor(onStateChange) {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readTask = null;
    this.decoder = new TextDecoder();
    this.textBuffer = "";
    this.tokens = [];
    this.tokenWaiter = null;
    this.closing = false;
    this.ready = false;
    this.onStateChange = onStateChange;
  }

  async connect(authorizedPort = null) {
    if (!("serial" in navigator)) throw new Error("Trình duyệt này không hỗ trợ Web Serial.");
    this.port = authorizedPort || await navigator.serial.requestPort({
      filters: [{
        usbVendorId: TINYPHONE_USB_VENDOR_ID,
        usbProductId: TINYPHONE_USB_PRODUCT_ID,
      }],
    });
    if (!isTinyPhoneCdcPort(this.port)) {
      throw new Error("Hãy chọn cổng USB gốc của TinyPhone, hiển thị là USB Serial Device.");
    }
    try {
      await this.port.open(TINYPHONE_CDC_OPEN_OPTIONS);
      await this.configureCdcSignals();
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.readTask = this.readLoop();
      this.onStateChange("waiting", "Đang chờ TinyPhone phản hồi...");
      await this.handshake();
      this.ready = true;
      this.onStateChange("connected", "Đã kết nối TinyPhone qua USB");
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async configureCdcSignals() {
    if (!this.port) return;
    // Arduino TinyUSB CDC uses DTR to recognize an attached host and permit
    // device-to-browser writes. Leave RTS untouched because the ESP32-S3 also
    // uses its native USB interface for boot/debug control before the app runs.
    try {
      await this.port.setSignals({
        dataTerminalReady: true,
      });
    } catch (_error) {
      // Some host drivers do not expose modem-control signals.
    }
  }

  async handshake() {
    const deadline = Date.now() + 20000;
    this.tokens.length = 0;
    while (Date.now() < deadline) {
      await this.writeLine("UHELLO");
      try {
        const token = await this.waitToken(1400);
        if (token === "HELLO") return;
        if (token.startsWith("ERROR ")) throw new Error(token.slice(6));
      } catch (error) {
        if (error.message !== "TinyPhone phản hồi quá lâu.") throw error;
      }
    }
    throw new Error("TinyPhone không phản hồi. Hãy đóng Serial Monitor, nhấn RESET một lần rồi thử lại.");
  }

  async listFiles() {
    if (!this.ready || !this.writer) throw new Error("Hãy kết nối TinyPhone trước.");
    this.tokens.length = 0;
    await this.writeLine("ULIST");
    await this.waitForToken((token) => token === "LIST BEGIN", 12000);
    const inventory = {
      wallpapers: [],
      music: [],
      playlist: { present: false, size: 0, name: "playlist.csv" },
    };
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const token = await this.waitToken(Math.max(1, deadline - Date.now()));
      if (token.startsWith("ERROR ")) throw new Error(token.slice(6));
      if (token.startsWith("LIST END ")) {
        inventory.wallpapers.sort((a, b) => a.slot - b.slot);
        inventory.music.sort((a, b) => a.name.localeCompare(b.name));
        return inventory;
      }
      let match = /^WALL (\d+) ([01]) (\d+) (\S+)$/.exec(token);
      if (match) {
        inventory.wallpapers.push({
          slot: Number.parseInt(match[1], 10),
          present: match[2] === "1",
          size: Number.parseInt(match[3], 10),
          name: match[4],
        });
        continue;
      }
      match = /^PLAYLIST ([01]) (\d+) (\S+)$/.exec(token);
      if (match) {
        inventory.playlist = {
          present: match[1] === "1",
          size: Number.parseInt(match[2], 10),
          name: match[3],
        };
        continue;
      }
      match = /^MUSIC (\d+) (\S+)$/.exec(token);
      if (match) {
        inventory.music.push({
          size: Number.parseInt(match[1], 10),
          name: match[2],
        });
      }
    }
    throw new Error("TinyPhone phản hồi quá lâu khi đọc danh sách tệp.");
  }

  async readLoop() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.textBuffer += this.decoder.decode(value, { stream: true });
        const lines = this.textBuffer.split(/\r?\n/);
        this.textBuffer = lines.pop() || "";
        for (const line of lines) {
          const marker = line.indexOf("@TU ");
          if (marker >= 0) this.emitToken(line.slice(marker + 4).trim());
        }
      }
    } catch (error) {
      if (!this.closing) this.failPending(error);
    } finally {
      if (!this.closing) {
        this.ready = false;
        this.onStateChange("error", "TinyPhone đã ngắt kết nối");
      }
    }
  }

  emitToken(token) {
    if (!token) return;
    if (this.tokenWaiter) {
      const waiter = this.tokenWaiter;
      this.tokenWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(token);
    } else {
      this.tokens.push(token);
    }
  }

  failPending(error) {
    if (!this.tokenWaiter) return;
    const waiter = this.tokenWaiter;
    this.tokenWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  waitToken(timeoutMs) {
    if (this.tokens.length) return Promise.resolve(this.tokens.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.tokenWaiter?.timer === timer) this.tokenWaiter = null;
        reject(new Error("TinyPhone phản hồi quá lâu."));
      }, timeoutMs);
      this.tokenWaiter = { resolve, reject, timer };
    });
  }

  async waitForToken(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const token = await this.waitToken(Math.max(1, deadline - Date.now()));
      if (token.startsWith("ERROR ")) throw new Error(token.slice(6));
      if (predicate(token)) return token;
    }
    throw new Error("TinyPhone phản hồi quá lâu.");
  }

  async writeLine(line) {
    if (!this.writer) throw new Error("TinyPhone chưa được kết nối.");
    await this.writer.write(new TextEncoder().encode(`${line}\n`));
  }

  async upload(command, blob, onProgress) {
    if (!this.ready || !this.writer) throw new Error("Hãy kết nối TinyPhone trước.");
    this.tokens.length = 0;
    await this.writeLine(command);
    const readyToken = await this.waitForToken((token) => token.startsWith("READY "), 12000);
    const chunkSize = Number.parseInt(readyToken.slice(6), 10);
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 65536) {
      throw new Error("TinyPhone trả về kích thước khối truyền không hợp lệ.");
    }

    let sent = 0;
    const startedAt = performance.now();
    while (sent < blob.size) {
      const bytes = new Uint8Array(await blob.slice(sent, sent + chunkSize).arrayBuffer());
      await this.writer.write(bytes);
      sent += bytes.byteLength;
      const ack = await this.waitForToken((token) => token.startsWith("ACK "), 20000);
      const acknowledged = Number.parseInt(ack.slice(4), 10);
      if (acknowledged !== sent) throw new Error(`Xác nhận truyền dữ liệu không khớp tại ${sent} byte.`);
      const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
      // Receiving is only the first 90% of the operation. The remaining range
      // is reserved for the device-side remount, verification, and SD commit.
      onProgress?.((sent / blob.size) * 0.9, sent / elapsedSeconds, "sending");
    }

    await this.waitForToken((token) => token === "PROCESSING", 20000);
    onProgress?.(0.95, 0, "processing");
    await this.waitForToken((token) => token === "DONE", 180000);
  }

  async deleteMusic(filename) {
    if (!this.ready || !this.writer) throw new Error("Hãy kết nối TinyPhone trước.");
    if (!/^[a-z0-9][a-z0-9_]*\.wav$/.test(filename) || filename.length > 80) {
      throw new Error("Tên tệp nhạc không hợp lệ.");
    }
    this.tokens.length = 0;
    await this.writeLine(`UDELETE ${filename}`);
    await this.waitForToken((token) => token === "PROCESSING", 12000);
    await this.waitForToken((token) => token === "DONE", 30000);
  }

  async disconnect() {
    if (this.closing) return;
    this.closing = true;
    this.ready = false;
    this.failPending(new Error("TinyPhone đã ngắt kết nối."));
    try {
      await this.reader?.cancel();
    } catch (_error) {
      // The device may already be gone.
    }
    try {
      await this.readTask;
    } catch (_error) {
      // Read errors are expected when a USB cable is removed.
    }
    try { this.reader?.releaseLock(); } catch (_error) {}
    try { this.writer?.releaseLock(); } catch (_error) {}
    try { await this.port?.close(); } catch (_error) {}
    this.reader = null;
    this.writer = null;
    this.port = null;
    this.readTask = null;
    this.tokens.length = 0;
    this.closing = false;
    this.onStateChange("disconnected", "Đã ngắt kết nối");
  }
}

function setSerialState(state, message) {
  const status = $("#serial-state");
  const connectButton = $("#serial-connect");
  const friendly = {
    disconnected: "Chưa kết nối",
    waiting: "Đang kết nối...",
    connected: "Đã kết nối",
    error: "Chưa thể kết nối",
  };
  const unexpectedDisconnect = state === "error" && message === "TinyPhone đã ngắt kết nối";
  const stateLabel = unexpectedDisconnect ? message : (friendly[state] || message);
  status.textContent = stateLabel;
  status.classList.toggle("is-connected", state === "connected");
  status.classList.toggle("is-error", state === "error");
  connectButton.textContent = state === "error" ? "Thử kết nối lại" : "Kết nối TinyPhone";
  connectButton.disabled = state === "waiting" || state === "connected" || transferBusy;
  $("#serial-disconnect").disabled = state === "disconnected" || !serialSession?.port;
  $("#sd-refresh").disabled = state !== "connected" || sdRefreshBusy || transferBusy;
  $("#device-summary-state").textContent = stateLabel || "Chưa kết nối";
  if (unexpectedDisconnect) {
    $("#serial-support-note").textContent = "TinyPhone đã ngắt kết nối. Kiểm tra cáp USB rồi thử lại.";
    $("#serial-support-note").removeAttribute("title");
  } else if (state === "disconnected" && message === "Đã ngắt kết nối") {
    $("#serial-support-note").textContent = "Khi sẵn sàng, hãy nhấn Kết nối TinyPhone.";
    $("#serial-support-note").removeAttribute("title");
  }
  if (state !== "connected") {
    $("#installed-music-status").hidden = true;
    $("#summary-lock").textContent = "—";
    $("#summary-photos").textContent = "—";
    $("#summary-music").textContent = "—";
    $("#summary-good").textContent = state === "error"
      ? "Kiểm tra cáp USB rồi thử lại."
      : "Kết nối TinyPhone để bắt đầu ♡";
    renderPhotoGallery();
    renderInstalledMusic();
  }
  updateTransferButtons();
}

async function connectTinyPhone(port = null, quiet = false) {
  if (serialConnectBusy || serialSession?.ready) return Boolean(serialSession?.ready);
  serialConnectBusy = true;
  const session = new TinyPhoneSerialSession(setSerialState);
  serialSession = session;
  setSerialState(
    "waiting",
    port ? "Đang kết nối lại..." : "Hãy chọn USB Serial Device...",
  );
  try {
    await session.connect(port);
    if (serialSession !== session) {
      await session.disconnect();
      return false;
    }
    await refreshSdInventory(false);
    $("#serial-support-note").innerHTML = "TinyPhone đã sẵn sàng. Cậu có thể thay ảnh hoặc thêm nhạc.";
    $("#serial-support-note").removeAttribute("title");
    if (!quiet) showToast("Đã kết nối với TinyPhone.");
    return true;
  } catch (error) {
    if (serialSession === session) serialSession = null;
    const message = friendlySerialError(error);
    setSerialState(error?.name === "NotFoundError" ? "disconnected" : "error", message);
    $("#serial-support-note").textContent = error?.name === "NotFoundError"
      ? "Khi sẵn sàng, hãy nhấn Kết nối TinyPhone."
      : "Không thể kết nối TinyPhone. Kiểm tra cáp USB rồi thử lại.";
    $("#serial-support-note").title = message;
    if (!quiet && error?.name !== "NotFoundError") showToast("Không thể kết nối TinyPhone. Kiểm tra cáp USB rồi thử lại.", true);
    return false;
  } finally {
    serialConnectBusy = false;
    updateTransferButtons();
  }
}

async function reconnectAuthorizedTinyPhone() {
  if (!("serial" in navigator) || serialSession || serialConnectBusy) return false;
  try {
    const ports = await navigator.serial.getPorts();
    const tinyPhonePort = ports.find(isTinyPhoneCdcPort);
    if (!tinyPhonePort) return false;
    return await connectTinyPhone(tinyPhonePort, true);
  } catch (_error) {
    return false;
  }
}

function updateTransferButtons() {
  const ready = Boolean(serialSession?.ready) && !transferBusy;
  $("#save-photo").disabled = !ready || !selectedPhotoFile;
  $("#save-music").disabled = !ready || tracks.length === 0 || conversionRunning;
  $("#serial-connect").disabled = serialConnectBusy || Boolean(serialSession?.ready) || transferBusy;
  for (const button of $$(".remove-installed-button")) button.disabled = !ready;
}

$("#photo-display-name").addEventListener("input", () => {
  photoNameTouched = true;
});

$("#close-photo-editor").addEventListener("click", () => {
  $("#photo-editor").hidden = true;
  $("#photo-gallery").scrollIntoView({ behavior: "smooth", block: "start" });
});

$("#sd-refresh").addEventListener("click", () => refreshSdInventory());

$("#serial-connect").addEventListener("click", async () => {
  await connectTinyPhone();
});

$("#serial-disconnect").addEventListener("click", async () => {
  await serialSession?.disconnect();
  serialSession = null;
  updateTransferButtons();
});

setSerialState("disconnected", "Chưa kết nối");

if ("serial" in navigator) {
  navigator.serial.addEventListener("connect", (event) => {
    if (!serialSession && isTinyPhoneCdcPort(event.target)) {
      void connectTinyPhone(event.target, true);
    }
  });
  navigator.serial.addEventListener("disconnect", async (event) => {
    const disconnectedSession = serialSession;
    if (event.target !== disconnectedSession?.port) return;
    disconnectedSession.ready = false;
    setSerialState("error", "TinyPhone đã ngắt kết nối");
    await disconnectedSession.disconnect();
    if (serialSession === disconnectedSession) serialSession = null;
    setSerialState("error", "TinyPhone đã ngắt kết nối");
  });
  // No prompt is shown here. Browsers only return ports the user has already
  // approved, so the first connection still uses the Connect button once.
  void reconnectAuthorizedTinyPhone();
} else {
  $("#serial-connect").disabled = true;
  $("#serial-support-note").textContent = "Hãy mở trang này bằng Chrome hoặc Edge trên máy tính để kết nối USB.";
  $("#phone-help").hidden = false;
  setSerialState("error", "Trình duyệt chưa hỗ trợ");
}

window.addEventListener("pagehide", () => {
  if (!serialSession?.port) return;
  serialSession.disconnect().catch(() => {});
});

$("#save-photo").addEventListener("click", async () => {
  if (!selectedPhotoFile || !serialSession?.ready || transferBusy) return;
  transferBusy = true;
  updateTransferButtons();
  const slot = selectedPhotoSlot;
  setFriendlyStatus("photo", "working", "Đang chuẩn bị ảnh...", "TinyPhone sẽ nhận ảnh ngay sau đây.", null, 0.08);
  try {
    await nextPaint();
    const prepared = makeLvglRgb565Blob();
    const crc = (await crc32Blob(prepared)).toString(16).padStart(8, "0");
    setFriendlyStatus("photo", "working", "Đang gửi ảnh vào TinyPhone...", "Giữ cáp USB kết nối nhé.", null, 0.18);
    await serialSession.upload(`UWALL ${slot} ${prepared.size} ${crc}`, prepared, (value, _speed, phase) => {
      setFriendlyStatus(
        "photo",
        "working",
        phase === "processing" ? "Đang áp dụng vào thẻ SD..." : "Đang gửi ảnh vào TinyPhone...",
        phase === "processing" ? "Đã nhận đủ dữ liệu; đang kiểm tra và lưu ảnh." : `${Math.round(value * 100)}%`,
        null,
        value,
      );
    });
    savePhotoDisplayName(slot, $("#photo-display-name").value);
    await refreshSdInventory(false);
    renderPhotoGallery();
    setFriendlyStatus("photo", "success", "✓ Đã cập nhật ảnh", "Ảnh mới đã có trên TinyPhone ♡", null, 1);
    $("#photo-editor-title").textContent = photoDisplayName(slot);
    showToast("Ảnh mới đã có trên TinyPhone ♡");
  } catch (error) {
    setFriendlyStatus("photo", "error", "Chưa thể cập nhật ảnh", "Kiểm tra kết nối TinyPhone rồi thử lại.", error, 0);
    showToast("Chưa thể cập nhật ảnh.", true);
  } finally {
    transferBusy = false;
    updateTransferButtons();
  }
});

$("#save-music").addEventListener("click", async () => {
  if (!tracks.length || !serialSession?.ready || transferBusy) return;
  let error = validateMusicProject(false);
  if (error) {
    setFriendlyStatus("music", "error", "Chưa thể chuẩn bị nhạc", "Kiểm tra lại tên bài hát rồi thử lại.", error, 0);
    return;
  }
  const replacements = replacementNames();
  if (replacements.length) {
    if (!window.confirm("Một vài bài hát đã có trên TinyPhone. Cậu có muốn thay thế bằng bản mới không?")) return;
  }
  transferBusy = true;
  updateTransferButtons();
  const addedCount = tracks.length;
  try {
    const pending = tracks.filter((track) => !track.wavBlob);
    if (pending.length) {
      setFriendlyStatus("music", "working", "Đang chuẩn bị nhạc...", pending[0].title, null, 0.02);
      await runConversions(pending);
    }
    error = validateMusicProject(true);
    if (error) throw new Error(error);
    const oversized = tracks.find((track) => track.wavBlob.size > MAX_MUSIC_FILE_BYTES);
    if (oversized) throw new Error(`${oversized.filename} vượt quá giới hạn 50 MiB cho mỗi bài hát.`);
    const mediaPackage = makeMediaPackage();
    setFriendlyStatus("music", "working", "Đang chuẩn bị nhạc...", "Sắp xong rồi...", null, 0.76);
    const crc = (await crc32Blob(mediaPackage)).toString(16).padStart(8, "0");
    const command = replacements.length ? "UREPLACE" : "UUPLOAD";
    await serialSession.upload(`${command} ${mediaPackage.size} ${crc}`, mediaPackage, (value, _speed, phase) => {
      setFriendlyStatus(
        "music",
        "working",
        phase === "processing" ? "Đang áp dụng vào thẻ SD..." : "Đang gửi nhạc vào TinyPhone...",
        phase === "processing" ? "Đã nhận đủ dữ liệu; đang kiểm tra và cập nhật danh sách nhạc." : `${Math.round(value * 100)}%`,
        null,
        value,
      );
    });
    await refreshSdInventory(false);
    tracks = [];
    renderTrackList();
    setFriendlyStatus("music", "success", `✓ Đã thêm ${addedCount} bài hát`, "Nhạc mới đã sẵn sàng trên TinyPhone ♡", null, 1);
    $("#music-save-area").hidden = false;
    showToast("Nhạc mới đã sẵn sàng trên TinyPhone ♡");
  } catch (uploadError) {
    setFriendlyStatus("music", "error", "Chưa thể gửi nhạc vào TinyPhone", "Kiểm tra cáp USB rồi thử lại.", uploadError, 0);
    showToast("Chưa thể gửi nhạc vào TinyPhone.", true);
  } finally {
    transferBusy = false;
    updateTransferButtons();
  }
});
