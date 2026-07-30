"use strict";

const DEFAULT_ASSETS = [
  { id: "none", name: "なし", point: "none", scale: 1, xOff: 0, yOff: 0 },
  { id: "mimi", name: "みみ", fileName: "mimi.png", point: "face", scale: 2.4, xOff: 0, yOff: -60 },
  { id: "hat", name: "ぼうし", fileName: "hat.png", point: "face", scale: 2.5, xOff: 0, yOff: -100 },
  { id: "sunset", name: "夕焼け", fileName: "sunset.png", point: "bg", scale: 1, xOff: 0, yOff: 0 },
  { id: "star", name: "星", fileName: "star.png", point: "bg", scale: 1, xOff: 0, yOff: 0 }
];

const STORAGE_KEY = "arCameraAssetsV7";
const LEGACY_KEY = "myARCameraData_V6";
const DB_NAME = "ar-camera-images";
const DB_STORE = "images";
const MAX_UPLOAD_EDGE = 1280;
const MAX_UPLOAD_PIXELS = 1600000;

let faceMesh;
let video;
let cameraStream;
let currentDeviceId = "";
let faces = [];
let assetList = DEFAULT_ASSETS.map((asset) => ({ ...asset }));
let images = new Map();
let currentIndex = 1;
let currentMode = "photo";
let isFrontCamera = true;
let isRecording = false;
let mediaRecorder;
let recordedChunks = [];
let recordingStream;
let timerInterval;
let recordingStartedAt = 0;
let detectionSession = 0;
let faceDetectionActive = false;
let modelReady = false;
let cameraReady = false;
let editingIndex = -1;
let draftConfig = null;
let draftImage = null;
let draftObjectUrl = "";
let toastTimer;
let longPressTimer;
let dbPromise;
const activePointers = new Map();
let dragOrigin = null;
let pinchOrigin = null;

function preload() {
  faceMesh = ml5.faceMesh({ maxFaces: 5, flipHorizontal: false });
  modelReady = true;
  for (const asset of DEFAULT_ASSETS) {
    if (asset.fileName) {
      images.set(asset.id, loadImage(asset.fileName, undefined, () => {
        images.delete(asset.id);
      }));
    }
  }
}

function setup() {
  const density = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4
    ? 1
    : Math.min(window.devicePixelRatio || 1, 1.5);
  pixelDensity(density);
  frameRate(navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4 ? 24 : 30);

  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("camera-container");
  canvas.elt.setAttribute("aria-label", "カメラプレビュー");

  bindUI();
  bindCanvasGestures(canvas.elt);
  loadStoredAssets().finally(() => {
    createIconList();
    startCamera("user");
  });
}

function draw() {
  background(12);
  if (!cameraReady || !video || video.elt.readyState < 2) return;

  const sourceWidth = video.width || video.elt.videoWidth || width;
  const sourceHeight = video.height || video.elt.videoHeight || height;
  const previewScale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * previewScale;
  const drawHeight = sourceHeight * previewScale;
  const drawX = (width - drawWidth) / 2;
  const drawY = (height - drawHeight) / 2;

  push();
  if (isFrontCamera) {
    translate(width, 0);
    scale(-1, 1);
    image(video, drawX, drawY, drawWidth, drawHeight);
  } else {
    image(video, drawX, drawY, drawWidth, drawHeight);
  }
  pop();

  const config = draftConfig || assetList[currentIndex];
  const stamp = draftImage || getAssetImage(config);
  if (!config || config.point === "none" || !stamp) return;

  if (config.point === "bg") {
    drawBackgroundStamp(stamp, config);
  } else if (faces.length) {
    for (const face of faces.slice(0, 5)) {
      drawFaceStamp(stamp, config, face, previewScale, drawX, drawY);
    }
  }
}

function drawBackgroundStamp(stamp, config) {
  const scaleToCover = Math.max(width / stamp.width, height / stamp.height) * clamp(config.scale, .2, 6);
  imageMode(CENTER);
  image(
    stamp,
    width / 2 + numberOrZero(config.xOff),
    height / 2 + numberOrZero(config.yOff),
    stamp.width * scaleToCover,
    stamp.height * scaleToCover
  );
  imageMode(CORNER);
}

