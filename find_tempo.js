
// FPS MAP
const FPS_MAP = {
  '23.976':  { fps: 24000/1001,  drop: false },
  '24':      { fps: 24,          drop: false },
  '24.98':   { fps: 25000/1001,  drop: false },
  '25':      { fps: 25,          drop: false },
  '29.97':   { fps: 30000/1001,  drop: false },
  '29.97df': { fps: 30000/1001,  drop: true  },
  '30':      { fps: 30,          drop: false },
  '30df':    { fps: 30,          drop: true  },
  '50':      { fps: 50,          drop: false },
  '59.94':   { fps: 60000/1001,  drop: false },
  '60':      { fps: 60,          drop: false },
};

function secondsToAbsFrame(sec, fpsKey) {
  return Math.round(sec * FPS_MAP[fpsKey].fps);
}

function absFrameToSMPTE(f, fpsKey) {
  const { fps, drop } = FPS_MAP[fpsKey];
  if (drop) return dropFrameToSMPTE(f, fps, Math.round(fps));
  const fpsR = Math.round(fps);
  const fr = f % fpsR;
  const ts = Math.floor(f / fpsR);
  const s  = ts % 60, m = Math.floor(ts/60) % 60, h = Math.floor(ts/3600);
  return `${p(h)}:${p(m)}:${p(s)}:${p(fr)}`;
}

function dropFrameToSMPTE(f, fps, fpsRound) {
  const dropFrames = Math.round(fps * 0.066666);
  const framesPerMin   = Math.round(fps * 60) - dropFrames;
  const framesPer10Min = Math.round(fps * 600);
  const framesPerHour  = Math.round(fps * 3600);
  f = ((f % framesPerHour) + framesPerHour) % framesPerHour;
  const d = Math.floor(f / framesPer10Min);
  const m = Math.floor((f % framesPer10Min) / framesPerMin);
  if (m > 0) f += dropFrames * (9 * d + m - 1) + dropFrames;
  else       f += dropFrames * 9 * d;
  const fr = f % fpsRound;
  const ts = Math.floor(f / fpsRound);
  const s  = ts % 60, mi = Math.floor(ts/60) % 60, h = Math.floor(ts/3600);
  return `${p(h)};${p(mi)};${p(s)};${p(fr)}`;
}

function p(n) { return String(n).padStart(2,'0'); }

function smpteParse(tc, fpsKey) {
  const parts = tc.replace(/[;,]/g,':').split(':');
  if (parts.length < 4) return null;
  const [h,m,s,f] = parts.map(Number);
  if ([h,m,s,f].some(isNaN)) return null;
  const fps = FPS_MAP[fpsKey].fps;
  return Math.round((h*3600 + m*60 + s) * fps) + f;
}

function ppqToSeconds(tick, bpm, tpq) { return tick / tpq * (60 / bpm); }

function parseMIDI(buf) {
  const dv = new DataView(buf);
  let pos = 0;
  const r16 = () => { const v = dv.getUint16(pos); pos+=2; return v; };
  const r32 = () => { const v = dv.getUint32(pos); pos+=4; return v; };
  const rVLQ = () => {
    let v=0, b;
    do { b=dv.getUint8(pos++); v=(v<<7)|(b&0x7f); } while(b&0x80);
    return v;
  };
  if (r32() !== 0x4D546864) throw new Error('Not a MIDI file');
  r32(); r16();
  const numTracks = r16();
  const tpq = r16();
  let tempos = [{tick:0, bpm:120, sec:0}];
  let markers = [];
  for (let t=0; t<numTracks; t++) {
    if (r32() !== 0x4D54726B) throw new Error('Bad track');
    const len = r32();
    const end = pos + len;
    let tick=0, lastStatus=0;
    while (pos < end) {
      tick += rVLQ();
      let status = dv.getUint8(pos);
      if (status & 0x80) { lastStatus=status; pos++; } else { status=lastStatus; }
      if (status === 0xFF) {
        const type = dv.getUint8(pos++);
        const mlen = rVLQ();
        if (type === 0x51) {
          const us = (dv.getUint8(pos)<<16)|(dv.getUint8(pos+1)<<8)|dv.getUint8(pos+2);
          const bpm = 60000000/us;
          const prev = tempos[tempos.length-1];
          const sec  = prev.sec + ppqToSeconds(tick-prev.tick, prev.bpm, tpq);
          tempos.push({tick, bpm, sec});
        } else if (type === 0x06) {
          const name = new TextDecoder().decode(new Uint8Array(buf,pos,mlen));
          const prev = tempos[tempos.length-1];
          const sec  = prev.sec + ppqToSeconds(tick-prev.tick, prev.bpm, tpq);
          markers.push({name, seconds: sec});
        }
        pos += mlen;
      } else {
        const ch = status & 0x0F, cmd = status & 0xF0;
        if (cmd===0x80||cmd===0x90||cmd===0xA0||cmd===0xB0||cmd===0xE0) pos+=2;
        else if (cmd===0xC0||cmd===0xD0) pos+=1;
        else if (status===0xF2) pos+=2;
        else if (status===0xF3) pos+=1;
      }
    }
    pos = end;
  }
  return { markers, tpq, tempos };
}

