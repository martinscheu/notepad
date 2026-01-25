
  function updateSearchVisibility(isFocus){
    const elSearch = document.getElementById("search");
    if(!elSearch) return;
    // Always show the field; switch meaning based on mode.
    elSearch.style.display = "";
    elSearch.placeholder = isFocus ? "Find in note (Ctrl+K)" : "Search (Ctrl+K)";
  }

// Debug helper (enable by running: localStorage.setItem('notesDebug','1'); location.reload(); )
const NOTES_DEBUG = (typeof localStorage !== "undefined" && localStorage.getItem("notesDebug") === "1");
function dlog(...args){ if(NOTES_DEBUG) console.log("[notes]", ...args); }
let elSortModeLabel = null;
// Single source of truth (initial step): keep tab + selection state in one shared scope.
let tabs = [];
let activeTabId = null;
let selectedIds = new Set();

let elRename = null;

// Helper: active note title (tab label or meta)
window.getActiveTitle = function(){
  try{
    const activeTab = document.querySelector('.tab.active, .tab.is-active, .tab--active');
    if(activeTab){
      const nameEl = activeTab.querySelector('.name, .tab-name');
      let t = (nameEl ? nameEl.textContent : activeTab.textContent) || '';
      t = t.replace(/\s+/g, ' ').trim();
      t = t.replace(/\s*x\s*$/i, '').trim();
      return t;
    }
  }catch(e){}
  try{
    if(typeof getActiveTab === 'function'){
      const t = getActiveTab();
      if(t && t.meta){
        const v = (t.meta.display_title || t.meta.user_title || t.meta.title || t.meta.name || '').toString().trim();
        if(v) return v;
      }
    }
  }catch(e){}
  return '';
}

function renderTabsSafe(){
  try{
    if(typeof window !== "undefined" && typeof window.__notesRenderTabs === "function"){
      window.__notesRenderTabs();
      return;
    }
  }catch(e){}
  // fallback: no-op (tabs renderer not initialised yet)
}
;

