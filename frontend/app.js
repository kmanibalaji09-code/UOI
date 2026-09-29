// UOI Frontend: Google AI Studio Edition + Real-Time Search Grounding
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];

const S = {
  app: 'CAMERA_OFF',
  view: 'camera',
  mode: 'manual',
  facing: 'environment',
  objs: [],
  sel: null,
  hist: JSON.parse(localStorage.uoi || '[]'),
  stream: null,
  nid: 1,
  busy: false,
  isStatic: false,
  torchOn: false,
  aiKey: localStorage.ai_studio_key || '',
  prevView: 'camera'
};

const vid = $('#vid'), staticImg = $('#static-img'), sheet = $('#sheet');
const setApp = a => S.app = a;
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Anti-Spam Tracking
const searchedObjectIds = new Set();
const searchedLabelsLastTime = new Map();

function show(id) {
  $$('.view').forEach(v => v.classList.toggle('on', v.id === id));
}

function nav(v) {
  if (S.view !== 'detail') S.prevView = S.view;
  S.view = v;
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  closeSheet();
  if (v === 'camera') {
    show(S.isStatic || S.stream ? 'camera' : 'start');
    if (!S.isStatic && S.stream) loop();
  } else {
    show(v);
    setApp(v === 'history' ? 'HISTORY' : S.app);
    render();
  }
}

$$('nav button').forEach(b => b.onclick = () => nav(b.dataset.v));

// ---- Google AI Studio Settings Modal ----
const aiSettingsBtn = $('#ai-settings');
if (aiSettingsBtn) {
  aiSettingsBtn.onclick = () => {
    $('#ai-key-input').value = S.aiKey;
    $('#ai-modal').classList.add('open');
  };
}

window.closeAiModal = () => $('#ai-modal').classList.remove('open');

window.saveAiKey = () => {
  const k = $('#ai-key-input').value.trim();
  S.aiKey = k;
  if (k) localStorage.ai_studio_key = k;
  else localStorage.removeItem('ai_studio_key');
  closeAiModal();
  alert(k ? '⚡ Google AI Studio Key Connected!' : 'Google AI Studio Key Cleared.');
};

window.clearAiKey = () => {
  S.aiKey = '';
  $('#ai-key-input').value = '';
  localStorage.removeItem('ai_studio_key');
  closeAiModal();
  alert('Key disconnected.');
};

// ---- Camera Management ----
async function startCam() {
  setApp('CAMERA_REQUESTING');
  S.isStatic = false;
  vid.style.display = 'block';
  staticImg.style.display = 'none';
  $('#live-badge').textContent = '● LIVE';

  try {
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: S.facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    vid.srcObject = S.stream;
    await vid.play();
    setApp('CAMERA_ACTIVE');
    show('camera');
    loop();
  } catch (e) {
    console.warn('Camera failed/denied:', e);
    setApp('CAMERA_OFF');
    show('denied');
  }
}

$('#go').onclick = $('#retry').onclick = startCam;
$('#flip').onclick = () => {
  S.facing = S.facing === 'user' ? 'environment' : 'user';
  startCam();
};

// Torch / Flashlight
const torchBtn = $('#torch');
if (torchBtn) {
  torchBtn.onclick = async () => {
    if (!S.stream) return;
    const track = S.stream.getVideoTracks()[0];
    if (track && track.getCapabilities && track.getCapabilities().torch) {
      S.torchOn = !S.torchOn;
      await track.applyConstraints({ advanced: [{ torch: S.torchOn }] });
      torchBtn.classList.toggle('on', S.torchOn);
    } else {
      alert('Torch is not supported on this camera.');
    }
  };
}

$$('#mode button').forEach(b => b.onclick = () => {
  S.mode = b.dataset.m;
  $$('#mode button').forEach(x => x.classList.toggle('on', x === b));
  $('#hint').textContent = S.mode === 'scan' ? 'Auto-Scan Active: Auto-identifying >60% confidence objects' : 'Tap on any object to see details';
});

// Manual Shutter Button
const shutterBtn = $('#shutter');
if (shutterBtn) {
  shutterBtn.onclick = () => {
    if (S.objs.length > 0) {
      const sorted = [...S.objs].sort((a, b) => b.confidence - a.confidence);
      select(sorted[0]);
    } else {
      alert('Point camera at an object to capture & identify.');
    }
  };
}