// ── XML PARSER (Cubase tracklist2 format) ──
function parseCubaseXML(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  if (doc.querySelector('parseerror')) throw new Error('Invalid XML');

  // Leggi BPM dal TempoEvent interno (se presente), default 120
  let projectBPM = 120;
  const tempoEl = doc.querySelector('obj[class="MTempoEvent"]');
  if (tempoEl) {
    const bpmEl = tempoEl.querySelector('float[name="BPM"]');
    if (bpmEl) projectBPM = parseFloat(bpmEl.getAttribute('value')) || 120;
  }

  // TPQ di default Cubase = 480
  const projectTPQ = 480;
  // secondi = ticks / (BPM/60 * TPQ)
  const ticksPerSec = (projectBPM / 60) * projectTPQ;

  const mkEvents = doc.querySelectorAll('obj[class="MMarkerEvent"]');
  const result = [];
  mkEvents.forEach(ev => {
    const startEl = ev.querySelector('float[name="Start"]');
    const nameEl  = ev.querySelector('string[name="Name"]');
    if (!startEl) return;
    const ticks   = parseFloat(startEl.getAttribute('value'));
    const seconds = ticks / ticksPerSec;
    const name    = nameEl ? nameEl.getAttribute('value') : 'Marker';
    result.push({ name, seconds });
  });

  if (!result.length) throw new Error('No markers found in XML file');
  return result;
}

// State
let markers = [];
let nextId  = 1;
let editingAfter = null;
let editingRowId = null;
let results = [];
let sortCol = 'score', sortDir = -1;

// ── HISTORY (Undo/Redo) ──
const MAX_HISTORY = 50;
let history = [];   // stack di snapshot
let historyPos = -1; // punta all'ultimo snapshot applicato

function snapshotMarkers() {
  return JSON.parse(JSON.stringify(markers));
}

function historyPush() {
  // tronca eventuali redo in sospeso
  if (historyPos < history.length - 1)
    history = history.slice(0, historyPos + 1);
  history.push(snapshotMarkers());
  if (history.length > MAX_HISTORY) history.shift();
  historyPos = history.length - 1;
  updateUndoRedo();
}

function historyUndo() {
  if (historyPos <= 0) return;
  historyPos--;
  markers = JSON.parse(JSON.stringify(history[historyPos]));
  editingRowId = null; editingAfter = null;
  renderMarkerTable(); updateUndoRedo();
}

function historyRedo() {
  if (historyPos >= history.length - 1) return;
  historyPos++;
  markers = JSON.parse(JSON.stringify(history[historyPos]));
  editingRowId = null; editingAfter = null;
  renderMarkerTable(); updateUndoRedo();
}

function updateUndoRedo() {
  const u = document.getElementById('undoBtn');
  const r = document.getElementById('redoBtn');
  if (u) u.disabled = historyPos <= 0;
  if (r) r.disabled = historyPos >= history.length - 1;
}

// ── INLINE EDIT ──
function startEdit(id) {
  editingAfter = null;
  editingRowId = id;
  renderMarkerTable();
  // focus sul campo TC
  const el = document.getElementById(`etcInput_${id}`);
  if (el) { el.focus(); el.select(); }
}

function cancelEdit() {
  editingRowId = null;
  renderMarkerTable();
}

function commitEdit(id) {
  const fpsKey = document.getElementById('fps').value;
  const tcEl   = document.getElementById(`etcInput_${id}`);
  const descEl = document.getElementById(`edescInput_${id}`);
  if (!tcEl) return;
  const tcRaw = tcEl.value.trim();
  const absFrame = smpteParse(tcRaw, fpsKey);
  if (absFrame === null) {
    tcEl.style.borderColor = '#f38ba8';
    tcEl.focus();
    return;
  }
  const m = markers.find(x => x.id === id);
  if (!m) return;
  historyPush();
  m.absFrame = absFrame;
  m.tc       = absFrameToSMPTE(absFrame, fpsKey);
  m.seconds  = absFrame / FPS_MAP[fpsKey].fps;
  if (descEl && descEl.value.trim()) m.name = descEl.value.trim();
  markers.sort((a, b) => a.absFrame - b.absFrame);
  editingRowId = null;
  renderMarkerTable();
}

function editKey(e, id) {
  if (e.key === 'Enter')  { e.preventDefault(); commitEdit(id); }
  if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
}

function recalcMarkers() {
  const fpsKey = document.getElementById('fps').value;
  markers.forEach(m => {
    m.absFrame = secondsToAbsFrame(m.seconds, fpsKey);
    m.tc = absFrameToSMPTE(m.absFrame, fpsKey);
  });
}

function updateSearchBtn() {
  const btn = document.getElementById('searchBtn');
  const active = markers.filter(m => m.active && m.weight > 0);
  btn.disabled = active.length === 0;
}

