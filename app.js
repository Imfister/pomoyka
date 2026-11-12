'use strict';

// Данные — только в IndexedDB на данном устройстве. Никакого сетевого API.
const DB_NAME = 'pomoyka-local';
const DB_VERSION = 2;
const ENTRY_STORE = 'entries';
const BLOB_STORE = 'blobs';
const LABELS = {link:'Ссылка', image:'Фото', video:'Видео', text:'Текст', file:'Файл'};
const ICONS = {
  link: '<path d="M10 13.5l4-4M8.5 16.25H7a4.5 4.5 0 0 1 0-9h3M15.5 7.75H17a4.5 4.5 0 0 1 0 9h-3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.6" r="1.7"/><path d="M4 17l5.1-5 4.2 3.8 2.2-2.1 4.5 4.7"/>',
  video: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M3 7l1-4h16l1 4M9 3l-2 4m8-4l-2 4M3 11h18"/>',
  text: '<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14.5 3v5h4.5M8.5 12h7M8.5 16h5"/>',
  file: '<path d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5"/>'
};

const $ = id => document.getElementById(id);
const state = {db:null, entries:[], mode:'home', searching:false, currentId:null, renameId:null};
let thumbUrls = [];
let viewerUrl = null;
let toastTimeout;
let renderCounter = 0;
let openSwipeRow=null;

function newId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now()+'-'+Math.random().toString(36).slice(2);
}
function svgFor(type) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');
  svg.setAttribute('aria-hidden','true');
  // Содержимое берётся исключительно из фиксированных констант нашего кода.
  svg.innerHTML = ICONS[type] || ICONS.file;
  return svg;
}
function getErrorMessage(error) {
  if (error?.name === 'QuotaExceededError') return 'Не хватает доступного места для хранения файла.';
  return 'Не удалось сохранить данные. Проверь свободное место на iPhone.';
}
function showToast(message) {
  const t=$('toast');
  t.textContent=message;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout=setTimeout(()=>t.classList.remove('show'),3400);
}
function openDB() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=event=>{
      const database=request.result;
      const transaction=request.transaction;
      if (!database.objectStoreNames.contains(ENTRY_STORE)) database.createObjectStore(ENTRY_STORE,{keyPath:'id'});
      if (!database.objectStoreNames.contains(BLOB_STORE)) database.createObjectStore(BLOB_STORE,{keyPath:'id'});
      // Перенос вложений из возможной ранней версии, чтобы они не пропали при обновлении.
      if (event.oldVersion>0 && event.oldVersion<2) {
        const entries=transaction.objectStore(ENTRY_STORE);
        const blobs=transaction.objectStore(BLOB_STORE);
        const cursorRequest=entries.openCursor();
        cursorRequest.onsuccess=()=>{
          const cursor=cursorRequest.result;
          if (!cursor) return;
          const record=cursor.value;
          if (record.file instanceof Blob) {
            const attachment=record.file;
            blobs.put({id:record.id,blob:attachment});
            record.originalName=record.originalName || attachment.name || '';
            record.mime=attachment.type || '';
            record.size=attachment.size || 0;
            delete record.file;
            cursor.update(record);
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('База данных занята другой вкладкой'));
  });
}
function txRun(storeNames,mode,callback) {
  return new Promise((resolve,reject)=>{
    const tx=state.db.transaction(storeNames,mode);
    let req;
    try {req=callback(tx);} catch(error) {tx.abort();reject(error);return;}
    tx.oncomplete=()=>resolve(req?.result);
    tx.onerror=()=>reject(tx.error||new Error('Ошибка IndexedDB'));
    tx.onabort=()=>reject(tx.error||new Error('Операция прервана'));
  });
}
const readAll=()=>txRun([ENTRY_STORE],'readonly',tx=>tx.objectStore(ENTRY_STORE).getAll());
const readBlob=id=>txRun([BLOB_STORE],'readonly',tx=>tx.objectStore(BLOB_STORE).get(id)).then(row=>row?.blob||null);
function saveRecord(entry,blob) {
  return txRun([ENTRY_STORE,BLOB_STORE],'readwrite',tx=>{
    tx.objectStore(ENTRY_STORE).put(entry);
    if (blob) tx.objectStore(BLOB_STORE).put({id:entry.id,blob});
  });
}
function renameRecord(id,title) {
  return txRun([ENTRY_STORE],'readwrite',tx=>{
    const store=tx.objectStore(ENTRY_STORE);
    const request=store.get(id);
    request.onsuccess=()=>{if(request.result){request.result.title=title;store.put(request.result);}};
  });
}
function deleteRecords(ids) {
  return txRun([ENTRY_STORE,BLOB_STORE],'readwrite',tx=>{
    const entries=tx.objectStore(ENTRY_STORE),blobs=tx.objectStore(BLOB_STORE);
    ids.forEach(id=>{entries.delete(id);blobs.delete(id);});
  });
}
function clearAllRecords() {
  return txRun([ENTRY_STORE,BLOB_STORE],'readwrite',tx=>{
    tx.objectStore(ENTRY_STORE).clear();tx.objectStore(BLOB_STORE).clear();
  });
}

