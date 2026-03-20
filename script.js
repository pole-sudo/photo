/* ═══════════════════════════════════════════
   PhotoVisa — script.js
   ═══════════════════════════════════════════ */

// ══════════════════════════════════════════
// STATE
// ══════════════════════════════════════════
var origImg = null, origFile = null;
var aiMaskImg = null;
var faceData = null;
var bgColor = { r: 255, g: 255, b: 255 };
var curFmt = 'passport-vn';
var removeBackground = null;
var aiReady = false;
var rendering = false;
var animId = null, needDraw = false;

// Result preview zoom state
var rv = { scale: 1, tx: 0, ty: 0, dragging: false, dx: 0, dy: 0 };
// Lightbox state
var lb = { scale: 1, tx: 0, ty: 0, dragging: false, dx: 0, dy: 0 };

// Crop state
var cs = { x: 0, y: 0, scale: 1 };
var cW = 0, cH = 0;
var frame = { x: 0, y: 0, w: 0, h: 0 };
var dragging = false, dp = { x: 0, y: 0 };
var lastPinch = 0;

var FMTS = {
  'passport-vn': { w: 413, h: 531,  lbl: '35 × 45 mm', dpi: 300 },
  'cccd':        { w: 354, h: 472,  lbl: '30 × 40 mm', dpi: 300 },
  'us-visa':     { w: 600, h: 600,  lbl: '51 × 51 mm', dpi: 300 },
  'schengen':    { w: 413, h: 531,  lbl: '35 × 45 mm', dpi: 300 },
  'uk-visa':     { w: 413, h: 531,  lbl: '35 × 45 mm', dpi: 300 },
  'japan':       { w: 413, h: 531,  lbl: '35 × 45 mm', dpi: 300 },
};

// ══════════════════════════════════════════
// LOAD AI — try multiple CDN sources
// ══════════════════════════════════════════
async function loadAI() {
  var urls = [
    'https://esm.sh/@imgly/background-removal@1.5.5',
    'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/dist/index.mjs',
    'https://unpkg.com/@imgly/background-removal@1.5.5/dist/index.mjs',
  ];
  for (var u of urls) {
    try {
      var mod = await import(u);
      var fn = mod.removeBackground || mod.default?.removeBackground || mod.default;
      if (typeof fn === 'function') {
        removeBackground = fn;
        aiReady = true;
        console.log('AI loaded from:', u);
        return true;
      }
    } catch (e) {
      console.warn('Failed:', u, e.message);
    }
  }
  return false;
}

// ══════════════════════════════════════════
// LOAD FACE-API (UMD script tag)
// ══════════════════════════════════════════
function loadFaceApi() {
  return new Promise(function (res) {
    if (window.faceapi) { res(true); return; }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
    s.onload = function () { res(true); };
    s.onerror = function () { res(false); };
    document.head.appendChild(s);
  });
}

async function loadFaceModels() {
  if (!window.faceapi) return;
  try {
    var U = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(U),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(U),
    ]);
  } catch (e) { console.warn('face models:', e); }
}

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function () {
  setSection('upload');

  // Preload AI + face-api in background
  (async function () {
    var ok = await loadAI();
    await loadFaceApi();
    if (!ok) setAiInfoBar(false);
  })();

  // Upload events
  var uz = document.getElementById('upload-zone');
  uz.addEventListener('dragover',  function (e) { e.preventDefault(); uz.classList.add('drag'); });
  uz.addEventListener('dragleave', function ()  { uz.classList.remove('drag'); });
  uz.addEventListener('drop', function (e) {
    e.preventDefault(); uz.classList.remove('drag');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  document.getElementById('file-input').addEventListener('change', function (e) {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });
});

// ══════════════════════════════════════════
// FILE HANDLING
// ══════════════════════════════════════════
function handleFile(file) {
  if (!file.type.startsWith('image/')) { toast('Vui lòng chọn file ảnh!', 'err'); return; }
  if (file.size > 15 * 1024 * 1024)   { toast('File quá lớn (tối đa 15MB)', 'err'); return; }
  origFile = file;
  var r = new FileReader();
  r.onload = function (e) {
    var img = new Image();
    img.onload = function () { origImg = img; process(); };
    img.src = e.target.result;
  };
  r.readAsDataURL(file);
}

// ══════════════════════════════════════════
// MAIN PROCESS PIPELINE
// ══════════════════════════════════════════
async function process() {
  setSection('loading');
  setP(5); setLS(1, 'active');
  setLoad('Đang tải thư viện...', '');

  if (!aiReady) {
    var ok = await loadAI();
    if (!ok) console.warn('AI unavailable — fallback mode');
  }
  await loadFaceApi();
  await loadFaceModels();
  setLS(1, 'done'); setP(20);

  // Draw to canvas for face detection
  var oc = document.getElementById('orig-canvas');
  oc.width = origImg.width; oc.height = origImg.height;
  oc.getContext('2d').drawImage(origImg, 0, 0);

  // Face detection
  setLS(2, 'active'); setLoad('Nhận dạng khuôn mặt...', '');
  faceData = null;
  if (window.faceapi) {
    try {
      var det = await faceapi
        .detectSingleFace(oc, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.28 }))
        .withFaceLandmarks(true);
      if (det) faceData = { box: det.detection.box, score: det.detection.score };
    } catch (e) { console.warn('face:', e); }
  }
  setLS(2, 'done'); setP(35);

  // AI background removal
  setLS(3, 'active');
  setLoad('AI đang tách nền...', 'Lần đầu có thể mất 20–40 giây để tải model');
  aiMaskImg = null;

  if (aiReady && removeBackground) {
    try {
      var aiCfg = buildAiCfg(function (key, cur, tot) {
        if (tot > 0) setP(35 + Math.round((cur / tot) * 50));
      });
      var blob = await removeBackground(origFile, aiCfg);
      aiMaskImg = await blobToImg(blob);
      setLS(3, 'done'); setP(88);
    } catch (e) {
      console.warn('AI removal failed:', e);
      setLS(3, 'done');
    }
  } else {
    setLS(3, 'done');
  }

  setLS(4, 'active'); setLoad('Hoàn thiện...', '');
  await delay(60);
  setSection('editor');
  await delay(50);

  initCrop();
  await renderResult();
  setP(100); setSteps(3); setLS(4, 'done');

  if (faceData) {
    document.getElementById('face-bar').className = 'fstatus ok';
    document.getElementById('face-txt').textContent = 'Nhận dạng khuôn mặt (' + Math.round(faceData.score * 100) + '%)';
  } else {
    document.getElementById('face-bar').className = 'fstatus warn';
    document.getElementById('face-txt').textContent = 'Không tìm thấy khuôn mặt — căn giữa tự động';
  }

  setAiInfoBar(!!aiMaskImg);
  toast(aiMaskImg ? '✅ AI tách nền thành công!' : '✅ Xử lý xong (flood fill)', 'ok');
}