function drawFaceStamp(stamp, config, face, videoScale, drawX, drawY) {
  if (!face.keypoints || !face.keypoints[1] || !face.keypoints[234] || !face.keypoints[454]) return;
  const anchor = face.keypoints[1];
  const left = face.keypoints[234];
  const right = face.keypoints[454];
  let x = drawX + anchor.x * videoScale;
  if (isFrontCamera) x = width - x;
  const y = drawY + anchor.y * videoScale;
  const faceWidth = Math.abs(right.x - left.x) * videoScale;
  const stampWidth = faceWidth * clamp(config.scale, .2, 6);
  const stampHeight = stampWidth * (stamp.height / stamp.width);

  imageMode(CENTER);
  image(stamp, x + numberOrZero(config.xOff), y + numberOrZero(config.yOff), stampWidth, stampHeight);
  imageMode(CORNER);
}

async function startCamera(facingMode) {
  if (isRecording) return;
  cameraReady = false;
  faces = [];
  setStatus("カメラを準備中");
  showLoader("カメラを準備中");
  stopFaceDetection();
  stopCameraTracks();

  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError("このブラウザはカメラ撮影に対応していません");
    return;
  }

  try {
    const videoConstraints = await getCameraConstraints(facingMode);
    const startSession = detectionSession;
    video = createCapture({ video: videoConstraints, audio: false }, async (stream) => {
      if (startSession !== detectionSession || !video) {
        stream?.getTracks?.().forEach((track) => track.stop());
        return;
      }
      cameraStream = video.elt.srcObject || stream;
      const activeTrack = cameraStream?.getVideoTracks?.()[0];
      currentDeviceId = activeTrack?.getSettings?.().deviceId || currentDeviceId;
      try { await video.elt.play(); } catch {}
      cameraReady = true;
      hideLoader();
      setStatus("顔を認識中");
      beginFaceDetection();
    });
    video.hide();
    video.elt.muted = true;
    video.elt.autoplay = true;
    video.elt.playsInline = true;
    video.elt.setAttribute("playsinline", "");
    video.elt.addEventListener("error", () => {
      if (!cameraReady) showCameraError("カメラを開始できませんでした");
    }, { once: true });
  } catch (error) {
    const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
    showCameraError(denied ? "カメラの使用が許可されていません" : "カメラを開始できませんでした");
  }
}

function beginFaceDetection() {
  if (!faceMesh || !video || !cameraReady) return;
  const session = ++detectionSession;
  try {
    faceDetectionActive = true;
    faceMesh.detectStart(video, (results) => {
      if (session === detectionSession && cameraReady && !document.hidden) {
        faces = Array.isArray(results) ? results.slice(0, 5) : [];
        if (faces.length) {
          const status = byId("status-pill");
          status.textContent = "準備完了";
          status.style.opacity = "0";
        }
      }
    });
  } catch {
    faceDetectionActive = false;
    setStatus("顔認識を開始できませんでした");
  }
}

async function getCameraConstraints(facingMode) {
  const baseVideo = {};

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const cameras = devices.filter((device) => device.kind === "videoinput");
  const frontPattern = /(front|user|facetime|前面)/i;
  const backPattern = /(back|rear|environment|背面|外側)/i;
  const pattern = facingMode === "user" ? frontPattern : backPattern;
  let target = cameras.find((camera) => pattern.test(camera.label));

  if (!target && currentDeviceId && cameras.length > 1) {
    target = cameras.find((camera) => camera.deviceId && camera.deviceId !== currentDeviceId);
  }

  if (target?.deviceId) {
    return { ...baseVideo, deviceId: { exact: target.deviceId } };
  }
  return { ...baseVideo, facingMode: { ideal: facingMode } };
}

function stopFaceDetection() {
  detectionSession += 1;
  faces = [];
  if (!faceDetectionActive) return;
  try {
    if (faceMesh?.detectStop) faceMesh.detectStop();
  } catch {
    // 古いml5実装では停止済みの呼び出しが例外になる場合がある。
  } finally {
    faceDetectionActive = false;
  }
}

function stopCameraTracks() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  if (video) {
    video.elt.srcObject = null;
    video.remove();
    video = null;
  }
}