(function(){
  const $ = (id) => document.getElementById(id);

  const elSearch = $("search");
  const elSort = $("sort");
  const elNotesList = $("notesList");
  const elNotesCount = $("notesCount");
  const elStatusLine = $("statusLine");

  const elSplitter = $("splitter");

  const elTabsBar = $("tabsBar");

  const elNew = $("newNote");
  const elSelectAll = $("selectAll");
  const elSelectNone = $("selectNone");
  const elDownloadSelected = $("downloadSelected");
  const elDeleteSelected = $("deleteSelected");
  const elPreviewToggle = $("previewToggle");
  const elTocToggle = $("tocToggle");
  const elPdf = $("pdfNote");
  const elRename = $("renameNote");  const elDownload = $("downloadNote");  const elTheme = $("themeToggle");
  const elCopyLink = $("copyLink");
  const elPin = $("pinNote");
  const elMru = $("mruToggle");
  const elFileView = $("fileViewToggle");
  
  const elPreview = $("preview");
  const elEditor = $("editor");
  const elEditorHighlight = $("editorHighlight");
  const elTocPanel = $("tocPanel");
  const elTocList = $("tocList");
  const elTocDepth = $("tocDepth");
  const elFileName = $("fileName");
  const elSaveState = $("saveState");
  const elSaveTime = $("saveTime");

  let notes = [];

  // Tabs: ALWAYS open a new tab when clicking a note in the list.
  tabs = [];

  // Debug helper (enable by running: localStorage.setItem('notesDebug','1'); location.reload(); )
  const NOTES_DEBUG = (typeof localStorage !== "undefined" && localStorage.getItem("notesDebug") === "1");
  function dlog(...args){ if(NOTES_DEBUG) console.log("[notes]", ...args); }

  activeTabId = null;

  let isTyping = false;
  let saveTimer = null;
  let pollTimer = null;

  let previewMode = false;
  selectedIds = new Set();
let deleteInProgress = false;

  let lastSavedIso = "";

  let theme = localStorage.getItem("sn_theme") || "light";
  let mruMode = (localStorage.getItem("sn_mru") || "fixed"); // "fixed"(classic) | "mru"
  let fileView = (localStorage.getItem("sn_fileview") || localStorage.getItem("sn_sidebar") || "on"); // "on" | "off"
  let tocOpen = (localStorage.getItem("sn_toc") || "off");

  function setMruMode(mode){
    mruMode = (mode === "mru") ? "mru" : "fixed";
    elMru.textContent = (mruMode === "mru") ? "Tab sort: Classic" : "Tab sort: MRU";
    localStorage.setItem("sn_mru", mruMode);
    updateTabSortingInfo();
  }

  function setFileViewMode(mode){
    fileView = (mode === "off") ? "off" : "on";
    elFileView.textContent = (fileView === "off") ? "Notes list" : "Focus";
    localStorage.setItem("sn_fileview", fileView);

    updateSearchVisibility(fileView === "off");
    const layout = document.querySelector(".layout");
    if(!layout) return;
    if(fileView === "off"){
      layout.classList.add("sidebar-collapsed");
    } else {
      layout.classList.remove("sidebar-collapsed");
    }
  }

  function setTheme(t){
    theme = t;
    document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
    elTheme.textContent = (t === "dark") ? "Light" : "Dark";
    localStorage.setItem("sn_theme", t);
  }

  function setTocOpen(on){
    tocOpen = on ? "on" : "off";
    if(elTocPanel){
      elTocPanel.classList.toggle("hidden", tocOpen !== "on");
    }
    if(elTocToggle){
      elTocToggle.textContent = (tocOpen === "on") ? "TOC: On" : "TOC";
    }
    localStorage.setItem("sn_toc", tocOpen);
    updateToc();
  }

  function escapeRegExp(s){
    return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isWordChar(ch){
    return /[A-Za-z0-9_]/.test(ch || "");
  }

  function findNextMatch(text, query, startIndex, matchCase, wholeWord){
    if(!query) return null;
    const hay = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? query : query.toLowerCase();
    let idx = hay.indexOf(needle, Math.max(0, startIndex || 0));
    while(idx !== -1){
      if(wholeWord){
        const before = idx > 0 ? text[idx - 1] : "";
        const after = (idx + query.length < text.length) ? text[idx + query.length] : "";
        if(isWordChar(before) || isWordChar(after)){
          idx = hay.indexOf(needle, idx + 1);
          continue;
        }
      }
      return { start: idx, end: idx + query.length };
    }
    return null;
  }

  function updateEditorValueAndSchedule(value){
    elEditor.value = value;
    if(previewMode && elPreview){ elPreview.innerHTML = renderMarkdown(elEditor.value || ""); }
    const t = getActiveTab();
    if(!t) return;
    isTyping = true;
    setSaveState("Editing...", "");
    scheduleSave();
    t.content = elEditor.value;
    updateReplaceCount();
    updateEditorHighlight();
    updateToc();
  }

  function getReplaceOptions(){
    const matchCase = !!document.getElementById("replace-matchcase")?.checked;
    const wholeWord = !!document.getElementById("replace-wholeword")?.checked;
    const query = (document.getElementById("replace-find")?.value || "").trim();
    return { matchCase, wholeWord, query };
  }

  function computeMatches(text, query, matchCase, wholeWord){
    if(!query) return [];
    const flags = matchCase ? "g" : "gi";
    const pattern = wholeWord ? `\\b${escapeRegExp(query)}\\b` : escapeRegExp(query);
    const re = new RegExp(pattern, flags);
    const matches = [];
    let m;
    while((m = re.exec(text)) !== null){
      if(m[0].length === 0){
        re.lastIndex += 1;
        continue;
      }
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
    return matches;
  }

  function escapeForHighlight(s){
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function buildHighlightHtml(text, matches){
    if(!matches.length){
      return escapeForHighlight(text);
    }
    let out = "";
    let last = 0;
    for(const m of matches){
      out += escapeForHighlight(text.slice(last, m.start));
      out += `<span class="hl">${escapeForHighlight(text.slice(m.start, m.end))}</span>`;
      last = m.end;
    }
    out += escapeForHighlight(text.slice(last));
    return out;
  }

  function updateEditorHighlight(){
    if(!elEditorHighlight) return;
    const text = elEditor.value || "";
    const status = document.getElementById("replace-status");
    if(text.length > 50000){
      elEditorHighlight.innerHTML = escapeForHighlight(text);
      if(status) status.textContent = "Highlight disabled for large notes.";
      return;
    }
    const { matchCase, wholeWord, query } = getReplaceOptions();
    if(!query){
      elEditorHighlight.innerHTML = escapeForHighlight(text);
      return;
    }
    const matches = computeMatches(text, query, matchCase, wholeWord);
    elEditorHighlight.innerHTML = buildHighlightHtml(text, matches);
    syncEditorHighlightScroll();
  }

  function syncEditorHighlightScroll(){
    if(!elEditorHighlight) return;
    elEditorHighlight.scrollTop = elEditor.scrollTop;
    elEditorHighlight.scrollLeft = elEditor.scrollLeft;
  }

  function updateToc(){
    if(!elTocPanel || !elTocList) return;
    if(tocOpen !== "on"){
      elTocList.innerHTML = "";
      return;
    }
    const depth = parseInt(elTocDepth?.value || "3", 10);
    const headings = buildHeadingIndex(elEditor.value || "").filter(h => h.level <= depth);
    elTocList.innerHTML = "";
    for(const h of headings){
      const item = document.createElement("button");
      item.type = "button";
      item.className = "toc-item";
      item.textContent = `${"•".repeat(h.level)} ${h.text}`;
      item.addEventListener("click", () => {
        if(previewMode && elPreview){
          const el = elPreview.querySelector(`#${CSS.escape(h.id)}`);
          if(el) el.scrollIntoView({behavior:"smooth", block:"start"});
        } else {
          const pos = h.index;
          elEditor.focus();
          elEditor.setSelectionRange(pos, pos);
        }
      });
      elTocList.appendChild(item);
    }
  }

  function updateReplaceCount(){
    const countEl = document.getElementById("replace-count");
    if(!countEl) return;
    const { matchCase, wholeWord, query } = getReplaceOptions();
    const text = elEditor.value || "";
    const matches = computeMatches(text, query, matchCase, wholeWord);
    const total = matches.length;
    if(total === 0){
      countEl.textContent = "0 matches";
      return;
    }
    const selStart = elEditor.selectionStart || 0;
    const selEnd = elEditor.selectionEnd || 0;
    let idx = matches.findIndex(m => m.start === selStart && m.end === selEnd);
    if(idx === -1){
      idx = matches.findIndex(m => m.start >= selEnd);
      if(idx === -1) idx = 0;
    }
    countEl.textContent = `${idx + 1} of ${total} matches`;
  }

  function searchInCurrentNote(fromNext){
    const q = (elSearch.value || "").trim();
    if(!q) return;
    const t = getActiveTab();
    if(!t) return;
    const text = elEditor.value || "";
    const start = fromNext ? (elEditor.selectionEnd || 0) : 0;
    let match = findNextMatch(text, q, start, false, false);
    if(!match && start > 0){
      match = findNextMatch(text, q, 0, false, false);
    }
    if(match){
      elEditor.focus();
      elEditor.setSelectionRange(match.start, match.end);
    } else {
      setStatus("No match");
    }
  }

  function findInCurrentNote(fromNext, focusEditor, restoreFocus){
    const { matchCase, wholeWord, query } = getReplaceOptions();
    if(!query) return;
    const t = getActiveTab();
    if(!t) return;
    const text = elEditor.value || "";
    const start = fromNext ? (elEditor.selectionEnd || 0) : 0;
    let match = findNextMatch(text, query, start, matchCase, wholeWord);
    if(!match && start > 0){
      match = findNextMatch(text, query, 0, matchCase, wholeWord);
    }
    if(match){
      const findInput = document.getElementById("replace-find");
      const selStart = findInput ? findInput.selectionStart : null;
      const selEnd = findInput ? findInput.selectionEnd : null;
      if(focusEditor || restoreFocus){
        elEditor.focus();
      }
      elEditor.setSelectionRange(match.start, match.end);
      if(restoreFocus && findInput){
        findInput.focus();
        if(selStart !== null && selEnd !== null){
          findInput.setSelectionRange(selStart, selEnd);
        }
      }
    } else {
      const status = document.getElementById("replace-status");
      if(status) status.textContent = "No match found.";
    }
    updateReplaceCount();
  }

  function openReplaceModal(){
    const panel = document.getElementById("replace-panel");
    if(!panel) return;
    panel.classList.remove("hidden");
    const findInput = document.getElementById("replace-find");
    if(findInput && !findInput.value){
      const selected = elEditor.value.slice(elEditor.selectionStart || 0, elEditor.selectionEnd || 0);
      findInput.value = selected || (elSearch ? (elSearch.value || "").trim() : "");
    }
    setTimeout(() => {
      if(findInput){ findInput.focus(); findInput.select(); }
    }, 0);
    updateReplaceCount();
    updateEditorHighlight();
  }

  function closeReplaceModal(){
    const panel = document.getElementById("replace-panel");
    if(!panel) return;
    panel.classList.add("hidden");
    updateEditorHighlight();
  }

  function replaceNext(){
    const findInput = document.getElementById("replace-find");
    const withInput = document.getElementById("replace-with");
    const { matchCase, wholeWord } = getReplaceOptions();
    const status = document.getElementById("replace-status");
    const query = (findInput ? findInput.value : "").trim();
    if(!query){ if(status) status.textContent = "Enter text to find."; return; }

    const text = elEditor.value || "";
    const selStart = elEditor.selectionStart || 0;
    const selEnd = elEditor.selectionEnd || 0;
    const selected = text.slice(selStart, selEnd);
    const cmpSelected = matchCase ? selected : selected.toLowerCase();
    const cmpQuery = matchCase ? query : query.toLowerCase();

    let nextStart = selEnd;
    let didReplace = false;
    if(cmpSelected === cmpQuery && selected.length){
      const replacement = withInput ? withInput.value : "";
      const newText = text.slice(0, selStart) + replacement + text.slice(selEnd);
      updateEditorValueAndSchedule(newText);
      const caret = selStart + replacement.length;
      elEditor.setSelectionRange(caret, caret);
      nextStart = caret;
      didReplace = true;
    }

    let match = findNextMatch(elEditor.value || "", query, nextStart, matchCase, wholeWord);
    if(!match && nextStart > 0){
      match = findNextMatch(elEditor.value || "", query, 0, matchCase, wholeWord);
    }

    if(match){
      elEditor.focus();
      elEditor.setSelectionRange(match.start, match.end);
      if(status) status.textContent = didReplace ? "Replaced and moved to next match." : "Match found.";
    } else {
      if(status) status.textContent = didReplace ? "Replaced. No further matches." : "No match found.";
    }
    updateReplaceCount();
    updateEditorHighlight();
  }

  function replaceAll(){
    const findInput = document.getElementById("replace-find");
    const withInput = document.getElementById("replace-with");
    const { matchCase, wholeWord } = getReplaceOptions();
    const status = document.getElementById("replace-status");
    const query = (findInput ? findInput.value : "").trim();
    if(!query){ if(status) status.textContent = "Enter text to find."; return; }
    const replacement = withInput ? withInput.value : "";

    const flags = matchCase ? "g" : "gi";
    const pattern = wholeWord ? `\\b${escapeRegExp(query)}\\b` : escapeRegExp(query);
    const re = new RegExp(pattern, flags);
    const text = elEditor.value || "";
    const matches = text.match(re);
    const count = matches ? matches.length : 0;
    if(count === 0){
      if(status) status.textContent = "No matches found.";
      return;
    }
    const newText = text.replace(re, replacement);
    updateEditorValueAndSchedule(newText);
    if(status) status.textContent = `Replaced ${count} match${count === 1 ? "" : "es"}.`;
    updateReplaceCount();
    updateEditorHighlight();
  }

  function openRenameModal(){
    const modal = document.getElementById("rename-modal");
    if(!modal) return;
    const t = getActiveTab();
    if(!t) return;
    const input = document.getElementById("rename-input");
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden","false");
    if(input){
      input.value = (t.meta && (t.meta.title || t.meta.display_title || t.meta.user_title || "")) || "";
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }
  }

  function closeRenameModal(){
    const modal = document.getElementById("rename-modal");
    if(!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden","true");
  }

  async function saveRenameFromModal(){
    const t = getActiveTab();
    if(!t) return;
    const input = document.getElementById("rename-input");
    const newTitle = (input ? input.value : "").trim();
    setStatus("Renaming...");
    try{
      const meta = await apiPut(
        `/api/notes/${encodeURIComponent(t.noteId)}/meta`,
        {user_title: newTitle, title: newTitle}
      );
      t.meta = meta;
      t.rev = meta.rev || t.rev;
    setFileName(meta);
      setStatus("Idle");
      await loadNotes();
      renderTabs();
      closeRenameModal();
    }catch(e){
      console.error(e);
      setStatus("Error renaming note");
    }
  }

  function bindRenameModal(){
    const modal = document.getElementById("rename-modal");
    if(!modal) return;
    if(modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    modal.addEventListener("click", (ev) => {
      if(ev.target === modal) closeRenameModal();
    });
    const closeBtn = document.getElementById("rename-close");
    if(closeBtn) closeBtn.addEventListener("click", closeRenameModal);
    const cancelBtn = document.getElementById("rename-cancel");
    if(cancelBtn) cancelBtn.addEventListener("click", closeRenameModal);
    const saveBtn = document.getElementById("rename-save");
    if(saveBtn) saveBtn.addEventListener("click", saveRenameFromModal);
    const input = document.getElementById("rename-input");
    if(input) input.addEventListener("keydown", (e) => {
      if(e.key === "Enter"){
        e.preventDefault();
        saveRenameFromModal();
      }
    });
  }

  function bindReplaceModal(){
    const panel = document.getElementById("replace-panel");
    if(!panel) return;
    if(panel.dataset.bound === "1") return;
    panel.dataset.bound = "1";
    const elReplaceClose = document.getElementById("replace-close");
    if(elReplaceClose) elReplaceClose.addEventListener("click", closeReplaceModal);
    const elFindNext = document.getElementById("replace-find-next");
    if(elFindNext) elFindNext.addEventListener("click", () => findInCurrentNote(true, true, false));
    const elReplaceNext = document.getElementById("replace-next");
    if(elReplaceNext) elReplaceNext.addEventListener("click", replaceNext);
    const elReplaceAll = document.getElementById("replace-all");
    if(elReplaceAll) elReplaceAll.addEventListener("click", replaceAll);
    const findInput = document.getElementById("replace-find");
    if(findInput) findInput.addEventListener("input", () => {
      updateReplaceCount();
      findInCurrentNote(false, false, true);
      updateEditorHighlight();
    });
    const matchCase = document.getElementById("replace-matchcase");
    if(matchCase) matchCase.addEventListener("change", () => {
      updateReplaceCount();
      updateEditorHighlight();
    });
    const wholeWord = document.getElementById("replace-wholeword");
    if(wholeWord) wholeWord.addEventListener("change", () => {
      updateReplaceCount();
      updateEditorHighlight();
    });
  }
  // Expose for DOMContentLoaded handler defined outside this IIFE.
  if(typeof window !== "undefined"){
    window.bindReplaceModal = bindReplaceModal;
    window.bindRenameModal = bindRenameModal;
  }

function fmtTime(iso){
    if(!iso) return "";
    try{ return new Date(iso).toLocaleString(); }catch(e){ return iso; }
  }

  function updateTabSortingInfo(){
    const el = document.getElementById("tabSortingInfo");
    if(!el) return;
    const label = (mruMode === "mru") ? "MRU" : "Classic";
    el.textContent = `Tab sorting: ${label}`;
  }


  function getActiveFilename(){
    // Prefer the active tab meta filename
    try{
      const t = getActiveTab && getActiveTab();
      if(t && t.meta){
        return (t.meta.filename || t.meta.file || t.meta.path || "").toString().trim();
      }
    }catch(e){}

    // Fallback: active tab label (display title)
    try{
      const active = document.querySelector(".tab.active .name");
      if(active && active.textContent) return active.textContent.trim();
    }catch(e){}

    // Fallback: fileName element if present
    try{
      const el = document.getElementById("fileName");
      if(el && el.textContent) return el.textContent.trim();
    }catch(e){}

    return "";
  }


  function setStatus(text){
    // Replace "Idle" in the sidebar with the last saved timestamp, if available.
    if(text === "Idle" && lastSavedIso){
      const fn = (typeof getActiveFilename === "function") ? getActiveFilename() : "";
      const title = (typeof getActiveTitle === "function") ? getActiveTitle() : "";
      const label = (title && title.trim()) ? title.trim() : (fn && fn.trim()) ? fn.trim() : "";
      elStatusLine.textContent = `Saved\n${fmtTime(lastSavedIso)}${label ? `\n${label}` : ""}`;
      return;
    }
    elStatusLine.textContent = text;
  }

  function setSaveState(state, whenIso){
    elSaveState.textContent = state;
    elSaveTime.textContent = whenIso ? fmtTime(whenIso) : "";

    if(state === "Saved" && whenIso){
      lastSavedIso = whenIso;
      // Mirror status to the sidebar header
      setStatus("Idle");
    }
  }

  
  function escapeHtml(s){
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function slugifyHeading(s){
    return (s || "")
      .toLowerCase()
      .replace(/<\/?[^>]+>/g, "")
      .replace(/[^a-z0-9\s_-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 48) || "section";
  }

  function buildHeadingIndex(md){
    const lines = (md || "").replace(/\r\n/g,"\n").split("\n");
    const counters = {};
    const out = [];
    let idx = 0;
    for(const raw of lines){
      const line = raw;
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if(m){
        const level = m[1].length;
        const text = m[2].trim();
        const base = slugifyHeading(text);
        const n = (counters[base] || 0) + 1;
        counters[base] = n;
        const id = n > 1 ? `${base}-${n}` : base;
        out.push({ level, text, id, index: idx });
      }
      idx += line.length + 1;
    }
    return out;
  }

  function renderMarkdown(md){
    const lines = (md || "").replace(/\r\n/g,"\n").split("\n");
    let out = "";
    let inCode = false;
    let codeBuf = [];
    let listMode = null;
    const headingCounters = {};

    const flushList = () => { if(listMode){ out += `</${listMode}>`; listMode=null; } };
    const flushCode = () => {
      if(inCode){
        out += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
        inCode = false; codeBuf = [];
      }
    };
    const inlineMd = (s) => {
      let x = escapeHtml(s);
      x = x.replace(/`([^`]+)`/g, (_m,c)=>`<code>${escapeHtml(c)}</code>`);
      x = x.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      x = x.replace(/\*([^*]+)\*/g, "<em>$1</em>");
      return x;
    };

    for(const raw of lines){
      const line = raw;

      if(line.trim().startsWith("```")){
        if(inCode) flushCode();
        else { flushList(); inCode = true; }
        continue;
      }
      if(inCode){ codeBuf.push(line); continue; }

      if(/^---\s*$/.test(line) || /^\*\*\*\s*$/.test(line)){ flushList(); out += "<hr/>"; continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if(h){
        flushList();
        const lvl = h[1].length;
        const text = h[2].trim();
        const base = slugifyHeading(text);
        const n = (headingCounters[base] || 0) + 1;
        headingCounters[base] = n;
        const id = n > 1 ? `${base}-${n}` : base;
        out += `<h${lvl} id="${id}">${inlineMd(text)}</h${lvl}>`;
        continue;
      }

      const bq = line.match(/^>\s?(.*)$/);
      if(bq){ flushList(); out += `<blockquote>${inlineMd(bq[1])}</blockquote>`; continue; }

      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if(ol){
        if(listMode !== "ol"){ flushList(); listMode="ol"; out += "<ol>"; }
        out += `<li>${inlineMd(ol[1])}</li>`;
        continue;
      }

      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if(ul){
        if(listMode !== "ul"){ flushList(); listMode="ul"; out += "<ul>"; }
        out += `<li>${inlineMd(ul[1])}</li>`;
        continue;
      }

      if(line.trim() === ""){ flushList(); continue; }

      flushList();
      out += `<p>${inlineMd(line)}</p>`;
    }

    flushCode(); flushList();
    return out;
  }

  function setPreviewMode(on){
    previewMode = !!on;
    if(!elPreview) return;

    if(previewMode){
      elPreview.innerHTML = renderMarkdown(elEditor.value || "");
      elPreview.style.display = "block";
      elEditor.style.display = "none";
      if(elEditorHighlight) elEditorHighlight.style.display = "none";
      elPreviewToggle.textContent = "Edit";
    } else {
      elPreview.style.display = "none";
      elEditor.style.display = "block";
      if(elEditorHighlight) elEditorHighlight.style.display = "";
      elPreviewToggle.textContent = "Preview";
    }
    updateToc();
  }

  function downloadPdf(){
    const t = getActiveTab();
    if(!t) return;

    const noteId = t.noteId;
    const title = (t.meta?.title || "").trim() || (t.meta?.filename || "note");
    fetch(`/api/notes/${encodeURIComponent(noteId)}/pdf`)
      .then(async (r) => {
        if(!r.ok){
          let detail = "";
          try{ detail = await r.text(); }catch(e){}
          throw new Error(`pdf_failed ${r.status} ${detail}`);
        }
        return r.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${sanitizeFilename(title)}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=>URL.revokeObjectURL(url), 1000);
      })
      .catch((e)=> { console.error(e); alert("PDF export failed. Check server logs."); });
  }

function enableActions(enabled){
    elPreviewToggle.disabled = !enabled;
    elPdf.disabled = !enabled;
    if(elRename){ elRename.disabled = !enabled; }
    elDownload.disabled = !enabled;
  }

  async function apiGet(url){
    const r = await fetch(url, {headers: {"Accept": "application/json"}});
    if(!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function apiPost(url, body){
    const r = await fetch(url, {method:"POST", headers: {"Content-Type":"application/json","Accept":"application/json"}, body: JSON.stringify(body||{})});
    if(!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function apiPut(url, body){
    const r = await fetch(url, {method:"PUT", headers: {"Content-Type":"application/json","Accept":"application/json"}, body: JSON.stringify(body||{})});
    if(!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function apiDelete(url){
    const r = await fetch(url, {method:"DELETE", headers: {"Accept":"application/json"}});
    if(!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function pinPrefix(meta){
    return meta && meta.pinned ? "* " : "";
  }

  function displayTitle(meta){
    const t = (meta.title || "").trim();
    if(t) return t;
    return meta.filename || meta.id;
  }

  function displayTitleWithPin(meta){
    return pinPrefix(meta) + displayTitle(meta);
  }

  function displayFilenameWithPin(meta){
    const fn = (meta && meta.filename) ? meta.filename : "-";
    return pinPrefix(meta) + fn;
  }

  function setFileName(meta){
    if(!elFileName) return;
    elFileName.textContent = displayFilenameWithPin(meta);
  }

  function makeNoteRow(meta){
    const row = document.createElement("div");
    row.className = "note-row" + (meta.pinned ? " pinned" : "");
    row.dataset.id = meta.id;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "note-check";
    cb.dataset.id = meta.id;
    cb.value = meta.id;
    cb.dataset.noteId = meta.id;
    cb.checked = selectedIds.has(String(meta.id));
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      toggleSelected(String(meta.id), cb.checked);
    });

    const content = document.createElement("div");
    content.className = "note-content";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = displayTitleWithPin(meta);

    const sub = document.createElement("div");
    sub.className = "sub";
    const left = document.createElement("div");
    left.textContent = meta.pinned ? "* pinned" : "unpinned";
    const right = document.createElement("div");
    right.textContent = "";
    sub.appendChild(left);
    sub.appendChild(right);

    content.appendChild(title);
    content.appendChild(sub);

    row.appendChild(cb);
    row.appendChild(content);

    row.addEventListener("click", () => openNoteInNewTab(meta.id));
    return row;
  }

  
  function toggleSelected(id, on){
    if(on) selectedIds.add(id);
    else selectedIds.delete(id);
  }

function renderNotesList(){
    elNotesList.innerHTML = "";
    elNotesCount.textContent = `Notes: ${notes.length}`;
    for(const meta of notes){
      elNotesList.appendChild(makeNoteRow(meta));
    }
  }

  
  function updateSortModeLabel(){
  const current = (typeof mruMode !== "undefined" && mruMode === "mru") ? "MRU" : "Classic";
  // top label (if present)
  if(typeof elSortModeLabel !== "undefined" && elSortModeLabel){
    elSortModeLabel.textContent = current;
  }
  // footer label
  const ft = document.getElementById("footerTabSorting");
  if(ft) ft.textContent = current;
}

function renderTabs(){
    elTabsBar.innerHTML = "";
    for(const t of tabs){
      const tab = document.createElement("div");
      tab.className = "tab" + (t.tabId === activeTabId ? " active" : "");
      tab.dataset.tabid = t.tabId;
      tab.dataset.noteId = t.noteId;

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = t.meta ? displayTitleWithPin(t.meta) : t.noteId;

      tab.appendChild(name);

      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.textContent = "x";
      close.title = "Close";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTab(t.tabId);
      });
      tab.appendChild(close);

      tab.addEventListener("click", () => activateTab(t.tabId));
      elTabsBar.appendChild(tab);
    }
  }


  function closeTab(tabId){
    const idx = tabs.findIndex(t => t.tabId === tabId);
    if(idx < 0) return;

    const wasActive = (activeTabId === tabId);
    tabs.splice(idx, 1);

    if(tabs.length === 0){
      activeTabId = null;
      enableActions(false);
      elEditor.value = "";
      elEditor.disabled = true;
      elFileName.textContent = "-";
      setSaveState("Idle", "");
      renderTabs();
      return;
    }

    if(wasActive){
      // Focus neighbor: prefer previous, else same index (now next)
      const nextIdx = Math.max(0, idx - 1);
      activeTabId = tabs[nextIdx].tabId;
      activateTab(activeTabId);
    } else {
      renderTabs();
    }
  }

  function getActiveTab(){
    return tabs.find(t => t.tabId === activeTabId) || null;
  }

  function activateTab(tabId){
    const t = tabs.find(x => x.tabId === tabId);
    if(!t) return;

    activeTabId = tabId;

    if(mruMode === "mru"){
      const idx = tabs.findIndex(x => x.tabId === tabId);
      if(idx > 0){
        const [moved] = tabs.splice(idx, 1);
        tabs.unshift(moved);
      }
    }

    isTyping = false;
    if(saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

    elEditor.disabled = false;
    elEditor.value = t.content || "";
    setFileName(t.meta);
    setSaveState("Saved", t.meta?.updated || "");
    enableActions(true);
    setPreviewMode(false);
    renderTabs();
    setStatus("Idle");
    updatePinButton();
    updateToc();
    elEditor.focus();
  }

  function newTabId(){
    return "tab_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  async function openNoteInNewTab(noteId){
    // If already open, focus the first matching tab
    const existing = tabs.find(t => t.noteId === noteId);
    if(existing){
      activateTab(existing.tabId);
      return;
    }
    setStatus("Loading note...");
    try{
      const data = await apiGet(`/api/notes/${encodeURIComponent(noteId)}`);
      const tab = {
        tabId: newTabId(),
        noteId,
        meta: data.meta,
        rev: data.meta?.rev || 0,
        content: data.content || "",
        lastLoadedContent: data.content || "",
      };
      tabs.push(tab);
      activeTabId = tab.tabId;
      renderTabs();
      activateTab(tab.tabId);
      updatePinButton();
      setStatus("Idle");
    }catch(e){
      console.error(e);
      setStatus("Error loading note");
    }
  }

  async function loadNotes(){
    const q = encodeURIComponent(elSearch.value.trim());
    const sort = encodeURIComponent(elSort.value);
    const url = q ? `/api/notes?sort=${sort}&q=${q}` : `/api/notes?sort=${sort}`;
    setStatus("Loading...");
    try{
      notes = await apiGet(url);
      renderNotesList();
      setStatus("Idle");
    }catch(e){
      console.error(e);
      setStatus("Error loading notes");
    }
  }

  async function createNote(){
    setStatus("Creating...");
    try{
      const meta = await apiPost("/api/notes", {ext: "md"});
      initSidebarResizer();
    await loadNotes();
    updateSortModeLabel();
      await openNoteInNewTab(meta.id);
    }catch(e){
      console.error(e);
      setStatus("Error creating note");
    }
  }

  async function saveContentNow(){
    const t = getActiveTab();
    if(!t) return;

    const content = elEditor.value;
    setSaveState("Saving...", "");

    try{
      const res = await apiPut(`/api/notes/${encodeURIComponent(t.noteId)}/content`, {
        content,
        base_rev: t.rev || 0
      });

      t.rev = res.rev || (t.rev + 1);
      t.meta.updated = res.updated;
      t.meta.rev = t.rev;
      t.content = content;
      t.lastLoadedContent = content;

      setSaveState("Saved", res.updated);
      setFileName(t.meta);
      await loadNotes();
      renderTabs();
    }catch(e){
      console.error(e);
      setSaveState("Save failed", "");
    }
  }

  function scheduleSave(){
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      isTyping = false;
      saveContentNow();
    }, 750);
  }


async function renameNote(){
    openRenameModal();
}

  async function togglePin(){
    const t = getActiveTab();
    if(!t) return;
    const nextPinned = !t.meta?.pinned;
    setStatus(nextPinned ? "Pinning..." : "Unpinning...");
    try{
      const meta = await apiPut(`/api/notes/${encodeURIComponent(t.noteId)}/meta`, {pinned: nextPinned});
      t.meta = meta;
      t.rev = meta.rev || t.rev;
      setFileName(t.meta);
      setStatus("Idle");
      await loadNotes();
      renderTabs();
      updatePinButton();
    }catch(e){
      console.error(e);
      setStatus("Error updating pin");
    }
  }

  function updatePinButton(){
    if(!elPin) return;
    const t = getActiveTab();
    const pinned = !!t?.meta?.pinned;
    elPin.textContent = pinned ? "Unpin" : "Pin";
  }

  async function deleteNote(){
    const t = getActiveTab();
    if(!t) return;
    const ok = confirm("Delete this note? It will be moved to trash.");
    if(!ok) return;

    setStatus("Deleting...");
    try{
      await apiDelete(`/api/notes/${encodeURIComponent(t.noteId)}`);
      const idx = tabs.findIndex(x => x.tabId === t.tabId);
      if(idx >= 0) tabs.splice(idx, 1);
      activeTabId = tabs.length ? tabs[tabs.length - 1].tabId : null;

      if(activeTabId){
        activateTab(activeTabId);
  }else{
        elEditor.value = "";
        setFileName(null);
        enableActions(false);
        elEditor.value = "";
        elEditor.disabled = true;
        setSaveState("Idle", "");
        renderTabs();
      }
    closeTabsForNotes([id]);

      await loadNotes();
      setStatus("Idle");
    }catch(e){
      console.error(e);
      setStatus("Error deleting note");
    }
  }

  function downloadAll(){
    window.location.href = "/api/export/all";
  }

  function downloadNote(){
    const t = getActiveTab();
    if(!t) return;
    window.location.href = `/api/notes/${encodeURIComponent(t.noteId)}/download`;
  }

  async function copyNoteLink(){
    const t = getActiveTab();
    if(!t) return;
    const url = `${window.location.origin}/?id=${encodeURIComponent(t.noteId)}`;
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        await navigator.clipboard.writeText(url);
        setStatus("Link copied");
      } else {
        prompt("Copy link:", url);
      }
    }catch(e){
      prompt("Copy link:", url);
    }
  }

  async function pollTabs(){
    if(isTyping) return;
    for(const t of tabs){
      try{
        const data = await apiGet(`/api/notes/${encodeURIComponent(t.noteId)}`);
        const remoteRev = data.meta?.rev || 0;
        if(remoteRev > (t.rev || 0)){
          t.rev = remoteRev;
          t.meta = data.meta;
          const remoteContent = data.content || "";
          t.content = remoteContent;

          if(t.tabId === activeTabId){
            setSaveState("Updated remotely", t.meta.updated);
            if(elEditor.value === t.lastLoadedContent){
              elEditor.value = remoteContent;
            }
            t.lastLoadedContent = remoteContent;
            setFileName(t.meta);
          } else {
            t.lastLoadedContent = remoteContent;
          }
        }
      }catch(e){
        // quiet
      }
    }
    renderTabs();
  }

  function setupPolling(){
    if(pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollTabs, 5000);
  }

  // Events
  elSearch.addEventListener("input", () => {
    if(fileView === "off"){
      searchInCurrentNote(false);
    } else {
      loadNotes();
    }
  });
  elSearch.addEventListener("keydown", (e) => {
    if(e.key === "Enter" && fileView === "off"){
      e.preventDefault();
      searchInCurrentNote(true);
    }
  });
  elSort.addEventListener("change", () => loadNotes());

  elNew.addEventListener("click", createNote);
  if(elSelectAll) elSelectAll.addEventListener("click", selectAll);
  if(elSelectNone) elSelectNone.addEventListener("click", selectNone);
  if(elDownloadSelected) elDownloadSelected.addEventListener("click", downloadSelected);
  if(elDeleteSelected) elDeleteSelected.addEventListener("click", deleteSelected);
  if(elRename){ elRename.addEventListener("click", renameNote); }  elDownload.addEventListener("click", downloadNote);  elPreviewToggle.addEventListener("click", () => setPreviewMode(!previewMode));
  if(elCopyLink){ elCopyLink.addEventListener("click", copyNoteLink); }
  if(elPin){ elPin.addEventListener("click", togglePin); }
  if(elTocToggle){ elTocToggle.addEventListener("click", () => setTocOpen(tocOpen !== "on")); }
  if(elTocDepth){ elTocDepth.addEventListener("change", updateToc); }
  elPdf.addEventListener("click", downloadPdf);
  elTheme.addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));
  elMru.addEventListener("click", () => setMruMode(mruMode === "mru" ? "fixed" : "mru"));
  elFileView.addEventListener("click", () => setFileViewMode(fileView === "on" ? "off" : "on"));
  const elReplaceBtn = $("replaceBtn");
  if(elReplaceBtn) elReplaceBtn.addEventListener("click", openReplaceModal);
  bindReplaceModal();
  bindRenameModal();

  elEditor.addEventListener("input", () => {
    if(previewMode && elPreview){ elPreview.innerHTML = renderMarkdown(elEditor.value || ""); }

    const t = getActiveTab();
    if(!t) return;
    isTyping = true;
    setSaveState("Editing...", "");
    scheduleSave();
    t.content = elEditor.value;
    updateEditorHighlight();
    updateToc();
  });
  elEditor.addEventListener("scroll", syncEditorHighlightScroll);

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey;

    if(ctrl && e.key.toLowerCase() === "k"){
      e.preventDefault();
      elSearch.focus();
      elSearch.select();
      return;
    }
    if(ctrl && e.key.toLowerCase() === "h"){
      e.preventDefault();
      openReplaceModal();
      return;
    }
    if(ctrl && e.key.toLowerCase() === "n"){
      e.preventDefault();
      createNote();
      return;
    }
    if(ctrl && e.key.toLowerCase() === "p"){
      e.preventDefault();
      togglePin();
      return;
    }
    if(ctrl && e.key.toLowerCase() === "b"){
      e.preventDefault();
      setFileViewMode(fileView === "on" ? "off" : "on");
      return;
    }
    if(ctrl && e.key.toLowerCase() === "x"){
      e.preventDefault();
      const t = getActiveTab();
      if(t) closeTab(t.tabId);
      return;
    }
    if(ctrl && e.key === "Tab"){
      e.preventDefault();
      if(!tabs.length) return;
      const idx = tabs.findIndex(t => t.tabId === activeTabId);
      if(idx < 0) return;
      if(e.shiftKey){
        const prev = (idx - 1 + tabs.length) % tabs.length;
        activateTab(tabs[prev].tabId);
      } else {
        const next = (idx + 1) % tabs.length;
        activateTab(tabs[next].tabId);
      }
      return;
    }
    if(e.key === "Escape"){
      const renameModal = document.getElementById("rename-modal");
      if(renameModal && !renameModal.classList.contains("hidden")){
        closeRenameModal();
        return;
      }
      const replacePanel = document.getElementById("replace-panel");
      if(replacePanel && !replacePanel.classList.contains("hidden")){
        closeReplaceModal();
        return;
      }
      if(document.activeElement === elSearch){
        elSearch.value = "";
        elSearch.blur();
        if(fileView === "off"){
          setStatus("Idle");
        } else {
          loadNotes();
        }
      }
    }
  });

  
  async function downloadSelected(){
    const ids = Array.from(selectedIds);
    if(!ids.length) return;
    const r = await fetch("/api/export_selected", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ids}),
    });
    if(!r.ok){ alert("Download failed"); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "notes-selected.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function deleteSelected(){
    if(deleteInProgress) { dlog("deleteSelected already running"); return; }
    deleteInProgress = true;
    try {
          dlog("deleteSelected start selectedIds=", Array.from(selectedIds));
      
          dlog("deleteSelected start selectedIds=", Array.from(selectedIds));
          const ids = Array.from(selectedIds);
          
          const openNoteIds = new Set((tabs || []).map(t => t.noteId));
          const willDeleteOpenTab = ids.some(id => openNoteIds.has(id));
if(!ids.length) return;
          if(!confirm(`Delete ${ids.length} note(s)?`)) return;
          for(const id of ids){
            try{ await fetch(`/api/notes/${id}`, {method:"DELETE"}); }catch(e){}
          }
              closeTabsForNotes(ids);
          selectedIds.clear();
          await loadNotes();
} finally {
      deleteInProgress = false;
    }
  }

  function selectAll(){
    notes.forEach(n => selectedIds.add(String(n.id)));
    renderNotesList();
  }

  function selectNone(){
    selectedIds.clear();
    renderNotesList();
  }



  function setSidebarWidth(px){
    const clamped = Math.max(260, Math.min(720, px));
    document.documentElement.style.setProperty("--sidebar-width", clamped + "px");
    try{ localStorage.setItem("sidebarWidth", String(clamped)); }catch(e){}
  }

  function initSidebarResizer(){
    if(!elSplitter) return;

    // restore
    try{
      const saved = localStorage.getItem("sidebarWidth");
      if(saved){
        const v = parseInt(saved, 10);
        if(!isNaN(v)) setSidebarWidth(v);
      }
    }catch(e){}

    const layoutEl = document.querySelector(".layout");
    let dragging = false;
    let layoutLeft = 0;

    const startDrag = (clientX) => {
      dragging = true;
      elSplitter.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      if(layoutEl){
        const r = layoutEl.getBoundingClientRect();
        layoutLeft = r.left;
      } else {
        layoutLeft = 0;
      }
      setSidebarWidth(clientX - layoutLeft);
    };

    const moveDrag = (clientX) => {
      if(!dragging) return;
      setSidebarWidth(clientX - layoutLeft);
    };

    const endDrag = () => {
      if(!dragging) return;
      dragging = false;
      elSplitter.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    // Pointer events (best cross-platform)
    elSplitter.addEventListener("pointerdown", (e) => {
      elSplitter.setPointerCapture(e.pointerId);
      startDrag(e.clientX);
      e.preventDefault();
    });

    elSplitter.addEventListener("pointermove", (e) => {
      moveDrag(e.clientX);
    });

    elSplitter.addEventListener("pointerup", () => endDrag());
    elSplitter.addEventListener("pointercancel", () => endDrag());

    // Fallback mouse for older browsers
    elSplitter.addEventListener("mousedown", (e) => {
      startDrag(e.clientX);
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => moveDrag(e.clientX));
    window.addEventListener("mouseup", () => endDrag());
  }

async function init(){
    setTheme(theme);
    setMruMode(mruMode);
    setFileViewMode(fileView);
    setTocOpen(tocOpen === "on");
    enableActions(false);
    elEditor.disabled = true;
    setSaveState("Idle", "");
    initSidebarResizer();
    await loadNotes();
    setupPolling();

    // Deep-link support: ?id=<note_id>
    const urlParams = new URLSearchParams(window.location.search || "");
    const deepId = (urlParams.get("id") || "").trim();
    if(deepId){
      try{
        await openNoteInNewTab(deepId);
        updateTabSortingInfo();
        return;
      }catch(e){
        // fall through to default behavior
      }
    }

    if(notes.length === 0){
      await createNote();
    } else {
      await openNoteInNewTab(notes[0].id);
    }
    updateTabSortingInfo();
  }

  if(typeof window !== "undefined"){
  window.__notesDebug = { tabs: () => tabs, selectedIds: () => Array.from(selectedIds), closeTabsForNotes, deleteSelected };
}

init();
})();


/* Sync (WebDAV) settings UI */
function $(id){ return document.getElementById(id); }

function openSyncModal(){
  const m = $("syncModal");
  if(!m) return;
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden","false");
}

function closeSyncModal(){
  const m = $("syncModal");
  if(!m) return;
  m.classList.add("hidden");
  m.setAttribute("aria-hidden","true");
}



  function closeTabsForNotes(noteIds){
  const ids = new Set((noteIds||[]).map(x => String(x)));
  if(typeof tabs === "undefined" || !Array.isArray(tabs)) { dlog("tabs not available"); return; }

  dlog("closeTabsForNotes noteIds=", Array.from(ids));
  dlog("tabs before=", tabs.map(t => t.noteId));

  const beforeLen = tabs.length;
  tabs = tabs.filter(t => !ids.has(String(t.noteId)));
  const removed = beforeLen - tabs.length;

  dlog("removed tabs=", removed);
  dlog("tabs after=", tabs.map(t => t.noteId));

  // If active tab got removed, pick a sensible next one
  if(activeTabId && ids.has(String(activeTabId))){
    activeTabId = tabs.length ? tabs[0].tabId : null;
  }

  renderTabsSafe();
}

async function loadSyncSettings(){
  try{
    const r = await fetch("/api/sync/settings");
    const j = await r.json();
    $("syncEnabled").checked = !!j.enabled;
    $("syncUrl").value = j.webdav_url || "";
    $("syncRemotePath").value = j.remote_path || "";
    $("syncUser").value = j.username || "";
    $("syncPass").value = j.password || "";
    $("syncMode").value = j.mode || "push";
    $("syncInterval").value = (j.interval_s || 60);
    $("syncNoDelete").checked = (j.no_deletes !== false);
  }catch(e){}
}

async function loadSyncStatus(){
  try{
    const r = await fetch("/api/sync/status");
    const j = await r.json();
    const t = j.last_time || "never";
    const res = j.last_result || "idle";
    const err = j.last_error ? (" - " + j.last_error) : "";
    $("syncStatus").textContent = `Status: ${res} (last: ${t})${err}`;
  }catch(e){
    const el = $("syncStatus");
    if(el) el.textContent = "Status: unavailable";
  }
}

async function saveSyncSettings(){
  const payload = {
    enabled: $("syncEnabled").checked,
    webdav_url: $("syncUrl").value.trim(),
    remote_path: $("syncRemotePath").value.trim(),
    username: $("syncUser").value.trim(),
    password: $("syncPass").value,
    mode: $("syncMode").value,
    interval_s: parseInt($("syncInterval").value || "60", 10),
    no_deletes: $("syncNoDelete").checked
  };
  const r = await fetch("/api/sync/settings", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  $("syncStatus").textContent = j.ok ? "Status: saved" : ("Status: error - " + (j.error||""));
  await loadSyncStatus();
  await updateTopSyncStatus();
}

async function testSync(){
  const payload = {
    webdav_url: $("syncUrl").value.trim(),
    remote_path: $("syncRemotePath").value.trim(),
    username: $("syncUser").value.trim(),
    password: $("syncPass").value
  };
  const r = await fetch("/api/sync/test", {
    method:"POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  $("syncStatus").textContent = j.ok ? "Status: connection OK" : ("Status: connection failed - " + (j.error||""));
  await loadSyncStatus();
  await updateTopSyncStatus();
}

async function runSyncNow(){
  // Ensure settings are persisted so the sidecar can read them
  await saveSyncSettings();

  const r = await fetch("/api/sync/run", {method:"POST"});
  const j = await r.json();
  $("syncStatus").textContent = j.ok ? "Status: sync requested" : ("Status: error - " + (j.error||""));
  await loadSyncStatus();
  await updateTopSyncStatus();
  setTimeout(loadSyncStatus, 1200);
  setTimeout(updateTopSyncStatus, 1200);
  setTimeout(loadSyncStatus, 3500);
  setTimeout(updateTopSyncStatus, 3500);
}

document.addEventListener("DOMContentLoaded", ()=>{
  if(typeof window !== "undefined" && typeof window.bindReplaceModal === "function"){
    window.bindReplaceModal();
  }
  if(typeof window !== "undefined" && typeof window.bindRenameModal === "function"){
    window.bindRenameModal();
  }
  elSortModeLabel = document.getElementById("tabSortingInfo");
  elRename = document.getElementById("renameNote");
  const b = $("syncBtn");
  if(b){
    b.addEventListener("click", async ()=>{
      openSyncModal();
      await loadSyncSettings();
      await loadSyncStatus();
  await updateTopSyncStatus();
    });
  }
  const c = $("syncCloseBtn");
  if(c) c.addEventListener("click", closeSyncModal);
  const m = $("syncModal");
  if(m){
    m.addEventListener("click", (ev)=>{
      const t = ev.target;
      if(t && t.getAttribute && t.getAttribute("data-close")==="sync") closeSyncModal();
    });
  }
  const s = $("syncSaveBtn"); if(s) s.addEventListener("click", saveSyncSettings);
  const t = $("syncTestBtn"); if(t) t.addEventListener("click", testSync);
  const r = $("syncRunBtn"); if(r) r.addEventListener("click", runSyncNow);
});


function handleDeletedNotes(ids){
  if(!Array.isArray(ids)) ids = [ids];

  // Close any open tabs for deleted notes
  try{
    ids.forEach((id)=>{
      if(typeof closeTabById === "function") closeTabById(id);
    });
  }catch(e){}

  // If the current note was deleted, switch immediately
  try{
    const activeId = (typeof getActiveNoteId === "function") ? getActiveNoteId() : null;
    if(activeId && ids.includes(activeId)){
      if(window.openTabs && window.openTabs.length > 0){
        activateTab(window.openTabs[0].id);
      }else if(window.allNotes && window.allNotes.length > 0){
        openNoteInNewTab(window.allNotes[0].id);
      }else{
        createNote();
      }
    }
  }catch(e){}
}


async function updateTopSyncStatus(){
  const el = document.getElementById("footerSyncSummary");
  const btn = document.getElementById("pauseSyncBtn");
  if(!el) return;

  try{
    const s = await fetch("/api/sync/settings");
    const settings = await s.json();

    if(!settings || !settings.enabled){
      el.textContent = "disabled";
      if(btn){ btn.classList.add("hidden"); }
      return;
    }

    const paused = !!settings.paused;

    const r = await fetch("/api/sync/status");
    const st = await r.json();
    let res = st.last_result || (paused ? "paused" : "idle");
    if(res === "pause") res = "paused";
    const t = st.last_time || "never";

    const stateTxt = paused ? "enabled (paused)" : "enabled";
    el.textContent = `${stateTxt} • last: ${t} • status: ${res}`;

    if(btn){
      btn.classList.remove("hidden");
      btn.textContent = paused ? "Resume Sync" : "Pause Sync";
      btn.dataset.paused = paused ? "true" : "false";
    }
  }catch(e){
    // silent
  }
}

document.addEventListener("DOMContentLoaded", ()=>{
  updateTopSyncStatus();
  setInterval(updateTopSyncStatus, 5000);
});


async function togglePauseSync(){
  const btn = document.getElementById("pauseSyncBtn");
  if(!btn) return;

  try{
    const s0 = await fetch("/api/sync/settings");
    const settings0 = await s0.json();
    const currentlyPaused = !!(settings0 && settings0.paused);

    const targetPaused = !currentlyPaused;

    const r = await fetch("/api/sync/pause", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({paused: targetPaused})
    });
    const j = await r.json();
    if(!j.ok){
      return;
    }

    await loadSyncSettings();
    await loadSyncStatus();
    await updateTopSyncStatus();
  }catch(e){
    // silent
  }
}








document.addEventListener("keydown", (e)=>{
  const key = (e.key || "").toLowerCase();
  // Rename: Ctrl+Shift+R (may be intercepted by browser in some cases)
  if(e.ctrlKey && e.shiftKey && !e.altKey && key === "r"){
    e.preventDefault();
    const btn = document.getElementById("renameNote");
    if(btn && !btn.classList.contains("hidden")) btn.click();
  }
});


document.addEventListener("DOMContentLoaded", ()=>{
  const p = document.getElementById("pauseSyncBtn");
  if(p) p.addEventListener("click", togglePauseSync);
});


function sanitizeFilename(name){
  const n = (name || "note").toString().trim() || "note";
  return n.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0,120).replace(/^_+|_+$/g,"") || "note";
}
