"use strict";

const APP_BUILD = "20260806-stage10-polish";
const DEFAULT_ASSETS = [
  { id: "none", name: "なし", point: "none", scale: 1, xOff: 0, yOff: 0 },
  { id: "mimi", name: "みみ", fileName: "mimi.png", point: "face", scale: 2.4, xOff: 0, yOff: -25 },
  { id: "hat", name: "ぼうし", fileName: "hat.png", point: "face", scale: 2.5, xOff: 0, yOff: -25 },
  { id: "sunset", name: "夕焼け", fileName: "sunset.png", point: "bg", scale: 1, xOff: 0, yOff: 0 },
  { id: "star", name: "星", fileName: "star.png", point: "bg", scale: 1, xOff: 0, yOff: 0 }
];

const STORAGE_KEY = "arCameraAssetsV7";
const LEGACY_KEY = "myARCameraData_V6";
const DB_NAME = "ar-camera-images";
const DB_STORE = "images";
const MAX_UPLOAD_EDGE = 1280;
const MAX_UPLOAD_PIXELS = 1600000;
const FACE_OFFSET_REFERENCE_WIDTH = 100;
const DEBUG_FACE_MESH = new URLSearchParams(location.search).get("debug") === "1";
const PLATFORM_KEY = "arCameraPlatformV1";
const SAVED_PLATFORM = readSavedPlatform();
const AUTO_PLATFORM = /Android/i.test(navigator.userAgent) ? "android" : "ios";
const DEVICE_MEMORY_GB = Number(navigator.deviceMemory) || 0;
const CPU_CORES = Number(navigator.hardwareConcurrency) || 0;
// OSの種類と端末性能は別物として扱う。Androidを選んだだけでは軽量化しない。
// 非常に少ないメモリ/CPU、または両方が控えめな端末だけを軽量モードにする。
const IS_LOW_SPEC_DEVICE =
  (DEVICE_MEMORY_GB > 0 && DEVICE_MEMORY_GB <= 2) ||
  (CPU_CORES > 0 && CPU_CORES <= 2) ||
  (DEVICE_MEMORY_GB > 0 && DEVICE_MEMORY_GB <= 4 &&
    CPU_CORES > 0 && CPU_CORES <= 4);

let faceMesh;
let video;
let cameraStream;
let currentDeviceId = "";
let faces = [];
let assetList = DEFAULT_ASSETS.map((asset) => ({ ...asset }));
let images = new Map();
const assetPreviewUrls = new Map();
let currentIndex = 1;
let currentMode = "photo";
let isFrontCamera = true;
let isRecording = false;
let mediaRecorder;
let recordedChunks = [];
let recordingStream;
let timerInterval;
let recordingStartedAt = 0;
let recordingFailed = false;
let detectionSession = 0;
let faceDetectionActive = false;
let lastFaceResultAt = 0;
let detectionWatchdogTimer = null;
let detectionRestarting = false;
let modelReady = false;
let modelLoading = false;
let cameraReady = false;
let cameraStartGeneration = 0;
let cameraSwitchInProgress = false;
let faceCoordinateSpace = null;
let observedFaceRange = null;
let editingIndex = -1;
let draftConfig = null;
let draftImage = null;
let draftObjectUrl = "";
let toastTimer;
let loaderHideTimer;
let longPressTimer;
let dbPromise;
const activePointers = new Map();
let pinchOrigin = null;
const modalFocusOrigins = new Map();
let canvasResizeObserver = null;
let canvasResizeFrame = 0;
let nextFaceTrackId = 1;
const facePlacementStates = new Map();

function preload() {
  for (const asset of DEFAULT_ASSETS) {
    if (asset.fileName) {
      images.set(asset.id, loadImage(asset.fileName, undefined, () => {
        images.delete(asset.id);
      }));
    }
  }
}

function setup() {
  modelReady = false;
  modelLoading = false;

  const useLightRendering = IS_LOW_SPEC_DEVICE;
  const density = useLightRendering ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
  pixelDensity(density);
  frameRate(useLightRendering ? 24 : 30);

  const initialViewport = getViewportSize();
  const canvas = createCanvas(initialViewport.width, initialViewport.height);
  canvas.parent("camera-container");
  canvas.elt.setAttribute("aria-label", "カメラプレビュー");

  const cameraContainer = byId("camera-container");
  if (window.ResizeObserver) {
    canvasResizeObserver = new ResizeObserver(() => scheduleCanvasResize());
    canvasResizeObserver.observe(cameraContainer);
  }
  window.visualViewport?.addEventListener("resize", scheduleCanvasResize);

  bindUI();
  bindCanvasGestures(canvas.elt);
  detectionWatchdogTimer = window.setInterval(checkFaceDetectionHealth, 750);
  loadStoredAssets().finally(() => {
    createIconList();
    if (SAVED_PLATFORM) {
      startCamera("user");
    } else {
      hideLoaderImmediately();
      openPlatformSelector(false);
    }
  });
}

