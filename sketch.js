var faceMesh; var video; var faces = []; var images = []; var currentIndex = 0; var isFrontCamera = true; 

// ✨ ジェスチャー用の変数 ✨
let initialPinchDist = 0;
let baseStampScale = 1; // カメラではなく「スタンプの基準サイズ」を記憶
let isDragging = false; 
let lastTouchX = 0;
let lastTouchY = 0;

var defaultAssets = [
  { fileName: "mimi.png", scale: 2.4, xOff: 0, yOff: -60, point: 1 },
  { fileName: "hat.png", scale: 2.5, xOff: 0, yOff: -100, point: 1 },
  { fileName: "sunset.png", scale: 1.0, xOff: 0, yOff: 0, point: 'bg' },
  { fileName: "star.png", scale: 1.0, xOff: 0, yOff: 0, point: 'bg' }
];

var assetList = [...defaultAssets];

let savedAssets = localStorage.getItem('myARCameraData_V6');
if (savedAssets) { 
  try { 
    let parsed = JSON.parse(savedAssets);
    if (parsed && parsed.length > 0) assetList = parsed;
  } catch(e) { console.log("データ読み込み失敗"); } 
}

var previewImg = null; var previewConfig = { scale: 2.4, xOff: 0, yOff: -60, point: 1, fileData: null };
var isEditMode = false; var editingIndex = -1; var originalConfig = null; 
var currentMode = 'photo'; var mediaRecorder; var recordedChunks = []; var isRecording = false;

function preload() {
  for (let i = 0; i < assetList.length; i++) {
    let imgSrc = assetList[i].fileData ? assetList[i].fileData : assetList[i].fileName;
    images[i] = loadImage(imgSrc);
  }
  faceMesh = ml5.faceMesh({ maxFaces: 5, flipHorizontal: false });
}

function setup() {
  let cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent('camera-container'); startCamera("user");
  createIconList(); setupPreviewEvents();

  document.getElementById('mode-photo').onclick = () => switchMode('photo');
  document.getElementById('mode-video').onclick = () => switchMode('video');

  document.getElementById('main-shutter-btn').onclick = () => {
    if (currentMode === 'photo') { takePhoto(); } else { toggleRecording(); }
  };

  document.getElementById('open-settings-btn').onclick = () => {
    document.body.classList.add('split-mode'); openPanelInAddMode();
  };
  document.getElementById('close-panel-btn').onclick = () => {
    document.body.classList.remove('split-mode');
  };

  let switchBtn = document.getElementById('switch-camera-btn');
  if (switchBtn) {
    switchBtn.onclick = () => { isFrontCamera = !isFrontCamera; startCamera(isFrontCamera ? "user" : "environment"); };
  }

  setTimeout(() => {
    let loader = document.getElementById('loading-screen');
    if(loader) {
      loader.style.opacity = '0';
      setTimeout(() => loader.style.display = 'none', 500);
    }
  }, 3000); 
}

function switchMode(mode) {
  if (isRecording) return;
  currentMode = mode;
  document.getElementById('mode-photo').classList.toggle('active', mode === 'photo');
  document.getElementById('mode-video').classList.toggle('active', mode === 'video');
  document.body.classList.toggle('mode-video-active', mode === 'video');
}

function startCamera(facingMode) {
  if (video) {
    if (video.elt && video.elt.srcObject) video.elt.srcObject.getTracks().forEach(t => t.stop());
    video.remove();
  }
  video = createCapture({ video: { facingMode: facingMode }, audio: false }, function() {
    faceMesh.detectStart(video, function(results) { faces = results; });
  });
  video.hide();
}