function bindUI() {
  byId("mode-photo").addEventListener("click", () => switchMode("photo"));
  byId("mode-video").addEventListener("click", () => switchMode("video"));
  byId("main-shutter-btn").addEventListener("click", () => {
    if (!cameraReady) return showToast("カメラを準備しています");
    currentMode === "photo" ? takePhoto() : toggleRecording();
  });
  byId("switch-camera-btn").addEventListener("click", async () => {
    if (isRecording) return showToast("録画を停止してから切り替えてください");
    isFrontCamera = !isFrontCamera;
    await startCamera(isFrontCamera ? "user" : "environment");
  });
  byId("open-settings-btn").addEventListener("click", openAddSheet);
  byId("close-panel-btn").addEventListener("click", cancelSheet);
  byId("cancel-edit-btn").addEventListener("click", cancelSheet);
  byId("sheet-backdrop").addEventListener("click", cancelSheet);
  byId("file-input").addEventListener("change", handleImageUpload);
  byId("save-effect-btn").addEventListener("click", saveEffect);
  byId("delete-btn").addEventListener("click", () => setModal("delete-dialog", true));
  byId("delete-cancel-btn").addEventListener("click", () => setModal("delete-dialog", false));
  byId("delete-confirm-btn").addEventListener("click", deleteEffect);
  byId("help-btn").addEventListener("click", () => setModal("tutorial-overlay", true));
  byId("tutorial-close-btn").addEventListener("click", () => {
    setModal("tutorial-overlay", false);
    safeStorageSet("arCameraTutorialSeen", "1");
  });
  byId("close-app-btn").addEventListener("click", () => {
    if (history.length > 1) history.back();
    else showToast("ブラウザの戻る操作で閉じられます");
  });

  document.querySelectorAll(".part-btn").forEach((button) => {
    button.addEventListener("click", () => {
      if (!draftConfig) return;
      draftConfig.point = button.dataset.point;
      syncPlacementButtons();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (isRecording) {
        stopRecording();
        showToast("画面が閉じられたため録画を停止しました");
      }
      faces = [];
    }
  });
  window.addEventListener("orientationchange", () => {
    if (isRecording) {
      stopRecording();
      showToast("画面が回転したため録画を停止しました");
    }
  });
  window.addEventListener("pagehide", cleanup);
  window.addEventListener("beforeunload", cleanup);

  if (!safeStorageGet("arCameraTutorialSeen")) {
    window.setTimeout(() => setModal("tutorial-overlay", true), 400);
  }
}

function switchMode(mode) {
  if (isRecording) return;
  currentMode = mode;
  const photo = mode === "photo";
  document.body.classList.toggle("video-mode", !photo);
  byId("mode-photo").classList.toggle("active", photo);
  byId("mode-video").classList.toggle("active", !photo);
  byId("mode-photo").setAttribute("aria-selected", String(photo));
  byId("mode-video").setAttribute("aria-selected", String(!photo));
  byId("main-shutter-btn").setAttribute("aria-label", photo ? "写真を撮る" : "録画を開始する");
}

function createIconList() {
  const list = byId("icon-list");
  list.replaceChildren();
  assetList.forEach((asset, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `filter-icon${index === currentIndex ? " active" : ""}`;
    button.setAttribute("role", "listitem");
    button.setAttribute("aria-label", `${asset.name || "エフェクト"}を選ぶ`);
    button.dataset.empty = String(asset.point === "none");
    const imageUrl = getAssetPreviewUrl(asset);
    if (imageUrl) button.style.backgroundImage = `url("${imageUrl}")`;

    button.addEventListener("click", () => selectEffect(index));
    const beginLongPress = () => {
      if (index === 0 || asset.builtIn) return;
      longPressTimer = window.setTimeout(() => openEditSheet(index), 550);
    };
    const cancelLongPress = () => window.clearTimeout(longPressTimer);
    button.addEventListener("pointerdown", beginLongPress);
    button.addEventListener("pointerup", cancelLongPress);
    button.addEventListener("pointercancel", cancelLongPress);
    button.addEventListener("pointermove", cancelLongPress);
    list.appendChild(button);
  });
}

function selectEffect(index) {
  if (index < 0 || index >= assetList.length) index = 0;
  currentIndex = index;
  draftConfig = null;
  draftImage = null;
  createIconList();
  const selected = assetList[currentIndex];
  if (selected?.point === "face" && !faces.length) {
    setStatus("顔を認識中");
  } else {
    setStatus(selected?.name || "エフェクトなし");
    window.setTimeout(() => { byId("status-pill").style.opacity = "0"; }, 900);
  }
}

function openAddSheet() {
  editingIndex = -1;
  draftConfig = { id: createId(), name: "追加画像", point: "face", scale: 2.4, xOff: 0, yOff: -60, custom: true };
  draftImage = null;
  byId("panel-title").textContent = "エフェクトを追加";
  byId("upload-section").hidden = false;
  byId("delete-btn").hidden = true;
  byId("save-effect-btn").textContent = "追加";
  byId("file-input").value = "";
  syncPlacementButtons();
  setSheet(true);
}

function openEditSheet(index) {
  if (index <= 0 || index >= assetList.length) return;
  editingIndex = index;
  currentIndex = index;
  draftConfig = { ...assetList[index] };
  draftImage = getAssetImage(assetList[index]);
  byId("panel-title").textContent = "エフェクトを編集";
  byId("upload-section").hidden = true;
  byId("delete-btn").hidden = Boolean(assetList[index].builtIn);
  byId("save-effect-btn").textContent = "保存";
  syncPlacementButtons();
  setSheet(true);
}

function cancelSheet() {
  draftConfig = null;
  draftImage = null;
  editingIndex = -1;
  revokeDraftUrl();
  setSheet(false);
}

function setSheet(open) {
  byId("settings-panel").hidden = !open;
  byId("sheet-backdrop").hidden = !open;
  document.body.classList.toggle("sheet-open", open);
}

function syncPlacementButtons() {
  document.querySelectorAll(".part-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.point === draftConfig?.point);
  });
}