async function reprocessAI() {
  if (!origFile)                      { toast('Chưa có ảnh', 'err'); return; }
  if (!aiReady || !removeBackground)  { toast('Thư viện AI chưa sẵn sàng', 'err'); return; }
  document.getElementById('renote').textContent = '🔄 AI đang xử lý lại...';
  try {
    var blob = await removeBackground(origFile, buildAiCfg(null));
    aiMaskImg = await blobToImg(blob);
    needDraw = true;
    await renderResult();
    document.getElementById('renote').textContent = '';
    setAiInfoBar(true);
    toast('✅ Đã tách nền lại!', 'ok');
  } catch (e) {
    document.getElementById('renote').textContent = '';
    toast('AI thất bại: ' + e.message, 'err');
  }
}

// publicPath → staticimgly.com (chứa .onnx model files)
// numThreads:1 → tắt SharedArrayBuffer (cần COOP/COEP không có ở file://)
// proxyToWorker:false → tránh tạo Worker từ blob: URL bị chặn ở file://
function buildAiCfg(progressCb) {
  var VERSION = '1.5.5';
  var cfg = {
    publicPath: 'https://staticimgly.com/@imgly/background-removal-data/' + VERSION + '/dist/',
    model: 'isnet_fp16',
    device: 'cpu',
    debug: false,
    proxyToWorker: false,
    onnxRuntime: { numThreads: 1 },
    output: { format: 'image/png', quality: 1 },
  };
  if (progressCb) cfg.progress = progressCb;
  return cfg;
}

// ══════════════════════════════════════════
// CROP EDITOR — INIT
// ══════════════════════════════════════════
function initCrop() {
  var cc = document.getElementById('crop-canvas');
  var dpr = window.devicePixelRatio || 1;

  // In the new layout the crop canvas fills the panel flex-column.
  // Use the parent panel's actual rendered width for the canvas width.
  var panel  = cc.closest('.panel-card') || cc.parentElement;
  var cWpx   = panel.clientWidth;
  // Height: match viewport feel — min 340, max 520
  var cHpx   = Math.round(Math.min(Math.max(cWpx * 0.85, 340), 520));

  cc.style.width  = cWpx + 'px';
  cc.style.height = cHpx + 'px';
  cc.width  = Math.round(cWpx * dpr);
  cc.height = Math.round(cHpx * dpr);
  cW = cWpx; cH = cHpx;

  compFrame();
  fitImage(false);
  if (faceData) centerFace();
  setupCropEv(cc);

  if (animId) cancelAnimationFrame(animId);
  (function loop() {
    if (needDraw) { drawCrop(); needDraw = false; }
    animId = requestAnimationFrame(loop);
  })();
  needDraw = true;
  updateZUI();
}

function compFrame() {
  var fmt = FMTS[curFmt], asp = fmt.w / fmt.h, pad = 32, fw, fh;
  if (asp >= cW / cH) { fw = cW - pad * 2; fh = fw / asp; }
  else                { fh = cH - pad * 2; fw = fh * asp; }
  frame = { x: (cW - fw) / 2, y: (cH - fh) / 2, w: fw, h: fh };
}

function fitImage(rerender) {
  if (!origImg) return;
  cs.scale = Math.min(cW / origImg.width, cH / origImg.height) * 0.94;
  cs.x = (cW - origImg.width  * cs.scale) / 2;
  cs.y = (cH - origImg.height * cs.scale) / 2;
  needDraw = true;
  updateZUI();
  if (rerender) schedRender();
}

function centerFace() {
  if (!faceData) return;
  var b = faceData.box;
  cs.scale = (frame.h * 0.65) / b.height;
  cs.x = (frame.x + frame.w / 2) - (b.x + b.width  / 2) * cs.scale;
  cs.y = (frame.y + frame.h * 0.37) - (b.y + b.height / 2) * cs.scale;
  needDraw = true;
  updateZUI();
}

function resetCrop() {
  if (faceData) centerFace(); else fitImage(false);
  needDraw = true; updateZUI(); schedRender();
}