// File Upload Support
function handleFileUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    if (S.stream) {
      S.stream.getTracks().forEach(t => t.stop());
      S.stream = null;
    }
    S.isStatic = true;
    vid.style.display = 'none';
    staticImg.style.display = 'block';
    staticImg.src = e.target.result;
    $('#live-badge').textContent = '🖼️ PHOTO';
    setApp('CAMERA_ACTIVE');
    show('camera');

    staticImg.onload = () => {
      detectStaticImage(staticImg);
    };
  };
  reader.readAsDataURL(file);
}

['#file-upload', '#file-upload-denied', '#file-upload-top'].forEach(id => {
  const el = $(id);
  if (el) {
    el.onchange = e => {
      if (e.target.files && e.target.files[0]) handleFileUpload(e.target.files[0]);
    };
  }
});

async function detectStaticImage(imgEl) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = Math.round(640 * (imgEl.naturalHeight || 480) / (imgEl.naturalWidth || 640));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
  
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.80));
  const fd = new FormData();
  fd.append('frame', blob);
  
  try {
    const res = await fetch('/api/detect', { method: 'POST', body: fd });
    const j = await res.json();
    S.objs = [];
    track(j.detections || []);
  } catch (e) {
    console.error('Detection error:', e);
  }
}

// Vision Loop
const small = document.createElement('canvas');
async function loop() {
  while (S.stream && S.view === 'camera' && !S.isStatic) {
    if (vid.videoWidth && !S.busy && S.app !== 'SEARCHING') {
      try {
        small.width = 320;
        small.height = Math.round(320 * vid.videoHeight / vid.videoWidth);
        small.getContext('2d').drawImage(vid, 0, 0, small.width, small.height);
        const blob = await new Promise(r => small.toBlob(r, 'image/jpeg', 0.60));
        const fd = new FormData();
        fd.append('frame', blob);
        const j = await (await fetch('/api/detect', { method: 'POST', body: fd })).json();
        track(j.detections || []);
      } catch (e) {
        console.error(e);
      }
    }
    await new Promise(r => setTimeout(r, S.mode === 'scan' ? 300 : 400));
  }
}

// IoU Tracker
const iou = (a, b) => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = x * y;
  return i / ((a.w * a.h + b.w * b.h - i) || 1);
};

function track(dets) {
  const now = Date.now();
  const used = new Set();

  for (const d of dets) {
    let best = null, bs = 0.35;
    for (const o of S.objs) {
      if (used.has(o.object_id) || o.class_name !== d.class_name) continue;
      const s = iou(o.bounding_box, d.bounding_box);
      if (s > bs) { bs = s; best = o; }
    }
    if (best) {
      Object.assign(best, d, { seen: now, tracking_state: 'TRACKED' });
      used.add(best.object_id);
    } else {
      const o = { ...d, object_id: S.nid++, seen: now, state: 'DETECTED', tracking_state: 'NEW' };
      S.objs.push(o);
      used.add(o.object_id);
    }
  }

  S.objs = S.objs.filter(o => (now - o.seen < (S.isStatic ? 999999 : 2000)) || o === S.sel);
  drawNodes();

  // Rule: Auto-search ONLY if Confidence >= 0.60
  for (const o of S.objs) {
    if (o.confidence >= 0.60 && !searchedObjectIds.has(o.object_id) && !o.result) {
      const lastTime = searchedLabelsLastTime.get(o.class_name) || 0;
      if (now - lastTime > 20000) {
        searchedLabelsLastTime.set(o.class_name, now);
        autoSearchObject(o);
      }
    }
  }
}

// Auto-search via backend with Google AI Studio key header
async function autoSearchObject(o) {
  if (!o || searchedObjectIds.has(o.object_id) || o.state === 'SEARCHING' || o.state === 'IDENTIFIED') return;
  searchedObjectIds.add(o.object_id);

  try {
    const c = snapshot(o);
    o.snap = c.toDataURL('image/jpeg', 0.80);
    o.state = 'ANALYZING';

    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.80));
    const fd = new FormData();
    fd.append('crop', blob);
    fd.append('label', o.class_name);

    const headers = {};
    if (S.aiKey) headers['X-AI-Studio-Key'] = S.aiKey;

    const res = await fetch('/api/search', { method: 'POST', body: fd, headers });
    const j = await res.json();
    if (j.ok) {
      o.result = j;
      o.state = 'IDENTIFIED';
      save(o);
      drawNodes();
      render();
    }
  } catch (e) {
    console.warn('Auto-search error for', o.class_name, e);
  }
}