function renderMarkerTable() {
  const fpsKey = document.getElementById('fps').value;
  const tbody  = document.getElementById('markerTbody');
  let html = '';

  markers.forEach((m, i) => {
    const isEditing = editingRowId === m.id;
    const weightCls = m.weight === 3 ? 'w-high' : m.weight === 1 ? 'w-low' : m.weight === 0 ? 'no-weight' : '';
    const rowCls = weightCls + (isEditing ? ' editing' : '');
    if (isEditing) {
      const wLabel = WEIGHT_LABEL[m.weight] ?? 'N';
      const wTitle = { 3:'Maggiore', 2:'Normale', 1:'Minore', 0:'Nessuno' }[m.weight] ?? 'Normale';
      html += `<tr class="${rowCls}" id="mrow_${m.id}">
        <td class="check-col"><input type="checkbox" ${m.active?'checked':''} onchange="setActive(${m.id},this.checked)"></td>
        <td class="col-num td-num">${i+1}</td>
        <td class="col-tc"><input class="inline-edit-tc tc-input" id="etcInput_${m.id}" value="${m.tc}" oninput="fmtTC(this)" onkeydown="editKey(event,${m.id})"></td>
        <td class="col-name"><input class="inline-edit-desc" id="edescInput_${m.id}" value="${m.name.replace(/"/g,'&quot;')}" onkeydown="editKey(event,${m.id})"></td>
        <td class="col-weight"><button class="weight-btn" data-w="${m.weight}" onclick="cycleWeight(${m.id})" title="${wTitle}">${wLabel}</button></td>
        <td class="td-actions">
          <button class="icon-btn ok-btn" onclick="commitEdit(${m.id})" title="Salva (Invio)"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></button>
          <button class="icon-btn cancel-btn" onclick="cancelEdit()" title="Annulla (Esc)"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </td>
      </tr>`;
    } else {
      const wLabel2 = WEIGHT_LABEL[m.weight] ?? 'N';
      const wTitle2 = { 3:'Maggiore', 2:'Normale', 1:'Minore', 0:'Nessuno' }[m.weight] ?? 'Normale';
      html += `<tr class="${rowCls}" id="mrow_${m.id}">
        <td class="check-col"><input type="checkbox" ${m.active?'checked':''} onchange="setActive(${m.id},this.checked)"></td>
        <td class="col-num td-num">${i+1}</td>
        <td class="col-tc td-tc">${m.tc}</td>
        <td class="col-name td-desc">${m.name}</td>
        <td class="col-weight"><button class="weight-btn" data-w="${m.weight}" onclick="cycleWeight(${m.id})" title="${wTitle2}">${wLabel2}</button></td>
        <td class="td-actions">
          <button class="icon-btn edit-btn" onclick="startEdit(${m.id})" title="Modifica"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="icon-btn del-btn" onclick="deleteMarker(${m.id})" title="Elimina"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </td>
      </tr>`;
    }
    if (editingAfter === m.id) html += inlineFormHTML(m.id);
  });
  if (editingAfter === 'end') html += inlineFormHTML('end');
  tbody.innerHTML = html;
  if (editingAfter !== null) {
    const form = document.getElementById(`iform_${editingAfter}`);
    if (form) form.querySelector('.add-tc').focus();
  }
  updateSearchBtn();
}

function inlineFormHTML(afterId) {
  return `<tr id="iform_${afterId}" class="inline-form-row">
    <td></td>
    <td><input class="add-tc tc-input edit-tc" placeholder="00:00:00:00" oninput="fmtTC(this)" onkeydown="formKey(event,'${afterId}')"></td>
    <td colspan="2"><input class="add-desc" placeholder="Nome marker" style="width:100%;background:#1a1a2e;border:1px solid #2a2a42;border-radius:3px;color:#cdd6f4;padding:2px 5px;font-size:11px;" onkeydown="formKey(event,'${afterId}')"></td>
    <td>
      <button class="btn-sm accent" onclick="confirmInlineMarker('${afterId}')">OK</button>
      <button class="btn-sm" onclick="cancelInlineForm()">X</button>
    </td>
  </tr>`;
}

function fmtTC(el) {
  let v = el.value.replace(/[^0-9]/g,'');
  if (v.length>2) v = v.slice(0,2)+':'+v.slice(2);
  if (v.length>5) v = v.slice(0,5)+':'+v.slice(5);
  if (v.length>8) v = v.slice(0,8)+':'+v.slice(8);
  if (v.length>11) v = v.slice(0,11);
  el.value = v;
}

function formKey(e, afterId) {
  if (e.key==='Enter')  { e.preventDefault(); confirmInlineMarker(afterId); }
  if (e.key==='Escape') { e.preventDefault(); cancelInlineForm(); }
}

function addMarkerAfter(id)  { editingAfter = id;    renderMarkerTable(); }
function addMarkerAtEnd()    { editingAfter = 'end'; renderMarkerTable(); }
function cancelInlineForm()  { editingAfter = null;  renderMarkerTable(); }

function confirmInlineMarker(afterId) {
  const fpsKey = document.getElementById('fps').value;
  const form   = document.getElementById(`iform_${afterId}`);
  if (!form) return;
  const tcRaw  = form.querySelector('.add-tc').value.trim();
  const desc   = form.querySelector('.add-desc').value.trim();
  const absFrame = smpteParse(tcRaw, fpsKey);
  if (absFrame === null) {
    form.querySelector('.add-tc').style.borderColor = '#f38ba8';
    form.querySelector('.add-tc').focus();
    return;
  }
  const newM = {
    id: nextId++, name: desc || `Marker ${markers.length+1}`,
    absFrame, durFrame: 0,
    tc: absFrameToSMPTE(absFrame, fpsKey),
    durTC: '-',
    seconds: absFrame / FPS_MAP[fpsKey].fps,
    weight: 2, active: true, manual: true,
  };
  historyPush();
  if (afterId === 'end') {
    markers.push(newM);
  } else {
    const idx = markers.findIndex(m => m.id === parseInt(afterId));
    markers.splice(idx + 1, 0, newM);
  }
  markers.sort((a,b) => a.absFrame - b.absFrame);
  editingAfter = null;
  renderMarkerTable();
}

const WEIGHT_CYCLE = [3, 2, 1, 0]; // H → N → L → —
const WEIGHT_LABEL = { 3: 'H', 2: 'N', 1: 'L', 0: '—' };

function cycleWeight(id) {
  const m = markers.find(x => x.id === id);
  if (!m) return;
  historyPush();
  const idx = WEIGHT_CYCLE.indexOf(m.weight);
  m.weight = WEIGHT_CYCLE[(idx + 1) % WEIGHT_CYCLE.length];
  // aggiorna solo il bottone senza ri-renderizzare tutta la tabella
  const btn = document.querySelector(`#mrow_${id} .weight-btn`);
  if (btn) {
    btn.dataset.w = m.weight;
    btn.textContent = WEIGHT_LABEL[m.weight];
    btn.title = { 3:'Maggiore', 2:'Normale', 1:'Minore', 0:'Nessuno' }[m.weight];
  }
  // aggiorna classi colore sulla riga
  const row = document.getElementById(`mrow_${id}`);
  if (row) {
    row.classList.remove('w-high', 'w-low', 'no-weight');
    if (m.weight === 3) row.classList.add('w-high');
    else if (m.weight === 1) row.classList.add('w-low');
    else if (m.weight === 0) row.classList.add('no-weight');
  }
  updateSearchBtn();
}

function setWeight(id, val) {
  const m = markers.find(x => x.id === id);
  if (m) { historyPush(); m.weight = parseInt(val); updateSearchBtn(); }
}

function setActive(id, val) {
  const m = markers.find(x => x.id === id);
  if (m) { historyPush(); m.active = val; updateSearchBtn(); }
}

function deleteMarker(id) {
  historyPush();
  if (editingAfter === id) editingAfter = null;
  if (editingRowId === id) editingRowId = null;
  markers = markers.filter(x => x.id !== id);
  renderMarkerTable();
}

