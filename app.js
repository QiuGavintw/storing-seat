(() => {
  const STORAGE_KEY = 'seating-plan-state-v1';
  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));

  const defaultState = () => ({
    layout: { rows: 5, cols: 6, teacherDesk: 'center', showTeacherDesk: true, showBlackboard: true, cellTypes: {} },
    students: [],
    seats: {}, // cellKey -> studentUid
    locked: {}, // cellKey -> true
    settings: { mode: 'random', fillOrder: 'row_lr', frontRows: 2, backRows: 2, genderMix: false, groupMix: true, darkMode: false, seatFontScale: 100 },
    separationRules: [], // {id, uids:[], strength:1}
    history: [], // {id, name, time, snapshot}
    ui: {}
  });

  let state = loadState();
  let undoStack = [];
  let redoStack = [];
  let dragSrcKey = null;
  const MAX_UNDO = 20;
  const MAX_HISTORY = 20;

  function uid() { return 'id_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
  function cellKey(r,c){ return `${r}-${c}`; }
  function parseCellKey(key){ const [r,c]=key.split('-').map(Number); return {r,c}; }
  function deepClone(o){ return JSON.parse(JSON.stringify(o)); }
  function clamp(n,min,max){ return Math.max(min, Math.min(max,n)); }

  function loadState(){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      return mergeDefaults(defaultState(), s);
    } catch { return defaultState(); }
  }
  function mergeDefaults(base, s){
    const out = {...base, ...s};
    out.layout = {...base.layout, ...(s.layout||{})};
    out.layout.cellTypes = {...(s.layout&&s.layout.cellTypes||{})};
    out.settings = {...base.settings, ...(s.settings||{})};
    out.students = Array.isArray(s.students)? s.students : [];
    out.seats = {...(s.seats||{})};
    out.locked = {...(s.locked||{})};
    out.separationRules = Array.isArray(s.separationRules)? s.separationRules : [];
    out.history = Array.isArray(s.history)? s.history : [];
    return out;
  }
  function saveState(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e){ console.warn('save failed', e); }
  }
  function pushUndo(label=''){
    undoStack.push(deepClone({layout:state.layout, students:state.students, seats:state.seats, locked:state.locked, settings:state.settings, separationRules:state.separationRules, label}));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
  }
  function restoreSnapshot(snap){
    state.layout = deepClone(snap.layout);
    state.students = deepClone(snap.students);
    state.seats = deepClone(snap.seats);
    state.locked = deepClone(snap.locked);
    state.settings = deepClone(snap.settings || state.settings);
    state.separationRules = deepClone(snap.separationRules || []);
  }
  function undo(){ if(!undoStack.length) return; const cur = deepClone({layout:state.layout, students:state.students, seats:state.seats, locked:state.locked, settings:state.settings, separationRules:state.separationRules}); const prev = undoStack.pop(); redoStack.push(cur); restoreSnapshot(prev); renderAll(); saveState(); updateUndoRedoButtons(); }
  function redo(){ if(!redoStack.length) return; const cur = deepClone({layout:state.layout, students:state.students, seats:state.seats, locked:state.locked, settings:state.settings, separationRules:state.separationRules}); const next = redoStack.pop(); undoStack.push(cur); restoreSnapshot(next); renderAll(); saveState(); updateUndoRedoButtons(); }
  function updateUndoRedoButtons(){ $('#undoBtn').disabled = undoStack.length===0; $('#redoBtn').disabled = redoStack.length===0; }

  function getStudent(uid){ return state.students.find(s=>s.uid===uid); }
  function studentByNumberOrName(key){ return state.students.find(s=>String(s.number)===String(key) || s.name===key); }

  function normalizeStudent(s){
    const fb = (s.frontBack||'').trim();
    let frontBack = '不指定';
    if (/前/.test(fb)) frontBack = '前排'; else if (/後|后/.test(fb)) frontBack = '後排';
    const g = (s.gender||'').trim();
    let gender = '';
    if (/^男/.test(g)) gender='男'; else if (/^女/.test(g)) gender='女'; else if (g) gender='其他';
    return {
      uid: s.uid || uid(),
      number: (s.number??'').toString().trim(),
      name: (s.name??'').toString().trim(),
      gender,
      frontBack,
      group: (s.group??'').toString().trim(),
      note: (s.note??'').toString().trim(),
      fixedSeat: normalizeFixedSeat(s.fixedSeat||''),
      restrictionTag: (s.restrictionTag??'').toString().trim()
    };
  }
  function normalizeFixedSeat(v){
    if(!v) return '';
    const s = String(v).trim().toUpperCase().replace(/\s+/g,'');
    let m = s.match(/^R(\d+)C(\d+)$/); if(m) return `R${+m[1]}C${+m[2]}`;
    m = s.match(/^(\d+)[,，-](\d+)$/); if(m) return `R${+m[1]}C${+m[2]}`;
    m = s.match(/^(\d+)行(\d+)列$/); if(m) return `R${+m[1]}C${+m[2]}`;
    return String(v).trim();
  }
  function fixedSeatToKey(fs){
    if(!fs) return null;
    const m = String(fs).toUpperCase().match(/^R(\d+)C(\d+)$/);
    if(!m) return null;
    return cellKey(+m[1]-1, +m[2]-1);
  }

  function ensureLayoutBounds(){
    const {rows, cols} = state.layout;
    const newTypes = {};
    for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){ const k=cellKey(r,c); if(state.layout.cellTypes[k]) newTypes[k]=state.layout.cellTypes[k]; }
    state.layout.cellTypes = newTypes;
    const newSeats = {}, newLocked = {};
    for(const k of Object.keys(state.seats)){ const {r,c}=parseCellKey(k); if(r<rows && c<cols) newSeats[k]=state.seats[k]; }
    for(const k of Object.keys(state.locked)){ const {r,c}=parseCellKey(k); if(r<rows && c<cols) newLocked[k]=state.locked[k]; }
    state.seats = newSeats; state.locked = newLocked;
  }

  function isSeatCell(k){ const t = state.layout.cellTypes[k]; return t !== 'stage' && t !== 'disabled'; }
  function getFillOrderKeys(){
    const {rows, cols} = state.layout;
    const keys = [];
    const push = (r,c)=>keys.push(cellKey(r,c));
    const mode = state.settings.fillOrder;
    if(mode==='row_lr'){ for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) push(r,c); }
    else if(mode==='row_rl'){ for(let r=0;r<rows;r++) for(let c=cols-1;c>=0;c--) push(r,c); }
    else if(mode==='row_snake_lr'){ for(let r=0;r<rows;r++){ if(r%2===0) for(let c=0;c<cols;c++) push(r,c); else for(let c=cols-1;c>=0;c--) push(r,c);} }
    else if(mode==='row_snake_rl'){ for(let r=0;r<rows;r++){ if(r%2===0) for(let c=cols-1;c>=0;c--) push(r,c); else for(let c=0;c<cols;c++) push(r,c);} }
    else if(mode==='col_tb'){ for(let c=0;c<cols;c++) for(let r=0;r<rows;r++) push(r,c); }
    else if(mode==='col_bt'){ for(let c=0;c<cols;c++) for(let r=rows-1;r>=0;r--) push(r,c); }
    else if(mode==='col_snake_tb'){ for(let c=0;c<cols;c++){ if(c%2===0) for(let r=0;r<rows;r++) push(r,c); else for(let r=rows-1;r>=0;r--) push(r,c);} }
    else if(mode==='col_snake_bt'){ for(let c=0;c<cols;c++){ if(c%2===0) for(let r=rows-1;r>=0;r--) push(r,c); else for(let r=0;r<rows;r++) push(r,c);} }
    else { for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) push(r,c); }
    return keys;
  }

  // ---------- Rendering ----------
  function applySeatFontScale(){
    const scale = clamp(parseInt(state.settings.seatFontScale, 10) || 100, 85, 150);
    state.settings.seatFontScale = scale;
    const card = $('#captureArea');
    if(card) card.style.setProperty('--seat-font-scale', (scale / 100).toString());
    const range = $('#seatFontRange');
    const value = $('#seatFontValue');
    if(range) range.value = String(scale);
    if(value) value.textContent = scale + '%';
  }
  function renderAll(){
    $('#rowsInput').value = state.layout.rows;
    $('#colsInput').value = state.layout.cols;
    $('#teacherDeskPos').value = state.layout.teacherDesk;
    $('#showTeacherDesk').checked = !!state.layout.showTeacherDesk;
    $('#showBlackboard').checked = !!state.layout.showBlackboard;
    $('#modeSelect').value = state.settings.mode;
    $('#fillOrderSelect').value = state.settings.fillOrder;
    $('#frontRows').value = state.settings.frontRows;
    $('#backRows').value = state.settings.backRows;
    $('#genderMix').checked = !!state.settings.genderMix;
    $('#groupMix').checked = !!state.settings.groupMix;
    document.body.classList.toggle('dark', !!state.settings.darkMode);
    $('#darkModeBtn').textContent = state.settings.darkMode ? '切換淺色模式' : '切換深色模式';
    applySeatFontScale();

    renderBoard();
    renderStudentTable();
    renderStats();
    renderHistory();
    updateUndoRedoButtons();
  }

  function updateBoardLayoutMode(){
    const card = $('#captureArea');
    const grid = $('#seatGrid');
    if(!card || !grid) return;
    const expanded = card.classList.contains('zoomed') || document.fullscreenElement === card;
    grid.style.gridTemplateColumns = `repeat(${state.layout.cols}, minmax(${expanded ? 120 : 90}px, 1fr))`;
    grid.style.width = expanded ? '100%' : '';
    grid.style.minWidth = expanded ? '0' : '';
  }
  function renderBoard(){
    const bb = $('#blackboard');
    const td = $('#teacherDesk');
    bb.classList.toggle('hidden', !state.layout.showBlackboard);
    td.classList.toggle('hidden', !state.layout.showTeacherDesk);
    td.className = 'teacher-desk pos-' + (state.layout.teacherDesk || 'center');
    const grid = $('#seatGrid');
    grid.innerHTML = '';
    updateBoardLayoutMode();
    for(let r=0;r<state.layout.rows;r++){
      for(let c=0;c<state.layout.cols;c++){
        const k = cellKey(r,c);
        const type = state.layout.cellTypes[k] || 'normal';
        const stuUid = state.seats[k];
        const stu = stuUid ? getStudent(stuUid) : null;
        const locked = !!state.locked[k];
        const div = document.createElement('div');
        div.className = 'seat';
        div.dataset.key = k;
        if(type==='disabled'){ div.classList.add('disabled'); }
        if(type==='stage'){ div.classList.add('stage'); }
        if(stu){ const gcls = stu.gender==='男'?'male':stu.gender==='女'?'female':'other'; div.classList.add(gcls); }
        if(locked) div.classList.add('locked');
        div.draggable = !!stu && type==='normal';
        const pos = document.createElement('div'); pos.className='pos'; pos.textContent = `R${r+1}C${c+1}`; div.appendChild(pos);
        if(type==='disabled'){
          const name = document.createElement('div'); name.className='name'; name.textContent='空區/禁用'; div.appendChild(name);
        } else if(type==='stage'){
          const name = document.createElement('div'); name.className='name'; name.textContent='講台'; div.appendChild(name);
        } else if(stu){
          const name = document.createElement('div'); name.className='name'; name.textContent = stu.name || '(未命名)'; div.appendChild(name);
          const meta = document.createElement('div'); meta.className='meta';
          const bits = [];
          if(stu.number) bits.push(`學號:${stu.number}`);
          if(stu.group) bits.push(`組:${stu.group}`);
          if(stu.frontBack && stu.frontBack!=='不指定') bits.push(stu.frontBack);
          meta.textContent = bits.join(' ');
          div.appendChild(meta);
          const tags = document.createElement('div'); tags.className='tags';
          if(stu.restrictionTag) { const b=document.createElement('span'); b.className='badge'; b.textContent=stu.restrictionTag; tags.appendChild(b); }
          if(stu.fixedSeat) { const b=document.createElement('span'); b.className='badge'; b.textContent='固定'; tags.appendChild(b); }
          if(locked) { const b=document.createElement('span'); b.className='badge'; b.textContent='鎖定'; tags.appendChild(b); }
          div.appendChild(tags);
          if(stu.note) div.title = stu.note;
        } else {
          const name = document.createElement('div'); name.className='name muted'; name.textContent = locked ? '（鎖定空位）' : '空位'; div.appendChild(name);
        }
        attachSeatEvents(div, k);
        grid.appendChild(div);
      }
    }
  }

  function renderStudentTable(){
    const wrap = $('#studentTableWrap');
    if(!state.students.length){ wrap.innerHTML = '<div class="muted" style="padding:8px">尚無學生資料</div>'; return; }
    let html = '<table><thead><tr><th>學號</th><th>姓名</th><th>性別</th><th>前後</th><th>組別</th><th>固定</th><th>限制</th><th></th></tr></thead><tbody>';
    for(const s of state.students){
      html += `<tr><td>${esc(s.number)}</td><td>${esc(s.name)}</td><td>${esc(s.gender)}</td><td>${esc(s.frontBack||'')}</td><td>${esc(s.group)}</td><td>${esc(s.fixedSeat)}</td><td>${esc(s.restrictionTag)}</td><td><button class="small" data-edit-stu="${s.uid}">編輯</button> <button class="small danger" data-del-stu="${s.uid}">刪</button></td></tr>`;
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
    $$('[data-edit-stu]').forEach(b=>b.addEventListener('click',()=>openStudentModal(b.dataset.editStu)));
    $$('[data-del-stu]').forEach(b=>b.addEventListener('click',()=>{ pushUndo(); removeStudent(b.dataset.delStu); renderAll(); saveState(); }));
  }

  function renderStats(){
    const total = state.students.length;
    const male = state.students.filter(s=>s.gender==='男').length;
    const female = state.students.filter(s=>s.gender==='女').length;
    const other = total - male - female;
    let usable=0, assigned=0;
    for(let r=0;r<state.layout.rows;r++) for(let c=0;c<state.layout.cols;c++){
      const k=cellKey(r,c); if(isSeatCell(k)) { usable++; if(state.seats[k]) assigned++; }
    }
    const pct = n => total? Math.round(n*1000/total)/10 : 0;
    $('#statsBox').innerHTML = `
      <div>全班人數：<b>${total}</b> 人（已入座 ${assigned} / 可用座位 ${usable}）</div>
      <div>男：${male} 人 (${pct(male)}%)　女：${female} 人 (${pct(female)}%)　其他/未填：${other} 人 (${pct(other)}%)</div>
      <div>空位：${Math.max(0, usable-assigned)}　未入座學生：${Math.max(0, total-assigned)}</div>`;
  }

  function renderHistory(){
    const list = $('#historyList');
    if(!state.history.length){ list.innerHTML = '<div class="muted">尚無歷史版本</div>'; return; }
    list.innerHTML = '';
    [...state.history].reverse().forEach(h => {
      const item = document.createElement('div'); item.className='history-item';
      const left = document.createElement('div');
      left.innerHTML = `<div>${esc(h.name||'未命名版本')}</div><div class="meta">${esc(h.time||'')}</div>`;
      const right = document.createElement('div');
      const loadBtn = document.createElement('button'); loadBtn.textContent='載入'; loadBtn.className='small';
      loadBtn.onclick = ()=>{ pushUndo(); applyHistory(h.id); };
      const delBtn = document.createElement('button'); delBtn.textContent='刪除'; delBtn.className='small danger';
      delBtn.onclick = ()=>{ state.history = state.history.filter(x=>x.id!==h.id); saveState(); renderHistory(); };
      right.append(loadBtn, ' ', delBtn);
      item.append(left,right); list.appendChild(item);
    });
  }

  function esc(s){ return String(s??'').replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m])); }

  // ---------- Events ----------
  function attachSeatEvents(el, key){
    el.addEventListener('click', (e)=>{ if(e.shiftKey) return; onSeatClick(key); });
    el.addEventListener('contextmenu', (e)=>{ e.preventDefault(); openContextMenu(e.clientX, e.clientY, key); });
    el.addEventListener('dragstart', (e)=>{ if(!state.seats[key]) { e.preventDefault(); return; } dragSrcKey = key; e.dataTransfer.setData('text/plain', key); });
    el.addEventListener('dragover', (e)=>{ if(dragSrcKey && dragSrcKey!==key && state.layout.cellTypes[key]!=='stage' && state.layout.cellTypes[key]!=='disabled'){ e.preventDefault(); el.classList.add('drag-over'); } });
    el.addEventListener('dragleave', ()=>el.classList.remove('drag-over'));
    el.addEventListener('drop', (e)=>{ e.preventDefault(); el.classList.remove('drag-over'); const src = dragSrcKey || e.dataTransfer.getData('text/plain'); if(src && src!==key) swapSeats(src,key); dragSrcKey=null; });
    el.addEventListener('dragend', ()=>{ dragSrcKey=null; $$('.seat.drag-over').forEach(n=>n.classList.remove('drag-over')); });
  }

  function onSeatClick(key){
    const type = state.layout.cellTypes[key] || 'normal';
    if(type === 'normal'){
      // cycle empty cell types when no student? easier: open quick chooser
      if(!state.seats[key]){
        openCellTypeModal(key);
      } else {
        openSeatStudentModal(key);
      }
    } else {
      openCellTypeModal(key);
    }
  }

  function swapSeats(a,b){
    const ta = state.layout.cellTypes[a]||'normal', tb = state.layout.cellTypes[b]||'normal';
    if(ta!=='normal' || tb!=='normal') return;
    pushUndo();
    const sa = state.seats[a]; const sb = state.seats[b];
    if(sa) state.seats[b]=sa; else delete state.seats[b];
    if(sb) state.seats[a]=sb; else delete state.seats[a];
    // keep locks as properties of cells; swapping keeps lock flags? better to swap nothing about lock except maybe not necessary; keep locks tied to cell
    renderAll(); saveState();
  }

  function openContextMenu(x,y,key){
    const menu = $('#contextMenu');
    const type = state.layout.cellTypes[key]||'normal';
    const hasStu = !!state.seats[key];
    const locked = !!state.locked[key];
    const items = [];
    if(type==='normal'){
      items.push(['指派/編輯學生', ()=>openAssignModal(key)]);
      if(hasStu) items.push(['清空此座位學生', ()=>{ pushUndo(); delete state.seats[key]; renderAll(); saveState(); }]);
      items.push([locked?'解鎖座位':'鎖定座位', ()=>{ pushUndo(); if(locked) delete state.locked[key]; else state.locked[key]=true; renderAll(); saveState(); }]);
    }
    items.push(['設為一般座位', ()=>setCellType(key,'normal')]);
    items.push(['設為講台', ()=>setCellType(key,'stage')]);
    items.push(['設為空區/禁用', ()=>setCellType(key,'disabled')]);
    menu.innerHTML = items.map((it,i)=>`<button data-i="${i}">${esc(it[0])}</button>`).join('');
    $$('button', menu).forEach((b,i)=>b.onclick=()=>{ hideContextMenu(); items[i][1](); });
    menu.style.left = Math.min(x, window.innerWidth-180) + 'px';
    menu.style.top = Math.min(y, window.innerHeight-200) + 'px';
    menu.classList.remove('hidden');
  }
  function hideContextMenu(){ $('#contextMenu').classList.add('hidden'); }

  function setCellType(key,type){
    pushUndo();
    if(type==='normal') delete state.layout.cellTypes[key]; else state.layout.cellTypes[key]=type;
    if(type!=='normal'){ delete state.seats[key]; delete state.locked[key]; }
    renderAll(); saveState();
  }

  // ---------- Modals ----------
  function openModal(title, bodyHtml, footerButtons=[]){
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    const f = $('#modalFooter'); f.innerHTML='';
    footerButtons.forEach(btn=>{
      const b=document.createElement('button'); b.textContent=btn.label; if(btn.className) b.className=btn.className;
      b.onclick = btn.onClick; f.appendChild(b);
    });
    $('#modal').classList.remove('hidden');
  }
  function closeModal(){ $('#modal').classList.add('hidden'); }

  function openCellTypeModal(key){
    const {r,c}=parseCellKey(key);
    openModal(`設定格子 R${r+1}C${c+1}`, `<p>選擇此格類型：</p>`, [
      {label:'一般座位', className:'primary', onClick:()=>{ setCellType(key,'normal'); closeModal(); }},
      {label:'講台', onClick:()=>{ setCellType(key,'stage'); closeModal(); }},
      {label:'空區/禁用', onClick:()=>{ setCellType(key,'disabled'); closeModal(); }},
      {label:'取消', onClick:closeModal}
    ]);
  }

  function openSeatStudentModal(key){
    const stu = getStudent(state.seats[key]); if(!stu) return openAssignModal(key);
    const body = `<div><b>${esc(stu.name||'')}</b>（${esc(stu.number||'')}）</div>
      <div class="muted">性別：${esc(stu.gender||'未填')}　前後：${esc(stu.frontBack||'不指定')}　組別：${esc(stu.group||'-')}</div>
      <div class="muted">備註：${esc(stu.note||'-')}</div>
      <div class="muted">限制：${esc(stu.restrictionTag||'-')}　固定：${esc(stu.fixedSeat||'-')}</div>`;
    openModal('座位學生資訊', body, [
      {label:'編輯學生', className:'primary', onClick:()=>{ closeModal(); openStudentModal(stu.uid); }},
      {label:'更換/指派', onClick:()=>{ closeModal(); openAssignModal(key); }},
      {label:'關閉', onClick:closeModal}
    ]);
  }

  function openAssignModal(key){
    const opts = ['<option value="">（空位）</option>'].concat(state.students.map(s=>`<option value="${s.uid}">${esc(s.number)} ${esc(s.name)}</option>`)).join('');
    const cur = state.seats[key]||'';
    openModal('指派學生到座位', `<label>選擇學生<select id="assignSelect">${opts}</select></label><div class="hint">若該學生原本已在其他座位，將會自動移動。</div>`, [
      {label:'確定', className:'primary', onClick:()=>{ const v=$('#assignSelect').value; pushUndo(); if(v){ // remove from other seat
          for(const k of Object.keys(state.seats)) if(state.seats[k]===v) delete state.seats[k];
          state.seats[key]=v;
        } else { delete state.seats[key]; }
        renderAll(); saveState(); closeModal(); }},
      {label:'取消', onClick:closeModal}
    ]);
    $('#assignSelect').value = cur;
  }

  function openStudentModal(stuUid){
    const s = stuUid ? getStudent(stuUid) : null;
    const isNew = !s;
    const st = s || {number:'',name:'',gender:'',frontBack:'不指定',group:'',note:'',fixedSeat:'',restrictionTag:''};
    const body = `<div class="form-grid">
      <label>學號<input id="eNumber" value="${esc(st.number)}"></label>
      <label>中文名<input id="eName" value="${esc(st.name)}"></label>
      <label>性別<select id="eGender"><option value="">不填</option><option ${st.gender==='男'?'selected':''}>男</option><option ${st.gender==='女'?'selected':''}>女</option><option ${st.gender==='其他'?'selected':''}>其他</option></select></label>
      <label>前後需求<select id="eFrontBack"><option ${st.frontBack==='不指定'?'selected':''}>不指定</option><option ${st.frontBack==='前排'?'selected':''}>前排</option><option ${st.frontBack==='後排'?'selected':''}>後排</option></select></label>
      <label>組別<input id="eGroup" value="${esc(st.group)}"></label>
      <label>固定座位<input id="eFixed" value="${esc(st.fixedSeat)}" placeholder="例: R1C2"></label>
      <label style="grid-column:1/-1">備註<input id="eNote" value="${esc(st.note)}"></label>
      <label style="grid-column:1/-1">限制標記<input id="eRestrict" value="${esc(st.restrictionTag)}" placeholder="例: A!!（相同代碼分開，!越多越遠）"></label>
    </div>`;
    openModal(isNew?'新增學生':'編輯學生', body, [
      {label:'儲存', className:'primary', onClick:()=>{
        const ns = normalizeStudent({
          uid: s? s.uid : undefined,
          number: $('#eNumber').value, name: $('#eName').value, gender: $('#eGender').value,
          frontBack: $('#eFrontBack').value, group: $('#eGroup').value, note: $('#eNote').value,
          fixedSeat: $('#eFixed').value, restrictionTag: $('#eRestrict').value
        });
        if(!ns.name && !ns.number){ alert('請至少輸入學號或姓名'); return; }
        pushUndo();
        if(isNew) state.students.push(ns); else { const i=state.students.findIndex(x=>x.uid===s.uid); if(i>=0) state.students[i]=ns; }
        renderAll(); saveState(); closeModal();
      }},
      {label:'取消', onClick:closeModal}
    ]);
  }

  function removeStudent(uid){
    state.students = state.students.filter(s=>s.uid!==uid);
    for(const k of Object.keys(state.seats)) if(state.seats[k]===uid) delete state.seats[k];
    state.separationRules.forEach(r=>{ r.uids = (r.uids||[]).filter(id=>id!==uid); });
    state.separationRules = state.separationRules.filter(r=> (r.uids||[]).length>1 || r.code);
  }

  function openSeparationRulesModal(){
    const renderRulesBody = () => {
      const stuOpts = state.students.map(s=>`<option value="${s.uid}">${esc((s.number?s.number+' ':'')+s.name)}</option>`).join('');
      let html = `<div class="hint">可設定需分開的學生組合與強度（1=不可相鄰，數字越大越需分遠）。名單中的限制標記（例 A!!）也會自動納入排位。</div>
        <div class="form-grid" style="margin-top:8px">
          <label>選擇學生 A<select id="ruleA">${stuOpts}</select></label>
          <label>選擇學生 B<select id="ruleB">${stuOpts}</select></label>
          <label>分開強度<select id="ruleStr"><option value="1">1 (! 不可相鄰)</option><option value="2">2 (!!)</option><option value="3">3 (!!!)</option></select></label>
          <div style="display:flex;align-items:end"><button id="addRuleBtn">新增規則</button></div>
        </div>
        <div class="rule-list" id="ruleList"></div>`;
      $('#modalBody').innerHTML = html;
      $('#addRuleBtn').onclick = () => {
        const a=$('#ruleA').value, b=$('#ruleB').value, st=parseInt($('#ruleStr').value,10)||1;
        if(!a||!b||a===b){ alert('請選擇兩位不同學生'); return; }
        pushUndo();
        state.separationRules.push({id:uid(), uids:[a,b], strength:st});
        renderAll(); saveState(); openSeparationRulesModal();
      };
      const list = $('#ruleList');
      if(!state.separationRules.length){ list.innerHTML='<div class="muted">尚無手動規則</div>'; return; }
      list.innerHTML = state.separationRules.map(r=>{
        const names = (r.uids||[]).map(id=>{ const s=getStudent(id); return s? esc((s.number?s.number+' ':'')+s.name):'(已刪除)'; }).join('、');
        return `<div class="rule-item"><div>${names || esc(r.code||'群組')} <span class="muted">強度 ${r.strength||1}</span></div><button class="small danger" data-del-rule="${r.id}">刪除</button></div>`;
      }).join('');
      $$('[data-del-rule]').forEach(b=>b.onclick=()=>{ pushUndo(); state.separationRules = state.separationRules.filter(r=>r.id!==b.dataset.delRule); renderAll(); saveState(); openSeparationRulesModal(); });
    };
    openModal('分開規則管理', '<div id="ruleHost"></div>', [{label:'關閉', onClick:closeModal}]);
    renderRulesBody();
  }

  // ---------- Import/Parse ----------
  function parsePasted(text){
    const lines = String(text||'').replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(l=>l.length);
    if(!lines.length) return [];
    const header = lines[0].split(',').map(s=>s.trim());
    const hasHeader = header.some(h=>/學號|姓名|中文名|性別|前後|組別|備註|固定|限制/.test(h));
    const start = hasHeader?1:0;
    const mapIdx = (nameList) => header.findIndex(h=>nameList.some(n=>h.includes(n)));
    let idx = {number:0,name:1,gender:2,frontBack:3,group:4,note:5,fixedSeat:6,restrictionTag:7};
    if(hasHeader){
      idx = {
        number: mapIdx(['學號']), name: mapIdx(['中文名','姓名','名字']), gender: mapIdx(['性別']),
        frontBack: mapIdx(['前後','需求']), group: mapIdx(['組別','分組','組']), note: mapIdx(['備註']),
        fixedSeat: mapIdx(['固定']), restrictionTag: mapIdx(['限制','標記'])
      };
    }
    const out = [];
    for(let i=start;i<lines.length;i++){
      const cols = parseCsvLine(lines[i]);
      const get = (j)=> j>=0 && j<cols.length ? cols[j].trim() : '';
      if(hasHeader){
        out.push(normalizeStudent({number:get(idx.number), name:get(idx.name), gender:get(idx.gender), frontBack:get(idx.frontBack), group:get(idx.group), note:get(idx.note), fixedSeat:get(idx.fixedSeat), restrictionTag:get(idx.restrictionTag)}));
      } else {
        out.push(normalizeStudent({number:get(0), name:get(1), gender:get(2), frontBack:get(3), group:get(4), note:get(5), fixedSeat:get(6), restrictionTag:get(7)}));
      }
    }
    return out.filter(s=>s.name || s.number);
  }
  function parseCsvLine(line){
    const res=[]; let cur=''; let q=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(q){
        if(ch==='"' && line[i+1]==='"'){ cur+='"'; i++; }
        else if(ch==='"'){ q=false; }
        else cur+=ch;
      } else {
        if(ch===','){ res.push(cur); cur=''; }
        else if(ch==='"'){ q=true; }
        else cur+=ch;
      }
    }
    res.push(cur); return res;
  }

  async function importFile(file){
    const name = file.name.toLowerCase();
    if(name.endsWith('.csv') || name.endsWith('.txt')){
      const text = await file.text();
      return parsePasted(text);
    }
    if(name.endsWith('.xlsx') || name.endsWith('.xls')){
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {defval:''});
      return rows.map(r=>normalizeStudent({
        number: r['學號']??r['number']??r['Number']??r['id']??'',
        name: r['中文名']??r['姓名']??r['name']??r['Name']??'',
        gender: r['性別']??r['gender']??'',
        frontBack: r['前後需求']??r['前後']??r['frontBack']??'',
        group: r['組別']??r['分組']??r['group']??'',
        note: r['備註']??r['note']??'',
        fixedSeat: r['固定座位']??r['固定']??r['fixedSeat']??'',
        restrictionTag: r['限制標記']??r['限制']??r['restriction']??''
      })).filter(s=>s.name||s.number);
    }
    throw new Error('不支援的檔案格式');
  }

  function mergeImportedStudents(list, replace=false){
    if(replace) state.students = [];
    const existingKeys = new Set(state.students.map(s=>`${s.number}||${s.name}`));
    for(const s of list){
      const key = `${s.number}||${s.name}`;
      if(!replace && existingKeys.has(key)){
        // update existing
        const ex = state.students.find(x=>`${x.number}||${x.name}`===key);
        Object.assign(ex, s, {uid: ex.uid});
      } else {
        if(!s.uid) s.uid = uid();
        state.students.push(s);
        existingKeys.add(key);
      }
    }
  }

  // ---------- Arrangement ----------
  function getAvailableSeatKeys(){
    return getFillOrderKeys().filter(k => isSeatCell(k));
  }
  function buildSeparationGroups(){
    const groups = [];
    // from manual rules
    for(const r of state.separationRules){ if((r.uids||[]).length>=2) groups.push({uids:[...r.uids], strength: clamp(parseInt(r.strength,10)||1,1,5)}); }
    // from restriction tags
    const byCode = {};
    for(const s of state.students){
      const tag = (s.restrictionTag||'').trim(); if(!tag) continue;
      const m = tag.match(/^(.+?)(!+)$/);
      if(m){ const code=m[1]||'_'; const st=m[2].length; (byCode[code]||(byCode[code]={uids:[], strength:st})).uids.push(s.uid); byCode[code].strength=Math.max(byCode[code].strength, st); }
      else if(/!+$/.test(tag)){ const st=(tag.match(/!+$/)||['!'])[0].length; groups.push({uids:[s.uid], strength:st, solo:true}); }
    }
    for(const code of Object.keys(byCode)){ if(byCode[code].uids.length>=2) groups.push(byCode[code]); }
    return groups;
  }

  function computeArrangement(){
    const {rows, cols} = state.layout;
    const frontRows = clamp(parseInt(state.settings.frontRows,10)||0,0,rows);
    const backRows = clamp(parseInt(state.settings.backRows,10)||0,0,rows);
    const available = getAvailableSeatKeys();
    const availableSet = new Set(available);
    const groups = buildSeparationGroups();

    // keep locked cells as-is, clear others
    const newSeats = {};
    const occupied = new Set();
    for(const k of available){
      if(state.locked[k] && state.seats[k] && getStudent(state.seats[k])){ newSeats[k]=state.seats[k]; occupied.add(state.seats[k]); }
    }
    // fixed seat assignments for unplaced students
    const unplaced = state.students.filter(s=>!occupied.has(s.uid));
    for(const s of [...unplaced]){
      const fk = fixedSeatToKey(s.fixedSeat);
      if(fk && availableSet.has(fk) && !newSeats[fk] && !state.locked[fk]){
        newSeats[fk]=s.uid; occupied.add(s.uid);
      }
    }
    const remainingStudents = state.students.filter(s=>!occupied.has(s.uid));

    // base ordering
    let base = [...remainingStudents];
    const mode = state.settings.mode;
    const numVal = v => { const n=parseFloat(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n)? null : n; };
    const cmpStr = (a,b)=>String(a||'').localeCompare(String(b||''),'zh-Hant');
    if(mode==='id_asc') base.sort((a,b)=>{ const na=numVal(a.number), nb=numVal(b.number); if(na!=null&&nb!=null&&na!==nb) return na-nb; return cmpStr(a.number,b.number)||cmpStr(a.name,b.name); });
    else if(mode==='id_desc') base.sort((a,b)=>{ const na=numVal(a.number), nb=numVal(b.number); if(na!=null&&nb!=null&&na!==nb) return nb-na; return cmpStr(b.number,a.number)||cmpStr(b.name,a.name); });
    else if(mode==='name_asc') base.sort((a,b)=>cmpStr(a.name,b.name)||cmpStr(a.number,b.number));
    else if(mode==='name_desc') base.sort((a,b)=>cmpStr(b.name,a.name)||cmpStr(b.number,a.number));
    else base = shuffle(base);

    // prioritize constrained students first (front/back, in separation groups, in groups) while keeping relative base order
    const sepUidSet = new Set(groups.flatMap(g=>g.uids||[]));
    base.sort((a,b)=>{
      const sa = (a.frontBack!=='不指定'?2:0) + (sepUidSet.has(a.uid)?1:0) + (a.group?1:0);
      const sb = (b.frontBack!=='不指定'?2:0) + (sepUidSet.has(b.uid)?1:0) + (b.group?1:0);
      return sb - sa;
    });

    const freeKeys = getFillOrderKeys().filter(k=>availableSet.has(k) && !newSeats[k]);

    for(const stu of base){
      let bestKey = null, bestScore = Infinity;
      for(const k of freeKeys){
        if(newSeats[k]) continue;
        const score = seatScore(stu, k, newSeats, {rows,cols,frontRows,backRows,groups});
        if(score < bestScore){ bestScore = score; bestKey = k; }
      }
      if(bestKey){ newSeats[bestKey]=stu.uid; }
    }
    return newSeats;
  }

  function arrangeSeats(){
    pushUndo();
    state.seats = computeArrangement();
    renderAll(); saveState();
  }

  function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

  function neighbors8(k, rows, cols){
    const {r,c}=parseCellKey(k); const res=[];
    for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){ if(!dr&&!dc) continue; const nr=r+dr,nc=c+dc; if(nr>=0&&nr<rows&&nc>=0&&nc<cols) res.push(cellKey(nr,nc)); }
    return res;
  }
  function manhattan(a,b){ const pa=parseCellKey(a), pb=parseCellKey(b); return Math.abs(pa.r-pb.r)+Math.abs(pa.c-pb.c); }

  function seatScore(stu, key, seats, ctx){
    const {rows, frontRows, backRows, groups} = ctx;
    const {r} = parseCellKey(key);
    let score = 0;
    // front/back preference
    if(stu.frontBack==='前排'){
      const limit = Math.max(0, frontRows-1);
      if(r > limit) score += 1000 + (r-limit)*50;
    } else if(stu.frontBack==='後排'){
      const start = Math.max(0, rows-backRows);
      if(r < start) score += 1000 + (start-r)*50;
    }
    // separation groups
    for(const g of groups){
      if(!(g.uids||[]).includes(stu.uid)) continue;
      const strength = clamp(parseInt(g.strength,10)||1,1,5);
      for(const otherUid of g.uids){ if(otherUid===stu.uid) continue; const otherKey = findSeatByStudent(seats, otherUid); if(!otherKey) continue; 
        const d = manhattan(key, otherKey);
        const minD = strength; // 1 => must not be adjacent (dist>=2 preferred), higher => farther
        if(d <= 1) score += 5000 * strength;
        else if(d <= minD) score += (minD - d + 1) * 800 * strength;
        else score += Math.max(0, (3 - d)) * 20 * strength;
      }
    }
    // group mixing: avoid same group adjacent, spread
    if(state.settings.groupMix && stu.group){
      let sameAdj=0, sameTotal=0, groupCount=0;
      for(const nk of neighbors8(key, ctx.rows, ctx.cols)){
        const ouid = seats[nk]; if(!ouid) continue; const o=getStudent(ouid); if(o && o.group===stu.group) sameAdj++;
      }
      score += sameAdj * 400;
      // spread: penalize if many of same group already in same row half? simple: distance to center of same group members
      const placed = [];
      for(const [sk,uid] of Object.entries(seats)){ const o=getStudent(uid); if(o && o.group===stu.group) placed.push(sk); }
      if(placed.length){
        const avg = placed.reduce((acc,pk)=>{ const p=parseCellKey(pk); acc.r+=p.r; acc.c+=p.c; return acc; }, {r:0,c:0});
        avg.r/=placed.length; avg.c/=placed.length; const p=parseCellKey(key); const dist = Math.abs(p.r-avg.r)+Math.abs(p.c-avg.c);
        score += Math.max(0, 3 - dist) * 30; // encourage farther
      }
    }
    // gender mixing
    if(state.settings.genderMix && stu.gender && (stu.gender==='男'||stu.gender==='女')){
      let sameAdj=0, oppAdj=0;
      for(const nk of neighbors8(key, ctx.rows, ctx.cols)){
        const ouid = seats[nk]; if(!ouid) continue; const o=getStudent(ouid); if(!o||!o.gender) continue;
        if(o.gender===stu.gender) sameAdj++; else if((o.gender==='男'||o.gender==='女') && o.gender!==stu.gender) oppAdj++;
      }
      score += sameAdj * 120 - oppAdj * 30;
    }
    return score;
  }
  function findSeatByStudent(seats, uid){ for(const [k,v] of Object.entries(seats)) if(v===uid) return k; return null; }

  // ---------- History versions ----------
  function saveHistoryVersion(){
    const name = prompt('輸入版本名稱（可留空）', `版本 ${new Date().toLocaleString('zh-TW')}`);
    if(name===null) return;
    const snapshot = { layout: deepClone(state.layout), students: deepClone(state.students), seats: deepClone(state.seats), locked: deepClone(state.locked), settings: deepClone(state.settings), separationRules: deepClone(state.separationRules) };
    state.history.push({id:uid(), name: name || `版本 ${state.history.length+1}`, time: new Date().toLocaleString('zh-TW'), snapshot});
    if(state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
    saveState(); renderHistory();
  }
  function applyHistory(id){
    const h = state.history.find(x=>x.id===id); if(!h) return;
    restoreSnapshot(h.snapshot);
    renderAll(); saveState();
  }

  // ---------- Export/Import ----------
  function downloadBlob(blob, filename){ const a=document.createElement('a'); const url=URL.createObjectURL(blob); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 0); }
  function getSampleRows(){
    return [
      ['學號','中文名','性別','前後需求','組別','備註','固定座位','限制標記'],
      ['1','王小明','男','前排','1','需要靠近黑板','',''],
      ['2','李小華','女','不指定','1','','','A!!'],
      ['3','陳大文','男','後排','2','','','A!!'],
      ['4','林怡君','女','不指定','2','','',''],
      ['5','張志豪','男','不指定','3','','','B!'],
      ['6','黃雅婷','女','前排','3','','','B!'],
      ['7','吳冠廷','男','不指定','4','','',''],
      ['8','蔡佩珊','女','後排','4','','',''],
      ['9','劉承翰','男','不指定','1','','',''],
      ['10','許家瑜','女','不指定','2','','',''],
      ['11','楊宗憲','男','不指定','3','','',''],
      ['12','鄭心妤','女','不指定','4','','','']
    ];
  }
  function downloadSampleCSV(){
    const rows = getSampleRows();
    const csv = rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
    downloadBlob(new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'}), '學生名單範例.csv');
  }
  function downloadSampleExcel(){
    if(typeof XLSX === 'undefined'){ alert('Excel 範例功能需要連網載入元件，請確認網路連線後再試。'); return; }
    const rows = getSampleRows();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '學生名單');
    XLSX.writeFile(wb, '學生名單範例.xlsx');
  }
  function exportJSON(){
    const data = { version:1, exportedAt: new Date().toISOString(), state: {layout:state.layout, students:state.students, seats:state.seats, locked:state.locked, settings:state.settings, separationRules:state.separationRules, history:state.history} };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}), 'seating-plan.json');
  }
  function importJSONFile(file){
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const s = data.state || data;
        pushUndo();
        state = mergeDefaults(defaultState(), s);
        ensureLayoutBounds();
        renderAll(); saveState();
        alert('已匯入 JSON 設定');
      } catch(e){ alert('匯入失敗：' + e.message); }
    };
    reader.readAsText(file);
  }
  function exportCSV(){
    const header = ['學號','中文名','性別','前後需求','組別','備註','固定座位','限制標記'];
    const rows = state.students.map(s=>[s.number,s.name,s.gender,s.frontBack,s.group,s.note,s.fixedSeat,s.restrictionTag]);
    const csv = [header, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
    downloadBlob(new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'}), 'students.csv');
  }
  async function exportPNG(){
    const area = $('#captureArea');
    const canvas = await html2canvas(area, {backgroundColor: getComputedStyle(document.body).getPropertyValue('--card') || '#fff', scale:2});
    canvas.toBlob(blob=>{ if(blob) downloadBlob(blob,'seating-plan.png'); });
  }

  // ---------- Arrange animation, zoom & fullscreen ----------
  const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
  function setArranging(on, msg=''){
    const status = $('#arrangeStatus');
    if(status){ status.textContent = msg || '🎲 抽號中，正在為同學安排座位...'; status.classList.toggle('hidden', !on); }
    const btn = $('#arrangeBtn');
    if(btn){ btn.disabled = !!on; btn.textContent = on ? '抽號中...' : '🎲 抽號編排座位'; }
  }
  function setBoardZoom(on){
    const card = $('#captureArea');
    if(!card) return;
    const next = (typeof on === 'boolean') ? on : !card.classList.contains('zoomed');
    card.classList.toggle('zoomed', next);
    const btn = $('#zoomToggleBtn');
    if(btn) btn.textContent = next ? '還原大小' : '放大座位圖';
    updateBoardLayoutMode();
  }
  async function toggleFullscreen(){
    const card = $('#captureArea');
    if(!card) return;
    try {
      if(document.fullscreenElement){
        await document.exitFullscreen();
      } else if(card.requestFullscreen){
        await card.requestFullscreen();
      } else if(card.webkitRequestFullscreen){
        card.webkitRequestFullscreen();
      }
    } catch(e){ console.warn('fullscreen failed', e); }
  }
  function updateFullscreenButton(){
    const btn = $('#fullscreenBtn');
    if(!btn) return;
    const active = !!document.fullscreenElement;
    btn.textContent = active ? '退出全螢幕' : '全螢幕';
    updateBoardLayoutMode();
  }
  async function animateAndArrange(){
    let undoPushed = false;
    try {
      if(!state.students.length){ alert('請先匯入或新增學生名單'); return; }
      const finalSeats = computeArrangement();
      pushUndo();
      undoPushed = true;
      const kept = {};
      const available = getAvailableSeatKeys();
      for(const k of available){ if(state.locked[k] && state.seats[k] && getStudent(state.seats[k])) kept[k]=state.seats[k]; }
      const animCells = available.filter(k=>!kept[k]);
      const pool = state.students.map(s=>s.uid);
      setArranging(true);
      const rounds = 14;
      for(let i=0;i<rounds;i++){
        const temp = {...kept};
        const shuffledIds = shuffle(pool);
        let idx = 0;
        for(const k of animCells){ if(idx < shuffledIds.length) temp[k]=shuffledIds[idx++]; }
        state.seats = temp;
        renderBoard(); renderStats();
        $$('#seatGrid .seat').forEach(el=>{ if(animCells.includes(el.dataset.key)) el.classList.add('shuffling'); });
        await sleep(90);
      }
      state.seats = finalSeats;
      renderAll();
      $$('#seatGrid .seat').forEach(el=>{ if(el.dataset.key && finalSeats[el.dataset.key]) el.classList.add('pop-in'); });
      saveState();
      setBoardZoom(true);
      const card = $('#captureArea');
      if(card) card.scrollIntoView({behavior:'smooth', block:'start'});
    } catch(e){
      console.error(e);
      if(undoPushed && undoStack.length){
        const prev = undoStack.pop(); redoStack = []; restoreSnapshot(prev); renderAll(); saveState(); updateUndoRedoButtons();
      }
      alert('編排失敗：'+e.message);
    }
    finally { setArranging(false); }
  }

  // ---------- Init & bindings ----------
  function bind(){
    document.addEventListener('click', (e)=>{ if(!e.target.closest('#contextMenu')) hideContextMenu(); });
    window.addEventListener('scroll', hideContextMenu, true);
    $('#modalClose').onclick = closeModal;
    $('#modal').addEventListener('click', (e)=>{ if(e.target.id==='modal') closeModal(); });

    $('#rowsInput').addEventListener('change', e=>{ pushUndo(); state.layout.rows = clamp(parseInt(e.target.value,10)||1,1,20); ensureLayoutBounds(); renderAll(); saveState(); });
    $('#colsInput').addEventListener('change', e=>{ pushUndo(); state.layout.cols = clamp(parseInt(e.target.value,10)||1,1,20); ensureLayoutBounds(); renderAll(); saveState(); });
    $('#teacherDeskPos').addEventListener('change', e=>{ pushUndo(); state.layout.teacherDesk = e.target.value; renderAll(); saveState(); });
    $('#showTeacherDesk').addEventListener('change', e=>{ pushUndo(); state.layout.showTeacherDesk = e.target.checked; renderAll(); saveState(); });
    $('#showBlackboard').addEventListener('change', e=>{ pushUndo(); state.layout.showBlackboard = e.target.checked; renderAll(); saveState(); });

    $('#modeSelect').addEventListener('change', e=>{ state.settings.mode = e.target.value; saveState(); });
    $('#fillOrderSelect').addEventListener('change', e=>{ state.settings.fillOrder = e.target.value; saveState(); });
    $('#frontRows').addEventListener('change', e=>{ state.settings.frontRows = clamp(parseInt(e.target.value,10)||0,0,20); saveState(); });
    $('#backRows').addEventListener('change', e=>{ state.settings.backRows = clamp(parseInt(e.target.value,10)||0,0,20); saveState(); });
    $('#genderMix').addEventListener('change', e=>{ state.settings.genderMix = e.target.checked; saveState(); });
    $('#groupMix').addEventListener('change', e=>{ state.settings.groupMix = e.target.checked; saveState(); });

    $$('#nameTabs .tab').forEach(tab=>tab.addEventListener('click', ()=>{
      $$('#nameTabs .tab').forEach(t=>t.classList.remove('active'));
      $$('.tab-pane').forEach(p=>p.classList.remove('active'));
      tab.classList.add('active'); $(`.tab-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
    }));

    $('#importPasteBtn').onclick = ()=>{ const list=parsePasted($('#pasteInput').value); if(!list.length){ alert('未解析到有效名單'); return; } pushUndo(); mergeImportedStudents(list,false); renderAll(); saveState(); alert(`已匯入 ${list.length} 筆`); };
    $('#importFileBtn').onclick = async ()=>{ const f=$('#fileInput').files[0]; if(!f){ alert('請選擇檔案'); return; } try{ const list=await importFile(f); if(!list.length){ alert('未解析到有效名單'); return; } pushUndo(); mergeImportedStudents(list,false); renderAll(); saveState(); alert(`已匯入 ${list.length} 筆`);}catch(e){ alert('匯入失敗：'+e.message); } };
    const bindSampleBtn = (id, fn) => { const el = $(id); if(el) el.onclick = fn; };
    bindSampleBtn('#downloadSampleCsvBtn', downloadSampleCSV);
    bindSampleBtn('#downloadSampleCsvBtn2', downloadSampleCSV);
    bindSampleBtn('#downloadSampleExcelBtn', downloadSampleExcel);
    bindSampleBtn('#downloadSampleExcelBtn2', downloadSampleExcel);
    $('#addStudentBtn').onclick = ()=>{ const s=normalizeStudent({number:$('#mNumber').value,name:$('#mName').value,gender:$('#mGender').value,frontBack:$('#mFrontBack').value,group:$('#mGroup').value,note:$('#mNote').value,fixedSeat:$('#mFixed').value,restrictionTag:$('#mRestrict').value}); if(!s.name&&!s.number){ alert('請至少輸入學號或姓名'); return;} pushUndo(); state.students.push(s); ['#mNumber','#mName','#mGroup','#mNote','#mFixed','#mRestrict'].forEach(id=>$(id).value=''); $('#mGender').value=''; $('#mFrontBack').value='不指定'; renderAll(); saveState(); };
    $('#clearStudentsBtn').onclick = ()=>{ if(!confirm('確定清空名單與座位安排？')) return; pushUndo(); state.students=[]; state.seats={}; state.locked={}; state.separationRules=[]; renderAll(); saveState(); };

    $('#arrangeBtn').onclick = ()=>{ animateAndArrange(); };
    $('#clearSeatsBtn').onclick = ()=>{ pushUndo(); state.seats={}; renderAll(); saveState(); };
    $('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
    $('#exportPngBtn').onclick = ()=>exportPNG().catch(e=>alert('匯出失敗：'+e.message));
    $('#printBtn').onclick = ()=>window.print();
    $('#exportJsonBtn').onclick = exportJSON;
    $('#importJsonBtn').onclick = ()=>$('#jsonFileInput').click();
    $('#jsonFileInput').addEventListener('change', e=>{ const f=e.target.files[0]; if(f) importJSONFile(f); e.target.value=''; });
    $('#exportCsvBtn').onclick = exportCSV;
    $('#saveHistoryBtn').onclick = saveHistoryVersion;
    $('#separationRulesBtn').onclick = openSeparationRulesModal;
    $('#darkModeBtn').onclick = ()=>{ state.settings.darkMode = !state.settings.darkMode; renderAll(); saveState(); };
    const zoomBtn = $('#zoomToggleBtn'); if(zoomBtn) zoomBtn.onclick = ()=>setBoardZoom();
    const fsBtn = $('#fullscreenBtn'); if(fsBtn) fsBtn.onclick = ()=>toggleFullscreen();
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    const fontRange = $('#seatFontRange');
    if(fontRange){
      fontRange.addEventListener('input', e=>{
        state.settings.seatFontScale = clamp(parseInt(e.target.value,10)||100, 85, 150);
        applySeatFontScale();
        saveState();
      });
    }
    updateFullscreenButton();
  }

  ensureLayoutBounds();
  bind();
  renderAll();
  saveState();
})();