// ══════════════════════════════════════════
// CROP EDITOR — DRAW
// ══════════════════════════════════════════
function drawCrop() {
  var cc = document.getElementById('crop-canvas');
  if (!cc || !origImg) return;
  var dpr = window.devicePixelRatio || 1;
  var ctx = cc.getContext('2d');
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cW, cH);

  // Checkerboard background
  var ts = 11;
  for (var iy = 0; iy < cH; iy += ts) {
    for (var ix = 0; ix < cW; ix += ts) {
      ctx.fillStyle = (Math.floor(ix / ts) + Math.floor(iy / ts)) % 2 === 0 ? '#1a2438' : '#141c2e';
      ctx.fillRect(ix, iy, ts, ts);
    }
  }

  // Draw image (AI mask preview if available)
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, cW, cH); ctx.clip();
  var src = aiMaskImg || origImg;
  ctx.drawImage(src, cs.x, cs.y, origImg.width * cs.scale, origImg.height * cs.scale);
  ctx.restore();

  // Dark overlay outside crop frame
  var fx = frame.x, fy = frame.y, fw = frame.w, fh = frame.h;
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(0,       0,        cW,       fy);
  ctx.fillRect(0,       fy + fh,  cW,       cH - fy - fh);
  ctx.fillRect(0,       fy,       fx,       fh);
  ctx.fillRect(fx + fw, fy,       cW - fx - fw, fh);

  // Rule-of-thirds grid
  ctx.save();
  ctx.strokeStyle = 'rgba(212,175,80,.18)'; ctx.lineWidth = 0.7;
  for (var i = 1; i < 3; i++) {
    var gx = fx + fw * i / 3, gy = fy + fh * i / 3;
    ctx.beginPath(); ctx.moveTo(gx, fy); ctx.lineTo(gx, fy + fh); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(fx, gy); ctx.lineTo(fx + fw, gy); ctx.stroke();
  }
  ctx.restore();

  // Frame border
  ctx.strokeStyle = 'rgba(212,175,80,.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(fx, fy, fw, fh);

  // Corner L-handles
  ctx.save();
  ctx.strokeStyle = '#f0cf7a'; ctx.lineWidth = 2.5; ctx.lineCap = 'square';
  var cl = 14;
  [[fx, fy, 1, 1], [fx + fw, fy, -1, 1], [fx, fy + fh, 1, -1], [fx + fw, fy + fh, -1, -1]].forEach(function (c) {
    ctx.beginPath();
    ctx.moveTo(c[0] + c[2] * cl, c[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(c[0], c[1] + c[3] * cl);
    ctx.stroke();
  });
  ctx.restore();

  // Format label overlay
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(fx + 4, fy + 4, 70, 17);
  ctx.fillStyle = '#d4af50'; ctx.font = 'bold 9px sans-serif';
  ctx.fillText(FMTS[curFmt].lbl, fx + 9, fy + 14);

  // Face guide circle
  if (faceData) {
    ctx.save();
    ctx.strokeStyle = 'rgba(52,211,153,.2)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(fx + fw / 2, fy + fh * 0.37, fw * 0.18, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

// ══════════════════════════════════════════
// CROP EDITOR — EVENTS
// ══════════════════════════════════════════
function setupCropEv(cc) {
  cc.addEventListener('mousedown', function (e) {
    dragging = true;
    var r = cc.getBoundingClientRect();
    dp = { x: e.clientX - r.left, y: e.clientY - r.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var r = document.getElementById('crop-canvas').getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    cs.x += mx - dp.x; cs.y += my - dp.y;
    dp = { x: mx, y: my };
    needDraw = true; schedRender();
  });
  window.addEventListener('mouseup', function () { dragging = false; });

  cc.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = cc.getBoundingClientRect();
    applyZoom(e.deltaY < 0 ? 1.09 : 0.92, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  cc.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (e.touches.length === 1) { dragging = true; dp = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }
    else if (e.touches.length === 2) { dragging = false; lastPinch = tDist(e.touches); }
  }, { passive: false });

  cc.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (e.touches.length === 1 && dragging) {
      cs.x += e.touches[0].clientX - dp.x; cs.y += e.touches[0].clientY - dp.y;
      dp = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      needDraw = true; schedRender();
    } else if (e.touches.length === 2) {
      var d = tDist(e.touches);
      if (lastPinch > 0) {
        var r = cc.getBoundingClientRect();
        var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        var my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        applyZoom(d / lastPinch, mx, my);
      }
      lastPinch = d;
    }
  }, { passive: false });

  cc.addEventListener('touchend', function () { dragging = false; lastPinch = 0; });
}

function tDist(t) {
  var dx = t[1].clientX - t[0].clientX, dy = t[1].clientY - t[0].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}
function applyZoom(f, px, py) {
  var ns = Math.max(0.04, Math.min(25, cs.scale * f)), sf = ns / cs.scale;
  cs.x = px - (px - cs.x) * sf; cs.y = py - (py - cs.y) * sf; cs.scale = ns;
  needDraw = true; updateZUI(); schedRender();
}
function adjZoom(d)    { applyZoom(1 + d, cW / 2, cH / 2); }
function zoomSlider(v) {
  var ns = parseFloat(v) / 100, sf = ns / cs.scale;
  cs.x = cW / 2 - (cW / 2 - cs.x) * sf; cs.y = cH / 2 - (cH / 2 - cs.y) * sf; cs.scale = ns;
  needDraw = true; schedRender();
  document.getElementById('zoom-lbl').textContent = Math.round(ns * 100) + '%';
}
function updateZUI() {
  var p = Math.round(cs.scale * 100);
  document.getElementById('zoom-lbl').textContent   = p + '%';
  document.getElementById('zoom-range').value = Math.min(600, Math.max(5, p));
}
function getCrop() {
  return { x: (frame.x - cs.x) / cs.scale, y: (frame.y - cs.y) / cs.scale, w: frame.w / cs.scale, h: frame.h / cs.scale };
}

// ══════════════════════════════════════════
// RENDER OUTPUT — high-quality pipeline
// ══════════════════════════════════════════

// Read sharpness slider (0-100)
function getSharp() { var el = document.getElementById('sharp'); return el ? parseInt(el.value) : 40; }
function getSkin()  { var el = document.getElementById('skin');  return el ? parseInt(el.value) : 0;  }

// Main preview render (300 DPI = FMTS base size)
async function renderResult() {
  if (!origImg) return;
  var fmt = FMTS[curFmt];
  var result = await buildOutput(fmt.w, fmt.h);
  var rc = document.getElementById('result-canvas');
  rc.width = fmt.w; rc.height = fmt.h;
  rc.style.transform = ''; // reset before drawing
  rc.getContext('2d').drawImage(result, 0, 0);
  document.getElementById('size-badge').textContent = fmt.lbl;
  // (Re)initialise zoom after every render so canvas size updates are handled
  initResultZoom();
}

// High-resolution render for download (600 DPI = 2× base)
async function renderHiRes() {
  if (!origImg) return null;
  var fmt = FMTS[curFmt];
  return buildOutput(fmt.w * 2, fmt.h * 2);
}

// Core pipeline: takes target pixel dimensions, returns an offscreen canvas
async function buildOutput(OW, OH) {
  var ic  = getCrop();
  var br  = parseInt(document.getElementById('bright').value);
  var co  = parseInt(document.getElementById('contrast').value);
  var fe  = parseInt(document.getElementById('feather').value);
  var sh  = getSharp();
  var sk  = getSkin();
  var bg  = bgColor;

  var cropW = Math.max(1, Math.min(Math.round(ic.w), origImg.width));
  var cropH = Math.max(1, Math.min(Math.round(ic.h), origImg.height));

  if (aiMaskImg) {
    // ════ AI PATH ════════════════════════════════
    var origCrop = makeCanvas(cropW, cropH);
    origCrop.ctx.imageSmoothingEnabled = true;
    origCrop.ctx.imageSmoothingQuality = 'high';
    origCrop.ctx.drawImage(origImg, ic.x, ic.y, ic.w, ic.h, 0, 0, cropW, cropH);

    var maskCrop = makeCanvas(cropW, cropH);
    maskCrop.ctx.imageSmoothingEnabled = true;
    maskCrop.ctx.imageSmoothingQuality = 'high';
    maskCrop.ctx.drawImage(aiMaskImg, ic.x, ic.y, ic.w, ic.h, 0, 0, cropW, cropH);

    var origScaled = multiStepScale(origCrop.canvas, OW, OH);
    var maskScaled = multiStepScale(maskCrop.canvas, OW, OH);

    // Adjustments on clean RGB
    applyBC(origScaled.ctx, OW, OH, br, co);

    // ① Làm mịn da — TRƯỚC khi sharpening (quan trọng: thứ tự đúng)
    if (sk > 0) applySkinSmooth(origScaled.ctx, OW, OH, sk);

    // ② Unsharp mask — phục hồi cạnh và chi tiết sau khi đã mịn da
    if (sh > 0) applyUSM(origScaled.ctx, OW, OH, sh / 100 * 1.5, 1.2, 4);

    var od = origScaled.ctx.getImageData(0, 0, OW, OH).data;
    var maskData = maskScaled.ctx.getImageData(0, 0, OW, OH);
    var md = maskData.data;

    if (fe > 0) featherAlpha(md, OW, OH, fe);

    var out = new ImageData(OW, OH);
    var outD = out.data;
    var bgR = bg.r, bgG = bg.g, bgB = bg.b;
    for (var i = 0; i < OW * OH * 4; i += 4) {
      var a = md[i + 3] / 255;
      outD[i]     = Math.round(od[i]     * a + bgR * (1 - a));
      outD[i + 1] = Math.round(od[i + 1] * a + bgG * (1 - a));
      outD[i + 2] = Math.round(od[i + 2] * a + bgB * (1 - a));
      outD[i + 3] = 255;
    }

    var dst = makeCanvas(OW, OH);
    dst.ctx.fillStyle = 'rgb(' + bgR + ',' + bgG + ',' + bgB + ')';
    dst.ctx.fillRect(0, 0, OW, OH);
    dst.ctx.putImageData(out, 0, 0);
    return dst.canvas;

  } else {
    // ════ FALLBACK: flood fill ════════════════════
    var srcCrop = makeCanvas(cropW, cropH);
    srcCrop.ctx.imageSmoothingEnabled = true;
    srcCrop.ctx.imageSmoothingQuality = 'high';
    srcCrop.ctx.drawImage(origImg, ic.x, ic.y, ic.w, ic.h, 0, 0, cropW, cropH);
    applyBC(srcCrop.ctx, cropW, cropH, br, co);

    var scaled = multiStepScale(srcCrop.canvas, OW, OH);
    if (sk > 0) applySkinSmooth(scaled.ctx, OW, OH, sk);
    if (sh > 0) applyUSM(scaled.ctx, OW, OH, sh / 100 * 1.5, 1.2, 4);

    var iD = scaled.ctx.getImageData(0, 0, OW, OH);
    var mask = floodFill(iD, 40);
    if (fe > 0) featherMask(mask, OW, OH, fe);
    applyFgMask(iD, mask, bg);

    var dst = makeCanvas(OW, OH);
    dst.ctx.fillStyle = 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')';
    dst.ctx.fillRect(0, 0, OW, OH);
    dst.ctx.putImageData(iD, 0, 0);
    return dst.canvas;
  }
}

// ══════════════════════════════════════════
// SKIN SMOOTHING — Frequency Separation
// ══════════════════════════════════════════
//
// Kỹ thuật: Frequency Separation (tách tần số) — chuẩn retouching chuyên nghiệp
//
// Ảnh = Low Frequency (màu sắc, sắc tố, đốm) + High Frequency (texture, lỗ chân lông, chi tiết)
//
// Quy trình:
//   1. Phát hiện pixel da dựa trên YCbCr — không phụ thuộc tone màu da
//   2. Tạo Low Frequency layer = gaussian blur mạnh (làm mịn tone màu)
//   3. Tạo "skin strength mask" = mức độ là da tại mỗi pixel
//   4. Blend: pixel_final = lerp(original, lowFreq, skinMask × strength)
//   5. Giữ nguyên High Frequency → mắt, mũi, miệng, tóc, lông mày KHÔNG bị ảnh hưởng
//
// Ưu điểm: Da mịn tự nhiên, không plastic, không mất nét ở chi tiết quan trọng
//
// strength: 0–100 (từ slider)
// ══════════════════════════════════════════
function applySkinSmooth(ctx, W, H, strength) {
  if (strength <= 0) return;
  var str = strength / 100;

  var origData = ctx.getImageData(0, 0, W, H);
  var od = origData.data;

  // ── Step 1: Detect skin pixels (YCbCr color space) ──
  // YCbCr cho phép nhận dạng da độc lập với độ sáng
  // Đây là range da tổng quát từ nghiên cứu (bao phủ nhiều tông da)
  var skinMask = new Float32Array(W * H); // 0.0 = không phải da, 1.0 = da rõ ràng

  for (var i = 0; i < W * H; i++) {
    var di = i * 4;
    var R = od[di], G = od[di+1], B = od[di+2];

    // Convert RGB → YCbCr
    var Y  =  0.299   * R + 0.587   * G + 0.114   * B;
    var Cb = -0.16874 * R - 0.33126 * G + 0.5     * B + 128;
    var Cr =  0.5     * R - 0.41869 * G - 0.08131 * B + 128;

    // Điều kiện da: dựa trên Cb/Cr range + độ sáng hợp lý
    var isSkin = (
      Y  > 40  && Y  < 240  &&  // không quá tối, không quá sáng
      Cb > 77  && Cb < 127  &&  // blue chroma range của da
      Cr > 133 && Cr < 173       // red chroma range của da
    );

    if (!isSkin) { skinMask[i] = 0; continue; }

    // Soft gradient: da sáng hơn → mịn hơn (đốm, nám thì ít bị ảnh hưởng)
    // Cũng tính proximity score: trung tâm range → score cao hơn
    var cbDist = 1 - Math.abs(Cb - 102) / 25;  // 102 = midpoint của [77,127]
    var crDist = 1 - Math.abs(Cr - 153) / 20;  // 153 = midpoint của [133,173]
    skinMask[i] = Math.max(0, Math.min(1, cbDist * crDist));
  }

  // ── Step 2: Gaussian blur trên toàn ảnh (Low Frequency) ──
  // Radius tỉ lệ với kích thước ảnh và strength
  var blurData = ctx.getImageData(0, 0, W, H);
  var blurR = Math.max(2, Math.round(W / 80 * (0.5 + str * 0.5)));

  // 3-pass box blur ≈ Gaussian (nhanh hơn convolution, kết quả gần tương đương)
  for (var pass = 0; pass < 3; pass++) {
    boxBlurPass(blurData.data, W, H, blurR, true);   // ngang
    boxBlurPass(blurData.data, W, H, blurR, false);  // dọc
  }
  var bd = blurData.data;

  // ── Step 3: Erode skinMask (co biên để tránh halo quanh tóc/mắt) ──
  var erodedMask = new Float32Array(W * H);
  var eR = Math.max(1, Math.round(blurR * 0.5));
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var minV = skinMask[y * W + x];
      if (minV === 0) { erodedMask[y * W + x] = 0; continue; }
      for (var dy = -eR; dy <= eR; dy++) {
        for (var dx = -eR; dx <= eR; dx++) {
          var nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          var v = skinMask[ny * W + nx];
          if (v < minV) minV = v;
        }
      }
      erodedMask[y * W + x] = minV;
    }
  }

  // ── Step 4: Blend original ↔ blur theo eroded skin mask ──
  // Giữ original luminance contrast (texture) — chỉ làm mịn chrominance + low-freq
  var outData = ctx.createImageData(W, H);
  var outd = outData.data;

  for (var i = 0; i < W * H; i++) {
    var di = i * 4;
    var sm = erodedMask[i] * str;

    if (sm < 0.01) {
      outd[di]   = od[di];
      outd[di+1] = od[di+1];
      outd[di+2] = od[di+2];
      outd[di+3] = od[di+3];
      continue;
    }

    // Preserve luminance (Y) — chỉ làm mịn màu sắc (Cb, Cr)
    // Giữ lại một phần luminance từ original để texture không hoàn toàn mất
    var oR = od[di], oG = od[di+1], oB = od[di+2];
    var bR = bd[di], bG = bd[di+1], bB = bd[di+2];

    // Tính luminance của original và blurred
    var oLum = 0.299*oR + 0.587*oG + 0.114*oB;
    var bLum = 0.299*bR + 0.587*bG + 0.114*bB;

    // Blend màu nhưng giữ một phần luminance gốc (tránh mất structure mặt)
    var lumPreserve = 0.35; // 35% luminance được giữ lại
    var blendR = bR + (oR - bR) * (1 - sm) + (oLum - bLum) * lumPreserve * sm;
    var blendG = bG + (oG - bG) * (1 - sm) + (oLum - bLum) * lumPreserve * sm;
    var blendB = bB + (oB - bB) * (1 - sm) + (oLum - bLum) * lumPreserve * sm;

    outd[di]   = Math.max(0, Math.min(255, Math.round(blendR)));
    outd[di+1] = Math.max(0, Math.min(255, Math.round(blendG)));
    outd[di+2] = Math.max(0, Math.min(255, Math.round(blendB)));
    outd[di+3] = od[di+3];
  }

  ctx.putImageData(outData, 0, 0);
}

// ══════════════════════════════════════════
// UNSHARP MASK (USM)
// ══════════════════════════════════════════
// Công thức: sharp = original + amount × (original − blur)
// amount  : 0..2  — cường độ (0.6 mặc định)
// radius  : pixel — bán kính blur (1–2px)
// threshold: 0–30 — bỏ qua pixel gần bằng nhau (giữ vùng phẳng sạch)
function applyUSM(ctx, W, H, amount, radius, threshold) {
  if (amount <= 0) return;
  var orig = ctx.getImageData(0, 0, W, H);
  var blurred = ctx.getImageData(0, 0, W, H);

  // Fast box blur approximation of Gaussian (3 passes = very close to Gaussian)
  var passes = 3;
  var r = Math.max(1, Math.round(radius));
  for (var p = 0; p < passes; p++) {
    boxBlurPass(blurred.data, W, H, r, true);   // horizontal
    boxBlurPass(blurred.data, W, H, r, false);  // vertical
  }

  var od = orig.data, bd = blurred.data;
  var out = ctx.createImageData(W, H);
  var outd = out.data;

  for (var i = 0; i < W * H * 4; i += 4) {
    for (var c = 0; c < 3; c++) {
      var o = od[i + c], b = bd[i + c];
      var diff = o - b;
      if (Math.abs(diff) < threshold) {
        outd[i + c] = o; // below threshold → don't sharpen (preserve flat areas)
      } else {
        outd[i + c] = Math.max(0, Math.min(255, Math.round(o + amount * diff)));
      }
    }
    outd[i + 3] = od[i + 3]; // preserve alpha
  }
  ctx.putImageData(out, 0, 0);
}

