var faceMesh; var video; var faces = []; var images = []; var currentIndex = 0; var isFrontCamera = true; 

// ✨ 最初から入っている厳選アセット（合計4枚） ✨
var defaultAssets = [
  // --- 顔ハメ（2枚） ---
  { fileName: "mimi.png", scale: 2.4, xOff: 0, yOff: -60, point: 1 },
  { fileName: "hat.png", scale: 2.5, xOff: 0, yOff: -100, point: 1 },
  
  // --- 背景（2枚） ---
  { fileName: "sunset.png", scale: 1.0, xOff: 0, yOff: 0, point: 'bg' },
  { fileName: "star.png", scale: 1.0, xOff: 0, yOff: 0, point: 'bg' }
];

var assetList = [...defaultAssets];

// ✨ データを「V6」にアップデート！これで過去の記憶を強制リセット！ ✨
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

// ↓ sketch.js の中にある draw() をこれに書き換え！

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
      // ✨ 修正ポイント：背景でもスライダーの数値（scale, xOff, yOff）を反映させる！ ✨
      imageMode(CENTER); 
      let bgScale = (height / targetImg.height) * targetConfig.scale; // スライダーの大きさを掛ける
      push(); 
      // スライダーの上下左右のズレを足す
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

function openPanelInAddMode() {
  isEditMode = false; document.getElementById('panel-title').innerText = '新しいイラストを登録';
  document.getElementById('upload-section').style.display = 'block'; 
  document.getElementById('add-btn').style.display = 'block';
  document.getElementById('edit-btns').style.display = 'none'; 
  document.getElementById('file-input').value = "";
  resetSliders(2.4, 0, -60); previewImg = null;
}

function openPanelInEditMode(index) {
  isEditMode = true; editingIndex = index; currentIndex = index; 
  document.getElementById('panel-title').innerText = 'イラストを編集'; 
  document.getElementById('upload-section').style.display = 'none'; 
  document.getElementById('add-btn').style.display = 'none';
  document.getElementById('edit-btns').style.display = 'flex'; 
  let d = assetList[index]; resetSliders(d.scale, d.xOff || 0, d.yOff || 0);
  previewImg = images[index]; previewConfig = { ...d }; originalConfig = { ...d }; 
}

function resetSliders(s, x, y) {
  document.getElementById('scale-slider').value = s; document.getElementById('x-slider').value = x; document.getElementById('y-slider').value = y;
  previewConfig.scale = s; previewConfig.xOff = x; previewConfig.yOff = y;
}

function setupPreviewEvents() {
  document.getElementById('file-input').onchange = (e) => {
    let r = new FileReader(); r.onload = (ev) => { previewImg = loadImage(ev.target.result); previewConfig.fileData = ev.target.result; }; r.readAsDataURL(e.target.files[0]);
  };
  document.querySelectorAll('.part-btn').forEach(btn => {
    btn.onclick = (e) => { document.querySelectorAll('.part-btn').forEach(b => b.classList.remove('active')); e.target.classList.add('active'); previewConfig.point = e.target.getAttribute('data-point'); };
  });
  document.getElementById('scale-slider').oninput = (e) => previewConfig.scale = parseFloat(e.target.value);
  document.getElementById('x-slider').oninput = (e) => previewConfig.xOff = parseFloat(e.target.value);
  document.getElementById('y-slider').oninput = (e) => previewConfig.yOff = parseFloat(e.target.value);
  document.getElementById('reset-scale').onclick = () => resetSliders(isEditMode ? originalConfig.scale : 2.4, previewConfig.xOff, previewConfig.yOff);
  document.getElementById('reset-x').onclick = () => resetSliders(previewConfig.scale, isEditMode ? originalConfig.xOff : 0, previewConfig.yOff);
  document.getElementById('reset-y').onclick = () => resetSliders(previewConfig.scale, previewConfig.xOff, isEditMode ? originalConfig.yOff : -60);
  
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
  // 保存名も「_V6」に！
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

// ↓ この関数をまるまる上書き！

async function takePhoto() {
  // ✨ 1. フラッシュを光らせる演出
  let flash = document.getElementById('flash-overlay');
  if (flash) {
    flash.classList.remove('fade');
    flash.classList.add('active');
    setTimeout(() => {
      flash.classList.remove('active');
      flash.classList.add('fade');
    }, 50);
  }

  // 📸 2. 写真を撮って保存する処理（ここが消えちゃってたはず！）
  let canvasElement = document.querySelector('canvas');
  canvasElement.toBlob(async (blob) => {
    let file = new File([blob], 'ar-photo.png', { type: 'image/png' });
    
    // スマホのシェア画面（LINEで送る・画像を保存する画面）が出せるかチェック
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { 
        await navigator.share({ files: [file], title: 'AR写真' }); 
      } catch (error) {
        console.log("シェアがキャンセルされました");
      }
    } else {
      // PCなどの場合は普通にダウンロードフォルダに保存
      saveCanvas('ar-photo-' + Date.now(), 'png');
    }
  }, 'image/png');
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }