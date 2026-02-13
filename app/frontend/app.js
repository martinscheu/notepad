
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
  const elJournalToday = $("journalToday");
  const elUpload = $("uploadNote");
  const elUploadInput = $("uploadInput");
  const elSelectAll = $("selectAll");
  const elSelectNone = $("selectNone");
  const elDownloadSelected = $("downloadSelected");
  const elDeleteSelected = $("deleteSelected");
  const elPreviewToggle = $("previewToggle");
  const elPreviewFormat = $("previewFormat");
  const elTocToggle = $("tocToggle");
  const elPdf = $("pdfNote");
  const elRename = $("renameNote");  const elDownload = $("downloadNote");
  const elCopyLink = $("copyLink");
  const elPin = $("pinNote");
  const elDownloadBtn = $("downloadBtn");
  const elMoreBtn = $("moreBtn");
  const elFileView = $("fileViewToggle");
  const elUndo = $("undoBtn");
  const elRedo = $("redoBtn");

  const elPreview = $("preview");
  const elEditor = $("editor");
  const elEditorHighlight = $("editorHighlight");
  const elEditorHighlightTop = $("editorHighlightTop");
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
  let previewFormat = (localStorage.getItem("sn_preview_format") || "md");
  let groupState = {};
  selectedIds = new Set();
let deleteInProgress = false;

  let lastSavedIso = "";

  let theme = localStorage.getItem("sn_theme") || "light";
  let mruMode = (localStorage.getItem("sn_mru") || "fixed"); // "fixed"(classic) | "mru"
  let fileView = (localStorage.getItem("sn_fileview") || localStorage.getItem("sn_sidebar") || "on"); // "on" | "off"
  let tocOpen = (localStorage.getItem("sn_toc") || "off");

  function setMruMode(mode){
    mruMode = (mode === "mru") ? "mru" : "fixed";
    localStorage.setItem("sn_mru", mruMode);
    const ss = document.getElementById("settingsTabSort");
    if(ss) ss.value = mruMode;
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
    localStorage.setItem("sn_theme", t);
    const st = document.getElementById("settingsTheme");
    if(st) st.value = t;
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

  function findPrevMatch(text, query, beforeIndex, matchCase, wholeWord){
    if(!query) return null;
    const hay = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? query : query.toLowerCase();
    let idx = hay.lastIndexOf(needle, Math.max(0, beforeIndex - 1));
    while(idx !== -1){
      if(wholeWord){
        const before = idx > 0 ? text[idx - 1] : "";
        const after = (idx + query.length < text.length) ? text[idx + query.length] : "";
        if(isWordChar(before) || isWordChar(after)){
          idx = hay.lastIndexOf(needle, idx - 1);
          continue;
        }
      }
      return { start: idx, end: idx + query.length };
    }
    return null;
  }

  function updateEditorValueAndSchedule(value){
    elEditor.value = value;
    if(previewMode && elPreview){ renderPreview(); }
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

  function buildTopHighlightHtml(text, matches, currentIdx){
    if(currentIdx < 0 || currentIdx >= matches.length) return "";
    const m = matches[currentIdx];
    let out = escapeForHighlight(text.slice(0, m.start));
    out += `<span class="hl-current-text">${escapeForHighlight(text.slice(m.start, m.end))}</span>`;
    out += escapeForHighlight(text.slice(m.end));
    return out;
  }

  function buildHighlightHtml(text, matches, currentIdx){
    if(!matches.length){
      return escapeForHighlight(text);
    }
    let out = "";
    let last = 0;
    for(let i = 0; i < matches.length; i++){
      const m = matches[i];
      out += escapeForHighlight(text.slice(last, m.start));
      const cls = i === currentIdx ? "hl-current" : "hl";
      const id = i === currentIdx ? ' id="hl-active"' : "";
      out += `<span class="${cls}"${id}>${escapeForHighlight(text.slice(m.start, m.end))}</span>`;
      last = m.end;
    }
    out += escapeForHighlight(text.slice(last));
    return out;
  }

  function getCurrentMatchIndex(matches){
    const selStart = elEditor.selectionStart || 0;
    const selEnd = elEditor.selectionEnd || 0;
    let idx = matches.findIndex(m => m.start === selStart && m.end === selEnd);
    if(idx === -1){
      idx = matches.findIndex(m => m.start >= selStart);
    }
    return idx === -1 ? 0 : idx;
  }

  function setHighlightContent(html, topHtml){
    elEditorHighlight.innerHTML = `<div class="editor-highlight-inner">${html}</div>`;
    if(elEditorHighlightTop){
      elEditorHighlightTop.innerHTML = topHtml
        ? `<div class="editor-highlight-top-inner">${topHtml}</div>`
        : "";
    }
    syncEditorHighlightScroll();
  }

  function updateEditorHighlight(){
    if(!elEditorHighlight) return;
    const text = elEditor.value || "";
    const status = document.getElementById("replace-status");
    if(text.length > 50000){
      setHighlightContent(escapeForHighlight(text));
      if(status) status.textContent = "Highlight disabled for large notes.";
      return;
    }
    const { matchCase, wholeWord, query } = getReplaceOptions();
    if(!query){
      setHighlightContent(escapeForHighlight(text));
      return;
    }
    const matches = computeMatches(text, query, matchCase, wholeWord);
    const curIdx = matches.length ? getCurrentMatchIndex(matches) : -1;
    setHighlightContent(
      buildHighlightHtml(text, matches, curIdx),
      buildTopHighlightHtml(text, matches, curIdx)
    );
  }

  function syncHighlightGeometry(){
    if(!elEditorHighlight) return;
    const sbw = elEditor.offsetWidth - elEditor.clientWidth;
    elEditorHighlight.style.right = sbw + "px";
    if(elEditorHighlightTop) elEditorHighlightTop.style.right = sbw + "px";
  }

  function syncEditorHighlightScroll(){
    if(!elEditorHighlight) return;
    syncHighlightGeometry();
    const tx = `translate(${-elEditor.scrollLeft}px, ${-elEditor.scrollTop}px)`;
    requestAnimationFrame(() => {
      const inner = elEditorHighlight.firstElementChild;
      if(inner) inner.style.transform = tx;
      if(elEditorHighlightTop){
        const topInner = elEditorHighlightTop.firstElementChild;
        if(topInner) topInner.style.transform = tx;
      }
    });
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
    updateEditorHighlight();
  }

  function findInCurrentNotePrev(){
    const { matchCase, wholeWord, query } = getReplaceOptions();
    if(!query) return;
    const t = getActiveTab();
    if(!t) return;
    const text = elEditor.value || "";
    const before = elEditor.selectionStart || text.length;
    let match = findPrevMatch(text, query, before, matchCase, wholeWord);
    if(!match && before < text.length){
      match = findPrevMatch(text, query, text.length, matchCase, wholeWord);
    }
    if(match){
      elEditor.focus();
      elEditor.setSelectionRange(match.start, match.end);
    } else {
      const status = document.getElementById("replace-status");
      if(status) status.textContent = "No match found.";
    }
    updateReplaceCount();
    updateEditorHighlight();
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

  function getDefaultPdfMeta(){
    return {
      author: "",
      company: "",
      version: "",
      date: "",
      use_export_date: true,
      tlp: "AMBER",
    };
  }

  function getDocDefaults(){
    try{
      const raw = localStorage.getItem("sn_doc_defaults");
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return { author: "", company: "", tlp: "AMBER" };
  }

  function applyPdfUseExportDateState(){
    const useExport = $("pdfUseExportDate");
    const dateInput = $("pdfDate");
    if(!useExport || !dateInput) return;
    dateInput.disabled = !!useExport.checked;
    dateInput.classList.toggle("is-disabled", !!useExport.checked);
  }

  function setPdfFields(pdf){
    const defaults = getDocDefaults();
    const p = Object.assign(getDefaultPdfMeta(), (pdf || {}));
    const author = $("pdfAuthor");
    const company = $("pdfCompany");
    const version = $("pdfVersion");
    const date = $("pdfDate");
    const useExport = $("pdfUseExportDate");
    const tlp = $("pdfTlp");
    if(author) author.value = p.author || defaults.author || "";
    if(company) company.value = p.company || defaults.company || "";
    if(version) version.value = p.version || "";
    if(date) date.value = p.date || "";
    if(useExport) useExport.checked = !!p.use_export_date;
    if(tlp) tlp.value = (p.tlp || defaults.tlp || "AMBER").toUpperCase();
    applyPdfUseExportDateState();
  }

  function readPdfFields(){
    return {
      author: ($("pdfAuthor")?.value || "").trim(),
      company: ($("pdfCompany")?.value || "").trim(),
      version: ($("pdfVersion")?.value || "").trim(),
      date: ($("pdfDate")?.value || "").trim(),
      use_export_date: !!$("pdfUseExportDate")?.checked,
      tlp: (($("pdfTlp")?.value || "AMBER").trim().toUpperCase()),
    };
  }

  async function loadPdfSettingsForActiveNote(){
    const t = getActiveTab();
    if(!t) return;
    try{
      const pdf = await apiGet(`/api/notes/${encodeURIComponent(t.noteId)}/pdf-settings`);
      t.meta = t.meta || {};
      t.meta.pdf = pdf;
      setPdfFields(pdf);
    }catch(e){
      setPdfFields((t.meta && t.meta.pdf) || null);
    }
  }

  function openRenameModal(mode){
    const modal = document.getElementById("rename-modal");
    if(!modal) return;
    const t = getActiveTab();
    if(!t) return;
    const input = document.getElementById("rename-input");
    const subjectInput = document.getElementById("subject-input");
    const renameSection = document.getElementById("rename-section");
    const metadataSection = document.getElementById("metadata-section");
    const titleEl = document.getElementById("rename-title");
    if(mode === "metadata"){
      if(renameSection) renameSection.style.display = "none";
      if(metadataSection) metadataSection.style.display = "";
      if(titleEl) titleEl.textContent = "Document metadata";
    } else if(mode === "rename"){
      if(renameSection) renameSection.style.display = "";
      if(metadataSection) metadataSection.style.display = "none";
      if(titleEl) titleEl.textContent = "Rename note";
    } else {
      if(renameSection) renameSection.style.display = "";
      if(metadataSection) metadataSection.style.display = "";
      if(titleEl) titleEl.textContent = "Rename note";
    }
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden","false");
    if(input){
      input.value = (t.meta && (t.meta.title || t.meta.display_title || t.meta.user_title || "")) || "";
      if(mode !== "metadata") setTimeout(() => { input.focus(); input.select(); }, 0);
    }
    if(subjectInput){
      subjectInput.value = (t.meta && (t.meta.subject || "")) || "";
    }
    const dl = document.getElementById("subject-suggestions");
    if(dl){
      const subjects = [...new Set(notes.map(n => (n.subject || "").trim()).filter(Boolean))].sort();
      dl.innerHTML = subjects.map(s => `<option value="${s.replace(/"/g,'&quot;')}">`).join("");
    }
    const encCheckbox = document.getElementById("noteEncrypted");
    if(encCheckbox) encCheckbox.checked = !!(t.meta && t.meta.encrypted);
    setPdfFields((t.meta && t.meta.pdf) || null);
    loadPdfSettingsForActiveNote();
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
    const subjectInput = document.getElementById("subject-input");
    const newTitle = (input ? input.value : "").trim();
    const newSubject = (subjectInput ? subjectInput.value : "").trim();
    const pdfPayload = readPdfFields();
    setStatus("Renaming...");
    try{
      const meta = await apiPut(
        `/api/notes/${encodeURIComponent(t.noteId)}/meta`,
        {user_title: newTitle, title: newTitle, subject: newSubject}
      );
      try{
        const pdfRes = await apiPut(
          `/api/notes/${encodeURIComponent(t.noteId)}/pdf-settings`,
          pdfPayload
        );
        if(pdfRes && pdfRes.pdf){
          meta.pdf = pdfRes.pdf;
        }
        // Update encrypted from pdfRes meta if TLP:RED auto-encrypted
        if(pdfRes && pdfRes.meta && pdfRes.meta.encrypted !== undefined){
          meta.encrypted = pdfRes.meta.encrypted;
        }
      }catch(e){
        console.error(e);
      }

      // Handle encryption toggle
      const encCheckbox = document.getElementById("noteEncrypted");
      if(encCheckbox){
        const wantEncrypted = encCheckbox.checked;
        const isEncrypted = !!(meta.encrypted);
        if(wantEncrypted !== isEncrypted){
          try{
            const encRes = await apiPut(
              `/api/notes/${encodeURIComponent(t.noteId)}/encrypt`,
              {encrypted: wantEncrypted}
            );
            if(encRes && encRes.meta){
              Object.assign(meta, encRes.meta);
            } else if(encRes && encRes.encrypted !== undefined){
              meta.encrypted = encRes.encrypted;
            }
          }catch(e){
            console.error("Encryption toggle failed:", e);
            alert("Encryption toggle failed. " + (e.message || "Check that a passphrase is configured in Settings."));
          }
        }
      }

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
    const useExport = document.getElementById("pdfUseExportDate");
    if(useExport) useExport.addEventListener("change", applyPdfUseExportDateState);
    const input = document.getElementById("rename-input");
    if(input) input.addEventListener("keydown", (e) => {
      if(e.key === "Enter"){
        e.preventDefault();
        saveRenameFromModal();
      }
    });
    const subjectInput = document.getElementById("subject-input");
    if(subjectInput) subjectInput.addEventListener("keydown", (e) => {
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
    const elFindPrev = document.getElementById("replace-find-prev");
    if(elFindPrev) elFindPrev.addEventListener("click", findInCurrentNotePrev);
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
    // Settings modal dropdown is updated via setMruMode
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

  const CITE_START = "\uE200";
  const CITE_END = "\uE201";
  const CITE_SEP = "\uE202";
  const CITE_RE = new RegExp(`${CITE_START}cite${CITE_SEP}([\\s\\S]+?)${CITE_END}`, "g");
  function normalizeCitations(text){
    if(!text) return text;
    const replaced = String(text).replace(CITE_RE, (_m, inner) => {
      const parts = String(inner || "").split(CITE_SEP).filter(Boolean);
      return parts.length ? `[cite: ${parts.join(", ")}]` : "[cite]";
    });
    return replaced.replace(new RegExp(`[${CITE_START}${CITE_SEP}${CITE_END}]`, "g"), "");
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
      const parts = String(s || "").split("`");
      let x = "";
      for(let i = 0; i < parts.length; i++){
        const seg = parts[i];
        if(i % 2 === 1){
          x += `<code>${escapeHtml(seg)}</code>`;
        } else {
          x += escapeHtml(seg);
        }
      }
      x = x.replace(/\*\*([\s\S]+?)\*\*/g, (m, inner) => {
        const safe = String(inner || "").replace(/\*/g, "&#42;");
        return `<strong>${safe}</strong>`;
      });
      x = x.replace(/(^|[^*])\*([^\s*][^*]*?[^\s*])\*([^*]|$)/g, "$1<em>$2</em>$3");
      return x;
    };

    const splitTableRow = (line) => {
      let s = (line || "").trim();
      if(s.startsWith("|")) s = s.slice(1);
      if(s.endsWith("|")) s = s.slice(0, -1);
      return s.split("|").map(c => c.trim());
    };
    const isTableSep = (line) => {
      if(!line || !line.includes("|")) return false;
      let s = line.trim();
      if(s.startsWith("|")) s = s.slice(1);
      if(s.endsWith("|")) s = s.slice(0, -1);
      if(!s.trim()) return false;
      const parts = s.split("|").map(c => c.trim());
      return parts.every(p => /^:?-{3,}:?$/.test(p));
    };
    const cellAlign = (cell) => {
      const c = (cell || "").trim();
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if(left && right) return "center";
      if(right) return "right";
      return "left";
    };

    for(let i = 0; i < lines.length; i++){
      const line = lines[i];

      if(line.trim().startsWith("```")){
        if(inCode) flushCode();
        else { flushList(); inCode = true; }
        continue;
      }
      if(inCode){ codeBuf.push(line); continue; }

      const next = lines[i + 1];
      if(next && isTableSep(next) && line.includes("|")){
        flushList();
        const headers = splitTableRow(line);
        const aligns = splitTableRow(next).map(cellAlign);
        const rows = [];
        i += 2;
        for(; i < lines.length; i++){
          const rowLine = lines[i];
          if(!rowLine || !rowLine.includes("|")) break;
          if(rowLine.trim() === "") break;
          rows.push(splitTableRow(rowLine));
        }
        i -= 1;

        out += "<table><thead><tr>";
        for(let c = 0; c < headers.length; c++){
          const a = aligns[c] || "left";
          out += `<th style="text-align:${a}">${inlineMd(headers[c] || "")}</th>`;
        }
        out += "</tr></thead><tbody>";
        for(const row of rows){
          out += "<tr>";
          for(let c = 0; c < headers.length; c++){
            const a = aligns[c] || "left";
            out += `<td style="text-align:${a}">${inlineMd(row[c] || "")}</td>`;
          }
          out += "</tr>";
        }
        out += "</tbody></table>";
        continue;
      }

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

  function setPreviewFormat(fmt){
    previewFormat = (fmt === "json" || fmt === "yaml" || fmt === "md" || fmt === "txt") ? fmt : "md";
    localStorage.setItem("sn_preview_format", previewFormat);
    if(elPreviewFormat){ elPreviewFormat.value = previewFormat; }
    if(previewMode){ renderPreview(); }
  }

  let previewToken = 0;
  async function renderPreview(){
    if(!previewMode || !elPreview) return;
    const text = elEditor.value || "";

    if(previewFormat === "yaml"){
      const token = ++previewToken;
      elPreview.innerHTML = `<div class="muted">Validating YAML...</div>`;
      try{
        const r = await fetch("/api/preview/yaml", {
          method: "POST",
          headers: {"Content-Type":"application/json","Accept":"application/json"},
          body: JSON.stringify({text})
        });
        if(token !== previewToken) return;
        const data = await r.json().catch(() => ({}));
        if(!r.ok){
          const msg = (data && data.error) ? data.error : "YAML validation failed";
          elPreview.innerHTML = `<div class="muted">YAML error: ${escapeHtml(msg)}</div>`;
          return;
        }
        if(data && data.ok){
          const pretty = data.pretty || "";
          elPreview.innerHTML = `<pre><code class="language-yaml">${escapeHtml(pretty)}</code></pre>`;
          injectCopyButtons();
        } else {
          const msg = (data && data.error) ? data.error : "Invalid YAML";
          elPreview.innerHTML = `<div class="muted">YAML error: ${escapeHtml(msg)}</div>`;
        }
      }catch(e){
        if(token !== previewToken) return;
        const msg = e && e.message ? e.message : String(e);
        elPreview.innerHTML = `<div class="muted">YAML error: ${escapeHtml(msg)}</div>`;
      }
      return;
    }

    if(previewFormat === "json"){
      const trimmed = (text || "").trim();
      if(!trimmed){
        elPreview.innerHTML = "";
        return;
      }
      try{
        const parsed = JSON.parse(trimmed);
        const pretty = JSON.stringify(parsed, null, 2);
        elPreview.innerHTML = `<pre><code class="language-json">${escapeHtml(pretty)}</code></pre>`;
        injectCopyButtons();
      }catch(e){
        const msg = e && e.message ? e.message : String(e);
        elPreview.innerHTML = `<div class="muted">JSON error: ${escapeHtml(msg)}</div>`;
      }
      return;
    }

    if(previewFormat === "txt"){
      elPreview.innerHTML = `<pre><code class="language-text">${escapeHtml(text)}</code></pre>`;
      injectCopyButtons();
      return;
    }

    elPreview.innerHTML = renderMarkdown(text);
    injectCopyButtons();
  }

  function copyToClipboard(text){
    if(navigator.clipboard && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text).catch(() => copyFallback(text));
    }
    return copyFallback(text);
  }
  function copyFallback(text){
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  function injectCopyButtons(){
    if(!elPreview) return;
    elPreview.querySelectorAll("pre").forEach(pre => {
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code");
        const txt = code ? code.textContent : pre.textContent;
        copyToClipboard(txt).then(() => {
          btn.textContent = "Copied";
          setTimeout(() => { btn.textContent = "Copy"; }, 1500);
        });
      });
      pre.appendChild(btn);
    });
  }

  function setPreviewMode(on){
    previewMode = !!on;
    if(!elPreview) return;

    if(previewMode){
      renderPreview();
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
    const format = (previewFormat === "md") ? "md" : "txt";
    fetch(`/api/notes/${encodeURIComponent(noteId)}/pdf?format=${encodeURIComponent(format)}`)
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
    if(elPdf) elPdf.disabled = !enabled;
    if(elRename){ elRename.disabled = !enabled; }
    if(elDownload) elDownload.disabled = !enabled;
    if(elDownloadBtn) elDownloadBtn.disabled = !enabled;
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

  function normalizeSubject(s){
    return (s || "").trim();
  }

  function getGroupKey(meta){
    const sub = normalizeSubject(meta.subject);
    return sub || "Unsorted";
  }

  function loadGroupState(){
    try{
      const raw = localStorage.getItem("sn_group_state");
      if(raw) groupState = JSON.parse(raw) || {};
    }catch(e){
      groupState = {};
    }
  }

  function saveGroupState(){
    try{
      localStorage.setItem("sn_group_state", JSON.stringify(groupState || {}));
    }catch(e){}
  }

  function toggleGroup(key){
    groupState[key] = !groupState[key];
    saveGroupState();
    renderNotesList();
  }

  function makeGroupHeader(name, count, collapsed){
    const header = document.createElement("div");
    header.className = "note-group-header";
    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.alignItems = "center";

    const caret = document.createElement("span");
    caret.className = "note-group-caret";
    caret.textContent = collapsed ? "▶" : "▼";
    left.appendChild(caret);

    const title = document.createElement("div");
    title.className = "note-group-title";
    title.textContent = name;
    left.appendChild(title);

    const right = document.createElement("div");
    right.className = "note-group-count";
    right.textContent = `${count}`;

    header.appendChild(left);
    header.appendChild(right);
    return header;
  }

  function setEncryptedBadge(meta){
    const badge = document.getElementById("encryptedBadge");
    if(!badge) return;
    if(meta && meta.encrypted){
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  function setFileName(meta){
    if(!elFileName) return;
    elFileName.textContent = displayFilenameWithPin(meta);
    setTlpBadge(meta);
    setEncryptedBadge(meta);
  }

  function setTlpBadge(meta){
    const badge = document.getElementById("tlpBadge");
    if(!badge){
      return;
    }
    if(!meta){
      badge.classList.add("hidden");
      return;
    }
    const tlpRaw = (meta.pdf && meta.pdf.tlp) ? String(meta.pdf.tlp) : "AMBER";
    const tlp = tlpRaw.toUpperCase();
    badge.textContent = `TLP: ${tlp}`;
    badge.classList.remove("hidden", "tlp-clear", "tlp-green", "tlp-amber", "tlp-red");
    if(tlp === "CLEAR"){
      badge.classList.add("tlp-clear");
    }else if(tlp === "GREEN"){
      badge.classList.add("tlp-green");
    }else if(tlp === "AMBER+STRICT"){
      badge.classList.add("tlp-amber-strict");
    }else if(tlp === "RED"){
      badge.classList.add("tlp-red");
    }else{
      badge.classList.add("tlp-amber");
    }
  }

  const TLP_CYCLE = ["CLEAR", "GREEN", "AMBER", "AMBER+STRICT", "RED"];
  async function cycleTlp(){
    const t = getActiveTab();
    if(!t || !t.meta) return;
    const cur = (t.meta.pdf && t.meta.pdf.tlp) ? String(t.meta.pdf.tlp).toUpperCase() : "AMBER";
    const idx = TLP_CYCLE.indexOf(cur);
    const next = TLP_CYCLE[(idx + 1) % TLP_CYCLE.length];
    const pdf = Object.assign({}, t.meta.pdf || {}, {tlp: next});
    try{
      const res = await apiPut(
        `/api/notes/${encodeURIComponent(t.noteId)}/pdf-settings`,
        pdf
      );
      if(res && res.pdf) t.meta.pdf = res.pdf;
      if(res && res.meta && res.meta.encrypted !== undefined){
        t.meta.encrypted = res.meta.encrypted;
        setEncryptedBadge(t.meta);
      }
      setTlpBadge(t.meta);
    }catch(e){
      console.error("TLP update failed:", e);
    }
  }

  function makeNoteRow(meta, isActive){
    const row = document.createElement("div");
    row.className = "note-row" + (meta.pinned ? " pinned" : "") + (isActive ? " active" : "");
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

  // --- Journal tree ---
  const MONTH_NAMES = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
  const JOURNAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})\s+(\w+)/;

  function parseJournalTitle(title){
    const m = (title || "").match(JOURNAL_DATE_RE);
    if(!m) return null;
    return { year: m[1], month: m[2], day: m[3], dayName: m[4] };
  }

  async function openJournalToday(){
    const dateStr = new Date().toLocaleDateString("en-CA"); // "YYYY-MM-DD"
    setStatus("Opening journal...");
    try{
      const res = await apiPost("/api/journal/today", { date: dateStr });
      const noteId = res.id;
      await loadNotes();
      await openNoteInNewTab(noteId);
      setStatus("Idle");
    }catch(e){
      console.error(e);
      setStatus("Error opening journal");
    }
  }

  async function openJournalAggregate(year, month){
    const aggId = month ? `journal-agg-${year}-${month}` : `journal-agg-${year}`;
    // If already open, focus it
    const existing = tabs.find(t => t.tabId === aggId);
    if(existing){
      activateTab(existing.tabId);
      return;
    }
    setStatus("Loading journal...");
    try{
      const params = month ? `year=${year}&month=${month}` : `year=${year}`;
      const data = await apiGet(`/api/journal/aggregate?${params}`);
      const entries = data.entries || [];
      let md = "";
      for(const e of entries){
        md += `## ${e.title}\n\n${e.content || ""}\n\n---\n\n`;
      }
      if(!entries.length) md = "*No journal entries for this period.*";
      const tabTitle = month ? `Journal: ${year}-${month}` : `Journal: ${year}`;
      const tab = {
        tabId: aggId,
        noteId: null,
        isAggregate: true,
        meta: { title: tabTitle },
        rev: 0,
        content: md,
        lastLoadedContent: md,
      };
      tabs.push(tab);
      activeTabId = tab.tabId;
      renderTabs();
      activateTab(tab.tabId);
      setStatus("Idle");
    }catch(e){
      console.error(e);
      setStatus("Error loading journal aggregate");
    }
  }

  function renderJournalTree(journalNotes, activeNoteId){
    // Build tree: { year: { month: [{ meta, day, dayName }] } }
    const tree = {};
    for(const meta of journalNotes){
      const p = parseJournalTitle(meta.title);
      if(!p) continue;
      if(!tree[p.year]) tree[p.year] = {};
      if(!tree[p.year][p.month]) tree[p.year][p.month] = [];
      tree[p.year][p.month].push({ meta, day: p.day, dayName: p.dayName });
    }
    // Sort years descending
    const years = Object.keys(tree).sort().reverse();

    const container = document.createElement("div");
    container.className = "journal-group" + (groupState["__journal__"] ? " collapsed" : "");

    // Header
    const header = document.createElement("div");
    header.className = "journal-header";
    const headerLeft = document.createElement("div");
    headerLeft.className = "journal-header-left";
    const caret = document.createElement("span");
    caret.className = "journal-caret";
    caret.textContent = groupState["__journal__"] ? "\u25B6" : "\u25BC";
    headerLeft.appendChild(caret);
    const titleEl = document.createElement("span");
    titleEl.className = "journal-header-title";
    titleEl.textContent = "Journal";
    headerLeft.appendChild(titleEl);
    const countEl = document.createElement("span");
    countEl.className = "journal-header-count";
    countEl.textContent = `${journalNotes.length}`;
    headerLeft.appendChild(countEl);
    header.appendChild(headerLeft);

    const todayBtn = document.createElement("button");
    todayBtn.type = "button";
    todayBtn.className = "journal-today-btn";
    todayBtn.textContent = "+ Today";
    todayBtn.addEventListener("click", (e) => { e.stopPropagation(); openJournalToday(); });
    header.appendChild(todayBtn);

    header.addEventListener("click", () => {
      groupState["__journal__"] = !groupState["__journal__"];
      saveGroupState();
      renderNotesList();
    });
    container.appendChild(header);

    // Tree body
    const treeBody = document.createElement("div");
    treeBody.className = "journal-tree-body";

    const nowDate = new Date();
    const currentYear = String(nowDate.getFullYear());
    const currentMonth = String(nowDate.getMonth() + 1).padStart(2, "0");

    for(const year of years){
      const yearKey = `__jy_${year}`;
      // Auto-expand current year, collapse others
      const yearCollapsed = groupState[yearKey] !== undefined ? !!groupState[yearKey] : (year !== currentYear);
      const yearEl = document.createElement("div");
      yearEl.className = "journal-year" + (yearCollapsed ? " collapsed" : "");

      const yearHeader = document.createElement("div");
      yearHeader.className = "journal-year-header";
      const yCaret = document.createElement("span");
      yCaret.className = "journal-caret";
      yCaret.textContent = yearCollapsed ? "\u25B6" : "\u25BC";
      yearHeader.appendChild(yCaret);
      const yLabel = document.createElement("span");
      yLabel.className = "journal-aggregate-link";
      yLabel.textContent = year;
      yLabel.addEventListener("click", (e) => { e.stopPropagation(); openJournalAggregate(year, null); });
      yearHeader.appendChild(yLabel);
      yearHeader.addEventListener("click", () => {
        groupState[yearKey] = !groupState[yearKey];
        saveGroupState();
        renderNotesList();
      });
      yearEl.appendChild(yearHeader);

      const yearBody = document.createElement("div");
      yearBody.className = "journal-year-body";

      const months = Object.keys(tree[year]).sort().reverse();
      for(const month of months){
        const monthKey = `__jm_${year}_${month}`;
        const monthCollapsed = groupState[monthKey] !== undefined ? !!groupState[monthKey] : !(year === currentYear && month === currentMonth);
        const monthEl = document.createElement("div");
        monthEl.className = "journal-month" + (monthCollapsed ? " collapsed" : "");

        const monthHeader = document.createElement("div");
        monthHeader.className = "journal-month-header";
        const mCaret = document.createElement("span");
        mCaret.className = "journal-caret";
        mCaret.textContent = monthCollapsed ? "\u25B6" : "\u25BC";
        monthHeader.appendChild(mCaret);
        const mLabel = document.createElement("span");
        mLabel.className = "journal-aggregate-link";
        mLabel.textContent = `${month} ${MONTH_NAMES[parseInt(month,10)] || ""}`;
        mLabel.addEventListener("click", (e) => { e.stopPropagation(); openJournalAggregate(year, month); });
        monthHeader.appendChild(mLabel);
        monthHeader.addEventListener("click", () => {
          groupState[monthKey] = !groupState[monthKey];
          saveGroupState();
          renderNotesList();
        });
        monthEl.appendChild(monthHeader);

        const monthBody = document.createElement("div");
        monthBody.className = "journal-month-body";

        // Sort days descending
        const days = tree[year][month].sort((a,b) => b.day.localeCompare(a.day));
        for(const entry of days){
          const dayEl = document.createElement("div");
          dayEl.className = "journal-day" + (activeNoteId && String(entry.meta.id) === String(activeNoteId) ? " active" : "");
          dayEl.textContent = `${entry.day} ${entry.dayName}`;
          dayEl.addEventListener("click", () => openNoteInNewTab(entry.meta.id));
          monthBody.appendChild(dayEl);
        }
        monthEl.appendChild(monthBody);
        yearBody.appendChild(monthEl);
      }
      yearEl.appendChild(yearBody);
      treeBody.appendChild(yearEl);
    }
    container.appendChild(treeBody);
    return container;
  }

function renderNotesList(){
    elNotesList.innerHTML = "";
    const activeNoteId = (getActiveTab && getActiveTab()) ? getActiveTab().noteId : null;

    // Separate journal vs regular notes
    const journalNotes = [];
    const regularNotes = [];
    for(const meta of notes){
      if(meta.subject === "Journal" && parseJournalTitle(meta.title)){
        journalNotes.push(meta);
      } else {
        regularNotes.push(meta);
      }
    }

    elNotesCount.textContent = `Notes: ${notes.length}`;

    // Render journal tree first
    if(journalNotes.length > 0){
      elNotesList.appendChild(renderJournalTree(journalNotes, activeNoteId));
    }

    // Render regular notes grouped as before
    const grouped = {};
    for(const meta of regularNotes){
      const key = getGroupKey(meta);
      if(!grouped[key]) grouped[key] = [];
      grouped[key].push(meta);
    }
    const keys = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
    for(const key of keys){
      const items = grouped[key];
      const collapsed = !!groupState[key];
      const groupEl = document.createElement("div");
      groupEl.className = "note-group" + (collapsed ? " collapsed" : "");
      const header = makeGroupHeader(key, items.length, collapsed);
      header.addEventListener("click", () => toggleGroup(key));
      groupEl.appendChild(header);

      const body = document.createElement("div");
      body.className = "note-group-body";
      for(const meta of items){
        const isActive = activeNoteId && String(meta.id) === String(activeNoteId);
        body.appendChild(makeNoteRow(meta, isActive));
      }
      groupEl.appendChild(body);
      elNotesList.appendChild(groupEl);
    }
  }

  
  function updateSortModeLabel(){
  const current = (typeof mruMode !== "undefined" && mruMode === "mru") ? "MRU" : "Classic";
  // top label (if present)
  if(typeof elSortModeLabel !== "undefined" && elSortModeLabel){
    elSortModeLabel.textContent = current;
  }
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
      name.textContent = t.isAggregate ? (t.meta?.title || "Journal") : (t.meta ? displayTitleWithPin(t.meta) : t.noteId);

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
      setPreviewMode(false);
      if(elPreview) elPreview.innerHTML = "";
      if(elEditorHighlight) elEditorHighlight.innerHTML = "";
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

    // Save cursor/scroll of the tab we're leaving
    const prev = tabs.find(x => x.tabId === activeTabId);
    if(prev && prev.tabId !== tabId){
      prev._cursor = elEditor.selectionStart;
      prev._scroll = elEditor.scrollTop;
      saveCursorPos(prev.noteId, prev._cursor, prev._scroll);
    }

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

    // Handle aggregate (read-only) tabs
    if(t.isAggregate){
      elEditor.disabled = true;
      elEditor.value = t.content || "";
      setFileName(t.meta);
      setSaveState("", "");
      enableActions(false);
      setPreviewMode(true);
      renderTabs();
      renderNotesList();
      setStatus("Idle");
      return;
    }

    elEditor.disabled = false;
    elEditor.value = t.content || "";
    setFileName(t.meta);
    setSaveState("Saved", t.meta?.updated || "");
    enableActions(true);
    setPreviewMode(false);
    renderTabs();
    renderNotesList();
    setStatus("Idle");
    updatePinButton();
    updateToc();
    elEditor.focus();
    if(t._cursor == null){
      const saved = loadCursorPos(t.noteId);
      if(saved){ t._cursor = saved.c; t._scroll = saved.s; }
    }
    const pos = t._cursor != null ? t._cursor : 0;
    const scr = t._scroll != null ? t._scroll : 0;
    elEditor.setSelectionRange(pos, pos);
    elEditor.scrollTop = scr;
    requestAnimationFrame(() => { elEditor.scrollTop = scr; });
  }

  function saveCursorPos(noteId, cursor, scroll){
    try{
      const store = JSON.parse(localStorage.getItem("sn_cursor") || "{}");
      store[noteId] = {c: cursor, s: scroll};
      localStorage.setItem("sn_cursor", JSON.stringify(store));
    }catch(e){}
  }
  function loadCursorPos(noteId){
    try{
      const store = JSON.parse(localStorage.getItem("sn_cursor") || "{}");
      return store[noteId] || null;
    }catch(e){ return null; }
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
    if(t.isAggregate) return;

    const raw = elEditor.value;
    const content = normalizeCitations(raw);
    if(content !== raw){
      const start = elEditor.selectionStart;
      const end = elEditor.selectionEnd;
      elEditor.value = content;
      elEditor.selectionStart = Math.min(start, content.length);
      elEditor.selectionEnd = Math.min(end, content.length);
      if(previewMode && elPreview){ renderPreview(); }
      updateEditorHighlight();
      updateToc();
    }
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
      saveCursorPos(t.noteId, elEditor.selectionStart, elEditor.scrollTop);
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
    openRenameModal("rename");
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
      closeTabsForNotes([t.noteId]);

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

  function isSupportedUploadFile(file){
    const name = (file && file.name) ? file.name.toLowerCase() : "";
    return name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".yaml") || name.endsWith(".yml");
  }

  async function uploadFiles(files){
    const list = Array.from(files || []);
    if(!list.length) return;

    const valid = list.filter(isSupportedUploadFile);
    const invalid = list.filter((f) => !isSupportedUploadFile(f));

    if(!valid.length){
      alert("Only .md, .txt, .yaml or .yml files are supported.");
      return;
    }

    const fd = new FormData();
    for(const f of valid){
      fd.append("files", f, f.name);
    }

    setStatus("Uploading...");
    try{
      const r = await fetch("/api/notes/import", { method: "POST", body: fd });
      if(!r.ok){
        const msg = await r.text();
        throw new Error(msg || "Upload failed");
      }
      const data = await r.json();
      await loadNotes();
      if(Array.isArray(data.created)){
        for(const meta of data.created){
          if(meta && meta.id){
            await openNoteInNewTab(meta.id);
          }
        }
      }
      if(Array.isArray(data.errors) && data.errors.length){
        const lines = data.errors.map(e => `${e.file || "file"}: ${e.error || "error"}`);
        alert(`Some files were skipped:\n${lines.join("\n")}`);
      }
      if(invalid.length){
        const names = invalid.map(f => f.name).join(", ");
        alert(`Skipped unsupported files: ${names}`);
      }
      setStatus("Idle");
    }catch(e){
      console.error(e);
      setStatus("Upload failed");
      alert("Upload failed. Check console or server logs.");
    }
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
      if(t.isAggregate) continue;
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
  if(elJournalToday) elJournalToday.addEventListener("click", openJournalToday);
  if(elUpload){
    elUpload.addEventListener("click", () => {
      if(elUploadInput){
        elUploadInput.value = "";
        elUploadInput.click();
      }
    });
  }
  if(elUploadInput){
    elUploadInput.addEventListener("change", async () => {
      await uploadFiles(elUploadInput.files);
      elUploadInput.value = "";
    });
  }
  if(elSelectAll) elSelectAll.addEventListener("click", selectAll);
  if(elSelectNone) elSelectNone.addEventListener("click", selectNone);
  if(elDownloadSelected) elDownloadSelected.addEventListener("click", downloadSelected);
  if(elDeleteSelected) elDeleteSelected.addEventListener("click", deleteSelected);
  if(elRename){ elRename.addEventListener("click", renameNote); }
  elPreviewToggle.addEventListener("click", () => setPreviewMode(!previewMode));
  if(elUndo) elUndo.addEventListener("click", () => { elEditor.focus(); document.execCommand("undo"); });
  if(elRedo) elRedo.addEventListener("click", () => { elEditor.focus(); document.execCommand("redo"); });
  if(elPin){ elPin.addEventListener("click", togglePin); }
  if(elTocToggle){ elTocToggle.addEventListener("click", () => { closeDropdowns(); setTocOpen(tocOpen !== "on"); }); }
  if(elTocDepth){ elTocDepth.addEventListener("change", updateToc); }

  // Download dropdown
  if(elDownloadBtn){
    elDownloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.querySelector("#downloadDropdown .dropdown-menu");
      const willOpen = menu && menu.classList.contains("hidden");
      document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));
      if(willOpen) menu.classList.remove("hidden");
    });
  }
  // More dropdown
  if(elMoreBtn){
    elMoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.querySelector("#moreDropdown .dropdown-menu");
      const willOpen = menu && menu.classList.contains("hidden");
      document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));
      if(willOpen) menu.classList.remove("hidden");
    });
  }
  if(elDownload){ elDownload.addEventListener("click", () => { closeDropdowns(); downloadNote(); }); }
  if(elPdf){ elPdf.addEventListener("click", () => { closeDropdowns(); downloadPdf(); }); }
  if(elCopyLink){ elCopyLink.addEventListener("click", () => { closeDropdowns(); copyNoteLink(); }); }
  document.addEventListener("click", closeDropdowns);
  function closeDropdowns(){
    document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));
  }
  elFileView.addEventListener("click", () => setFileViewMode(fileView === "on" ? "off" : "on"));
  const elReplaceBtn = $("replaceBtn");
  if(elReplaceBtn) elReplaceBtn.addEventListener("click", openReplaceModal);
  const elMetadataBtn = $("metadataBtn");
  if(elMetadataBtn) elMetadataBtn.addEventListener("click", () => openRenameModal("metadata"));
  const elTlpBadge = $("tlpBadge");
  if(elTlpBadge) elTlpBadge.addEventListener("click", cycleTlp);
  if(elPreviewFormat){
    elPreviewFormat.addEventListener("change", () => setPreviewFormat(elPreviewFormat.value));
  }
  bindReplaceModal();
  bindRenameModal();

  window.addEventListener("beforeunload", () => {
    const t = getActiveTab();
    if(t) saveCursorPos(t.noteId, elEditor.selectionStart, elEditor.scrollTop);
  });

  let _cursorSaveTimer = null;
  elEditor.addEventListener("scroll", () => {
    const t = getActiveTab();
    if(!t) return;
    t._cursor = elEditor.selectionStart;
    t._scroll = elEditor.scrollTop;
    if(_cursorSaveTimer) clearTimeout(_cursorSaveTimer);
    _cursorSaveTimer = setTimeout(() => saveCursorPos(t.noteId, t._cursor, t._scroll), 500);
  });

  elEditor.addEventListener("input", () => {
    if(previewMode && elPreview){ renderPreview(); }

    const t = getActiveTab();
    if(!t) return;
    isTyping = true;
    setSaveState("Editing...", "");
    scheduleSave();
    t.content = elEditor.value;
    updateEditorHighlight();
    updateToc();
  });
  elEditor.addEventListener("paste", (e) => {
    const cb = e.clipboardData;
    if(!cb) return;
    const text = cb.getData("text/plain");
    if(!text) return;
    const normalized = normalizeCitations(text);
    if(normalized === text) return;
    e.preventDefault();
    const start = elEditor.selectionStart;
    const end = elEditor.selectionEnd;
    const value = elEditor.value;
    elEditor.value = value.slice(0, start) + normalized + value.slice(end);
    const caret = start + normalized.length;
    elEditor.selectionStart = caret;
    elEditor.selectionEnd = caret;
    elEditor.dispatchEvent(new Event("input", {bubbles: true}));
  });
  elEditor.addEventListener("scroll", syncEditorHighlightScroll);
  document.addEventListener("selectionchange", () => {
    if(document.activeElement === elEditor){
      const panel = document.getElementById("replace-panel");
      if(panel && !panel.classList.contains("hidden")){
        updateReplaceCount();
        updateEditorHighlight();
      }
    }
  });

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
    if(ctrl && e.key.toLowerCase() === "j"){
      e.preventDefault();
      openJournalToday();
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
    setPreviewFormat(previewFormat);
    loadGroupState();
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
window.setTheme = setTheme;
window.setMruMode = setMruMode;
})();


/* Sync (WebDAV) settings UI */
function _$(id){ return document.getElementById(id); }

function openSyncModal(){
  const m = _$("syncModal");
  if(!m) return;
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden","false");
}

function closeSyncModal(){
  const m = _$("syncModal");
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

/* Encryption settings UI */
async function loadEncryptionSettings(){
  try{
    const r = await fetch("/api/encryption/settings");
    const j = await r.json();
    const setupDiv = _$("encryptionSetup");
    const activeDiv = _$("encryptionActive");
    const statusEl = _$("encryptionStatus");
    const warn = _$("encryptionWarning");
    if(warn) warn.textContent = "";
    if(j.has_key){
      if(setupDiv) setupDiv.classList.add("hidden");
      if(activeDiv) activeDiv.classList.remove("hidden");
      const countText = j.encrypted_count ? ` (${j.encrypted_count} note${j.encrypted_count === 1 ? "" : "s"} encrypted)` : "";
      if(statusEl) statusEl.textContent = "Encryption enabled" + countText;
      // Clear all inputs
      const f = ["encryptionCurrentPassphrase","encryptionPassphrase","encryptionDisablePassphrase","encryptionNewPassphrase"];
      f.forEach(id => { const e = _$(id); if(e) e.value = ""; });
    } else {
      if(setupDiv) setupDiv.classList.remove("hidden");
      if(activeDiv) activeDiv.classList.add("hidden");
      const np = _$("encryptionNewPassphrase");
      if(np) np.value = "";
    }
  }catch(e){
    const el = _$("encryptionStatus");
    if(el) el.textContent = "Status: unavailable";
  }
}

async function enableEncryption(){
  const input = _$("encryptionNewPassphrase");
  const passphrase = (input ? input.value : "").trim();
  const warn = _$("encryptionWarning");
  if(warn) warn.textContent = "";
  if(!passphrase){
    if(warn) warn.textContent = "Passphrase cannot be empty";
    return;
  }
  try{
    const r = await fetch("/api/encryption/settings", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({passphrase})
    });
    const j = await r.json();
    if(j.ok){
      await loadEncryptionSettings();
    } else {
      if(warn) warn.textContent = j.error || "Error enabling encryption";
    }
  }catch(e){
    if(warn) warn.textContent = "Error enabling encryption";
  }
}

async function changeEncryptionPassphrase(){
  const currentInput = _$("encryptionCurrentPassphrase");
  const newInput = _$("encryptionPassphrase");
  const warn = _$("encryptionWarning");
  if(warn) warn.textContent = "";
  const current = (currentInput ? currentInput.value : "").trim();
  const newPass = (newInput ? newInput.value : "").trim();
  if(!current){
    if(warn) warn.textContent = "Enter your current passphrase";
    return;
  }
  if(!newPass){
    if(warn) warn.textContent = "Enter a new passphrase";
    return;
  }
  try{
    const r = await fetch("/api/encryption/settings", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({passphrase: newPass, current_passphrase: current})
    });
    const j = await r.json();
    if(j.ok){
      await loadEncryptionSettings();
      if(warn && j.warning === "key_changed"){
        warn.textContent = "Passphrase changed. Notes encrypted with the old passphrase will need to be re-encrypted.";
      }
    } else {
      if(warn) warn.textContent = j.error || "Error changing passphrase";
    }
  }catch(e){
    if(warn) warn.textContent = "Error changing passphrase";
  }
}

async function disableEncryption(){
  const input = _$("encryptionDisablePassphrase");
  const warn = _$("encryptionWarning");
  if(warn) warn.textContent = "";
  const passphrase = (input ? input.value : "").trim();
  if(!passphrase){
    if(warn) warn.textContent = "Enter your passphrase to confirm";
    return;
  }
  if(!confirm("Disable encryption? All encrypted notes will be decrypted and stored as plaintext.")){
    return;
  }
  try{
    const r = await fetch("/api/encryption/settings", {
      method: "DELETE",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({current_passphrase: passphrase})
    });
    const j = await r.json();
    if(j.ok){
      const msg = j.decrypted ? `Encryption disabled. ${j.decrypted} note(s) decrypted.` : "Encryption disabled.";
      await loadEncryptionSettings();
      if(warn){
        warn.style.color = "";
        warn.textContent = j.warning ? (msg + " " + j.warning) : msg;
        // Reset color after a moment
        setTimeout(() => { if(warn) warn.style.color = ""; }, 0);
      }
    } else {
      if(warn) warn.textContent = j.error || "Error disabling encryption";
    }
  }catch(e){
    if(warn) warn.textContent = "Error disabling encryption";
  }
}

async function loadSyncSettings(){
  try{
    const r = await fetch("/api/sync/settings");
    const j = await r.json();
    _$("syncEnabled").checked = !!j.enabled;
    _$("syncUrl").value = j.webdav_url || "";
    _$("syncRemotePath").value = j.remote_path || "";
    _$("syncUser").value = j.username || "";
    _$("syncPass").value = j.password || "";
    _$("syncMode").value = j.mode || "push";
    _$("syncInterval").value = (j.interval_s || 60);
    _$("syncNoDelete").checked = (j.no_deletes !== false);
  }catch(e){}
}

async function loadSyncStatus(){
  try{
    const r = await fetch("/api/sync/status");
    const j = await r.json();
    const t = j.last_time || "never";
    const res = j.last_result || "idle";
    const err = j.last_error ? (" - " + j.last_error) : "";
    _$("syncStatus").textContent = `Status: ${res} (last: ${t})${err}`;
  }catch(e){
    const el = _$("syncStatus");
    if(el) el.textContent = "Status: unavailable";
  }
}

async function saveSyncSettings(){
  const payload = {
    enabled: _$("syncEnabled").checked,
    webdav_url: _$("syncUrl").value.trim(),
    remote_path: _$("syncRemotePath").value.trim(),
    username: _$("syncUser").value.trim(),
    password: _$("syncPass").value,
    mode: _$("syncMode").value,
    interval_s: parseInt(_$("syncInterval").value || "60", 10),
    no_deletes: _$("syncNoDelete").checked
  };
  const r = await fetch("/api/sync/settings", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  _$("syncStatus").textContent = j.ok ? "Status: saved" : ("Status: error - " + (j.error||""));
  await loadSyncStatus();
  await updateTopSyncStatus();
}

async function testSync(){
  const payload = {
    webdav_url: _$("syncUrl").value.trim(),
    remote_path: _$("syncRemotePath").value.trim(),
    username: _$("syncUser").value.trim(),
    password: _$("syncPass").value
  };
  const r = await fetch("/api/sync/test", {
    method:"POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  _$("syncStatus").textContent = j.ok ? "Status: connection OK" : ("Status: connection failed - " + (j.error||""));
  await loadSyncStatus();
  await updateTopSyncStatus();
}

async function runSyncNow(){
  // Ensure settings are persisted so the sidecar can read them
  await saveSyncSettings();

  const r = await fetch("/api/sync/run", {method:"POST"});
  const j = await r.json();
  _$("syncStatus").textContent = j.ok ? "Status: sync requested" : ("Status: error - " + (j.error||""));
  await loadSyncStatus();
  await updateTopSyncStatus();
  setTimeout(loadSyncStatus, 1200);
  setTimeout(updateTopSyncStatus, 1200);
  setTimeout(loadSyncStatus, 3500);
  setTimeout(updateTopSyncStatus, 3500);
}

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


{
  // Modal & settings bindings (script is at end of body, DOM is ready)
  elRename = document.getElementById("renameNote");

  // Sync UI
  // Encryption UI bindings
  const encEnableBtn = _$("encryptionEnableBtn");
  if(encEnableBtn) encEnableBtn.addEventListener("click", enableEncryption);
  const encSaveBtn = _$("encryptionSaveBtn");
  if(encSaveBtn) encSaveBtn.addEventListener("click", changeEncryptionPassphrase);
  const encDisableBtn = _$("encryptionDisableBtn");
  if(encDisableBtn) encDisableBtn.addEventListener("click", disableEncryption);

  // Preferences bindings (theme + tab sort in Settings modal)
  const settingsTheme = document.getElementById("settingsTheme");
  if(settingsTheme){
    settingsTheme.value = localStorage.getItem("sn_theme") || "light";
    settingsTheme.addEventListener("change", () => window.setTheme(settingsTheme.value));
  }
  const settingsTabSort = document.getElementById("settingsTabSort");
  if(settingsTabSort){
    settingsTabSort.value = localStorage.getItem("sn_mru") || "fixed";
    settingsTabSort.addEventListener("change", () => window.setMruMode(settingsTabSort.value));
  }

  const b = _$("syncBtn");
  if(b){
    b.addEventListener("click", async ()=>{
      // Sync preferences dropdowns with current state
      const st = document.getElementById("settingsTheme");
      if(st) st.value = localStorage.getItem("sn_theme") || "light";
      const ss = document.getElementById("settingsTabSort");
      if(ss) ss.value = localStorage.getItem("sn_mru") || "fixed";
      // Load document defaults into form
      try{
        const dd = JSON.parse(localStorage.getItem("sn_doc_defaults") || "{}");
        const da = document.getElementById("defaultAuthor");
        const dc = document.getElementById("defaultCompany");
        const dt = document.getElementById("defaultTlp");
        if(da) da.value = dd.author || "";
        if(dc) dc.value = dd.company || "";
        if(dt) dt.value = (dd.tlp || "AMBER").toUpperCase();
      }catch(e){}
      openSyncModal();
      await loadSyncSettings();
      await loadSyncStatus();
      await loadEncryptionSettings();
      await updateTopSyncStatus();
    });
  }
  const c = _$("syncCloseBtn");
  if(c) c.addEventListener("click", closeSyncModal);
  const c2 = _$("syncCloseBtn2");
  if(c2) c2.addEventListener("click", closeSyncModal);
  const m = _$("syncModal");
  if(m){
    m.addEventListener("click", (ev)=>{
      const t = ev.target;
      if(t && t.getAttribute && t.getAttribute("data-close")==="sync") closeSyncModal();
    });
  }
  const s = _$("syncSaveBtn"); if(s) s.addEventListener("click", saveSyncSettings);
  const t = _$("syncTestBtn"); if(t) t.addEventListener("click", testSync);
  const r = _$("syncRunBtn"); if(r) r.addEventListener("click", runSyncNow);

  // Pause sync button
  const p = document.getElementById("pauseSyncBtn");
  if(p) p.addEventListener("click", togglePauseSync);

  // Document Defaults
  const saveDefaultsBtn = document.getElementById("saveDefaultsBtn");
  if(saveDefaultsBtn){
    saveDefaultsBtn.addEventListener("click", () => {
      const defaults = {
        author: (document.getElementById("defaultAuthor")?.value || "").trim(),
        company: (document.getElementById("defaultCompany")?.value || "").trim(),
        tlp: (document.getElementById("defaultTlp")?.value || "AMBER").toUpperCase(),
      };
      localStorage.setItem("sn_doc_defaults", JSON.stringify(defaults));
      saveDefaultsBtn.textContent = "Saved";
      setTimeout(() => { saveDefaultsBtn.textContent = "Save defaults"; }, 1200);
    });
  }

  // Collapsible settings sections
  document.querySelectorAll(".settings-section-header[data-toggle]").forEach(header => {
    header.addEventListener("click", () => {
      const sectionId = header.getAttribute("data-toggle");
      const section = document.getElementById(sectionId);
      if(section) section.classList.toggle("collapsed");
    });
  });

  // Top sync status polling
  updateTopSyncStatus();
  setInterval(updateTopSyncStatus, 5000);
}


function sanitizeFilename(name){
  const UMLAUT_MAP = {"ä":"ae","ö":"oe","ü":"ue","ß":"ss","Ä":"Ae","Ö":"Oe","Ü":"Ue"};
  let n = (name || "note").toString().trim() || "note";
  n = n.replace(/[äöüßÄÖÜ]/g, ch => UMLAUT_MAP[ch] || ch);
  n = n.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return n.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0,120).replace(/^_+|_+$/g,"") || "note";
}