async function handleImageUpload(event) {
  const file = event.target.files?.[0];
  if (!file || !draftConfig) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    showToast("PNG、JPEG、WebP画像を選んでください");
    return;
  }
  try {
    const optimized = await optimizeImage(file);
    await idbPut(draftConfig.id, optimized.blob);
    draftConfig.mimeType = optimized.blob.type;
    draftImage = await loadP5Image(optimized.url);
    revokeDraftUrl();
    draftObjectUrl = optimized.url;
    showToast("画像を読み込みました");
  } catch {
    showToast("画像を読み込めませんでした");
  }
}

async function optimizeImage(file) {
  const bitmap = "createImageBitmap" in window
    ? await createImageBitmap(file)
    : await loadHtmlImage(URL.createObjectURL(file));
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const edgeScale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(sourceWidth, sourceHeight));
  const pixelScale = Math.min(1, Math.sqrt(MAX_UPLOAD_PIXELS / (sourceWidth * sourceHeight)));
  const scale = Math.min(edgeScale, pixelScale);
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.getContext("2d", { alpha: true }).drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  if (bitmap.close) bitmap.close();
  const type = file.type === "image/png" ? "image/png" : "image/webp";
  let blob = await canvasToBlob(canvas, type, .84);
  if (!blob || (type === "image/webp" && blob.type !== "image/webp")) {
    blob = await canvasToBlob(canvas, "image/jpeg", .86);
  }
  return { blob, url: URL.createObjectURL(blob) };
}

async function saveEffect() {
  if (!draftConfig) return;
  if (editingIndex < 0 && !draftImage) {
    showToast("画像を選んでください");
    return;
  }
  draftConfig.scale = clamp(draftConfig.scale, .2, 6);
  if (editingIndex >= 0) {
    assetList[editingIndex] = { ...draftConfig };
  } else {
    assetList.push({ ...draftConfig });
    currentIndex = assetList.length - 1;
    images.set(draftConfig.id, draftImage);
  }
  persistMetadata();
  draftConfig = null;
  draftImage = null;
  editingIndex = -1;
  setSheet(false);
  createIconList();
  showToast("保存しました");
}

async function deleteEffect() {
  if (editingIndex <= 0 || editingIndex >= assetList.length || assetList[editingIndex].builtIn) return;
  const removed = assetList[editingIndex];
  assetList.splice(editingIndex, 1);
  images.delete(removed.id);
  if (removed.custom) await idbDelete(removed.id);
  currentIndex = clamp(currentIndex, 0, Math.max(0, assetList.length - 1));
  if (currentIndex >= editingIndex) currentIndex = Math.max(0, currentIndex - 1);
  persistMetadata();
  setModal("delete-dialog", false);
  cancelSheet();
  createIconList();
  showToast("削除しました");
}