// 1D separable box blur pass (horizontal or vertical)
function boxBlurPass(d, W, H, r, horiz) {
  var tmp = new Uint8ClampedArray(d.length);
  var len = horiz ? W : H;
  var step = horiz ? 4 : W * 4;
  var stride = horiz ? W * 4 : 4;

  for (var line = 0; line < (horiz ? H : W); line++) {
    var base = horiz ? line * W * 4 : line * 4;
    // Sliding window sum for each channel
    for (var c = 0; c < 4; c++) {
      var sum = 0, count = 0;
      // Seed window
      for (var k = 0; k <= r && k < len; k++) { sum += d[base + k * step + c]; count++; }
      for (var i = 0; i < len; i++) {
        tmp[base + i * step + c] = Math.round(sum / count);
        // Add next
        var add = i + r + 1;
        if (add < len) { sum += d[base + add * step + c]; count++; }
        // Remove expired
        var rem = i - r;
        if (rem >= 0) { sum -= d[base + rem * step + c]; count--; }
      }
    }
  }
  d.set(tmp);
}

// ── Multi-step downscaling ────────────────────────
// Giảm tối đa 50% mỗi bước → tránh aliasing khi scale lớn
function multiStepScale(srcCanvas, targetW, targetH) {
  var W = srcCanvas.width, H = srcCanvas.height, cur = srcCanvas;

  if (W <= targetW * 2 && H <= targetH * 2) {
    var out = makeCanvas(targetW, targetH);
    out.ctx.imageSmoothingEnabled = true;
    out.ctx.imageSmoothingQuality = 'high';
    out.ctx.drawImage(cur, 0, 0, targetW, targetH);
    return out;
  }

  while (W > targetW * 2 || H > targetH * 2) {
    var nW = Math.max(targetW, Math.round(W / 2));
    var nH = Math.max(targetH, Math.round(H / 2));
    var step = makeCanvas(nW, nH);
    step.ctx.imageSmoothingEnabled = true;
    step.ctx.imageSmoothingQuality = 'high';
    step.ctx.drawImage(cur, 0, 0, nW, nH);
    cur = step.canvas; W = nW; H = nH;
  }

  var final = makeCanvas(targetW, targetH);
  final.ctx.imageSmoothingEnabled = true;
  final.ctx.imageSmoothingQuality = 'high';
  final.ctx.drawImage(cur, 0, 0, targetW, targetH);
  return final;
}

function makeCanvas(w, h) {
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
}