function draw() {
  background(12);
  if (!cameraReady || !video || video.elt.readyState < 2) return;

  const frame = getCameraFrame();

  push();
  if (isFrontCamera) {
    translate(width, 0);
    scale(-1, 1);
  }
  image(video, frame.x, frame.y, frame.width, frame.height);
  pop();

  const config = draftConfig || assetList[currentIndex];
  const stamp = draftImage || getAssetImage(config);
  if (!config || config.point === "none" || !stamp) {
    if (DEBUG_FACE_MESH) drawFaceMeshDebug(frame);
    return;
  }

  if (config.point === "bg") {
    // 背景・フレーム画像は横幅をCanvasへ合わせ、画像の縦横比を維持する。
    // config.scale=1のとき、画像の横幅と画面の横幅が完全に一致する。
    const backgroundScale = (width / stamp.width) * clamp(config.scale, .2, 6);
    imageMode(CENTER);
    image(
      stamp,
      width / 2 + numberOrZero(config.xOff) * (width / 480),
      height / 2 + numberOrZero(config.yOff) * (width / 480),
      stamp.width * backgroundScale,
      stamp.height * backgroundScale
    );
    imageMode(CORNER);
    if (DEBUG_FACE_MESH) drawFaceMeshDebug(frame);
    return;
  }

  for (const face of faces.slice(0, 5)) {
    const placement = resolveFacePlacement(face, frame);
    if (!placement) continue;
    const stampWidth = placement.faceWidth * clamp(config.scale, .2, 6);
    const stampHeight = stampWidth * (stamp.height / stamp.width);
    const offsetScale = placement.faceWidth / FACE_OFFSET_REFERENCE_WIDTH;
    imageMode(CENTER);
    image(
      stamp,
      placement.x + numberOrZero(config.xOff) * offsetScale,
      placement.y + numberOrZero(config.yOff) * offsetScale,
      stampWidth,
      stampHeight
    );
    imageMode(CORNER);
  }
  if (DEBUG_FACE_MESH) drawFaceMeshDebug(frame);
}

function getCameraFrame() {
  // 既存プレビューと同じ優先順を維持する（表示比率を変えない）。
  const sourceWidth = video?.width || video?.elt?.videoWidth || width;
  const sourceHeight = video?.height || video?.elt?.videoHeight || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  return {
    sourceWidth,
    sourceHeight,
    scale,
    x: (width - sourceWidth * scale) / 2,
    y: (height - sourceHeight * scale) / 2,
    width: sourceWidth * scale,
    height: sourceHeight * scale
  };
}

function inspectFaceCoordinateSpace(results) {
  const points = results.flatMap((face) => Array.isArray(face?.keypoints) ? face.keypoints : []);
  if (!points.length) return;
  const maxX = Math.max(...points.map((point) => Number(point.x) || 0));
  const maxY = Math.max(...points.map((point) => Number(point.y) || 0));
  observedFaceRange = { maxX, maxY };

  // ml5へ渡しているp5.MediaElementの座標系を、プレビュー描画と共通で使う。
  // videoWidth/videoHeightへ置き換えると、顔が画面中心から離れたときに
  // ランドマークが左上方向へ圧縮されるため、ここでは混在させない。
  const inputWidth = video?.width || video?.elt?.videoWidth || 0;
  const inputHeight = video?.height || video?.elt?.videoHeight || 0;
  faceCoordinateSpace = resolveFaceCoordinateSpace(maxX, maxY, inputWidth, inputHeight);
}

function resolveFaceCoordinateSpace(maxX, maxY, inputWidth, inputHeight) {
  if (maxX <= 1.5 && maxY <= 1.5) {
    return { width: 1, height: 1, rotation: "none", name: "normalized 0-1" };
  }
  if (!(inputWidth > 0 && inputHeight > 0)) return null;

  // iPhone/iPad/Androidという端末名では補正しない。
  // FaceMeshへ渡したvideoの座標基準だけから変換を決め、Canvas側の中央クロップは
  // getCameraFrame()のframe.x/frame.y/frame.scaleで一度だけ適用する。
  if (inputHeight > inputWidth) {
    return {
      width: inputHeight,
      height: inputWidth,
      rotation: "clockwise",
      name: "landscape sensor -> portrait CW"
    };
  }
  return {
    width: inputWidth,
    height: inputHeight,
    rotation: "none",
    name: "video.width/video.height"
  };
}

function facePointToCanvas(point, frame) {
  if (!point || !faceCoordinateSpace) return null;
  let sourceX = point.x;
  let sourceY = point.y;
  let sourceWidth = faceCoordinateSpace.width;
  let sourceHeight = faceCoordinateSpace.height;
  if (faceCoordinateSpace.rotation === "clockwise") {
    sourceX = faceCoordinateSpace.height - point.y;
    sourceY = point.x;
    sourceWidth = faceCoordinateSpace.height;
    sourceHeight = faceCoordinateSpace.width;
  }
  const rawX = frame.x + sourceX * (frame.width / sourceWidth);
  // 前面カメラ映像はdraw()内で1回だけ反転しているため、
  // FaceMesh座標にも端末を問わず同じ1回の反転を適用する。
  const mirrorFaceCoordinates = isFrontCamera;
  const canvasX = mirrorFaceCoordinates ? width - rawX : rawX;
  const canvasY = frame.y + sourceY * (frame.height / sourceHeight);
  return { x: canvasX, y: canvasY };
}