function map(b) {
  const cw = $('#camera').clientWidth, ch = $('#camera').clientHeight;
  const vw = S.isStatic ? (staticImg.naturalWidth || cw) : vid.videoWidth;
  const vh = S.isStatic ? (staticImg.naturalHeight || ch) : vid.videoHeight;
  
  if (!cw || !ch || !vw || !vh) return { x: -999, y: -999 };

  const sc = Math.max(cw / vw, ch / vh);
  return {
    x: (b.x + b.w / 2) * vw * sc - (vw * sc - cw) / 2,
    y: (b.y + b.h / 2) * vh * sc - (vh * sc - ch) / 2
  };
}

function drawNodes() {
  const box = $('#nodes');
  const ids = new Set(S.objs.map(o => o.object_id));
  $$('.node').forEach(n => { if (!ids.has(+n.dataset.id)) n.remove(); });

  for (const o of S.objs) {
    let n = box.querySelector(`[data-id="${o.object_id}"]`);
    if (!n) {
      n = document.createElement('div');
      n.className = 'node';
      n.dataset.id = o.object_id;
      n.onclick = () => select(o);
      box.appendChild(n);
    }
    const p = map(o.bounding_box);
    if (p.x < 0 || p.y < 0) continue;
    n.style.left = p.x + 'px';
    n.style.top = p.y + 'px';
    n.classList.toggle('sel', S.sel && S.sel.object_id === o.object_id);
    
    const isReady = o.result && o.result.ok;
    const isHighConf = o.confidence >= 0.60;
    const labelText = isReady ? (o.result.possible_match || o.class_name) : o.class_name;
    
    n.classList.toggle('high-conf', isHighConf);
    
    n.innerHTML = `
      <span class="dot"></span>
      <span class="ln"></span>
      <span class="pill">
        ${esc(labelText)}
        ${isReady ? `<small>✓ AI Studio</small>` : `<small>${Math.round(o.confidence * 100)}%</small>`}
      </span>`;
  }
}

function snapshot(o) {
  const b = o.bounding_box;
  const sourceEl = S.isStatic ? staticImg : vid;
  const vw = S.isStatic ? (staticImg.naturalWidth || 640) : (vid.videoWidth || 640);
  const vh = S.isStatic ? (staticImg.naturalHeight || 480) : (vid.videoHeight || 480);
  const pad = 0.08;

  const x = Math.max(0, (b.x - pad * b.w) * vw);
  const y = Math.max(0, (b.y - pad * b.h) * vh);
  const w = Math.min(vw - x, b.w * vw * (1 + 2 * pad));
  const h = Math.min(vh - y, b.h * vh * (1 + 2 * pad));

  const c = document.createElement('canvas');
  const k = Math.min(1, 640 / Math.max(w || 1, h || 1));
  c.width = Math.max(1, w * k);
  c.height = Math.max(1, h * k);
  
  if (sourceEl) {
    c.getContext('2d').drawImage(sourceEl, x, y, w, h, 0, 0, c.width, c.height);
  }
  return c;
}

async function select(o) {
  S.sel = o;
  drawNodes();

  if (o.result && o.result.ok) {
    setApp('RESULT_READY');
    quick(o);
    return;
  }

  o.state = 'CAPTURING';
  const c = snapshot(o);
  o.snap = c.toDataURL('image/jpeg', 0.80);

  openSheet(`
    <div class="grab"></div>
    <div class="row">
      <img class="thumb" src="${o.snap}">
      <div>
        <h3 style="margin:0">${esc(o.class_name.toUpperCase())}</h3>
        <span class="badge">${Math.round(o.confidence * 100)}% confidence</span>
      </div>
      <button class="x" onclick="closeSheet()">✕</button>
    </div>
    <div class="scan"></div>
    <p>Analyzing in Google AI Studio…<br><small style="color:var(--mut)">Multimodal Gemini Vision + Search Grounding</small></p>
  `);

  setApp('SEARCHING');
  o.state = 'ANALYZING';

  try {
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    const fd = new FormData();
    fd.append('crop', blob);
    fd.append('label', o.class_name);

    const headers = {};
    if (S.aiKey) headers['X-AI-Studio-Key'] = S.aiKey;

    const j = await (await fetch('/api/search', { method: 'POST', body: fd, headers })).json();
    if (!j.ok) throw new Error('Search failed');

    o.result = j;
    o.state = 'IDENTIFIED';
    setApp('RESULT_READY');
    save(o);
    drawNodes();
    quick(o);
  } catch (e) {
    console.error(e);
    o.state = 'ERROR';
    setApp('CAMERA_ACTIVE');
    openSheet(`
      <div class="grab"></div>
      <h3>Couldn't identify exact brand & model</h3>
      <p>Try capturing from a clearer angle or uploading a photo.</p>
      <button class="btn" onclick="select(S.sel)">Try Again</button>
      <button class="btn alt" onclick="closeSheet()">Close</button>
    `);
  }
}