// ══════════════════════════════════════════
// IMAGE PROCESSING HELPERS
// ══════════════════════════════════════════
function featherAlpha(d, W, H, r) {
  var dist = new Float32Array(W * H).fill(1e9), q = [], h = 0;
  for (var i = 0; i < W * H; i++) if (d[i * 4 + 3] < 10) { dist[i] = 0; q.push(i); }
  while (h < q.length) {
    var i = q[h++], x = i % W, y = (i - x) / W, dd = dist[i];
    [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1].forEach(function (n) {
      if (n < 0) return; if (dist[n] > dd + 1) { dist[n] = dd + 1; q.push(n); }
    });
  }
  for (var i = 0; i < W * H; i++) if (dist[i] < r) d[i * 4 + 3] = Math.round(d[i * 4 + 3] * dist[i] / r);
}

function applyBC(ctx, W, H, br, co) {
  if (br === 0 && co === 0) return;
  var iD = ctx.getImageData(0, 0, W, H), d = iD.data;
  var f = (259 * (co + 255)) / (255 * (259 - co));
  for (var i = 0; i < d.length; i += 4) {
    for (var c = 0; c < 3; c++) {
      var v = d[i + c] + br; v = f * (v - 128) + 128;
      d[i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  ctx.putImageData(iD, 0, 0);
}

function floodFill(imgData, tol) {
  var d = imgData.data, W = imgData.width, H = imgData.height;
  var mask = new Uint8Array(W * H), smp = [], step = 2;
  for (var x = 0; x < W; x += step) { smp.push(gp(d, x, 0, W)); smp.push(gp(d, x, H - 1, W)); }
  for (var y = 0; y < H; y += step) { smp.push(gp(d, 0, y, W)); smp.push(gp(d, W - 1, y, W)); }
  smp.sort(function (a, b) { return lum(b.r, b.g, b.b) - lum(a.r, a.g, a.b); });
  var bgRef = medC(smp.slice(0, Math.max(4, Math.floor(smp.length * 0.2))));
  var effTol = tol * 1.8, q = [], h = 0;
  function vis(x, y) { var i = y * W + x; if (mask[i]) return; if (cd(gp(d, x, y, W), bgRef) <= effTol) { mask[i] = 255; q.push(i); } }
  [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].forEach(function (p) { vis(p[0], p[1]); });
  for (var x = 0; x < W; x += step) { vis(x, 0); vis(x, H - 1); }
  for (var y = 0; y < H; y += step) { vis(0, y); vis(W - 1, y); }
  while (h < q.length) {
    var i = q[h++]; mask[i] = 255; var x = i % W, y = (i - x) / W;
    [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1].forEach(function (n) {
      if (n < 0 || mask[n]) return; var nx = n % W, ny = (n - nx) / W;
      if (cd(gp(d, nx, ny, W), bgRef) <= effTol) { mask[n] = 1; q.push(n); }
    });
  }
  return mask;
}

function featherMask(mask, W, H, r) {
  var dist = new Float32Array(W * H).fill(1e9), q = [], h = 0;
  for (var i = 0; i < W * H; i++) if (mask[i] < 128) { dist[i] = 0; q.push(i); }
  while (h < q.length) {
    var i = q[h++], x = i % W, y = (i - x) / W, dd = dist[i];
    [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1].forEach(function (n) {
      if (n < 0) return; if (dist[n] > dd + 1) { dist[n] = dd + 1; q.push(n); }
    });
  }
  for (var i = 0; i < W * H; i++) if (mask[i] >= 128) { var dd = dist[i]; mask[i] = dd < r ? Math.round(128 + (dd / r) * 127) : 255; }
}

function applyFgMask(iD, mask, bg) {
  var d = iD.data;
  for (var i = 0; i < mask.length; i++) {
    if (mask[i] >= 128) {
      var a = (mask[i] - 128) / 127, di = i * 4;
      d[di]     = Math.round(d[di]     * (1 - a) + bg.r * a);
      d[di + 1] = Math.round(d[di + 1] * (1 - a) + bg.g * a);
      d[di + 2] = Math.round(d[di + 2] * (1 - a) + bg.b * a);
    }
  }
}

// Color utilities
function gp(d, x, y, W) { var i = (y * W + x) * 4; return { r: d[i], g: d[i + 1], b: d[i + 2] }; }
function cd(a, b) { return Math.sqrt((a.r - b.r) ** 2 * 0.299 + (a.g - b.g) ** 2 * 0.587 + (a.b - b.b) ** 2 * 0.114); }
function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
function medC(s) {
  var rs = s.map(function (x) { return x.r; }).sort(function (a, b) { return a - b; });
  var gs = s.map(function (x) { return x.g; }).sort(function (a, b) { return a - b; });
  var bs = s.map(function (x) { return x.b; }).sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return { r: rs[m], g: gs[m], b: bs[m] };
}
function blobToImg(blob) {
  return new Promise(function (res, rej) {
    var url = URL.createObjectURL(blob), img = new Image();
    img.onload = function () { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

// ══════════════════════════════════════════
// UI CONTROLS
// ══════════════════════════════════════════
function selFmt(btn) {
  var oldW = frame.w / cs.scale;
  document.querySelectorAll('.fbtn').forEach(function (b) { b.classList.remove('active'); });
  btn.classList.add('active'); curFmt = btn.dataset.fmt; compFrame();
  var newSc = frame.w / oldW, sf = newSc / cs.scale;
  cs.x = cW / 2 - (cW / 2 - cs.x) * sf; cs.y = cH / 2 - (cH / 2 - cs.y) * sf; cs.scale = newSc;
  needDraw = true; updateZUI(); schedRender();
}

function selBg(sw) {
  document.querySelectorAll('.sw').forEach(function (s) { s.classList.remove('active'); });
  sw.classList.add('active');
  var p = sw.dataset.c.split(',').map(Number);
  bgColor = { r: p[0], g: p[1], b: p[2] };
  schedRender();
}

var rt2 = null;
function schedRender() {
  clearTimeout(rt2);
  document.getElementById('renote').textContent = '⏳ Đang cập nhật...';
  rt2 = setTimeout(async function () {
    if (!origImg || rendering) return;
    rendering = true; await renderResult(); rendering = false;
    document.getElementById('renote').textContent = '';
  }, 350);
}

// ══════════════════════════════════════════
// RESULT PREVIEW ZOOM
// ══════════════════════════════════════════

// Called after every renderResult — reset to fit
function initResultZoom() {
  var wrap = document.getElementById('prev-wrap');
  var rc   = document.getElementById('result-canvas');
  if (!wrap || !rc) return;

  // Match the preview-wrap height to the crop canvas height so both panels are equal
  var cc = document.getElementById('crop-canvas');
  if (cc && cc.style.height) wrap.style.minHeight = cc.style.height;

  rv.scale = 1; rv.tx = 0; rv.ty = 0;
  applyResultTransform();
  updateZoomOutLbl();

  wrap.onmousedown = function (e) {
    rv.dragging = true; rv.dx = e.clientX - rv.tx; rv.dy = e.clientY - rv.ty;
    e.preventDefault();
  };
  window._rvMM = function (e) {
    if (!rv.dragging) return;
    rv.tx = e.clientX - rv.dx; rv.ty = e.clientY - rv.dy;
    applyResultTransform();
  };
  window._rvMU = function () { rv.dragging = false; };
  window.removeEventListener('mousemove', window._rvMM);
  window.removeEventListener('mouseup',   window._rvMU);
  window.addEventListener('mousemove', window._rvMM);
  window.addEventListener('mouseup',   window._rvMU);

  // Touch pan
  wrap.ontouchstart = function (e) {
    if (e.touches.length === 1) {
      rv.dragging = true;
      rv.dx = e.touches[0].clientX - rv.tx;
      rv.dy = e.touches[0].clientY - rv.ty;
    }
  };
  wrap.ontouchmove = function (e) {
    e.preventDefault();
    if (e.touches.length === 1 && rv.dragging) {
      rv.tx = e.touches[0].clientX - rv.dx;
      rv.ty = e.touches[0].clientY - rv.dy;
      applyResultTransform();
    }
  };
  wrap.ontouchend = function () { rv.dragging = false; };
}

function applyResultTransform() {
  var rc = document.getElementById('result-canvas');
  if (!rc) return;
  rc.style.transform = 'translate(' + rv.tx + 'px,' + rv.ty + 'px) scale(' + rv.scale + ')';
  rc.style.cursor = rv.scale > 1 ? (rv.dragging ? 'grabbing' : 'grab') : 'default';
}

function updateZoomOutLbl() {
  var lbl = document.getElementById('zoom-out-lbl');
  if (lbl) lbl.textContent = rv.scale === 1 ? '1×' : rv.scale < 1 ? '0.5×' : Math.round(rv.scale * 100) + '%';
}

function wheelZoomResult(e) {
  e.preventDefault();
  var factor = e.deltaY < 0 ? 1.15 : 0.87;
  var ns = Math.max(0.25, Math.min(8, rv.scale * factor));
  var wrap = document.getElementById('prev-wrap');
  var rect = wrap.getBoundingClientRect();
  var mx = e.clientX - rect.left - rect.width  / 2;
  var my = e.clientY - rect.top  - rect.height / 2;
  var sf = ns / rv.scale;
  rv.tx = mx - (mx - rv.tx) * sf;
  rv.ty = my - (my - rv.ty) * sf;
  rv.scale = ns;
  applyResultTransform();
  updateZoomOutLbl();
}

function zoomResult(dir) {
  var ns = Math.max(0.25, Math.min(8, rv.scale * (dir > 0 ? 1.4 : 0.71)));
  var sf = ns / rv.scale;
  rv.tx *= sf; rv.ty *= sf; rv.scale = ns;
  applyResultTransform(); updateZoomOutLbl();
}

function zoomResultFit() {
  rv.scale = 1; rv.tx = 0; rv.ty = 0;
  applyResultTransform(); updateZoomOutLbl();
}

// ══════════════════════════════════════════
// LIGHTBOX — full-screen viewer
// ══════════════════════════════════════════
function openLightbox() {
  var src = document.getElementById('result-canvas');
  if (!src || !src.width) { toast('Chưa có ảnh để xem', 'err'); return; }

  var lbc = document.getElementById('lightbox-canvas');
  // Copy result canvas at native resolution
  lbc.width  = src.width;
  lbc.height = src.height;
  lbc.getContext('2d').drawImage(src, 0, 0);

  // Set display size to fit viewport
  var maxW = window.innerWidth  * 0.88;
  var maxH = window.innerHeight * 0.78;
  var scaleW = maxW / src.width;
  var scaleH = maxH / src.height;
  var fitSc  = Math.min(1, scaleW, scaleH);

  lb.scale = fitSc; lb.tx = 0; lb.ty = 0;
  applyLbTransform();
  updateLbLbl();

  // Pan events
  lbc.onmousedown = function (e) {
    lb.dragging = true; lb.dx = e.clientX - lb.tx; lb.dy = e.clientY - lb.ty; e.preventDefault();
  };
  window.addEventListener('mousemove', lbMouseMove);
  window.addEventListener('mouseup',   lbMouseUp);
  lbc.onwheel = function (e) {
    e.preventDefault();
    var factor = e.deltaY < 0 ? 1.15 : 0.87;
    var ns = Math.max(0.1, Math.min(12, lb.scale * factor));
    var rect = lbc.getBoundingClientRect();
    var mx = e.clientX - rect.left - lbc.getBoundingClientRect().width  / 2;
    var my = e.clientY - rect.top  - lbc.getBoundingClientRect().height / 2;
    var sf = ns / lb.scale;
    lb.tx = mx - (mx - lb.tx) * sf; lb.ty = my - (my - lb.ty) * sf; lb.scale = ns;
    applyLbTransform(); updateLbLbl();
  };

  // Touch pinch + pan
  var lbLastPinch = 0;
  lbc.ontouchstart = function (e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      lb.dragging = true;
      lb.dx = e.touches[0].clientX - lb.tx; lb.dy = e.touches[0].clientY - lb.ty;
    } else if (e.touches.length === 2) {
      lb.dragging = false;
      lbLastPinch = tDist(e.touches);
    }
  };
  lbc.ontouchmove = function (e) {
    e.preventDefault();
    if (e.touches.length === 1 && lb.dragging) {
      lb.tx = e.touches[0].clientX - lb.dx; lb.ty = e.touches[0].clientY - lb.dy;
      applyLbTransform();
    } else if (e.touches.length === 2) {
      var d = tDist(e.touches);
      if (lbLastPinch > 0) {
        lb.scale = Math.max(0.1, Math.min(12, lb.scale * d / lbLastPinch));
        applyLbTransform(); updateLbLbl();
      }
      lbLastPinch = d;
    }
  };
  lbc.ontouchend = function () { lb.dragging = false; lbLastPinch = 0; };

  document.getElementById('result-lightbox').classList.add('open');

  // Keyboard: Escape to close, +/- to zoom
  window._lbKeyHandler = function (e) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === '+' || e.key === '=') lightboxZoom(1);
    else if (e.key === '-') lightboxZoom(-1);
  };
  window.addEventListener('keydown', window._lbKeyHandler);
}

function lbMouseMove(e) { if (!lb.dragging) return; lb.tx = e.clientX - lb.dx; lb.ty = e.clientY - lb.dy; applyLbTransform(); }
function lbMouseUp()    { lb.dragging = false; }

function applyLbTransform() {
  var lbc = document.getElementById('lightbox-canvas');
  if (!lbc) return;
  var dispW = lbc.width  * lb.scale;
  var dispH = lbc.height * lb.scale;
  lbc.style.width  = Math.round(dispW) + 'px';
  lbc.style.height = Math.round(dispH) + 'px';
  lbc.style.transform = 'translate(' + lb.tx + 'px,' + lb.ty + 'px)';
  lbc.style.cursor = lb.dragging ? 'grabbing' : (lb.scale > 0.5 ? 'grab' : 'default');
}

function updateLbLbl() {
  var lbl = document.getElementById('lb-lbl');
  if (lbl) lbl.textContent = Math.round(lb.scale * 100) + '%';
}

function lightboxZoom(dir) {
  lb.scale = Math.max(0.1, Math.min(12, lb.scale * (dir > 0 ? 1.4 : 0.71)));
  applyLbTransform(); updateLbLbl();
}

function lightboxZoomFit() {
  var lbc = document.getElementById('lightbox-canvas');
  var maxW = window.innerWidth * 0.88, maxH = window.innerHeight * 0.78;
  lb.scale = Math.min(1, maxW / lbc.width, maxH / lbc.height);
  lb.tx = 0; lb.ty = 0;
  applyLbTransform(); updateLbLbl();
}

function closeLightbox() {
  document.getElementById('result-lightbox').classList.remove('open');
  window.removeEventListener('mousemove', lbMouseMove);
  window.removeEventListener('mouseup',   lbMouseUp);
  if (window._lbKeyHandler) { window.removeEventListener('keydown', window._lbKeyHandler); delete window._lbKeyHandler; }
}

// ══════════════════════════════════════════
// DOWNLOAD — render at 600 DPI before saving
// ══════════════════════════════════════════
async function dlPhoto(fmt) {
  var f = FMTS[curFmt];
  var dlBtn = document.getElementById('dl-btn-jpg');
  if (dlBtn) { dlBtn.textContent = '⏳ Đang xuất 600 DPI...'; dlBtn.disabled = true; }
  document.getElementById('renote').textContent = '⏳ Đang xuất ảnh chất lượng cao...';

  try {
    // Render at 2× (600 DPI) for download — separate from preview canvas
    var hiResCanvas = await renderHiRes();
    var scale = 2;
    var mimeType = fmt === 'png' ? 'image/png' : 'image/jpeg';
    var quality  = fmt === 'png' ? 1.0 : 1.0; // JPEG q=1.0 for best quality
    var a = document.createElement('a');
    a.download = 'photovisa_' + curFmt + '_' + (f.w * scale) + 'x' + (f.h * scale) + '_600dpi.' + fmt;
    a.href = hiResCanvas.toDataURL(mimeType, quality);
    a.click();
    toast('✅ Đã tải ' + (f.w * scale) + '×' + (f.h * scale) + 'px 600 DPI!', 'ok');
    setSteps(4);
  } finally {
    if (dlBtn) { dlBtn.textContent = '⬇️ Tải xuống JPG (600 DPI)'; dlBtn.disabled = false; }
    document.getElementById('renote').textContent = '';
  }
}

async function dlPhoto300(fmt) {
  var f = FMTS[curFmt];
  var rc = document.getElementById('result-canvas');
  var mimeType = fmt === 'png' ? 'image/png' : 'image/jpeg';
  var a = document.createElement('a');
  a.download = 'photovisa_' + curFmt + '_' + f.w + 'x' + f.h + '_300dpi.' + fmt;
  a.href = rc.toDataURL(mimeType, 1.0);
  a.click();
  toast('✅ Đã tải ' + f.w + '×' + f.h + 'px 300 DPI!', 'ok');
  setSteps(4);
}

async function copyClip() {
  try {
    document.getElementById('result-canvas').toBlob(async function (b) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
      toast('📋 Đã sao chép!', 'ok');
    });
  } catch (e) { toast('Trình duyệt không hỗ trợ sao chép', 'err'); }
}

// ══════════════════════════════════════════
// APP CONTROL
// ══════════════════════════════════════════
function setSection(n) {
  ['upload', 'loading', 'editor'].forEach(function (s) {
    document.getElementById(s + '-section').style.display = 'none';
  });
  if      (n === 'upload')  { document.getElementById('upload-section').style.display  = 'flex';  setSteps(1); }
  else if (n === 'loading') { document.getElementById('loading-section').style.display = 'flex';  setSteps(2); }
  else if (n === 'editor')  { document.getElementById('editor-section').style.display  = 'block'; }
}

function resetApp() {
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  origImg = null; origFile = null; faceData = null; aiMaskImg = null;
  document.getElementById('file-input').value = '';
  document.getElementById('pfill').style.width = '0%';
  ['ls1', 'ls2', 'ls3', 'ls4'].forEach(function (id) { document.getElementById(id).className = 'ls'; });
  setSection('upload');
}

function setSteps(a) {
  for (var i = 1; i <= 4; i++) {
    var el = document.getElementById('s' + i); el.className = 'step';
    if (i < a) el.classList.add('done'); else if (i === a) el.classList.add('active');
  }
}
function setLS(n, state) { var el = document.getElementById('ls' + n); if (el) el.className = 'ls ' + state; }
function setLoad(t, s)   { document.getElementById('load-title').textContent = t; document.getElementById('load-sub').textContent = s; }
function setP(p)         { document.getElementById('pfill').style.width = p + '%'; }

function setAiInfoBar(success) {
  var bar = document.getElementById('ai-info-bar');
  if (success) {
    bar.innerHTML = '<div class="ai-tag"><div class="dot"></div>AI ISNet — Tách nền chính xác</div>' +
      '<span style="font-size:10px;color:#4a5568;">🔄 <a href="javascript:reprocessAI()" style="color:#d4af50;text-decoration:none;">Xử lý lại</a></span>';
  } else {
    bar.innerHTML = '<span style="font-size:11px;color:#fbbf24;">⚠️ Chưa tải được AI — dùng Flood Fill. ' +
      '<a href="javascript:reprocessAI()" style="color:#d4af50;text-decoration:none;">Thử lại AI</a></span>';
  }
}

var toastT;
function toast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show ' + (type || 'ok');
  clearTimeout(toastT);
  toastT = setTimeout(function () { t.className = ''; }, 3500);
}
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