function resolveFacePlacement(face, frame) {
  if (!face?.keypoints?.[1] || !face.keypoints[234] || !face.keypoints[454]) return null;
  const nose = facePointToCanvas(face.keypoints[1], frame);
  const leftCheek = facePointToCanvas(face.keypoints[234], frame);
  const rightCheek = facePointToCanvas(face.keypoints[454], frame);
  if (!nose || !leftCheek || !rightCheek) return null;
  const rawPlacement = {
    // 組み込みエフェクトの既存オフセットは鼻を基準に調整されている。
    // 顔幅だけは左右の頬234・454から求め、配置中心は鼻1を使う。
    x: nose.x,
    y: nose.y,
    faceWidth: pointDistance(leftCheek, rightCheek),
    nose,
    leftCheek,
    rightCheek
  };

  const trackId = face._trackId;
  if (!trackId) return rawPlacement;

  const now = performance.now();
  const frameKey = `${width}x${height}:${frame.x.toFixed(2)}:${frame.y.toFixed(2)}:${frame.scale.toFixed(4)}`;
  const previous = facePlacementStates.get(trackId);
  if (!previous || previous.frameKey !== frameKey) {
    facePlacementStates.set(trackId, { ...rawPlacement, face, updatedAt: now, frameKey });
    return rawPlacement;
  }

  // draw()とデバッグ描画から同じ検出結果を複数回参照しても、
  // 1回の検出につき1回だけ平滑化する。
  if (previous.face === face) return previous;

  const previousWidth = Math.max(1, previous.faceWidth);
  let targetX = rawPlacement.x;
  let targetY = rawPlacement.y;
  let targetWidth = rawPlacement.faceWidth;
  const centerDistance = Math.hypot(targetX - previous.x, targetY - previous.y);
  const movementRatio = centerDistance / previousWidth;
  const widthChangeRatio = Math.abs(targetWidth - previousWidth) / previousWidth;

  // 1フレームだけ大きく飛ぶ誤検出を、顔幅に比例した範囲へ抑える。
  const maxCenterStep = previousWidth * .45;
  if (centerDistance > maxCenterStep) {
    const stepRatio = maxCenterStep / centerDistance;
    targetX = previous.x + (targetX - previous.x) * stepRatio;
    targetY = previous.y + (targetY - previous.y) * stepRatio;
  }
  targetWidth = clamp(targetWidth, previousWidth * .82, previousWidth * 1.18);

  // 顔幅の約1.2%未満の揺れは止める。移動が大きいほど追従を速くする。
  const centerDeadZone = previousWidth * .012;
  if (Math.abs(targetX - previous.x) < centerDeadZone) targetX = previous.x;
  if (Math.abs(targetY - previous.y) < centerDeadZone) targetY = previous.y;
  if (widthChangeRatio < .015) targetWidth = previousWidth;

  const elapsedFrames = clamp((now - previous.updatedAt) / 33.333, .5, 3);
  const centerBaseAlpha = clamp(.14 + movementRatio * 2.4, .14, .82);
  const widthBaseAlpha = clamp(.1 + widthChangeRatio * 2, .1, .58);
  const centerAlpha = 1 - Math.pow(1 - centerBaseAlpha, elapsedFrames);
  const widthAlpha = 1 - Math.pow(1 - widthBaseAlpha, elapsedFrames);
  const smoothed = {
    ...rawPlacement,
    x: previous.x + (targetX - previous.x) * centerAlpha,
    y: previous.y + (targetY - previous.y) * centerAlpha,
    faceWidth: previousWidth + (targetWidth - previousWidth) * widthAlpha,
    face,
    updatedAt: now,
    frameKey
  };
  facePlacementStates.set(trackId, smoothed);
  return smoothed;
}

function drawFaceMeshDebug(frame) {
  push();
  noFill();
  stroke(0, 255, 255);
  strokeWeight(2);
  rect(frame.x, frame.y, frame.width, frame.height);

  for (const face of faces.slice(0, 5)) {
    const placement = resolveFacePlacement(face, frame);
    if (!placement) continue;
    stroke(255, 70, 70);
    line(placement.leftCheek.x, placement.leftCheek.y, placement.rightCheek.x, placement.rightCheek.y);
    noStroke();
    fill(255, 230, 0);
    circle(placement.nose.x, placement.nose.y, 10);
    fill(0, 200, 255);
    circle(placement.leftCheek.x, placement.leftCheek.y, 10);
    circle(placement.rightCheek.x, placement.rightCheek.y, 10);
    fill(255, 70, 190);
    circle(placement.x, placement.y, 12);
    fill(255);
    textSize(11);
    textAlign(CENTER, BOTTOM);
    text(`faceWidth ${placement.faceWidth.toFixed(1)}px`, placement.x, placement.y - 10);
  }

  noStroke();
  fill(0, 0, 0, 180);
  rect(8, 72, Math.min(width - 16, 360), 186, 8);
  fill(255);
  textSize(12);
  textAlign(LEFT, TOP);
  const basis = faceCoordinateSpace
    ? `${faceCoordinateSpace.name} ${faceCoordinateSpace.width} x ${faceCoordinateSpace.height}`
    : "未確定（顔を検出してください）";
  const range = observedFaceRange
    ? `${observedFaceRange.maxX.toFixed(2)}, ${observedFaceRange.maxY.toFixed(2)}`
    : "-";
  const activeConfig = draftConfig || assetList[currentIndex];
  text([
    `build: ${APP_BUILD}`,
    `FaceMesh基準: ${basis}`,
    `観測 max(x,y): ${range}`,
    `入力: ${frame.sourceWidth} x ${frame.sourceHeight}`,
    `表示: ${frame.width.toFixed(1)} x ${frame.height.toFixed(1)}  scale=${frame.scale.toFixed(4)}`,
    `crop offset: x=${frame.x.toFixed(1)} y=${frame.y.toFixed(1)}`,
    `video mirror: ${isFrontCamera ? "ON" : "OFF"}  face mirror: ${isFrontCamera ? "ON" : "OFF"}  faces: ${faces.length}`,
    `result age: ${lastFaceResultAt ? Math.round(performance.now() - lastFaceResultAt) : "-"}ms`,
    `effect offset: x=${numberOrZero(activeConfig?.xOff)} y=${numberOrZero(activeConfig?.yOff)}`
  ].join("\n"), 16, 80);
  pop();
}