function draw() {
  background(20);
  if (!video || !video.elt || video.width === 0 || video.height === 0) return;
  
  let imgScale = max(width / video.width, height / video.height);
  let vW = video.width * imgScale; let vH = video.height * imgScale;
  let vX = (width - vW) / 2; let vY = (height - vH) / 2;
  
  push(); if (isFrontCamera) { translate(width, 0); scale(-1, 1); }
  image(video, vX, vY, vW, vH);
  
  let targetImg = previewImg ? previewImg : images[currentIndex];
  let targetConfig = previewImg ? previewConfig : assetList[currentIndex];
  
  if (targetImg) {
    if (targetConfig.point === 'bg') {
      imageMode(CENTER); 
      let bgScale = (height / targetImg.height) * targetConfig.scale; 
      push(); 
      translate(width/2 + (targetConfig.xOff || 0), height/2 + (targetConfig.yOff || 0)); 
      if (isFrontCamera) scale(-1, 1); 
      image(targetImg, 0, 0, targetImg.width * bgScale, targetImg.height * bgScale); 
      pop();
    } else if (faces && faces.length > 0) {
      for (let face of faces) {
        let pt = parseInt(targetConfig.point); 
        if(face.keypoints[pt]) {
          let tx = vX + face.keypoints[pt].x * imgScale; let ty = vY + face.keypoints[pt].y * imgScale;
          let fw = abs(vX + face.keypoints[454].x * imgScale - (vX + face.keypoints[234].x * imgScale));
          imageMode(CENTER); push(); translate(tx + (targetConfig.xOff || 0), ty + (targetConfig.yOff || 0));
          if (isFrontCamera) scale(-1, 1); image(targetImg, 0, 0, fw * targetConfig.scale, fw * targetConfig.scale * (targetImg.height / targetImg.width)); pop();
        }
      }
    }
  }
  pop(); 
}

function createIconList() {
  let iconContainer = select('#icon-list'); if (!iconContainer) return; iconContainer.html(''); 
  for (let i = 0; i < assetList.length; i++) {
    let icon = createDiv(''); icon.parent(iconContainer); icon.addClass('filter-icon');
    icon.style('background-image', `url(${assetList[i].fileData || assetList[i].fileName})`);
    let editBadge = createDiv('⚙️'); editBadge.addClass('edit-badge'); editBadge.parent(icon);
    editBadge.mousePressed((e) => { e.stopPropagation(); document.body.classList.add('split-mode'); openPanelInEditMode(i); });
    icon.mousePressed(() => { currentIndex = i; previewImg = null; selectAll('.filter-icon').forEach(el => el.removeClass('active')); icon.addClass('active'); });
    if (i === currentIndex) icon.addClass('active');
  }
}

// ✨ スライダーリセット処理を削除してスッキリ！ ✨
function openPanelInAddMode() {
  isEditMode = false; document.getElementById('panel-title').innerText = '新しいイラストを登録';
  document.getElementById('upload-section').style.display = 'block'; 
  document.getElementById('add-btn').style.display = 'block';
  document.getElementById('edit-btns').style.display = 'none'; 
  document.getElementById('file-input').value = "";
  previewImg = null; previewConfig = { scale: 2.4, xOff: 0, yOff: -60, point: 1, fileData: null };
}

function openPanelInEditMode(index) {
  isEditMode = true; editingIndex = index; currentIndex = index; 
  document.getElementById('panel-title').innerText = 'イラストを編集'; 
  document.getElementById('upload-section').style.display = 'none'; 
  document.getElementById('add-btn').style.display = 'none';
  document.getElementById('edit-btns').style.display = 'flex'; 
  let d = assetList[index]; 
  previewImg = images[index]; previewConfig = { ...d }; originalConfig = { ...d }; 
}

function setupPreviewEvents() {
  document.getElementById('file-input').onchange = (e) => {
    let r = new FileReader(); r.onload = (ev) => { previewImg = loadImage(ev.target.result); previewConfig.fileData = ev.target.result; }; r.readAsDataURL(e.target.files[0]);
  };
  document.querySelectorAll('.part-btn').forEach(btn => {
    btn.onclick = (e) => { document.querySelectorAll('.part-btn').forEach(b => b.classList.remove('active')); e.target.classList.add('active'); previewConfig.point = e.target.getAttribute('data-point'); };
  });
  
  document.getElementById('add-btn').onclick = () => { 
    if(!previewImg) return alert("画像を選んでね！"); assetList.push({...previewConfig}); images.push(previewImg); saveAndClose(); 
  };
  document.getElementById('update-btn').onclick = () => { 
    assetList[editingIndex] = {...previewConfig}; images[editingIndex] = previewImg; saveAndClose(); 
  };
  document.getElementById('delete-btn').onclick = () => { 
    if(confirm("消す？")){ assetList.splice(editingIndex, 1); images.splice(editingIndex, 1); currentIndex = 0; saveAndClose(); } 
  };
}

function saveAndClose() { 
  localStorage.setItem('myARCameraData_V6', JSON.stringify(assetList)); 
  document.body.classList.remove('split-mode'); 
  previewImg = null; 
  createIconList(); 
}

function toggleRecording() { if (isRecording) { stopRecording(); } else { startRecording(); } }

function startRecording() {
  let canvasElement = document.querySelector('canvas');
  let stream = canvasElement.captureStream(30);
  let options = { mimeType: 'video/mp4' };
  if (!MediaRecorder.isTypeSupported('video/mp4')) options = { mimeType: 'video/webm' };
  mediaRecorder = new MediaRecorder(stream, options);
  recordedChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = saveVideo;
  mediaRecorder.start();
  isRecording = true;
  document.getElementById('main-shutter-btn').classList.add('recording');
}

function stopRecording() {
  if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  isRecording = false;
  document.getElementById('main-shutter-btn').classList.remove('recording');
}

async function saveVideo() {
  let blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
  let ext = mediaRecorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
  let file = new File([blob], `ar-video.${ext}`, { type: mediaRecorder.mimeType });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'AR動画' }); } catch (error) {}
  } else {
    let url = URL.createObjectURL(blob); let a = document.createElement('a'); a.href = url; a.download = `ar-video.${ext}`; a.click();
  }
}

async function takePhoto() {
  let flash = document.getElementById('flash-overlay');
  if (flash) {
    flash.classList.remove('fade');
    flash.classList.add('active');
    setTimeout(() => {
      flash.classList.remove('active');
      flash.classList.add('fade');
    }, 50);
  }

  let canvasElement = document.querySelector('canvas');
  canvasElement.toBlob(async (blob) => {
    let file = new File([blob], 'ar-photo.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { 
        await navigator.share({ files: [file], title: 'AR写真' }); 
      } catch (error) {
        console.log("シェアがキャンセルされました");
      }
    } else {
      saveCanvas('ar-photo-' + Date.now(), 'png');
    }
  }, 'image/png');
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

// ✨ スライダー不要！指だけでスタンプを完璧に操るジェスチャー ✨
function touchStarted(event) {
  // UI（ボタンやアイコン）を触った時は無視！
  if (event && event.target && event.target.tagName !== 'CANVAS') {
    isDragging = false; return;
  }
  
  let targetConfig = previewImg ? previewConfig : assetList[currentIndex];

  if (touches.length === 2) {
    // ✌️ 2本指なら「スタンプの拡大縮小」の準備
    initialPinchDist = dist(touches[0].x, touches[0].y, touches[1].x, touches[1].y);
    baseStampScale = targetConfig ? (targetConfig.scale || 1) : 1;
    isDragging = false; 
  } else if (touches.length === 1 || mouseIsPressed) {
    // 👆 1本指なら「スタンプの移動」の準備
    isDragging = true;
    lastTouchX = touches.length > 0 ? touches[0].x : mouseX;
    lastTouchY = touches.length > 0 ? touches[0].y : mouseY;
  }
}

function touchMoved(event) {
  if (event && event.target && event.target.tagName !== 'CANVAS') return; 

  let targetConfig = previewImg ? previewConfig : assetList[currentIndex];
  if (!targetConfig) return;

  if (touches.length === 2) {
    // ✌️ ピンチでスタンプの大きさを変える！
    let currentPinchDist = dist(touches[0].x, touches[0].y, touches[1].x, touches[1].y);
    let zoomFactor = currentPinchDist / initialPinchDist;
    targetConfig.scale = baseStampScale * zoomFactor;
    return false; 
  } else if (isDragging) {
    // 👆 スワイプでスタンプを移動させる！
    let currentX = touches.length > 0 ? touches[0].x : mouseX;
    let currentY = touches.length > 0 ? touches[0].y : mouseY;
    let dx = currentX - lastTouchX;
    let dy = currentY - lastTouchY;
    if (isFrontCamera) dx = -dx;

    targetConfig.xOff = (targetConfig.xOff || 0) + dx;
    targetConfig.yOff = (targetConfig.yOff || 0) + dy;

    lastTouchX = currentX;
    lastTouchY = currentY;
    return false; 
  }
}

function touchEnded() {
  if (isDragging || touches.length === 0) {
    isDragging = false;
    // 指を離した瞬間に変更を保存
    localStorage.setItem('myARCameraData_V6', JSON.stringify(assetList));
  }
}

function mouseReleased() { touchEnded(); }