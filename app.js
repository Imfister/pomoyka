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
const state = {db:null, entries:[], mode:'home', searching:false, currentId:null, renameId:null, selecting:false};
const selectedIds=new Set();
let bulkSharePayload=null;
let bulkShareSerial=0;
let thumbUrls = [];
let viewerUrl = null;
let toastTimeout;
let renderCounter = 0;
let openSwipeRow=null;
let menuSharePayload=null;
let menuShareSerial=0;

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
// Единственная проверка для ВСЕХ мест с кнопкой «Копировать».
// Произвольные файлы не являются переносимым ClipboardItem в Safari.
function canCopyRecord(entry){
  if(!entry)return false;
  if(entry.type==='link' || entry.type==='text'){
    return Boolean(String(recordText(entry)||'').trim()) && typeof navigator.clipboard?.writeText==='function';
  }
  if(entry.type!=='image' || !navigator.clipboard?.write || typeof ClipboardItem==='undefined')return false;
  if(typeof ClipboardItem.supports==='function' && !ClipboardItem.supports('image/png'))return false;
  const mime=inferFileMime(entry).toLowerCase();
  // Не показываем кнопку у неподдерживаемого/неопознанного типа картинки.
  return ['image/png','image/jpeg','image/webp','image/gif','image/heic','image/heif','image/bmp','image/avif'].includes(mime);
}
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
  const limit=mode==='home'&&!term&&!state.selecting?4:Infinity;
  const visible=list.slice(0,limit);
  $('listTitle').textContent=mode==='home'?(term?'Результаты поиска':'Последние добавления'):mode==='all'?'Все добавления':mode==='file'?'Другие файлы':({link:'Ссылки',image:'Фото',video:'Видео',text:'Текст'})[mode];
  $('searchInput').placeholder=({link:'Поиск по ссылкам',image:'Поиск по фото',video:'Поиск по видео',home:'Поиск по помойке',all:'Поиск по помойке'})[mode] || 'Поиск по записям';
  $('searchInput').setAttribute('aria-label',$('searchInput').placeholder);
  $('backButton').classList.toggle('hidden',mode==='home');
  $('clearCategoryButton').classList.toggle('hidden',!inCategory);
  $('moreButton').classList.toggle('hidden',state.selecting||!(mode==='home'&&!term&&list.length>4));
  $('moreButton').textContent=`Ещё (${list.length-4})`;
  const extra=state.entries.filter(e=>e.type==='file').length;
  $('otherFilesButton').classList.toggle('hidden',extra===0);
  $('otherCount').textContent=extra;
  updateSelectionUI();
  document.querySelectorAll('.category').forEach(btn=>btn.classList.toggle('active',btn.dataset.category===mode));

  const container=$('entries');container.replaceChildren();
  if(!visible.length){const p=document.createElement('p');p.className='empty';if(term||inCategory){p.textContent=term?'Ничего не найдено.':'Здесь пока пусто.';}else{p.append(document.createTextNode('Помойка пустая.'),document.createElement('br'),document.createTextNode('Добавьте что-нибудь.'));}container.append(p);return;}
  for(const entry of visible){
    const row=document.createElement('article');row.className='entry';row.dataset.entryId=String(entry.id);
    row.classList.toggle('selection-mode',state.selecting);
    row.classList.toggle('is-selected',selectedIds.has(entry.id));
    const slide=document.createElement('div');slide.className='entry-slide';
    const swipeDelete=document.createElement('button');swipeDelete.type='button';swipeDelete.className='swipe-delete';
    swipeDelete.setAttribute('aria-label','Удалить: '+recordName(entry));swipeDelete.title='Удалить запись';
    swipeDelete.innerHTML='<img src="./trash-swipe.png" alt="" aria-hidden="true">';
    swipeDelete.addEventListener('click',()=>deleteSwipedEntry(entry.id,row));
    const main=document.createElement('button');main.type='button';main.className='entry-main';main.setAttribute('aria-label','Открыть: '+recordName(entry));if(state.selecting)main.setAttribute('aria-pressed',String(selectedIds.has(entry.id)));
    main.addEventListener('click',()=>{
      if(state.selecting){toggleSelected(entry.id);return;}
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
    info.append(name,meta);
    if(state.selecting){const marker=document.createElement('span');marker.className='selection-mark';marker.setAttribute('aria-hidden','true');main.append(marker);}
    main.append(thumb,info);
    const options=document.createElement('button');options.type='button';options.className='entry-options';options.textContent='⋯';options.setAttribute('aria-label','Действия с записью: '+recordName(entry));options.addEventListener('click',()=>openItemMenu(entry.id));
    slide.append(main);
    if(canCopyRecord(entry)){
      const copy=document.createElement('button');copy.type='button';copy.className='entry-copy';copy.title='Копировать';
      copy.setAttribute('aria-label','Копировать содержимое: '+recordName(entry));
      copy.innerHTML='<img src="./copy-icon.png" alt="" aria-hidden="true">';
      copy.addEventListener('click',()=>copyRecordFromTap(entry));
      slide.append(copy);
    }
    slide.append(options);
    row.append(swipeDelete,slide);
    if(!state.selecting)bindEntrySwipe(row,slide,entry.id);
    container.append(row);
  }
}
// iPhone: свайп только открывает/закрывает мусорку; удаление — нажатием по ней.
const SWIPE_ACTION_WIDTH=62;
function closeSwipeRow(row,animate=true){
  if(!row)return;
  const slide=row.querySelector('.entry-slide');
  if(!slide)return;
  slide.style.transition=animate?'transform .20s ease':'none';
  slide.style.transform='translate3d(0,0,0)';
  const options=row.querySelector('.entry-options');
  if(options){options.style.transition=animate?'opacity .20s ease':'none';options.style.opacity='1';}
  const copy=row.querySelector('.entry-copy');
  if(copy){copy.style.transition=animate?'opacity .20s ease':'none';copy.style.opacity='1';}
  row.classList.remove('swipe-open');
  if(openSwipeRow===row)openSwipeRow=null;
}
function revealSwipeRow(row){
  if(openSwipeRow && openSwipeRow!==row)closeSwipeRow(openSwipeRow);
  const slide=row.querySelector('.entry-slide');
  slide.style.transition='transform .20s ease';
  slide.style.transform=`translate3d(-${SWIPE_ACTION_WIDTH}px,0,0)`;
  const options=row.querySelector('.entry-options');
  if(options){options.style.transition='opacity .20s ease';options.style.opacity='0';}
  const copy=row.querySelector('.entry-copy');
  if(copy){copy.style.transition='opacity .20s ease';copy.style.opacity='0';}
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
    const position=Math.max(-SWIPE_ACTION_WIDTH,Math.min(0,gesture.base+dx));
    slide.style.transform=`translate3d(${position}px,0,0)`;
    const options=row.querySelector('.entry-options');
    if(options){options.style.transition='none';options.style.opacity=String(1-Math.min(1,Math.abs(position)/SWIPE_ACTION_WIDTH));}
    const copy=row.querySelector('.entry-copy');
    if(copy){copy.style.transition='none';copy.style.opacity=String(1-Math.min(1,Math.abs(position)/SWIPE_ACTION_WIDTH));}
  },{passive:false});
  row.addEventListener('touchend',event=>{
    if(!gesture)return;
    const g=gesture;gesture=null;
    if(g.axis!=='horizontal')return;
    const dx=(event.changedTouches[0]?.clientX ?? g.lastX)-g.x;
    // Даже свайп через всю ширину экрана ничего не удаляет сам по себе.
    if(dx>20){
      closeSwipeRow(row);
    }else if(dx<-28 || (g.startOpen && dx<=20)){
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
  state.selecting=false;selectedIds.clear();bulkShareSerial++;bulkSharePayload=null;
  $('searchInput').value='';
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

// Передача файлов наружу происходит ТОЛЬКО по нажатию пользователя через меню iOS.
function inferFileMime(record) {
  if (record.mime && record.mime !== 'application/octet-stream') return record.mime;
  const extension=(record.originalName||'').split('.').pop().toLowerCase();
  return ({mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',flac:'audio/flac',ogg:'audio/ogg',
    mp4:'video/mp4',mov:'video/quicktime',m4v:'video/x-m4v',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',
    heic:'image/heic',heif:'image/heif',webp:'image/webp',gif:'image/gif',pdf:'application/pdf'})[extension] || 'application/octet-stream';
}
function recordIsAudio(record) {
  return Boolean(record && (inferFileMime(record).startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(record.originalName||'')));
}
function shareablePayload(record, blob) {
  if (record.type==='link') return {url:recordText(record)};
  if (record.type==='text' && recordText(record)) return {text:recordText(record)};
  if (!(blob instanceof Blob)) return null;
  const filename=record.originalName||'Сохранённый файл';
  const file=new File([blob],filename,{type:inferFileMime(record),lastModified:Date.now()});
  return {files:[file]};
}
function shareFromTap(payload) {
  // Нельзя ждать IndexedDB перед navigator.share(): iOS может потерять жест пользователя.
  if (!payload || typeof navigator.share!=='function'){
    showToast('Системное меню «Поделиться» недоступно.');return;
  }
  try {
    if (payload.files && typeof navigator.canShare==='function' && !navigator.canShare({files:payload.files})){
      showToast('iOS не позволяет поделиться этим файлом.');return;
    }
    Promise.resolve(navigator.share(payload)).catch(error=>{
      if(error?.name==='AbortError')return;
      console.info('Не удалось открыть меню Share:',error?.name);
      showToast('Не удалось открыть меню «Поделиться».');
    });
  }catch(error){
    console.info('Ошибка Share:',error?.name);
    showToast('Не удалось открыть меню «Поделиться».');
  }
}
function openItemMenu(id) {
  const entry=state.entries.find(r=>r.id===id);if(!entry)return;
  state.currentId=id;
  $('itemMenuTitle').textContent=recordName(entry);
  const sizeLabel=$('itemMenuSize');
  const hasAttachment=Number(entry.size)>0;
  sizeLabel.textContent=hasAttachment?formatBytes(Number(entry.size)):'';
  sizeLabel.classList.toggle('hidden',!hasAttachment);
  $('menuCopy').classList.toggle('hidden',!canCopyRecord(entry));
  const serial=++menuShareSerial;
  const button=$('menuShare');
  if(entry.type==='link'||(entry.type==='text'&&recordText(entry))){
    menuSharePayload=shareablePayload(entry,null);
    button.disabled=false;
    button.textContent='Поделиться';
  }else{
    menuSharePayload=null;
    button.disabled=true;
    button.textContent='Поделиться (подготовка…)';
    readBlob(id).then(blob=>{
      if(serial!==menuShareSerial || state.currentId!==id)return;
      menuSharePayload=shareablePayload(entry,blob);
      button.disabled=!menuSharePayload;
      button.textContent='Поделиться';
      if(!menuSharePayload)showToast('Файл не найден в локальном хранилище.');
    }).catch(()=>{
      if(serial!==menuShareSerial)return;
      button.disabled=true;
      button.textContent='Поделиться недоступно';
    });
  }
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
  let sharePayload=null;
  if(record.type==='link'){
    const anchor=document.createElement('a');anchor.textContent=recordText(record);anchor.href=recordText(record);anchor.rel='noopener noreferrer';anchor.target='_blank';body.append(anchor);
    sharePayload=shareablePayload(record,null);
  }else if(record.type==='text'&&recordText(record)){
    const content=document.createElement('div');content.className='text-preview';content.textContent=recordText(record);body.append(content);
    sharePayload=shareablePayload(record,null);
  }else{
    try{
      const file=await readBlob(id);
      if(!file){showToast('Не удалось открыть вложение.');return;}
      const mime=inferFileMime(record);
      // Для старых MP3 без MIME Safari нужна подсказка audio/mpeg.
      const displayBlob=(recordIsAudio(record) && !file.type)?new Blob([file],{type:mime}):file;
      viewerUrl=URL.createObjectURL(displayBlob);
      if(record.type==='image'){
        const img=document.createElement('img');img.src=viewerUrl;img.alt=recordName(record);body.append(img);
      }else if(record.type==='video'){
        const video=document.createElement('video');video.src=viewerUrl;video.controls=true;video.playsInline=true;video.preload='metadata';body.append(video);
      }else if(recordIsAudio(record)){
        const audio=document.createElement('audio');audio.src=viewerUrl;audio.controls=true;audio.preload='metadata';audio.setAttribute('aria-label','Аудиоплеер: '+recordName(record));body.append(audio);
      }else if(record.type==='text'&&file.size<2*1024*1024){
        const content=document.createElement('div');content.className='text-preview';content.textContent=await file.text();body.append(content);
      }else{
        const description=document.createElement('div');description.className='file-description';description.textContent=record.originalName||'Файл';body.append(description);
      }
      sharePayload=shareablePayload(record,file);
    }catch(error){console.error(error);showToast('Не удалось прочитать файл.');return;}
  }
  // В просмотре строго две кнопки и в указанном порядке. Другие действия доступны в меню «⋯».
  buttons.append(viewerButton('Переименовать',()=>{closeDialog('viewer');startRename(id)}));
  buttons.append(viewerButton('Поделиться',()=>shareFromTap(sharePayload)));
  if(canCopyRecord(record)){
    const copy=viewerButton('',()=>copyRecordFromTap(record));
    copy.classList.add('viewer-copy');copy.setAttribute('aria-label','Копировать содержимое');copy.title='Копировать';
    copy.innerHTML='<img src="./copy-icon.png" alt="" aria-hidden="true">';
    buttons.append(copy);
  }
  showDialog('viewer');
}
function formatBytes(n){
  if(n<1024)return `${n} Б`;
  if(n<1048576)return `${(n/1024).toFixed(n<10240?1:0)} КБ`;
  if(n<1073741824)return `${(n/1048576).toFixed(1)} МБ`;
  return `${(n/1073741824).toFixed(2)} ГБ`;
}
async function copyValue(value){
  if(!navigator.clipboard?.writeText){showToast('Копирование недоступно в этом браузере.');return;}
  try{await navigator.clipboard.writeText(value);showToast('Скопировано');}catch{showToast('Не удалось скопировать');}
}

// Копирование запускается непосредственно жестом пользователя.
// WebKit гарантирует формат image/png, но не произвольные файлы PDF, MP3, MOV.
function copyRecordFromTap(record){
  if(!canCopyRecord(record))return;
  if(record.type==='link' || record.type==='text'){
    copyValue(recordText(record));return;
  }
  // На iOS надёжно поддерживается формат PNG; другие файлы — через «Поделиться».
  const promise=readBlob(record.id).then(blob=>{
    if(!blob)throw new Error('Missing file');
    return convertToClipboardPNG(blob);
  });
  writeBinaryClipboard('image/png',promise);
}
function writeBinaryClipboard(mime,promise){
  // Вызываем write синхронно, а Blob передаём в виде Promise: это важно для iOS.
  try{
    const item=new ClipboardItem({[mime]:promise});
    Promise.resolve(navigator.clipboard.write([item])).then(()=>showToast('Скопировано')).catch(error=>{
      console.info('Clipboard write:',error?.name);
      showToast('iOS не позволяет скопировать этот файл');
    });
  }catch(error){
    console.info('ClipboardItem:',error?.name);
    showToast('iOS не позволяет скопировать этот файл');
  }
}
async function convertToClipboardPNG(blob){
  if(blob.type==='image/png')return blob;
  const url=URL.createObjectURL(blob);
  try{
    const image=new Image();
    await new Promise((resolve,reject)=>{
      image.onload=resolve;image.onerror=reject;image.src=url;
    });
    if(!image.naturalWidth||!image.naturalHeight)throw new Error('Image decode failed');
    const scale=Math.min(1,4096/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(image.naturalWidth*scale);
    canvas.height=Math.round(image.naturalHeight*scale);
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    const png=await new Promise((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(new Error('No PNG')),'image/png'));
    return png;
  }finally{URL.revokeObjectURL(url);}
}

function updateSelectionUI(){
  const selecting=state.selecting;
  $('selectionToggle').textContent=selecting?'Отмена':'Выбор';
  $('selectionToggle').setAttribute('aria-pressed',String(selecting));
  $('selectionBar').classList.toggle('hidden',!selecting);
  $('selectionBar').closest('.bottom-actions').classList.toggle('selecting',selecting);
  $('selectionCount').textContent='Выбрано: '+selectedIds.size;
  $('selectionDelete').disabled=selectedIds.size===0;
  $('selectionShare').disabled=selectedIds.size===0||!bulkSharePayload;
  $('selectionShare').textContent=selectedIds.size>0&&!bulkSharePayload?'Подготовка…':'Поделиться';
  $('clearCategoryButton').disabled=selecting;
}
function toggleSelectionMode(){
  state.selecting=!state.selecting;
  selectedIds.clear();bulkSharePayload=null;bulkShareSerial++;
  render();
}
function toggleSelected(id){
  if(!state.selecting)return;
  if(selectedIds.has(id))selectedIds.delete(id);else selectedIds.add(id);
  // Не перестраиваем DOM: иначе мигают миниатюры и SVG на каждой отметке.
  for(const row of $('entries').querySelectorAll('.entry[data-entry-id]')){
    if(row.dataset.entryId===String(id)){
      row.classList.toggle('is-selected',selectedIds.has(id));
      const button=row.querySelector('.entry-main');
      if(button)button.setAttribute('aria-pressed',String(selectedIds.has(id)));
      break;
    }
  }
  bulkSharePayload=null;bulkShareSerial++;
  updateSelectionUI();
  if(selectedIds.size)prepareBulkShare();
}
async function buildBulkShare(ids){
  const records=ids.map(id=>state.entries.find(record=>record.id===id)).filter(Boolean);
  if(!records.length)return null;
  const files=[],textParts=[];
  for(const record of records){
    if(record.type==='link' || (record.type==='text'&&recordText(record))){
      textParts.push(recordText(record));
    }else{
      const blob=await readBlob(record.id);
      if(!(blob instanceof Blob))throw new Error('Missing attachment '+record.id);
      files.push(new File([blob],record.originalName||'Файл',{type:inferFileMime(record)}));
    }
  }
  if(!files.length)return {text:textParts.join('\n\n')};
  if(textParts.length){
    files.push(new File([textParts.join('\n\n')],'Текст и ссылки.txt',{type:'text/plain'}));
  }
  return {files};
}
async function prepareBulkShare(){
  const serial=++bulkShareSerial;
  const ids=[...selectedIds];
  try{
    const payload=await buildBulkShare(ids);
    if(serial!==bulkShareSerial||!state.selecting)return;
    bulkSharePayload=payload;
    updateSelectionUI();
  }catch(error){
    if(serial!==bulkShareSerial)return;
    bulkSharePayload=null;
    updateSelectionUI();
    showToast('Не удалось подготовить выбранные файлы');
  }
}
async function deleteSelected(){
  if(!state.selecting||!selectedIds.size)return;
  const ids=[...selectedIds];
  if(!confirm(`Удалить выбранные записи (${ids.length})?\nДействие отменить нельзя.`))return;
  try{
    await deleteRecords(ids);
    state.selecting=false;selectedIds.clear();bulkShareSerial++;bulkSharePayload=null;
    await refresh();
    showToast('Выбранные записи удалены');
  }catch(error){showToast('Не удалось удалить выбранные записи');}
}

async function deleteOne(id){
  const record=state.entries.find(r=>r.id===id);if(!record)return;
  if(!confirm(`Удалить «${recordName(record)}»?`))return;
  try{await deleteRecords([id]);await refresh();showToast('Запись удалена');}catch{showToast('Ошибка удаления');}
}
async function deleteCategory(){
  const type=state.mode,records=state.entries.filter(r=>r.type===type);
  if(!records.length){showToast('Категория пуста');return;}
  const label=type==='file'?'«Другие файлы»':`«${({link:'Ссылки',image:'Фото',video:'Видео',text:'Текст'})[type]}»`;
  if(!confirm(`Удалить все записи из категории ${label} (${records.length})?\nДействие отменить нельзя.`))return;
  try{await deleteRecords(records.map(r=>r.id));await refresh();showToast('Категория очищена');}catch{showToast('Ошибка удаления');}
}
async function deleteEverything(){
  closeDialog('appMenu');
  if(!state.entries.length){showToast('Помойка уже пустая');return;}
  if(!confirm(`Удалить вообще все записи (${state.entries.length})? Фото, видео, ссылки и текст исчезнут без возможности восстановления.`))return;
  try{await clearAllRecords();setMode('home');await refresh();showToast('Помойка очищена');}catch{showToast('Ошибка удаления');}
}
async function importClipboard(){
  // Запускаем чтение ПРЯМО из нажатия — важно для iOS Paste.
  const clipboard=navigator.clipboard;
  if(!clipboard){showToast('Буфер недоступен');return;}
  try{
    if(typeof clipboard.read==='function'){
      const items=await clipboard.read();
      if(!items.length){showToast('Пустой буфер');return;}
      const files=[];const texts=[];let hadUnsupported=false;
      for(const item of items){
        const types=Array.from(item.types||[]);
        // Safari иногда предлагает одновременно image/png и text/html.
        // Сначала читаем картинку/файл, а не её текстовое описание.
        const binaries=types.filter(type=>
          /^(image|video|audio)\//i.test(type) ||
          /^application\/(pdf|zip|octet-stream|json|msword|vnd\.)/i.test(type));
        let gotBinary=false;
        for(const mime of binaries){
          try{
            const blob=await item.getType(mime);
            if(!(blob instanceof Blob)||!blob.size)continue;
            const ext=({
              'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif',
              'image/heic':'heic','image/heif':'heif','image/avif':'avif',
              'video/mp4':'mp4','video/quicktime':'mov','audio/mpeg':'mp3','audio/mp4':'m4a',
              'application/pdf':'pdf','application/zip':'zip','application/json':'json'
            })[mime.toLowerCase()] || mime.split('/')[1]?.replace(/[^a-z0-9]+/gi,'-') || 'bin';
            files.push(new File([blob],`Из буфера.${ext}`,{type:mime}));
            gotBinary=true;
            break;
          }catch(error){console.info('Формат буфера не прочитан:',mime,error?.name);hadUnsupported=true;}
        }
        if(gotBinary)continue;
        let gotText=false;
        for(const mime of ['text/plain','text/uri-list','text/html']){
          if(!types.includes(mime))continue;
          try{
            const raw=(await item.getType(mime)).text();
            const value=await raw;
            let text=value;
            if(mime==='text/html'){
              // Только локальный разбор HTML, без выполнения скриптов и сетевой загрузки.
              const documentFragment=new DOMParser().parseFromString(value,'text/html');
              // Некоторые источники копируют картинку как встроенный data:image/... в HTML.
              // Это дополнительный вариант, когда бинарный формат не был доступен.
              const source=documentFragment.querySelector('img[src^="data:image/"]')?.getAttribute('src');
              if(source && source.length<40_000_000){
                const match=/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(source);
                if(match){
                  try{
                    const binary=atob(match[2]);
                    const bytes=new Uint8Array(binary.length);
                    for(let k=0;k<binary.length;k++)bytes[k]=binary.charCodeAt(k);
                    const subtype=match[1].split('/')[1].replace('jpeg','jpg');
                    const file=new File([bytes],`Из буфера.${subtype}`,{type:match[1]});
                    files.push(file);gotBinary=true;break;
                  }catch(error){console.info('Встроенное изображение недоступно:',error?.name);}
                }
              }
              text=documentFragment.body?.textContent||'';
              if(!text.trim())text=documentFragment.querySelector('a[href]')?.getAttribute('href')||'';
            }
            if(text.trim()){texts.push(text);gotText=true;break;}
          }catch(error){console.info('Текстовый формат недоступен:',mime,error?.name);}
        }
        if(!gotText&&types.length)hadUnsupported=true;
      }
      if(files.length){await saveFiles(files);return;}
      if(texts.length){await saveText(texts.join('\n'));return;}
      showToast(hadUnsupported?'Этот формат буфера не поддерживается iPhone':'Пустой буфер');
      return;
    }
    if(typeof clipboard.readText==='function'){
      const value=await clipboard.readText();
      if(value.trim()){await saveText(value);return;}
      showToast('Пустой буфер');return;
    }
    showToast('Буфер недоступен');
  }catch(error){
    // Отмена системной плашки Paste — это не пустой буфер.
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
  $('searchInput').addEventListener('input',render);
  $('clearCategoryButton').addEventListener('click',deleteCategory);
  $('selectionToggle').addEventListener('click',toggleSelectionMode);
  $('selectionShare').addEventListener('click',()=>{if(bulkSharePayload)shareFromTap(bulkSharePayload);});
  $('selectionDelete').addEventListener('click',deleteSelected);
  $('appMenuButton').addEventListener('click',()=>showDialog('appMenu'));
  $('appDeleteAll').addEventListener('click',deleteEverything);
  // Запускаем системный file picker непосредственно из нажатия — без промежуточного окна.
  $('attachButton').addEventListener('click',()=>$('filesInput').click());
  $('filesInput').addEventListener('change',async e=>{const files=Array.from(e.target.files);e.target.value='';await saveFiles(files)});
  $('renameForm').addEventListener('submit',async event=>{
    event.preventDefault();const title=$('renameInput').value.trim();if(!title)return;
    try{await renameRecord(state.renameId,title);closeDialog('renameDialog');await refresh();showToast('Название изменено');}catch{showToast('Ошибка переименования');}
  });
  $('menuRename').addEventListener('click',()=>{const id=state.currentId;closeDialog('itemMenu');startRename(id)});
  $('menuDelete').addEventListener('click',()=>{const id=state.currentId;closeDialog('itemMenu');deleteOne(id)});
  $('menuShare').addEventListener('click',()=>{const payload=menuSharePayload;closeDialog('itemMenu');shareFromTap(payload);});
  $('menuCopy').addEventListener('click',()=>{
    const entry=state.entries.find(r=>r.id===state.currentId);
    closeDialog('itemMenu');
    if(entry)copyRecordFromTap(entry);
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
  $('viewer').addEventListener('close',()=>{const player=$('viewerBody').querySelector('video,audio');if(player)player.pause();releaseViewer();$('viewerBody').replaceChildren();$('viewerActions').replaceChildren();});
  window.addEventListener('pagehide',()=>{releaseThumbs();releaseViewer();});
}
async function main(){
  bindEvents();
  try{state.db=await openDB();await refresh();}
  catch(error){console.error(error);$('entries').replaceChildren();const p=document.createElement('p');p.className='empty';p.textContent='Не удалось открыть локальную память приложения. Проверь настройки Safari.';$('entries').append(p);}
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(error=>console.info('Service Worker:',error?.message));
}
main();