async function startCamera(facingMode) {
  if (isRecording) return false;
  const generation = ++cameraStartGeneration;
  setCameraSwitchBusy(true);
  cameraReady = false;
  faces = [];
  faceCoordinateSpace = null;
  observedFaceRange = null;
  setStatus("カメラを準備中");
  showLoader("カメラを準備中");
  stopFaceDetection();
  stopCameraTracks();

  if (!navigator.mediaDevices?.getUserMedia) {
    if (generation === cameraStartGeneration) {
      showCameraError("このブラウザはカメラ撮影に対応していません");
      setCameraSwitchBusy(false);
    }
    return false;
  }

  try {
    const videoConstraints = await getCameraConstraints(facingMode);
    if (generation !== cameraStartGeneration) return false;

    let createdVideo;
    createdVideo = createCapture({ video: videoConstraints, audio: false }, async (stream) => {
      if (generation !== cameraStartGeneration || video !== createdVideo) {
        stream?.getTracks?.().forEach((track) => track.stop());
        createdVideo?.remove?.();
        return;
      }
      cameraStream = createdVideo.elt.srcObject || stream;
      const activeTrack = cameraStream?.getVideoTracks?.()[0];
      currentDeviceId = activeTrack?.getSettings?.().deviceId || currentDeviceId;
      try { await createdVideo.elt.play(); } catch {}
      if (generation !== cameraStartGeneration || video !== createdVideo) {
        stream?.getTracks?.().forEach((track) => track.stop());
        createdVideo?.remove?.();
        return;
      }
      cameraReady = true;
      setCameraSwitchBusy(false);
      hideLoader();
      setStatus(modelReady ? "顔を認識中" : "顔認識を準備中");
      if (modelReady) beginFaceDetection();
      else initializeFaceMesh();
    });
    video = createdVideo;
    createdVideo.hide();
    createdVideo.elt.muted = true;
    createdVideo.elt.autoplay = true;
    createdVideo.elt.playsInline = true;
    createdVideo.elt.setAttribute("playsinline", "");
    createdVideo.elt.addEventListener("error", () => {
      if (generation === cameraStartGeneration && !cameraReady) {
        showCameraError("カメラを開始できませんでした");
        setCameraSwitchBusy(false);
      }
    }, { once: true });
    return true;
  } catch (error) {
    if (generation === cameraStartGeneration) {
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      showCameraError(denied ? "カメラの使用が許可されていません" : "カメラを開始できませんでした");
      setCameraSwitchBusy(false);
    }
    return false;
  }
}