// Quick Info Sheet
function quick(o) {
  const r = o.result.results || [];
  const topMatches = r.slice(0, 4);

  const titleText = o.result.possible_match || o.class_name.toUpperCase();
  const descText = o.result.description || `Multimodal AI Studio identification for ${o.class_name}.`;

  openSheet(`
    <div class="grab"></div>
    <div class="row">
      <img class="thumb" src="${o.snap}">
      <div>
        <h3 style="margin:0; font-size:18px">${esc(titleText)}</h3>
        <span class="badge">${Math.round(o.confidence * 100)}% match score</span>
        <p style="margin-top:4px"><small style="color:var(--mut)">Category:</small> <b>${esc(o.class_name)}</b></p>
      </div>
      <button class="x" onclick="closeSheet()">✕</button>
    </div>

    <p style="font-size:13px; color:var(--ink); opacity:0.9; margin-top:12px; line-height:1.4">
      ${esc(descText)}
    </p>

    <div class="chips" style="margin-top:10px">
      <span>⚡ Google AI Studio</span>
      <span>🌐 Search Grounded</span>
      <span>${esc(o.result.brand || o.class_name)}</span>
    </div>

    <h4 style="margin:16px 0 8px">Grounded Search Results</h4>
    <div class="row" style="overflow-x:auto; gap:10px; padding-bottom:8px">
      ${topMatches.length ? topMatches.map(x => `
        <a href="${esc(x.link)}" target="_blank" rel="noopener" class="top-match-card">
          <img class="thumb" style="width:90px;height:65px;border-radius:10px" src="${esc(x.thumbnail)}">
          <b>${esc(x.title.slice(0, 24))}</b>
          <small>${esc(x.domain)}</small>
        </a>
      `).join('') : `<p style="font-size:12px;color:var(--mut)">No direct links found.</p>`}
    </div>

    <div class="detail-actions" style="margin-top:12px">
      <button class="btn alt" onclick="speakText('${esc(titleText + '. ' + descText)}')">🔊 Listen Voice</button>
      <button class="btn" id="full">View Full Details →</button>
    </div>
  `);

  $('#full').onclick = () => {
    openDetail(o);
  };
}

function openSheet(h) {
  sheet.innerHTML = h;
  requestAnimationFrame(() => sheet.classList.add('open'));
}

function closeSheet() {
  sheet.classList.remove('open');
  if (S.sel) {
    S.sel = null;
    if (S.app !== 'CAMERA_OFF') setApp('CAMERA_ACTIVE');
    drawNodes();
  }
}

// Memory Optimization: Save max 30 items
function save(o) {
  const e = {
    id: o.object_id || Date.now(),
    label: o.class_name,
    conf: o.confidence,
    snap: o.snap,
    match: o.result ? o.result.possible_match : o.class_name,
    brand: o.result ? o.result.brand : o.class_name,
    model: o.result ? o.result.model : '',
    desc: o.result ? o.result.description : '',
    results: o.result ? o.result.results : [],
    t: Date.now()
  };
  
  const idx = S.hist.findIndex(x => x.id === e.id || (x.label === e.label && Math.abs(x.t - e.t) < 15000));
  if (idx >= 0) S.hist[idx] = e;
  else S.hist.unshift(e);
  
  S.hist = S.hist.slice(0, 30);
  try {
    localStorage.uoi = JSON.stringify(S.hist);
  } catch (_) {
    S.hist = S.hist.slice(0, 10);
  }
}