function recordName(entry) {
  return entry.title || entry.originalName || (entry.type==='link'?(entry.text||entry.content):'') ||
    (entry.type==='text'?String(entry.text||entry.content||'').trim().split('\n')[0].slice(0,70):'') || 'Без названия';
}
function recordText(entry){return entry.text ?? entry.content ?? '';}
function timeLabel(timestamp) {
  const date=new Date(timestamp), now=new Date();
  const midnight=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const clock=date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  if (timestamp>=midnight) return 'Сегодня, '+clock;
  if (timestamp>=midnight-86400000) return 'Вчера, '+clock;
  return date.toLocaleDateString('ru-RU')+', '+clock;
}
function releaseThumbs() {thumbUrls.forEach(u=>URL.revokeObjectURL(u));thumbUrls=[];}
function releaseViewer() {if(viewerUrl){URL.revokeObjectURL(viewerUrl);viewerUrl=null;}}
function closeDialog(id) {const dialog=$(id);if(dialog.open) dialog.close();}
function showDialog(id) {const dialog=$(id);if(!dialog.open)dialog.showModal();}

async function refresh() {
  state.entries=(await readAll()).sort((a,b)=>b.created-a.created||String(b.id).localeCompare(String(a.id)));
  render();
}
function render() {
  openSwipeRow=null;
  releaseThumbs();
  const serial=++renderCounter;
  const term=$('searchInput').value.trim().toLocaleLowerCase('ru-RU');
  const mode=state.mode;
  const inCategory=!['home','all'].includes(mode);
  let list=state.entries.filter(record=>(!inCategory||record.type===mode));
  if(term)list=list.filter(record=>[recordName(record),record.originalName,recordText(record)].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(term)));
  const limit=mode==='home'&&!term?4:Infinity;
  const visible=list.slice(0,limit);
  $('listTitle').textContent=mode==='home'?(term?'Результаты поиска':'Последние добавления'):mode==='all'?'Все добавления':mode==='file'?'Другие файлы':({link:'Ссылки',image:'Фото',video:'Видео',text:'Текст'})[mode];
  $('searchInput').placeholder=({link:'Поиск по ссылкам',image:'Поиск по фото',video:'Поиск по видео'})[mode] || 'Поиск по записям';
  $('backButton').classList.toggle('hidden',mode==='home');
  $('clearCategoryButton').classList.toggle('hidden',!inCategory||!state.entries.some(r=>r.type===mode));
  $('moreButton').classList.toggle('hidden',!(mode==='home'&&!term&&list.length>4));
  $('moreButton').textContent=`Ещё (${list.length-4})`;
  const extra=state.entries.filter(e=>e.type==='file').length;
  $('otherFilesButton').classList.toggle('hidden',extra===0);
  $('otherCount').textContent=extra;
  document.querySelectorAll('.category').forEach(btn=>btn.classList.toggle('active',btn.dataset.category===mode));

  const container=$('entries');container.replaceChildren();
  if(!visible.length){const p=document.createElement('p');p.className='empty';if(term||inCategory){p.textContent=term?'Ничего не найдено.':'Здесь пока пусто.';}else{p.append(document.createTextNode('Помойка пустая.'),document.createElement('br'),document.createTextNode('Добавьте что-нибудь.'));}container.append(p);return;}
  for(const entry of visible){
    const row=document.createElement('article');row.className='entry';
    const slide=document.createElement('div');slide.className='entry-slide';
    const swipeDelete=document.createElement('button');swipeDelete.type='button';swipeDelete.className='swipe-delete';
    swipeDelete.setAttribute('aria-label','Удалить: '+recordName(entry));swipeDelete.title='Удалить запись';
    swipeDelete.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6m4-6v6"/></svg>';
    swipeDelete.addEventListener('click',()=>deleteSwipedEntry(entry.id,row));
    const main=document.createElement('button');main.type='button';main.className='entry-main';main.setAttribute('aria-label','Открыть: '+recordName(entry));
    main.addEventListener('click',()=>{
      if(row.classList.contains('swipe-open')){closeSwipeRow(row);return;}
      openViewer(entry.id);
    });
    const thumb=document.createElement('div');thumb.className='entry-thumb';
    if(entry.type==='image'&&entry.thumbnail instanceof Blob){
      const img=document.createElement('img');const url=URL.createObjectURL(entry.thumbnail);thumbUrls.push(url);img.src=url;img.alt='';thumb.append(img);
    } else {
      thumb.append(svgFor(entry.type));
      // Вложение ранней версии без миниатюры — всё равно показываем само фото.
      if(entry.type==='image') readBlob(entry.id).then(blob=>{
        if(blob&&serial===renderCounter&&thumb.isConnected){const url=URL.createObjectURL(blob);thumbUrls.push(url);const img=document.createElement('img');img.src=url;img.alt='';thumb.replaceChildren(img);}
      }).catch(()=>{});
    }
    const info=document.createElement('div');info.className='entry-info';
    const name=document.createElement('div');name.className='entry-name';name.textContent=recordName(entry);
    const meta=document.createElement('div');meta.className='entry-meta';meta.textContent=`${LABELS[entry.type]||'Файл'} · ${timeLabel(entry.created)}`;
    info.append(name,meta);main.append(thumb,info);
    const options=document.createElement('button');options.type='button';options.className='entry-options';options.textContent='⋯';options.setAttribute('aria-label','Действия с записью: '+recordName(entry));options.addEventListener('click',()=>openItemMenu(entry.id));
    slide.append(main,options);
    row.append(swipeDelete,slide);
    bindEntrySwipe(row,slide,entry.id);
    container.append(row);
  }
}
// iPhone: свайп влево показывает мусорку, до левого края — удаляет.
const SWIPE_ACTION_WIDTH=62;
function closeSwipeRow(row,animate=true){
  if(!row)return;
  const slide=row.querySelector('.entry-slide');
  if(!slide)return;
  slide.style.transition=animate?'transform .20s ease':'none';
  slide.style.transform='translate3d(0,0,0)';
  row.classList.remove('swipe-open');
  if(openSwipeRow===row)openSwipeRow=null;
}
function revealSwipeRow(row){
  if(openSwipeRow && openSwipeRow!==row)closeSwipeRow(openSwipeRow);
  const slide=row.querySelector('.entry-slide');
  slide.style.transition='transform .20s ease';
  slide.style.transform=`translate3d(-${SWIPE_ACTION_WIDTH}px,0,0)`;
  row.classList.add('swipe-open');
  openSwipeRow=row;
}
async function deleteSwipedEntry(id,row){
  if(row.dataset.deleting==='1')return;
  if(!state.entries.some(entry=>entry.id===id))return;
  row.dataset.deleting='1';
  const slide=row.querySelector('.entry-slide');
  slide.style.transition='transform .18s ease-out';
  slide.style.transform=`translate3d(-${row.getBoundingClientRect().width}px,0,0)`;
  try{
    await deleteRecords([id]);
    await new Promise(resolve=>setTimeout(resolve,180));
    await refresh();
    showToast('Запись удалена');
  }catch(error){
    row.dataset.deleting='0';
    closeSwipeRow(row);
    showToast('Не удалось удалить запись');
  }
}
function bindEntrySwipe(row,slide,id){
  let gesture=null;
  let suppressClickUntil=0;
  row.addEventListener('click',event=>{
    // iOS может послать click вслед за свайпом: не открываем запись случайно.
    if(Date.now()<suppressClickUntil && event.target.closest('.entry-slide')){
      event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  row.addEventListener('touchstart',event=>{
    if(event.touches.length!==1 || event.target.closest('.swipe-delete'))return;
    const finger=event.touches[0];
    if(openSwipeRow && openSwipeRow!==row)closeSwipeRow(openSwipeRow);
    gesture={x:finger.clientX,y:finger.clientY,lastX:finger.clientX,
      axis:null,startOpen:row.classList.contains('swipe-open'),
      base:row.classList.contains('swipe-open')?-SWIPE_ACTION_WIDTH:0};
  },{passive:true});
  row.addEventListener('touchmove',event=>{
    if(!gesture || event.touches.length!==1 || row.dataset.deleting==='1')return;
    const finger=event.touches[0];
    const dx=finger.clientX-gesture.x,dy=finger.clientY-gesture.y;
    gesture.lastX=finger.clientX;
    if(!gesture.axis){
      if(Math.abs(dx)<9 && Math.abs(dy)<9)return;
      gesture.axis=Math.abs(dx)>Math.abs(dy)*1.2?'horizontal':'vertical';
    }
    if(gesture.axis!=='horizontal')return;
    event.preventDefault();
    suppressClickUntil=Date.now()+450;
    slide.style.transition='none';
    const position=Math.max(-row.clientWidth,Math.min(0,gesture.base+dx));
    slide.style.transform=`translate3d(${position}px,0,0)`;
  },{passive:false});
  row.addEventListener('touchend',event=>{
    if(!gesture)return;
    const g=gesture;gesture=null;
    if(g.axis!=='horizontal')return;
    const finishX=event.changedTouches[0]?.clientX ?? g.lastX;
    const dx=finishX-g.x;
    const nearLeftEdge=finishX<=Math.max(36,window.innerWidth*.10);
    const fullDistance=dx<=-row.clientWidth*.78;
    const reachedEdge=nearLeftEdge && dx<=-Math.min(105,row.clientWidth*.30);
    if(fullDistance||reachedEdge){
      deleteSwipedEntry(id,row);
    }else if(dx>20){
      closeSwipeRow(row);
    }else if(dx<-35 || (g.startOpen && dx>-25)){
      revealSwipeRow(row);
    }else{
      closeSwipeRow(row);
    }
  },{passive:true});
  row.addEventListener('touchcancel',()=>{
    if(!gesture)return;
    gesture=null;
    if(row.classList.contains('swipe-open'))revealSwipeRow(row);
    else closeSwipeRow(row);
  },{passive:true});
}

function setMode(mode) {
  state.mode=mode;
  if(mode==='home'){$('searchInput').value='';$('searchWrap').classList.add('hidden');}
  render();
}
function detectTextType(value) {
  const trimmed=value.trim();
  try {const url=new URL(trimmed);if((url.protocol==='https:'||url.protocol==='http:')&&!/\s/.test(trimmed)) return 'link';}catch{}
  return 'text';
}
async function saveText(value,title='') {
  const text=value.trim();
  if(!text){showToast('Пустую запись сохранять нечего.');return false;}
  const type=detectTextType(text);
  await saveRecord({id:newId(),created:Date.now(),type,title:title.trim(),text,originalName:'',mime:'',size:0,thumbnail:null});
  await refresh();showToast(type==='link'?'Ссылка сохранена':'Текст сохранён');return true;
}
function classifyFile(file) {
  const mime=(file.type||'').toLocaleLowerCase();
  const name=(file.name||'').toLocaleLowerCase();
  if(mime.startsWith('image/')||/\.(heic|heif|jpg|jpeg|png|webp|gif|bmp|avif)$/i.test(name))return 'image';
  if(mime.startsWith('video/')||/\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(name))return 'video';
  if(mime.startsWith('text/')||/\.(txt|md|csv|json|xml|log)$/i.test(name))return 'text';
  return 'file';
}
function imageThumbnail(blob) {
  return new Promise(resolve=>{
    const url=URL.createObjectURL(blob),image=new Image();
    image.onload=()=>{
      try {
        const w=image.naturalWidth,h=image.naturalHeight;
        if(!w||!h){resolve(null);return;}
        const scale=Math.min(1,400/Math.max(w,h));
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
        canvas.getContext('2d',{alpha:false}).drawImage(image,0,0,canvas.width,canvas.height);
        canvas.toBlob(result=>{URL.revokeObjectURL(url);resolve(result)},'image/jpeg',.78);
      }catch{URL.revokeObjectURL(url);resolve(null);}
    };
    image.onerror=()=>{URL.revokeObjectURL(url);resolve(null);};
    image.src=url;
  });
}
async function saveFiles(fileList) {
  const files=Array.from(fileList||[]);if(!files.length)return;
  let saved=0;
  for(const [index,file] of files.entries()){
    if(!file||!file.size){continue;}
    const type=classifyFile(file);
    try{
      const thumbnail=type==='image'?await imageThumbnail(file):null;
      const entry={id:newId(),created:Date.now()+index,type,title:'',text:'',originalName:file.name||'Без названия',mime:file.type||'',size:file.size,thumbnail};
      await saveRecord(entry,file);saved++;
    }catch(error){console.error('Ошибка сохранения файла:',error);showToast(getErrorMessage(error));}
  }
  await refresh();
  if(saved)showToast(saved===1?'Файл сохранён':`Сохранено файлов: ${saved}`);
  if(saved<files.length&&!saved)showToast('Не получилось сохранить файлы.');
}

function openItemMenu(id) {
  const entry=state.entries.find(r=>r.id===id);if(!entry)return;
  state.currentId=id;
  $('itemMenuTitle').textContent=recordName(entry);
  $('menuCopy').classList.toggle('hidden',!(entry.type==='link'||(entry.type==='text'&&Boolean(recordText(entry)))));
  showDialog('itemMenu');
}
function startRename(id){
  const entry=state.entries.find(r=>r.id===id);if(!entry)return;
  state.renameId=id;
  $('renameInput').value=recordName(entry);
  showDialog('renameDialog');
}
function viewerButton(text,onClick){const button=document.createElement('button');button.type='button';button.textContent=text;button.addEventListener('click',onClick);return button;}
async function openViewer(id) {
  const record=state.entries.find(r=>r.id===id);if(!record)return;
  releaseViewer();
  $('viewerTitle').textContent=recordName(record);
  const body=$('viewerBody'),buttons=$('viewerActions');body.replaceChildren();buttons.replaceChildren();
  if(record.type==='link'){
    const anchor=document.createElement('a');anchor.textContent=recordText(record);anchor.href=recordText(record);anchor.rel='noopener noreferrer';anchor.target='_blank';body.append(anchor);
    buttons.append(viewerButton('Копировать ссылку',()=>copyValue(recordText(record))));
  }else if(record.type==='text'&&recordText(record)){
    const content=document.createElement('div');content.className='text-preview';content.textContent=recordText(record);body.append(content);
    buttons.append(viewerButton('Копировать текст',()=>copyValue(recordText(record))));
  }else{
    try{
      const file=await readBlob(id);
      if(!file){showToast('Не удалось открыть вложение.');return;}
      viewerUrl=URL.createObjectURL(file);
      if(record.type==='image'){
        const img=document.createElement('img');img.src=viewerUrl;img.alt=recordName(record);body.append(img);
      }else if(record.type==='video'){
        const video=document.createElement('video');video.src=viewerUrl;video.controls=true;video.playsInline=true;video.preload='metadata';body.append(video);
      }else if(record.type==='text'&&file.size<2*1024*1024){
        const content=document.createElement('div');content.className='text-preview';content.textContent=await file.text();body.append(content);
      }else{
        const description=document.createElement('div');description.className='file-description';description.textContent=`${record.originalName||'Файл'} · ${formatBytes(file.size)}`;body.append(description);
      }
      const download=document.createElement('a');download.href=viewerUrl;download.download=record.originalName||'Файл';download.textContent='Сохранить файл';buttons.append(download);
    }catch(error){console.error(error);showToast('Не удалось прочитать файл.');return;}
  }
  buttons.append(viewerButton('Переименовать',()=>{closeDialog('viewer');startRename(id)}));
  showDialog('viewer');
}
function formatBytes(n){return n>=1048576?(n/1048576).toFixed(1)+' МБ':Math.max(1,Math.round(n/1024))+' КБ';}
async function copyValue(value){
  if(!navigator.clipboard?.writeText){showToast('Копирование недоступно в этом браузере.');return;}
  try{await navigator.clipboard.writeText(value);showToast('Скопировано');}catch{showToast('Не удалось скопировать');}
}
async function deleteOne(id){
  const record=state.entries.find(r=>r.id===id);if(!record)return;
  if(!confirm(`Удалить «${recordName(record)}»?`))return;
  try{await deleteRecords([id]);await refresh();showToast('Запись удалена');}catch{showToast('Ошибка удаления');}
}
async function deleteCategory(){
  const type=state.mode,records=state.entries.filter(r=>r.type===type);
  if(!records.length)return;
  const label=type==='file'?'«Другие файлы»':`«${({link:'Ссылки',image:'Фото',video:'Видео',text:'Текст'})[type]}»`;
  if(!confirm(`Удалить все записи из категории ${label} (${records.length})? Отменить это нельзя.`))return;
  try{await deleteRecords(records.map(r=>r.id));await refresh();showToast('Категория очищена');}catch{showToast('Ошибка удаления');}
}
async function deleteEverything(){
  closeDialog('appMenu');
  if(!state.entries.length){showToast('Помойка уже пустая');return;}
  if(!confirm(`Удалить вообще все записи (${state.entries.length})? Фото, видео, ссылки и текст исчезнут без возможности восстановления.`))return;
  try{await clearAllRecords();setMode('home');await refresh();showToast('Помойка очищена');}catch{showToast('Ошибка удаления');}
}
async function importClipboard(){
  // Системный запрос «Paste» вызывается только прямым нажатием на кнопку.
  // Ни одно дополнительное окно внутри приложения не открывается.
  if(!navigator.clipboard){showToast('Буфер недоступен');return;}
  try{
    if(typeof navigator.clipboard.read==='function'){
      const selection=await navigator.clipboard.read();
      for(const item of selection){
        const imageType=item.types.find(type=>/^image\/(png|jpeg|webp)$/i.test(type));
        if(imageType){
          const blob=await item.getType(imageType);
          const ext=imageType==='image/jpeg'?'jpg':imageType.split('/')[1];
          await saveFiles([new File([blob],`Из буфера.${ext}`,{type:imageType})]);
          return;
        }
        const textType=item.types.includes('text/plain')?'text/plain':item.types.includes('text/uri-list')?'text/uri-list':null;
        if(textType){
          const blob=await item.getType(textType);
          const value=await blob.text();
          if(value.trim()){await saveText(value);return;}
        }
      }
      showToast('Пустой буфер');
      return;
    }
    if(typeof navigator.clipboard.readText==='function'){
      const value=await navigator.clipboard.readText();
      if(value.trim()){await saveText(value);return;}
      showToast('Пустой буфер');
      return;
    }
    showToast('Буфер недоступен');
  }catch(error){
    // На iOS пользователь может отменить системную плашку Paste.
    // В таком случае не открываем других окон и не показываем ложное «Пустой буфер».
    if(error?.name==='NotAllowedError'||error?.name==='AbortError')return;
    if(error?.name==='NotFoundError'){showToast('Пустой буфер');return;}
    console.info('Ошибка чтения буфера:',error?.name);
    showToast('Не удалось прочитать буфер');
  }
}

function bindEvents(){
  document.querySelectorAll('.category').forEach(button=>button.addEventListener('click',()=>setMode(state.mode===button.dataset.category?'home':button.dataset.category)));
  $('otherFilesButton').addEventListener('click',()=>setMode('file'));
  $('backButton').addEventListener('click',()=>setMode('home'));
  $('moreButton').addEventListener('click',()=>setMode('all'));
  $('searchToggle').addEventListener('click',()=>{
    const open=$('searchWrap').classList.toggle('hidden')===false;
    if(open)$('searchInput').focus();else{$('searchInput').value='';render();}
  });
  $('searchInput').addEventListener('input',render);
  $('clearCategoryButton').addEventListener('click',deleteCategory);
  $('appMenuButton').addEventListener('click',()=>showDialog('appMenu'));
  $('appDeleteAll').addEventListener('click',deleteEverything);
  // Запускаем системный file picker непосредственно из нажатия — без промежуточного окна.
  $('attachButton').addEventListener('click',()=>$('filesInput').click());
  $('filesInput').addEventListener('change',async e=>{const files=Array.from(e.target.files);e.target.value='';await saveFiles(files)});
  $('renameForm').addEventListener('submit',async event=>{
    event.preventDefault();const title=$('renameInput').value.trim();if(!title)return;
    try{await renameRecord(state.renameId,title);closeDialog('renameDialog');await refresh();showToast('Название изменено');}catch{showToast('Ошибка переименования');}
  });
  $('menuOpen').addEventListener('click',()=>{const id=state.currentId;closeDialog('itemMenu');openViewer(id)});
  $('menuRename').addEventListener('click',()=>{const id=state.currentId;closeDialog('itemMenu');startRename(id)});
  $('menuDelete').addEventListener('click',()=>{const id=state.currentId;closeDialog('itemMenu');deleteOne(id)});
  $('menuCopy').addEventListener('click',()=>{
    const entry=state.entries.find(r=>r.id===state.currentId);
    if(entry){copyValue(recordText(entry));closeDialog('itemMenu');}
  });
  $('clipboardButton').addEventListener('click',importClipboard);
  const quickText=$('quickText'),quickSave=$('quickTextSave');
  const resizeQuickText=()=>{
    quickSave.disabled=!quickText.value.trim();
    quickText.style.height='auto';
    quickText.style.height=Math.min(quickText.scrollHeight,116)+'px';
  };
  quickText.addEventListener('input',resizeQuickText);
  quickText.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){
      event.preventDefault();$('quickTextForm').requestSubmit();
    }
  });
  $('quickTextForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const value=quickText.value;
    if(!value.trim())return;
    quickSave.disabled=true;
    try{
      if(await saveText(value)){
        quickText.value='';
        quickText.blur();
      }
    }catch(error){console.error(error);showToast(getErrorMessage(error));}
    finally{resizeQuickText();}
  });
  resizeQuickText();
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>closeDialog(button.dataset.close)));
  // Закрываем модальные окна обычным нажатием по затемнённой области, как в настройках.
  document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{
    if(event.target===dialog)closeDialog(dialog.id);
  }));
  $('viewer').addEventListener('close',()=>{const video=$('viewerBody').querySelector('video');if(video)video.pause();releaseViewer();$('viewerBody').replaceChildren();$('viewerActions').replaceChildren();});
  window.addEventListener('pagehide',()=>{releaseThumbs();releaseViewer();});
}
async function main(){
  bindEvents();
  try{state.db=await openDB();await refresh();}
  catch(error){console.error(error);$('entries').replaceChildren();const p=document.createElement('p');p.className='empty';p.textContent='Не удалось открыть локальную память приложения. Проверь настройки Safari.';$('entries').append(p);}
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(error=>console.info('Service Worker:',error?.message));
}
main();