function setCameraSwitchBusy(busy) {
  cameraSwitchInProgress = busy;
  const button = byId("switch-camera-btn");
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function initializeFaceMesh() {
  if (modelLoading || modelReady) return;
  modelLoading = true;

  const finishLoading = (loadedModel) => {
    if (loadedModel?.detectStart) faceMesh = loadedModel;
    if (modelReady) return;
    if (!faceMesh?.detectStart) {
      failLoading(new Error("FaceMesh model is unavailable"));
      return;
    }
    modelReady = true;
    modelLoading = false;
    setStatus("顔を認識中");
    if (cameraReady && video && !faceDetectionActive) beginFaceDetection();
  };

  const failLoading = (error) => {
    modelLoading = false;
    modelReady = false;
    faceMesh = null;
    console.error("FaceMesh initialization failed", error);
    showFaceMeshError("顔認識を読み込めませんでした");
  };

  try {
    const createdModel = ml5.faceMesh({
      maxFaces: 5,
      flipHorizontal: false,
      callback: finishLoading
    });
    if (createdModel?.then) {
      createdModel.then(finishLoading).catch(failLoading);
    } else {
      faceMesh = createdModel;
    }
  } catch (error) {
    failLoading(error);
  }
}

function beginFaceDetection() {
  if (!faceMesh || !modelReady || !video || !cameraReady || faceDetectionActive) return;
  const session = ++detectionSession;
  lastFaceResultAt = performance.now();
  try {
    faceDetectionActive = true;
    faceMesh.detectStart(video, (results) => {
      if (session === detectionSession && cameraReady && !document.hidden) {
        lastFaceResultAt = performance.now();
        const uniqueFaces = dedupeFaces(Array.isArray(results) ? results.slice(0, 5) : []);
        faces = stabilizeFaces(uniqueFaces, faces);
        const activeTrackIds = new Set(faces.map((face) => face._trackId));
        for (const trackId of facePlacementStates.keys()) {
          if (!activeTrackIds.has(trackId)) facePlacementStates.delete(trackId);
        }
        inspectFaceCoordinateSpace(faces);
        if (!byId("settings-panel").hidden) syncEditorStatus();
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

function dedupeFaces(results) {
  const unique = [];
  for (const face of results) {
    const nose = face?.keypoints?.[1];
    const left = face?.keypoints?.[234];
    const right = face?.keypoints?.[454];
    if (!nose || !left || !right) continue;
    const faceWidth = pointDistance(left, right);
    const duplicate = unique.some((saved) => {
      const savedNose = saved.keypoints[1];
      const savedWidth = pointDistance(saved.keypoints[234], saved.keypoints[454]);
      const centerDistance = pointDistance(nose, savedNose);
      const widthRatio = Math.min(faceWidth, savedWidth) / Math.max(1, Math.max(faceWidth, savedWidth));
      return centerDistance < Math.max(faceWidth, savedWidth) * .35 && widthRatio > .6;
    });
    if (!duplicate) unique.push(face);
  }
  return unique.slice(0, 5);
}

function stabilizeFaces(results, previousFaces) {
  const usedPrevious = new Set();
  return results.map((face) => {
    const nose = face.keypoints[1];
    const left = face.keypoints[234];
    const right = face.keypoints[454];
    const faceWidth = Math.max(1, pointDistance(left, right));
    let matchIndex = -1;
    let matchDistance = Infinity;

    previousFaces.forEach((previous, index) => {
      if (usedPrevious.has(index) || !previous?.keypoints?.[1]) return;
      const distance = pointDistance(nose, previous.keypoints[1]);
      if (distance < matchDistance && distance < faceWidth * .8) {
        matchIndex = index;
        matchDistance = distance;
      }
    });

    if (matchIndex < 0) return { ...face, _trackId: nextFaceTrackId++ };
    usedPrevious.add(matchIndex);
    const previous = previousFaces[matchIndex];
    return { ...face, _trackId: previous._trackId || nextFaceTrackId++ };
  });
}

function checkFaceDetectionHealth() {
  if (!cameraReady || !faceDetectionActive || document.hidden || detectionRestarting) return;
  const resultAge = performance.now() - lastFaceResultAt;
  if (resultAge > 1200) faces = [];
  if (resultAge <= 3000) return;

  detectionRestarting = true;
  stopFaceDetection();
  if (cameraReady && video && !document.hidden) beginFaceDetection();
  detectionRestarting = false;
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
  facePlacementStates.clear();
  lastFaceResultAt = 0;
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
  byId("loading-retry-btn").addEventListener("click", retryCameraOrModel);
  byId("mode-photo").addEventListener("click", () => switchMode("photo"));
  byId("mode-video").addEventListener("click", () => switchMode("video"));
  byId("main-shutter-btn").addEventListener("click", () => {
    if (!cameraReady) return showToast("カメラを準備しています");
    currentMode === "photo" ? takePhoto() : toggleRecording();
  });
  byId("switch-camera-btn").addEventListener("click", async () => {
    if (isRecording) return showToast("録画を停止してから切り替えてください");
    if (cameraSwitchInProgress) return;
    isFrontCamera = !isFrontCamera;
    await startCamera(isFrontCamera ? "user" : "environment");
  });
  byId("open-settings-btn").addEventListener("click", openAddSheet);
  byId("edit-selected-btn").addEventListener("click", () => {
    if (currentIndex > 0 && assetList[currentIndex]?.custom) openEditSheet(currentIndex);
  });
  byId("close-panel-btn").addEventListener("click", cancelSheet);
  byId("cancel-edit-btn").addEventListener("click", cancelSheet);
  byId("sheet-backdrop").addEventListener("click", cancelSheet);
  byId("file-input").addEventListener("change", handleImageUpload);
  byId("save-effect-btn").addEventListener("click", enterAdjustmentMode);
  byId("adjustment-cancel-btn").addEventListener("click", cancelSheet);
  byId("adjustment-save-btn").addEventListener("click", saveEffect);
  byId("fine-adjust-toggle").addEventListener("click", toggleFineAdjustControls);
  byId("delete-btn").addEventListener("click", () => setModal("delete-dialog", true));
  byId("delete-cancel-btn").addEventListener("click", () => setModal("delete-dialog", false));
  byId("delete-confirm-btn").addEventListener("click", deleteEffect);
  byId("help-btn").addEventListener("click", () => setModal("tutorial-overlay", true));
  byId("tutorial-close-btn").addEventListener("click", () => {
    setModal("tutorial-overlay", false);
    safeStorageSet("arCameraTutorialSeen", "1");
  });
  byId("change-platform-btn").addEventListener("click", () => {
    setModal("tutorial-overlay", false);
    openPlatformSelector(true);
  });
  byId("platform-cancel-btn").addEventListener("click", () => setModal("platform-overlay", false));
  document.querySelectorAll("[data-platform]").forEach((button) => {
    button.addEventListener("click", () => selectPlatform(button.dataset.platform));
  });
  document.querySelectorAll(".part-btn").forEach((button) => {
    button.addEventListener("click", () => {
      if (!draftConfig) return;
      draftConfig.point = button.dataset.point;
      syncPlacementButtons();
      syncEditorUI();
    });
  });
  document.querySelectorAll("[data-adjust]").forEach((button) => {
    button.addEventListener("click", () => nudgeDraftEffect(button.dataset.adjust));
  });
  document.querySelectorAll("[data-scale]").forEach((button) => {
    button.addEventListener("click", () => scaleDraftEffect(button.dataset.scale));
  });
  byId("reset-effect-btn").addEventListener("click", resetDraftEffect);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (isRecording) {
        stopRecording();
        showToast("画面が閉じられたため録画を停止しました");
      }
      stopFaceDetection();
      faceCoordinateSpace = null;
      observedFaceRange = null;
    } else if (cameraReady && video && modelReady) {
      beginFaceDetection();
    }
  });
  window.addEventListener("orientationchange", () => {
    // 回転前後ではFaceMeshの座標基準が変わるため、古い平滑化座標を混ぜない。
    faces = [];
    facePlacementStates.clear();
    faceCoordinateSpace = null;
    observedFaceRange = null;
    scheduleCanvasResize();
    if (isRecording) {
      stopRecording();
      showToast("画面が回転したため録画を停止しました");
    }
  });
  window.addEventListener("pagehide", cleanup);
  window.addEventListener("beforeunload", cleanup);

  if (SAVED_PLATFORM && !safeStorageGet("arCameraTutorialSeen")) {
    window.setTimeout(() => setModal("tutorial-overlay", true), 400);
  }
}

function readSavedPlatform() {
  try {
    const value = localStorage.getItem("arCameraPlatformV1");
    if (value === "ios" || value === "android") return value;
  } catch {}
  const requested = new URLSearchParams(location.search).get("platform");
  return requested === "ios" || requested === "android" ? requested : "";
}

function openPlatformSelector(canCancel) {
  document.querySelectorAll("[data-platform]").forEach((button) => {
    button.dataset.recommended = String(button.dataset.platform === AUTO_PLATFORM);
    button.dataset.selected = String(Boolean(SAVED_PLATFORM) && button.dataset.platform === SAVED_PLATFORM);
    button.setAttribute("aria-pressed", button.dataset.selected);
  });
  byId("platform-cancel-btn").hidden = !canCancel;
  setModal("platform-overlay", true);
}

function selectPlatform(platform) {
  if (platform !== "ios" && platform !== "android") return;
  if (!safeStorageSet(PLATFORM_KEY, platform)) {
    const url = new URL(location.href);
    url.searchParams.set("platform", platform);
    location.href = url.href;
    return;
  }
  document.querySelectorAll("[data-platform]").forEach((button) => {
    const selected = button.dataset.platform === platform;
    button.dataset.selected = String(selected);
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = true;
  });
  window.setTimeout(() => {
    showLoader("端末設定を反映中");
    location.reload();
  }, 160);
}

function hideLoaderImmediately() {
  const loader = byId("loading-screen");
  loader.style.opacity = "0";
  loader.hidden = true;
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
  const selected = assetList[currentIndex];
  byId("edit-selected-btn").hidden = !selected?.custom;
}

function selectEffect(index) {
  if (index < 0 || index >= assetList.length) index = 0;
  if (
    index === currentIndex &&
    assetList[index]?.custom &&
    byId("settings-panel").hidden &&
    byId("adjustment-mode").hidden
  ) {
    openEditSheet(index);
    return;
  }
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
  draftConfig = { id: createId(), name: "追加画像", point: "face", scale: 2.4, xOff: 0, yOff: 0, custom: true };
  draftImage = null;
  byId("panel-title").textContent = "エフェクトを追加";
  byId("upload-section").hidden = false;
  byId("delete-btn").hidden = true;
  byId("save-effect-btn").textContent = "位置を調整";
  byId("file-input").value = "";
  syncPlacementButtons();
  setSheet(true);
  syncEditorUI();
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
  byId("save-effect-btn").textContent = "位置を調整";
  syncPlacementButtons();
  setSheet(true);
  syncEditorUI();
}

function cancelSheet() {
  if (editingIndex < 0 && draftConfig?.custom) void idbDelete(draftConfig.id).catch(() => {});
  draftConfig = null;
  draftImage = null;
  editingIndex = -1;
  revokeDraftUrl();
  byId("adjustment-mode").hidden = true;
  document.body.classList.remove("adjustment-mode");
  setSheet(false);
}

function enterAdjustmentMode() {
  if (!draftConfig) return;
  if (editingIndex < 0 && !draftImage) {
    showToast("画像を選んでください");
    return;
  }
  setSheet(false);
  byId("fine-adjust-controls").hidden = true;
  byId("fine-adjust-toggle").setAttribute("aria-expanded", "false");
  byId("adjustment-mode").hidden = false;
  document.body.classList.add("adjustment-mode");
  syncEditorUI();
}

function toggleFineAdjustControls() {
  const controls = byId("fine-adjust-controls");
  const opening = controls.hidden;
  controls.hidden = !opening;
  byId("fine-adjust-toggle").setAttribute("aria-expanded", String(opening));
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

function syncEditorUI() {
  if (!draftConfig) return;
  const ready = editingIndex >= 0 || Boolean(draftImage);
  const controls = byId("effect-edit-controls");
  controls.classList.toggle("is-disabled", !ready);
  controls.querySelectorAll("button").forEach((button) => {
    button.disabled = !ready;
  });
  byId("save-effect-btn").disabled = !ready;
  byId("effect-scale-value").textContent = `${draftConfig.scale.toFixed(2)}×`;

  syncEditorStatus();
}

function syncEditorStatus() {
  if (!draftConfig) return;
  const ready = editingIndex >= 0 || Boolean(draftImage);
  let message = "画像を選んでください";
  if (ready && draftConfig.point === "bg") message = "「位置を調整」で全画面表示します";
  if (ready && draftConfig.point === "face") {
    message = faces.length
      ? `顔を${Math.min(faces.length, 5)}人検出中・「位置を調整」で全画面表示します`
      : "顔を画面中央に映してください";
  }
  const status = byId("face-edit-status");
  if (status.textContent !== message) status.textContent = message;
}

function nudgeDraftEffect(direction) {
  if (!draftConfig || (!draftImage && editingIndex < 0)) return;
  const step = 4;
  if (direction === "left") draftConfig.xOff -= step;
  if (direction === "right") draftConfig.xOff += step;
  if (direction === "up") draftConfig.yOff -= step;
  if (direction === "down") draftConfig.yOff += step;
}

function scaleDraftEffect(direction) {
  if (!draftConfig || (!draftImage && editingIndex < 0)) return;
  const delta = direction === "up" ? .1 : -.1;
  draftConfig.scale = clamp(draftConfig.scale + delta, .2, 6);
  syncEditorUI();
}

function resetDraftEffect() {
  if (!draftConfig || (!draftImage && editingIndex < 0)) return;
  draftConfig.xOff = 0;
  draftConfig.yOff = 0;
  draftConfig.scale = draftConfig.point === "face" ? 2.4 : 1;
  syncEditorUI();
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
    syncEditorUI();
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
  const wasEditing = editingIndex >= 0;
  draftConfig.scale = clamp(draftConfig.scale, .2, 6);
  if (editingIndex >= 0) {
    assetList[editingIndex] = { ...draftConfig };
  } else {
    assetList.push({ ...draftConfig });
    currentIndex = assetList.length - 1;
    images.set(draftConfig.id, draftImage);
    if (draftObjectUrl) {
      revokeAssetPreviewUrl(draftConfig.id);
      assetPreviewUrls.set(draftConfig.id, draftObjectUrl);
      draftObjectUrl = "";
    }
  }
  persistMetadata();
  draftConfig = null;
  draftImage = null;
  editingIndex = -1;
  byId("adjustment-mode").hidden = true;
  document.body.classList.remove("adjustment-mode");
  setSheet(false);
  createIconList();
  showToast(wasEditing ? "変更を保存しました" : "エフェクトを追加しました");
}

async function deleteEffect() {
  if (editingIndex <= 0 || editingIndex >= assetList.length || assetList[editingIndex].builtIn) return;
  const removed = assetList[editingIndex];
  assetList.splice(editingIndex, 1);
  images.delete(removed.id);
  revokeAssetPreviewUrl(removed.id);
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
    const recordingFps = IS_LOW_SPEC_DEVICE ? 20 : 30;
    const canvasPixels = canvas.width * canvas.height;
    const videoBitsPerSecond = IS_LOW_SPEC_DEVICE
      ? 1500000
      : canvasPixels <= 1280 * 720 ? 2500000 : 4000000;
    recordingStream = canvas.captureStream(recordingFps);
    mediaRecorder = new MediaRecorder(recordingStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond
    });
  } catch {
    stopRecordingTracks();
    mediaRecorder = null;
    showToast("動画録画を開始できませんでした");
    return;
  }
  recordedChunks = [];
  recordingFailed = false;
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) recordedChunks.push(event.data);
  });
  mediaRecorder.addEventListener("stop", saveVideo, { once: true });
  mediaRecorder.addEventListener("error", handleRecordingError, { once: true });
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
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch { handleRecordingError(); }
  } else {
    stopRecordingTracks();
  }
}