function clearAllMarkers() {
  if (markers.length && !confirm('Clear all markers?')) return;
  historyPush();
  markers = []; editingAfter = null; editingRowId = null;
  if (window._setImportAreaLocked) window._setImportAreaLocked(false);
  renderMarkerTable();
  results = [];
  // pulisce risultati
  document.getElementById('resultsWrap').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </div>
      <p>Import a file and run the search</p>
    </div>`;
  // pulisce il pannello dettaglio
  document.getElementById('detailGrid').innerHTML = '';
  document.getElementById('detailTitleText').textContent = 'Dettaglio — clicca un BPM';
  const detailPanel = document.getElementById('detailPanel');
  if (!detailPanel.classList.contains('collapsed')) toggleDetailPanel();
  // nasconde il badge max hits e l'info ricerca
  document.getElementById('maxHitsBadge').style.display = 'none';
  document.getElementById('searchInfo').textContent = '';
}

// SEARCH
async function runSearch() {
  const fpsKey   = document.getElementById('fps').value;
  const bpmMin   = parseFloat(document.getElementById('bpmMin').value)  || 60;
  const bpmMax   = parseFloat(document.getElementById('bpmMax').value)  || 200;
  const bpmStep  = parseFloat(document.getElementById('bpmStep').value) || 0.5;
  const tolVal   = parseFloat(document.getElementById('tolerance').value) || 2;
  const nearMult = parseFloat(document.getElementById('nearMult').value) || 3;
  const fps      = FPS_MAP[fpsKey].fps;
  const tolUnit    = document.getElementById('toleranceUnit').value;
  const tolFrames  = tolUnit === 'ms'
    ? Math.round(tolVal / 1000 * fps)
    : Math.round(tolVal);
  const nearFrames = tolFrames * nearMult;

  const offMin  = parseInt(document.getElementById('offsetMin').value)  || 0;
  const offMax  = parseInt(document.getElementById('offsetMax').value)  || 0;
  const offStep = Math.max(1, parseInt(document.getElementById('offsetStep').value) || 1);
  const offsets = [];
  for (let o = offMin; o <= offMax; o += offStep) offsets.push(o);
  if (!offsets.length) offsets.push(0);

  const active = markers.filter(m => m.active && m.weight > 0);
  if (!active.length) return;

  const btn = document.getElementById('searchBtn');
  btn.disabled = true; btn.textContent = 'Searching...';
  const pw = document.getElementById('progressWrap');
  const pb = document.getElementById('progressBar');
  const pl = document.getElementById('progressLabel');
  pw.style.display = 'flex';

  const bpmList = [];
  for (let b = bpmMin; b <= bpmMax + 1e-9; b += bpmStep)
    bpmList.push(Math.round(b * 10000) / 10000);

  results = [];
  const CHUNK = 100;
  for (let ci = 0; ci < bpmList.length; ci += CHUNK) {
    bpmList.slice(ci, ci+CHUNK).forEach(bpm =>
      results.push(evalBpm(bpm, active, tolFrames, nearFrames, fpsKey, offsets))
    );
    const pct = Math.min(100, Math.round((ci+CHUNK)/bpmList.length*100));
    pb.style.width = pct + '%';
    pl.textContent = `${pct}% - ${Math.min(ci+CHUNK, bpmList.length)}/${bpmList.length} BPM`;
    await new Promise(r => setTimeout(r, 0));
  }

  pw.style.display = 'none';
  btn.disabled = false; btn.textContent = 'Search';

  const maxHits = Math.max(...results.map(r => r.hitCount + r.nearCount));
  document.getElementById('maxHitsBadge').style.display = '';
  document.getElementById('maxHitsVal').textContent = maxHits;
  document.getElementById('searchInfo').textContent =
    `${results.length} BPM — ${active.length} markers — ±${tolFrames} fr`;

  sortResults(); renderResults();
}

function evalBpmAtOffset(bpm, active, tolFrames, nearFrames, fpsKey, offsetFrames) {
  let hitCount=0, nearCount=0, missCount=0, totalErr=0;
  const fps = FPS_MAP[fpsKey].fps;
  const details = [];
  active.forEach(m => {
    if (m.weight === 0) return;
    const framesPerBeat = (60.0 / bpm) * fps;
    const shiftedFrame  = m.absFrame - offsetFrames;
    const n = Math.round(shiftedFrame / framesPerBeat);
    const beatFrame = Math.round(n * framesPerBeat) + offsetFrames;
    const diff = Math.abs(m.absFrame - beatFrame);
    let status;
    if (diff <= tolFrames)       { status = 'hit';  hitCount++; }
    else if (diff <= nearFrames) { status = 'near'; nearCount++; }
    else                         { status = 'miss'; missCount++; }
    totalErr += diff * m.weight;
    details.push({ ...m, status, diffFrames: diff, beatFrame, beatTC: absFrameToSMPTE(beatFrame, fpsKey) });
  });
  return { hitCount, nearCount, missCount, totalErr,
    score: hitCount*100000 + nearCount*1000 - totalErr, details };
}

function evalBpm(bpm, active, tolFrames, nearFrames, fpsKey, offsets) {
  let best = null, bestOffset = 0;
  for (const off of offsets) {
    const r = evalBpmAtOffset(bpm, active, tolFrames, nearFrames, fpsKey, off);
    if (!best || r.score > best.score) { best = r; bestOffset = off; }
  }
  return { bpm, offset: bestOffset, ...best };
}

function sortResults() {
  results.sort((a,b) => {
    let va, vb;
    switch(sortCol) {
      case 'bpm':   va=a.bpm;       vb=b.bpm;       break;
      case 'hit':   va=a.hitCount;  vb=b.hitCount;  break;
      case 'near':  va=a.nearCount; vb=b.nearCount; break;
      case 'miss':  va=a.missCount; vb=b.missCount; break;
      case 'error': va=a.totalErr;  vb=b.totalErr;  break;
      default:      va=a.score;     vb=b.score;     break;
    }
    return (va - vb) * sortDir;
  });
}

function renderResults() {
  if (!results.length) return;
  const best = Math.max(...results.map(r => r.score));
  const maxE = Math.max(...results.map(r => r.totalErr)) || 1;
  const wrap = document.getElementById('resultsWrap');

  const colClass = { bpm:'col-bpm', error:'col-err', hit:'col-hit', near:'col-near', miss:'col-miss' };
  const th = (col, label) => {
    const sorted = sortCol === col;
    const arrow  = sorted ? (sortDir === -1 ? '▾' : '▴') : '';
    return `<th onclick="resort('${col}')" class="${colClass[col]||''} ${sorted?'sorted':''}">${label}${arrow?` <span style="opacity:.7">${arrow}</span>`:''}</th>`;
  };

  wrap.innerHTML = `<table class="rtable">
    <thead><tr>
      ${th('bpm','BPM')}
      ${th('error','Total Error')}
      ${th('hit','Hit')}
      ${th('near','Near')}
      ${th('miss','Miss')}
    </tr></thead>
    <tbody>
    ${results.map((r, idx) => {
      const isBest = r.score === best;
      const ep = Math.max(0, 1 - r.totalErr / maxE);
      const bc = ep > .7 ? 'good' : ep > .4 ? 'medium' : 'bad';
      const offStr = r.offset ? ` <span style="color:#9070c0;font-size:9px;">+${r.offset}f</span>` : '';
      return `<tr class="${isBest?'best-row':''}" onclick="showDetail(${idx})" style="cursor:pointer;">
        <td><span class="td-bpm">${r.bpm.toFixed(2)}</span>${offStr}${isBest?' <span style="color:#a6e3a1;font-size:9px;">best</span>':''}</td>
        <td><div class="bar-wrap"><div class="bar-fill ${bc}" style="width:${Math.round(ep*100)}%"></div></div></td>
        <td><span class="hit-num">${r.hitCount}</span></td>
        <td><span class="near-num">${r.nearCount}</span></td>
        <td><span class="miss-num">${r.missCount}</span></td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
}

function resort(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = col==='error'||col==='miss' ? 1 : -1; }
  sortResults(); renderResults();
}

function showDetail(idx) {
  const r = results[idx];
  const offStr = r.offset ? ` +${r.offset}f` : '';
  const wrap = document.getElementById('resultsWrap');

  wrap.innerHTML = `
    <div class="detail-view">
      <div class="detail-view-header">
        <button class="detail-back-btn" onclick="showResultsList()">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Results
        </button>
        <div class="detail-view-title">
          <span class="detail-view-bpm">${r.bpm.toFixed(2)} BPM${offStr}</span>
          <span class="detail-view-stats">
            <span class="hit-num">● ${r.hitCount} Hit</span>
            <span class="near-num">● ${r.nearCount} Near</span>
            <span class="miss-num">● ${r.missCount} Miss</span>
            <span style="color:var(--text-muted)">Err ${r.totalErr} fr</span>
          </span>
        </div>
      </div>
      <div class="detail-view-body">
        ${r.details.map(m => `
          <div class="detail-marker ${m.status}">
            <span class="detail-marker-name" title="${m.name}">${m.name}</span>
            <span class="detail-marker-tc">${m.tc}</span>
            <span class="detail-marker-arrow">→</span>
            <span class="detail-marker-beat">${m.beatTC}</span>
            <span class="detail-marker-err">${m.diffFrames === 0 ? 'OK' : m.diffFrames + ' fr'}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function showResultsList() {
  renderResults();
}

function toggleDetailPanel() {} // legacy — non più usata


// RESIZER ORIZZONTALI (tra pannelli)
(function() {
  function makeColResizer(resizerId, panelId, direction) {
    // direction: 'left' = ridimensiona il pannello a sinistra del resizer
    //            'right' = ridimensiona il pannello a destra
    const resizer = document.getElementById(resizerId);
    const panel   = document.getElementById(panelId);
    if (!resizer || !panel) return;
    let dragging=false, startX=0, startW=0;
    resizer.addEventListener('mousedown', e => {
      if (window.innerWidth <= 768) return;
      dragging=true; startX=e.clientX; startW=panel.offsetWidth;
      resizer.classList.add('dragging');
      document.body.style.userSelect='none';
      document.body.style.cursor='ew-resize';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = direction === 'left'
        ? e.clientX - startX
        : startX - e.clientX;
      const minW = parseInt(panel.style.minWidth || getComputedStyle(panel).minWidth) || 200;
      const maxW = parseInt(panel.style.maxWidth || getComputedStyle(panel).maxWidth) || 600;
      panel.style.width = Math.max(minW, Math.min(startW + delta, maxW)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging=false; resizer.classList.remove('dragging');
      document.body.style.userSelect='';
      document.body.style.cursor='';
    });
  }
  makeColResizer('colResizer1', 'panelSettings', 'left');
  // colResizer2 è dentro il wrapper, ma l'id rimane lo stesso
  makeColResizer('colResizer2', 'panelMarkers',  'right');
})();

// CUSTOM SPINNERS
function stepNum(id, dir) {
  const el = document.getElementById(id);
  if (!el) return;
  const step = parseFloat(el.step) || 1;
  const min  = el.min !== '' ? parseFloat(el.min) : -Infinity;
  const max  = el.max !== '' ? parseFloat(el.max) : Infinity;
  let val = parseFloat(el.value) || 0;
  val = Math.round((val + dir * step) * 100000) / 100000;
  val = Math.max(min, Math.min(max, val));
  el.value = val;
  el.dispatchEvent(new Event('input'));
  el.dispatchEvent(new Event('change'));
}

// MOBILE TABS
const TAB_MAP = { settings:'panelSettings', results:'panelResults', markers:'panelMarkers' };

function isMobile() { return window.innerWidth <= 768; }

function switchTab(name, btn) {
  if (!isMobile()) return;
  Object.entries(TAB_MAP).forEach(([k,id]) =>
    document.getElementById(id)?.classList.toggle('tab-active', k===name)
  );
  document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function initMobileTabs() {
  if (!isMobile()) {
    Object.values(TAB_MAP).forEach(id => document.getElementById(id)?.classList.remove('tab-active'));
    return;
  }
  Object.values(TAB_MAP).forEach(id => document.getElementById(id)?.classList.remove('tab-active'));
  document.getElementById('panelSettings')?.classList.add('tab-active');
  document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.mobile-tab')?.classList.add('active');
}

window.addEventListener('load', initMobileTabs);
window.addEventListener('resize', initMobileTabs);

// FILE IMPORT
(function() {
  const area  = document.getElementById('importArea');
  const input = document.getElementById('fileInput');
  const label = document.getElementById('mobileFileLabel');

  function setImportAreaLocked(locked) {
    const area  = document.getElementById('importArea');
    const input = document.getElementById('fileInput');
    if (!area) return;
    if (locked) {
      area.classList.add('import-locked');
      if (input) input.disabled = true;
    } else {
      area.classList.remove('import-locked');
      if (input) { input.disabled = false; input.value = ''; }
    }
  }

  function importMarkersFromList(mkList) {
    const fpsKey = document.getElementById('fps').value;
    historyPush();
    setImportAreaLocked(true);
    markers = mkList.map((mk, i) => {
      const absFrame = secondsToAbsFrame(mk.seconds, fpsKey);
      return {
        id: nextId++, name: mk.name || ('Marker ' + (i+1)),
        absFrame, durFrame: 0,
        tc: absFrameToSMPTE(absFrame, fpsKey), durTC: '-',
        seconds: mk.seconds,
        weight: 2, active: true, manual: false,
      };
    });
    editingRowId = null; editingAfter = null;
    renderMarkerTable();
    document.getElementById('midiInfo').textContent = '';
    // apri il pannello marker se è collassato
    const panel = document.getElementById('panelMarkers');
    if (panel && panel.classList.contains('collapsed')) toggleMarkerPanel();
  }

  function loadFile(file) {
    if (!file) return;
    if (label) label.textContent = file.name;
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'xml') {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const mkList = parseCubaseXML(e.target.result);
          importMarkersFromList(mkList);
        } catch(err) { alert('XML parsing error: ' + err.message); }
      };
      reader.readAsText(file, 'utf-8');
    } else {
      // MIDI (.mid / .midi)
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const midi = parseMIDI(e.target.result);
          importMarkersFromList(midi.markers);
        } catch(err) { alert('MIDI parsing error: ' + err.message); }
      };
      reader.readAsArrayBuffer(file);
    }
  }

  if (area) {
    area.addEventListener('click', () => { if (!area.classList.contains('import-locked')) input.click(); });
    area.addEventListener('dragover', e => { if (area.classList.contains('import-locked')) return; e.preventDefault(); area.classList.add('drag-over'); });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', e => { e.preventDefault(); area.classList.remove('drag-over'); if (!area.classList.contains('import-locked')) loadFile(e.dataTransfer.files[0]); });
  }

  // esponi globalmente per clearAllMarkers
  window._setImportAreaLocked = setImportAreaLocked;
  if (input) input.addEventListener('change', () => loadFile(input.files[0]));
})();

// EVENT LISTENERS
document.getElementById('searchBtn').addEventListener('click', runSearch);

document.getElementById('fps').addEventListener('change', () => {
  recalcMarkers();
  renderMarkerTable();
  if (results.length) runSearch();
});

function updateSearchInfo() {
  const min  = parseFloat(document.getElementById('bpmMin').value)  || 0;
  const max  = parseFloat(document.getElementById('bpmMax').value)  || 0;
  const step = parseFloat(document.getElementById('bpmStep').value) || 1;
  const n = step > 0 ? Math.max(0, Math.round((max-min)/step)+1) : 0;
  document.getElementById('searchInfo').textContent = markers.length ? `${n} BPM to evaluate` : '';
}

['bpmMin','bpmMax','bpmStep'].forEach(id =>
  document.getElementById(id).addEventListener('input', updateSearchInfo)
);

// ── COLLAPSE MARKER PANEL ──
function toggleMarkerPanel() {
  if (window.innerWidth <= 768) return; // solo desktop
  const panel   = document.getElementById('panelMarkers');
  const tabSvg  = document.getElementById('collapseTabSvg');
  const collapsed = panel.classList.toggle('collapsed');
  // freccia: punta a destra (→) quando collassato per indicare "espandi"
  if (tabSvg) tabSvg.style.transform = collapsed ? 'rotate(180deg)' : 'rotate(0deg)';
}

// Keyboard shortcuts Undo/Redo
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); historyUndo(); }
  if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); historyRedo(); }
});

// ── LOGO PULSE (random interval 1–3 min) ──
(function() {
  const logo = document.querySelector('.logo-icon');
  if (!logo) return;
  function scheduleNextPulse() {
    const delay = (60 + Math.random() * 120) * 1000; // 1–3 minuti
    setTimeout(() => {
      logo.classList.add('pulsing');
      logo.addEventListener('animationend', function handler() {
        logo.classList.remove('pulsing');
        logo.removeEventListener('animationend', handler);
        scheduleNextPulse();
      });
    }, delay);
  }
  scheduleNextPulse();
})();

// ── THEME TOGGLE ──
function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch(e) {}
}

// applica tema salvato all'avvio
(function() {
  try {
    if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark');
  } catch(e) {}
})();

// INIT
history = [snapshotMarkers()]; // snapshot iniziale vuoto
historyPos = 0;
updateUndoRedo();
renderMarkerTable();
updateSearchBtn();

// ── DEFAULT MARKERS (embedded) ──
(function() {
  const DEFAULT_XML = `<?xml version="1.0" encoding="utf-8"?>
<tracklist2>
   <list name="track" type="obj">
      <obj class="MMarkerTrackEvent" ID="1098520624">
         <int name="Flags" value="1"/>
         <float name="Start" value="0"/>
         <float name="Length" value="1746375.55300000007264316082000732421875"/>
         <obj class="MListNode" name="Node" ID="985941824">
            <string name="Name" value="Markers" wide="true"/>
            <member name="Domain">
               <int name="Type" value="0"/>
               <obj class="MTempoTrackEvent" name="Tempo Track" ID="706013696">
                  <list name="TempoEvent" type="obj">
                     <obj class="MTempoEvent" ID="519283408">
                        <float name="BPM" value="120"/>
                        <float name="PPQ" value="0"/>
                     </obj>
                  </list>
                  <float name="RehearsalTempo" value="120"/>
                  <member name="Additional Attributes"><int name="Lock" value="0"/></member>
               </obj>
            </member>
            <list name="Events" type="obj">
               <obj class="MMarkerEvent" ID="993089424"><float name="Start" value="0"/><float name="Length" value="0"/><string name="Name" value="MX IN" wide="true"/><int name="ID" value="1"/></obj>
               <obj class="MMarkerEvent" ID="986827040"><float name="Start" value="1456.66"/><float name="Length" value="0"/><string name="Name" value="Title Card" wide="true"/><int name="ID" value="2"/></obj>
               <obj class="MMarkerEvent" ID="986826752"><float name="Start" value="2314.26"/><float name="Length" value="0"/><string name="Name" value="Establishing Shot" wide="true"/><int name="ID" value="3"/></obj>
               <obj class="MMarkerEvent" ID="986828768"><float name="Start" value="3275.86"/><float name="Length" value="0"/><string name="Name" value="First Action Beat" wide="true"/><int name="ID" value="4"/></obj>
               <obj class="MMarkerEvent" ID="986822432"><float name="Start" value="5015.70"/><float name="Length" value="0"/><string name="Name" value="Tension Build" wide="true"/><int name="ID" value="5"/></obj>
               <obj class="MMarkerEvent" ID="986163408"><float name="Start" value="6164.5"/><float name="Length" value="0"/><string name="Name" value="Chase - Start" wide="true"/><int name="ID" value="6"/></obj>
               <obj class="MMarkerEvent" ID="986160096"><float name="Start" value="6518.42"/><float name="Length" value="0"/><string name="Name" value="Fight Sting" wide="true"/><int name="ID" value="7"/></obj>
               <obj class="MMarkerEvent" ID="986156352"><float name="Start" value="7759.38"/><float name="Length" value="0"/><string name="Name" value="Emotional Break" wide="true"/><int name="ID" value="8"/></obj>
               <obj class="MMarkerEvent" ID="986163552"><float name="Start" value="7926.42"/><float name="Length" value="0"/><string name="Name" value="Danger Cue" wide="true"/><int name="ID" value="9"/></obj>
               <obj class="MMarkerEvent" ID="986165136"><float name="Start" value="8238.10"/><float name="Length" value="0"/><string name="Name" value="Dialogue Scene" wide="true"/><int name="ID" value="10"/></obj>
               <obj class="MMarkerEvent" ID="986162832"><float name="Start" value="8393.30"/><float name="Length" value="0"/><string name="Name" value="Chase - Peak" wide="true"/><int name="ID" value="11"/></obj>
               <obj class="MMarkerEvent" ID="986164704"><float name="Start" value="8560.66"/><float name="Length" value="0"/><string name="Name" value="Flashback Hit" wide="true"/><int name="ID" value="12"/></obj>
               <obj class="MMarkerEvent" ID="986156784"><float name="Start" value="8706.58"/><float name="Length" value="0"/><string name="Name" value="Suspense Hold" wide="true"/><int name="ID" value="13"/></obj>
               <obj class="MMarkerEvent" ID="986159808"><float name="Start" value="9080.98"/><float name="Length" value="0"/><string name="Name" value="Night Chase" wide="true"/><int name="ID" value="14"/></obj>
               <obj class="MMarkerEvent" ID="986156208"><float name="Start" value="9457.30"/><float name="Length" value="0"/><string name="Name" value="Ambush Sting" wide="true"/><int name="ID" value="15"/></obj>
               <obj class="MMarkerEvent" ID="951976064"><float name="Start" value="10596.5"/><float name="Length" value="0"/><string name="Name" value="Relief Moment" wide="true"/><int name="ID" value="16"/></obj>
               <obj class="MMarkerEvent" ID="951970304"><float name="Start" value="10763.86"/><float name="Length" value="0"/><string name="Name" value="False Scare" wide="true"/><int name="ID" value="17"/></obj>
               <obj class="MMarkerEvent" ID="951974768"><float name="Start" value="11055.70"/><float name="Length" value="0"/><string name="Name" value="Low Tension" wide="true"/><int name="ID" value="18"/></obj>
               <obj class="MMarkerEvent" ID="951975632"><float name="Start" value="11338.90"/><float name="Length" value="0"/><string name="Name" value="Climax Build" wide="true"/><int name="ID" value="19"/></obj>
               <obj class="MMarkerEvent" ID="951978224"><float name="Start" value="13318.74"/><float name="Length" value="0"/><string name="Name" value="Reveal Hit" wide="true"/><int name="ID" value="20"/></obj>
               <obj class="MMarkerEvent" ID="951976352"><float name="Start" value="13966.42"/><float name="Length" value="0"/><string name="Name" value="Final Standoff" wide="true"/><int name="ID" value="21"/></obj>
               <obj class="MMarkerEvent" ID="951974912"><float name="Start" value="14898.26"/><float name="Length" value="0"/><string name="Name" value="Emotional Peak" wide="true"/><int name="ID" value="22"/></obj>
               <obj class="MMarkerEvent" ID="951977648"><float name="Start" value="16360.02"/><float name="Length" value="0"/><string name="Name" value="Escape Run" wide="true"/><int name="ID" value="23"/></obj>
               <obj class="MMarkerEvent" ID="951972464"><float name="Start" value="17288.34"/><float name="Length" value="0"/><string name="Name" value="Aftermath" wide="true"/><int name="ID" value="24"/></obj>
               <obj class="MMarkerEvent" ID="951971456"><float name="Start" value="18322.58"/><float name="Length" value="0"/><string name="Name" value="Resolution" wide="true"/><int name="ID" value="25"/></obj>
               <obj class="MMarkerEvent" ID="951978512"><float name="Start" value="18499.22"/><float name="Length" value="0"/><string name="Name" value="Epilogue" wide="true"/><int name="ID" value="26"/></obj>
               <obj class="MMarkerEvent" ID="951973472"><float name="Start" value="19791.38"/><float name="Length" value="0"/><string name="Name" value="End Credits" wide="true"/><int name="ID" value="27"/></obj>
               <obj class="MMarkerEvent" ID="951975200"><float name="Start" value="20823.06"/><float name="Length" value="0"/><string name="Name" value="MX OUT" wide="true"/><int name="ID" value="28"/></obj>
            </list>
         </obj>
      </obj>
   </list>
</tracklist2>`;

  try {
    const mkList = parseCubaseXML(DEFAULT_XML);
    const fpsKey = document.getElementById('fps').value;
    markers = mkList.map((mk, i) => {
      const absFrame = secondsToAbsFrame(mk.seconds, fpsKey);
      return {
        id: nextId++, name: mk.name || ('Marker ' + (i + 1)),
        absFrame, durFrame: 0,
        tc: absFrameToSMPTE(absFrame, fpsKey), durTC: '-',
        seconds: mk.seconds,
        weight: 2, active: true, manual: false,
      };
    });
    history = [JSON.parse(JSON.stringify(markers))];
    historyPos = 0;
    editingRowId = null; editingAfter = null;
    renderMarkerTable();
    updateUndoRedo();
    updateSearchBtn();
    if (window._setImportAreaLocked) window._setImportAreaLocked(true);
    const panel = document.getElementById('panelMarkers');
    if (panel && panel.classList.contains('collapsed')) toggleMarkerPanel();
  } catch(e) { console.warn('Default markers failed:', e); }
})();

// Pannello marker collassato di default (si apre automaticamente all'import)
(function() {
  const tabSvg = document.getElementById('collapseTabSvg');
  if (tabSvg) tabSvg.style.transform = 'rotate(180deg)';
})();