const ago = t => {
  const m = Math.round((Date.now() - t) / 6e4);
  return m < 1 ? 'just now' : m < 60 ? m + ' mins ago' : m < 1440 ? Math.round(m / 60) + ' hrs ago' : new Date(t).toLocaleDateString();
};

function render() {
  const empty = t => `<div class="empty"><b>${t[0]}</b><p>${t[1]}</p></div>`;
  
  const countEl = $('#disc-count');
  if (countEl) countEl.textContent = S.hist.length;

  $('#dfeed').innerHTML = S.hist.length ? S.hist.slice(0, 12).map(h => `
    <div class="card" onclick="openDetail(S.hist.find(x => x.id == ${h.id}))">
      <img src="${h.snap}">
      <div>
        <b>${esc(h.match || h.label)}</b>
        <span>${Math.round((h.conf || 0.9) * 100)}% conf · ${ago(h.t)}</span>
      </div>
    </div>
  `).join('') : empty(['No live discoveries yet.', 'Point camera or upload photo (>60% confidence objects auto-search).']);

  $('#hfeed').innerHTML = S.hist.length ? S.hist.map(h => `
    <div class="hrow" onclick="openDetail(S.hist.find(x => x.id == ${h.id}))">
      <img class="thumb" src="${h.snap}">
      <div>
        <b>${esc(h.match || h.label)}</b><br>
        <span class="badge">${Math.round((h.conf || 0.9) * 100)}% confidence</span>
        <small style="color:var(--mut);margin-left:6px">${ago(h.t)}</small>
      </div>
    </div>
  `).join('') : empty(['No history yet.', 'Discovered items automatically save here with Google links.']);
}

const clearBtn = $('#clear-hist');
if (clearBtn) {
  clearBtn.onclick = () => {
    S.hist = [];
    localStorage.removeItem('uoi');
    render();
  };
}

// Detailed Information View
function openDetail(h) {
  closeSheet();
  if (!h) return;
  
  const r = h.results || (h.result ? h.result.results : []);
  const titleText = h.match || (h.result ? h.result.possible_match : h.label.toUpperCase());
  const descText = h.desc || (h.result ? h.result.description : `Technical specifications and Google web search for ${titleText}.`);
  const primaryLink = r[0] ? r[0].link : `https://www.google.com/search?q=${encodeURIComponent(titleText)}`;

  $('#detail').innerHTML = `
    <button class="back" onclick="nav(S.prevView || 'history')">← Back</button>
    <img class="snap" src="${h.snap}">
    <h2 style="margin-top:16px; font-size:24px">${esc(titleText)}</h2>
    <span class="badge" style="margin-top:4px">${Math.round((h.conf || 0.9) * 100)}% confidence match</span>
    
    <p style="color:var(--ink); opacity:0.9; margin-top:12px; font-size:14px; line-height:1.5">
      ${esc(descText)}
    </p>

    <div class="chips" style="margin-top:14px">
      <span>🎯 Brand: ${esc(h.brand || h.label)}</span>
      <span>⚡ Google AI Studio</span>
      <span>Grounded Links</span>
    </div>

    <h3 style="margin-top:22px; font-size:18px">Grounded Google Search Results</h3>
    <div class="web-results-list">
      ${r.map(x => `
        <a class="res" href="${esc(x.link)}" target="_blank" rel="noopener">
          ${x.thumbnail ? `<img src="${esc(x.thumbnail)}">` : `<div class="icon-ph">🔍</div>`}
          <div>
            <b>${esc(x.title)}</b>
            <small>${esc(x.source)} · ${esc(x.domain)}</small>
            ${x.description ? `<small style="color:var(--ink); opacity:0.8">${esc(x.description.slice(0, 130))}</small>` : ''}
          </div>
          <span class="arrow">›</span>
        </a>
      `).join('') || '<p class="empty">No web links found.</p>'}
    </div>

    <div class="detail-actions">
      <button class="btn alt" onclick="speakText('${esc(titleText + '. ' + descText)}')">🔊 Listen Voice</button>
      <a class="btn" target="_blank" rel="noopener" href="${esc(primaryLink)}">🌐 Open Google Link</a>
    </div>
  `;

  show('detail');
  $$('nav button').forEach(b => b.classList.toggle('on', false));
}

window.speakText = txt => {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(txt);
    u.rate = 1.0;
    window.speechSynthesis.speak(u);
  } else {
    alert('Voice readout not supported on this browser.');
  }
};

render();