function handleRecordingError() {
  recordingFailed = true;
  isRecording = false;
  window.clearInterval(timerInterval);
  timerInterval = null;
  document.body.classList.remove("recording");
  byId("video-timer").textContent = "00:00";
  byId("main-shutter-btn").setAttribute("aria-label", "録画を開始する");
  stopRecordingTracks();
  showToast("録画中にエラーが発生しました");
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
  if (recordingFailed) {
    recordedChunks = [];
    mediaRecorder = null;
    return;
  }
  if (!blob.size) return showToast("動画を保存できませんでした");
  await shareOrDownload(blob, `ar-video-${Date.now()}.${extension}`, type, "AR動画");
  recordedChunks = [];
  mediaRecorder = null;
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
    if (!document.body.classList.contains("adjustment-mode") || !draftConfig) return;
    canvas.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 2) {
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
      syncEditorUI();
    } else if (previous) {
      const offsetScale = getDraftOffsetScale();
      draftConfig.xOff += (event.clientX - previous.x) / offsetScale;
      draftConfig.yOff += (event.clientY - previous.y) / offsetScale;
    }
    event.preventDefault();
  }, { passive: false });

  const endPointer = (event) => {
    activePointers.delete(event.pointerId);
    if (activePointers.size < 2) pinchOrigin = null;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
}

