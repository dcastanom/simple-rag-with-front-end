/* global state */
let chatHistory = [];
let hasDocuments = false;

/* DOM refs */
const chatMessages   = document.getElementById('chatMessages');
const chatForm       = document.getElementById('chatForm');
const questionInput  = document.getElementById('questionInput');
const sendBtn        = document.getElementById('sendBtn');
const fileInput      = document.getElementById('fileInput');
const browseBtn      = document.getElementById('browseBtn');
const uploadArea     = document.getElementById('uploadArea');
const uploadProgress = document.getElementById('uploadProgress');
const progressFill   = document.getElementById('progressFill');
const progressText   = document.getElementById('progressText');
const documentList   = document.getElementById('documentList');
const emptyDocs      = document.getElementById('emptyDocs');

/* ── Bootstrap ───────────────────────────────────────────────── */
loadDocuments();

/* ── File upload ─────────────────────────────────────────────── */
browseBtn.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
  fileInput.value = '';
});

async function handleFiles(files) {
  for (const file of Array.from(files)) {
    await uploadFile(file);
  }
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  showProgress(`Uploading "${file.name}"…`, 0);

  /* animate progress while waiting */
  let pct = 0;
  const timer = setInterval(() => {
    pct = Math.min(pct + 8, 88);
    setProgress(pct);
  }, 250);

  try {
    const res = await fetch('/api/documents/upload', { method: 'POST', body: formData });
    clearInterval(timer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    setProgress(100);
    showProgress(`"${file.name}" uploaded successfully!`, 100);
    await loadDocuments();
  } catch (err) {
    clearInterval(timer);
    showProgress(`Error: ${err.message}`, 0);
  } finally {
    setTimeout(() => { uploadProgress.hidden = true; }, 3000);
  }
}

function showProgress(msg, pct) {
  uploadProgress.hidden = false;
  progressText.textContent = msg;
  setProgress(pct);
}

function setProgress(pct) {
  progressFill.style.width = `${pct}%`;
}

/* ── Document list ───────────────────────────────────────────── */
async function loadDocuments() {
  try {
    const res = await fetch('/api/documents');
    if (!res.ok) return;
    const docs = await res.json();
    renderDocuments(docs);
  } catch {
    /* silently ignore network errors on initial load */
  }
}

function renderDocuments(docs) {
  /* remove old items */
  documentList.querySelectorAll('.document-item').forEach((el) => el.remove());

  hasDocuments = docs.length > 0;
  emptyDocs.hidden = hasDocuments;
  sendBtn.disabled = !hasDocuments;

  docs.forEach((doc) => {
    const item = document.createElement('div');
    item.className = 'document-item';
    item.innerHTML = `
      <span class="doc-icon">${docIcon(doc.filename)}</span>
      <div class="doc-details">
        <span class="doc-name" title="${escHtml(doc.filename)}">${escHtml(doc.filename)}</span>
        <span class="doc-meta">${fmtSize(doc.size)}</span>
      </div>
      <button class="delete-btn" data-id="${escHtml(doc.id)}" title="Delete document" aria-label="Delete ${escHtml(doc.filename)}">×</button>
    `;
    item.querySelector('.delete-btn').addEventListener('click', () =>
      deleteDocument(doc.id, doc.filename)
    );
    documentList.appendChild(item);
  });
}

async function deleteDocument(id, filename) {
  if (!confirm(`Delete "${filename}"?`)) return;

  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    await loadDocuments();
  } catch (err) {
    alert(`Could not delete document: ${err.message}`);
  }
}

/* ── Chat ────────────────────────────────────────────────────── */
questionInput.addEventListener('input', () => {
  sendBtn.disabled = !hasDocuments || questionInput.value.trim() === '';
});

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  questionInput.value = '';
  sendBtn.disabled = true;

  removeWelcome();
  appendMessage('user', question);

  const loaderId = appendLoader();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history: chatHistory }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    removeLoader(loaderId);
    appendMessage('bot', data.answer, data.sources);
    chatHistory.push({ question, answer: data.answer });
    if (chatHistory.length > 10) chatHistory.shift();
  } catch (err) {
    removeLoader(loaderId);
    appendMessage('error', `Error: ${err.message}`);
  } finally {
    sendBtn.disabled = !hasDocuments;
    questionInput.focus();
  }
});

/* ── Message rendering ───────────────────────────────────────── */
function removeWelcome() {
  const w = document.getElementById('welcomeMsg');
  if (w) w.remove();
}

function appendMessage(type, text, sources = []) {
  const wrap = document.createElement('div');
  wrap.className = `message ${type}-message`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = type === 'user' ? 'You' : type === 'bot' ? 'AI' : '!';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = formatText(text);

  if (type === 'bot' && sources.length > 0) {
    bubble.appendChild(buildSources(sources));
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function buildSources(sources) {
  const container = document.createElement('div');
  container.className = 'sources';

  const heading = document.createElement('p');
  heading.className = 'sources-heading';
  heading.textContent = '📎 Sources';
  container.appendChild(heading);

  sources.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'source-item';

    const label = s.page != null ? `${s.filename} — page ${s.page + 1}` : s.filename;
    item.innerHTML = `
      <span class="source-file">${escHtml(label)}</span>
      <p class="source-snippet">${escHtml(s.content)}</p>
    `;
    container.appendChild(item);
  });

  return container;
}

function appendLoader() {
  const id = `loader-${Date.now()}`;
  const wrap = document.createElement('div');
  wrap.id = id;
  wrap.className = 'message bot-message';
  wrap.innerHTML = `
    <div class="message-avatar">AI</div>
    <div class="message-bubble">
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return id;
}

function removeLoader(id) {
  document.getElementById(id)?.remove();
}

/* ── Helpers ─────────────────────────────────────────────────── */
function formatText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function docIcon(filename) {
  if (filename.toLowerCase().endsWith('.pdf')) return '📕';
  if (filename.toLowerCase().endsWith('.md'))  return '📝';
  return '📄';
}

function fmtSize(bytes) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