async function takePhoto() {
  const canvas = document.querySelector("canvas");
  if (!canvas) return;
  byId("flash-overlay").classList.remove("flash");
  void byId("flash-overlay").offsetWidth;
  byId("flash-overlay").classList.add("flash");
  const blob = await canvasToBlob(canvas, "image/jpeg", .92);
  if (!blob) return showToast("写真を保存できませんでした");
  await shareOrDownload(blob, `ar-photo-${Date.now()}.jpg`, "image/jpeg", "AR写真");
}

function toggleRecording() {
  isRecording ? stopRecording() : startRecording();
}

function startRecording() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    showToast("このブラウザは動画録画に対応していません");
    return;
  }
  const canvas = document.querySelector("canvas");
  const mimeType = chooseRecordingMimeType();
  try {
    recordingStream = canvas.captureStream(24);
    mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType, videoBitsPerSecond: 3500000 } : undefined);
  } catch {
    showToast("動画録画を開始できませんでした");
    return;
  }
  recordedChunks = [];
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) recordedChunks.push(event.data);
  });
  mediaRecorder.addEventListener("stop", saveVideo, { once: true });
  mediaRecorder.addEventListener("error", () => showToast("録画中にエラーが発生しました"), { once: true });
  mediaRecorder.start(1000);
  isRecording = true;
  recordingStartedAt = Date.now();
  document.body.classList.add("recording");
  byId("main-shutter-btn").setAttribute("aria-label", "録画を停止する");
  updateTimer();
  timerInterval = window.setInterval(updateTimer, 250);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  window.clearInterval(timerInterval);
  timerInterval = null;
  document.body.classList.remove("recording");
  byId("video-timer").textContent = "00:00";
  byId("main-shutter-btn").setAttribute("aria-label", "録画を開始する");
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function updateTimer() {
  const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
  byId("video-timer").textContent =
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

async function saveVideo() {
  const type = mediaRecorder?.mimeType || recordedChunks[0]?.type || "video/webm";
  const blob = new Blob(recordedChunks, { type });
  const extension = type.includes("mp4") ? "mp4" : "webm";
  stopRecordingTracks();
  if (!blob.size) return showToast("動画を保存できませんでした");
  await shareOrDownload(blob, `ar-video-${Date.now()}.${extension}`, type, "AR動画");
  recordedChunks = [];
}

function chooseRecordingMimeType() {
  const candidates = [
    "video/mp4;codecs=h264",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function shareOrDownload(blob, fileName, type, title) {
  const file = new File([blob], fileName, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      showToast("共有しました");
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("端末に保存しました");
}

function bindCanvasGestures(canvas) {
  canvas.addEventListener("pointerdown", (event) => {
    if (!document.body.classList.contains("sheet-open") || !draftConfig) return;
    canvas.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 1) {
      dragOrigin = { x: event.clientX, y: event.clientY };
    } else if (activePointers.size === 2) {
      const [a, b] = [...activePointers.values()];
      pinchOrigin = { distance: pointDistance(a, b), scale: draftConfig.scale };
    }
    event.preventDefault();
  }, { passive: false });

  canvas.addEventListener("pointermove", (event) => {
    if (!activePointers.has(event.pointerId) || !draftConfig) return;
    const previous = activePointers.get(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size >= 2 && pinchOrigin) {
      const [a, b] = [...activePointers.values()];
      draftConfig.scale = clamp(pinchOrigin.scale * pointDistance(a, b) / Math.max(1, pinchOrigin.distance), .2, 6);
    } else if (previous) {
      draftConfig.xOff += event.clientX - previous.x;
      draftConfig.yOff += event.clientY - previous.y;
    }
    event.preventDefault();
  }, { passive: false });

  const endPointer = (event) => {
    activePointers.delete(event.pointerId);
    if (activePointers.size < 2) pinchOrigin = null;
    if (!activePointers.size) dragOrigin = null;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function cleanup() {
  if (isRecording) stopRecording();
  window.clearInterval(timerInterval);
  window.clearTimeout(toastTimer);
  window.clearTimeout(longPressTimer);
  stopRecordingTracks();
  stopFaceDetection();
  stopCameraTracks();
  revokeDraftUrl();
}

function stopRecordingTracks() {
  if (recordingStream) recordingStream.getTracks().forEach((track) => track.stop());
  recordingStream = null;
}

async function loadStoredAssets() {
  const stored = safeJsonParse(safeStorageGet(STORAGE_KEY));
  if (Array.isArray(stored)) {
    assetList = DEFAULT_ASSETS.map((asset) => ({ ...asset, builtIn: true }))
      .concat(stored.filter((asset) => asset?.custom && asset.id));
  } else {
    assetList = DEFAULT_ASSETS.map((asset) => ({ ...asset, builtIn: true }));
    await migrateLegacyAssets();
  }
  for (const asset of assetList.filter((item) => item.custom)) {
    const blob = await idbGet(asset.id);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    try {
      images.set(asset.id, await loadP5Image(url));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function migrateLegacyAssets() {
  const legacy = safeJsonParse(safeStorageGet(LEGACY_KEY));
  if (!Array.isArray(legacy)) return;
  for (const item of legacy) {
    if (!item?.fileData) continue;
    try {
      const id = createId();
      const blob = await (await fetch(item.fileData)).blob();
      await idbPut(id, blob);
      assetList.push({
        id,
        name: "追加画像",
        point: item.point === "bg" ? "bg" : "face",
        scale: Number(item.scale) || 1,
        xOff: Number(item.xOff) || 0,
        yOff: Number(item.yOff) || 0,
        mimeType: blob.type,
        custom: true
      });
    } catch {
      // 読み込めない旧データだけをスキップする。
    }
  }
  persistMetadata();
  try { localStorage.removeItem(LEGACY_KEY); } catch {}
}

function persistMetadata() {
  const customAssets = assetList.filter((asset) => asset.custom).map(({ id, name, point, scale, xOff, yOff, mimeType, custom }) => ({
    id, name, point, scale, xOff, yOff, mimeType, custom
  }));
  safeStorageSet(STORAGE_KEY, JSON.stringify(customAssets));
}

function getAssetImage(asset) {
  return asset ? images.get(asset.id) : null;
}

function getAssetPreviewUrl(asset) {
  if (!asset || asset.point === "none") return "";
  if (asset.fileName) return asset.fileName;
  const image = images.get(asset.id);
  return image?.canvas?.toDataURL?.("image/png") || image?.src || "";
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function idbRequest(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, mode);
    const request = action(transaction.objectStore(DB_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const idbPut = (key, value) => idbRequest("readwrite", (store) => store.put(value, key));
const idbGet = (key) => idbRequest("readonly", (store) => store.get(key));
const idbDelete = (key) => idbRequest("readwrite", (store) => store.delete(key));

function loadP5Image(url) {
  return new Promise((resolve, reject) => loadImage(url, resolve, reject));
}

function loadHtmlImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = reject;
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function setModal(id, open) {
  byId(id).hidden = !open;
}

function setStatus(message) {
  const status = byId("status-pill");
  status.textContent = message;
  status.style.opacity = "1";
}

function showLoader(message) {
  byId("loading-screen").hidden = false;
  byId("loading-screen").style.opacity = "1";
  byId("loading-screen").querySelector("p").textContent = message;
}

function hideLoader() {
  const loader = byId("loading-screen");
  loader.style.opacity = "0";
  window.setTimeout(() => { loader.hidden = true; }, 220);
}

function showCameraError(message) {
  cameraReady = false;
  showLoader(message);
  const spinner = byId("loading-screen").querySelector(".spinner");
  spinner.hidden = true;
  setStatus(message);
}

function showToast(message) {
  const toast = byId("toast");
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2400);
}

function revokeDraftUrl() {
  if (draftObjectUrl) URL.revokeObjectURL(draftObjectUrl);
  draftObjectUrl = "";
}

function byId(id) {
  return document.getElementById(id);
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function numberOrZero(value) {
  return Number(value) || 0;
}

function createId() {
  return crypto.randomUUID?.() || `asset-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    showToast("端末に設定を保存できませんでした");
    return false;
  }
}

function safeJsonParse(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