function getDraftOffsetScale() {
  if (draftConfig?.point === "bg") return Math.max(.1, width / 480);
  if (draftConfig?.point !== "face" || !faces.length || !video || !cameraReady) return 1;
  const placement = resolveFacePlacement(faces[0], getCameraFrame());
  return placement ? Math.max(.1, placement.faceWidth / FACE_OFFSET_REFERENCE_WIDTH) : 1;
}

function getViewportSize() {
  const container = document.getElementById("camera-container");
  const bounds = container?.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportWidth = viewport?.width || document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = viewport?.height || document.documentElement.clientHeight || window.innerHeight;
  return {
    width: Math.max(1, Math.round(bounds?.width || viewportWidth)),
    height: Math.max(1, Math.round(bounds?.height || viewportHeight))
  };
}

function syncCanvasToViewport() {
  canvasResizeFrame = 0;
  const next = getViewportSize();
  if (width !== next.width || height !== next.height) {
    resizeCanvas(next.width, next.height);
    // 異なるCanvasサイズで平滑化した座標を次の向きへ持ち越さない。
    faces = [];
    facePlacementStates.clear();
    faceCoordinateSpace = null;
    observedFaceRange = null;
  }
}

function scheduleCanvasResize() {
  if (canvasResizeFrame) cancelAnimationFrame(canvasResizeFrame);
  canvasResizeFrame = requestAnimationFrame(syncCanvasToViewport);
}

function windowResized() {
  scheduleCanvasResize();
}

function cleanup() {
  cameraStartGeneration += 1;
  setCameraSwitchBusy(false);
  if (isRecording) stopRecording();
  window.clearInterval(timerInterval);
  window.clearTimeout(toastTimer);
  window.clearTimeout(longPressTimer);
  window.clearInterval(detectionWatchdogTimer);
  detectionWatchdogTimer = null;
  if (canvasResizeFrame) cancelAnimationFrame(canvasResizeFrame);
  canvasResizeFrame = 0;
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
  window.visualViewport?.removeEventListener("resize", scheduleCanvasResize);
  stopRecordingTracks();
  stopFaceDetection();
  stopCameraTracks();
  revokeDraftUrl();
  for (const id of assetPreviewUrls.keys()) revokeAssetPreviewUrl(id);
}

function stopRecordingTracks() {
  if (recordingStream) recordingStream.getTracks().forEach((track) => track.stop());
  recordingStream = null;
}

async function loadStoredAssets() {
  const stored = safeJsonParse(safeStorageGet(STORAGE_KEY));
  if (Array.isArray(stored)) {
    assetList = DEFAULT_ASSETS.map((asset) => ({ ...asset, builtIn: true }))
      .concat(stored
        .filter((asset) => asset?.custom && asset.id)
        .map((asset) => ({
          ...asset,
          // 旧版の追加画像へ一律設定していた初期値だけを中立位置へ移行する。
          yOff: Number(asset.yOff) === -60 ? 0 : asset.yOff
        })));
  } else {
    assetList = DEFAULT_ASSETS.map((asset) => ({ ...asset, builtIn: true }));
    await migrateLegacyAssets();
  }
  const customAssets = assetList.filter((item) => item.custom);
  await Promise.allSettled(customAssets.map(async (asset) => {
    const blob = await idbGet(asset.id);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    try {
      images.set(asset.id, await loadP5Image(url));
      revokeAssetPreviewUrl(asset.id);
      assetPreviewUrls.set(asset.id, url);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }));
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
  return assetPreviewUrls.get(asset.id) || images.get(asset.id)?.src || "";
}

function revokeAssetPreviewUrl(id) {
  const url = assetPreviewUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  assetPreviewUrls.delete(id);
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
    image.onerror = (error) => {
      URL.revokeObjectURL(url);
      reject(error);
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function setModal(id, open) {
  const modal = byId(id);
  if (open) {
    modalFocusOrigins.set(id, document.activeElement);
    modal.hidden = false;
    requestAnimationFrame(() => {
      modal.querySelector("button:not([hidden]):not([disabled]), input:not([hidden]):not([disabled])")?.focus();
    });
    return;
  }
  modal.hidden = true;
  const origin = modalFocusOrigins.get(id);
  modalFocusOrigins.delete(id);
  if (origin?.isConnected) origin.focus();
}

function setStatus(message) {
  const status = byId("status-pill");
  status.textContent = message;
  status.style.opacity = "1";
}

function showLoader(message) {
  window.clearTimeout(loaderHideTimer);
  const loader = byId("loading-screen");
  loader.hidden = false;
  loader.style.opacity = "1";
  loader.querySelector("p").textContent = message;
  loader.querySelector(".spinner").hidden = false;
  byId("loading-retry-btn").hidden = true;
}

function hideLoader() {
  const loader = byId("loading-screen");
  window.clearTimeout(loaderHideTimer);
  loader.style.opacity = "0";
  loaderHideTimer = window.setTimeout(() => { loader.hidden = true; }, 220);
}

function showCameraError(message) {
  cameraReady = false;
  showLoader(message);
  const spinner = byId("loading-screen").querySelector(".spinner");
  spinner.hidden = true;
  byId("loading-retry-btn").hidden = false;
  setStatus(message);
}

function showFaceMeshError(message) {
  showLoader(message);
  byId("loading-screen").querySelector(".spinner").hidden = true;
  byId("loading-retry-btn").hidden = false;
  setStatus(message);
}

function retryCameraOrModel() {
  if (cameraSwitchInProgress || modelLoading) return;
  if (!cameraReady || !video) {
    startCamera(isFrontCamera ? "user" : "environment");
    return;
  }
  showLoader("顔認識を準備中");
  initializeFaceMesh();
}

function showToast(message) {
  const toast = byId("toast");
  window.clearTimeout(toastTimer);
  window.clearTimeout(loaderHideTimer);
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
