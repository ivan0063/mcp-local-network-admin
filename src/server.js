import 'dotenv/config';
import express from 'express';
import { runAgent } from './agent.js';

const app = express();
app.use(express.json());

// Sesiones en memoria: sessionId → historial de conversación
const sessions = new Map();

// ─── API ──────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message y sessionId son requeridos' });
  }

  const history = sessions.get(sessionId) ?? [];
  const toolsUsed = [];

  try {
    const result = await runAgent(message, history, ({ tool, input }) => {
      toolsUsed.push({ tool, input });
    });

    sessions.set(sessionId, result.history);
    res.json({ reply: result.text, toolsUsed });
  } catch (err) {
    console.error('[Error en agente]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset', (req, res) => {
  const { sessionId } = req.body;
  sessions.delete(sessionId);
  res.json({ ok: true });
});

// ─── UI ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(/* html */ `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Asistente Local</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:         #0d0f0e;
    --surface:    #141714;
    --border:     #1e2420;
    --border2:    #2a332d;
    --text:       #c8d5c9;
    --text-dim:   #5a6b5c;
    --accent:     #4ade80;
    --accent-dim: #1a3d24;
    --accent2:    #22d3ee;
    --warn:       #fbbf24;
    --error:      #f87171;
    --jenkins:    #d97706;
    --ha:         #3b82f6;
  }

  html, body { height: 100%; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'IBM Plex Sans', sans-serif;
    font-size: 14px;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ─── Header ─── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--surface);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .brand-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .brand-name {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    font-weight: 500;
    color: var(--accent);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .status-bar {
    display: flex;
    gap: 16px;
    align-items: center;
  }

  .status-pill {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }

  .status-pill .dot {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: var(--text-dim);
  }

  .status-pill.jenkins .dot { background: var(--jenkins); }
  .status-pill.ha .dot { background: var(--ha); }

  .reset-btn {
    background: none;
    border: 1px solid var(--border2);
    color: var(--text-dim);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    padding: 4px 10px;
    cursor: pointer;
    letter-spacing: 0.05em;
    transition: all 0.15s;
  }

  .reset-btn:hover {
    border-color: var(--error);
    color: var(--error);
  }

  /* ─── Messages ─── */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    scroll-behavior: smooth;
  }

  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

  .msg {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 800px;
    animation: fadeUp 0.2s ease;
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.assistant { align-self: flex-start; align-items: flex-start; }

  .msg-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    text-transform: uppercase;
    padding: 0 2px;
  }

  .msg.user .msg-label { color: var(--accent-dim); }

  .bubble {
    padding: 12px 16px;
    border-radius: 2px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .msg.user .bubble {
    background: var(--accent-dim);
    border: 1px solid #2d5c38;
    color: #a7f3be;
    border-radius: 2px 2px 0 2px;
  }

  .msg.assistant .bubble {
    background: var(--surface);
    border: 1px solid var(--border2);
    border-radius: 2px 2px 2px 0;
  }

  /* Tool usage trace */
  .tools-trace {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    background: rgba(0,0,0,0.3);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent-dim);
  }

  .tool-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--text-dim);
  }

  .tool-badge {
    padding: 1px 6px;
    font-size: 9px;
    letter-spacing: 0.05em;
    border-radius: 1px;
    text-transform: uppercase;
  }

  .tool-badge.jenkins { background: rgba(217,119,6,0.15); color: var(--jenkins); border: 1px solid rgba(217,119,6,0.3); }
  .tool-badge.ha      { background: rgba(59,130,246,0.15); color: var(--ha);      border: 1px solid rgba(59,130,246,0.3); }
  .tool-badge.other   { background: rgba(100,100,100,0.15); color: var(--text-dim); border: 1px solid var(--border2); }

  .tool-name { color: var(--text); }

  /* Typing indicator */
  .typing {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: var(--surface);
    border: 1px solid var(--border2);
    align-self: flex-start;
    animation: fadeUp 0.2s ease;
  }

  .typing-dots {
    display: flex;
    gap: 4px;
  }

  .typing-dots span {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: var(--text-dim);
    animation: bounce 1.2s infinite;
  }
  .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
  .typing-dots span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); }
    30% { transform: translateY(-5px); background: var(--accent); }
  }

  .typing-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--text-dim);
  }

  /* ─── Input ─── */
  .input-area {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: var(--surface);
    padding: 16px 20px;
  }

  .input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }

  .input-prefix {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 14px;
    color: var(--accent);
    padding-bottom: 10px;
    flex-shrink: 0;
    user-select: none;
  }

  textarea {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border2);
    color: var(--text);
    font-family: 'IBM Plex Sans', sans-serif;
    font-size: 14px;
    padding: 10px 14px;
    resize: none;
    outline: none;
    min-height: 42px;
    max-height: 140px;
    line-height: 1.5;
    border-radius: 2px;
    transition: border-color 0.15s;
  }

  textarea::placeholder { color: var(--text-dim); }
  textarea:focus { border-color: var(--accent-dim); }

  button#send {
    background: var(--accent);
    color: #0a1a0f;
    border: none;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    padding: 10px 16px;
    cursor: pointer;
    border-radius: 2px;
    transition: all 0.15s;
    text-transform: uppercase;
    flex-shrink: 0;
    align-self: flex-end;
    height: 42px;
  }

  button#send:hover { background: #6ee7a0; }
  button#send:disabled { background: var(--accent-dim); color: var(--text-dim); cursor: not-allowed; }

  /* ─── Empty state ─── */
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    color: var(--text-dim);
    text-align: center;
    padding: 40px;
  }

  .empty-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    max-width: 480px;
    width: 100%;
  }

  .example-cmd {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 10px 14px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    cursor: pointer;
    text-align: left;
    line-height: 1.5;
    transition: all 0.15s;
    border-radius: 2px;
  }

  .example-cmd:hover {
    border-color: var(--accent-dim);
    color: var(--text);
  }

  .empty-title {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
</style>
</head>
<body>

<header>
  <div class="brand">
    <div class="brand-dot"></div>
    <span class="brand-name">Local Assistant</span>
  </div>
  <div class="status-bar">
    <div class="status-pill jenkins">
      <div class="dot"></div>
      Jenkins
    </div>
    <div class="status-pill ha">
      <div class="dot"></div>
      Home Assistant
    </div>
    <button class="reset-btn" onclick="resetSession()">Reset</button>
  </div>
</header>

<div id="messages">
  <div class="empty-state" id="empty">
    <div class="empty-title">¿Qué quieres hacer?</div>
    <div class="empty-grid">
      <div class="example-cmd" onclick="useExample(this)">Muéstrame todos los jobs de Jenkins y su estado</div>
      <div class="example-cmd" onclick="useExample(this)">¿Cuáles luces están encendidas ahora?</div>
      <div class="example-cmd" onclick="useExample(this)">Haz deploy de mi-app copiando el pipeline de otra-app</div>
      <div class="example-cmd" onclick="useExample(this)">Lista las automatizaciones de Home Assistant</div>
      <div class="example-cmd" onclick="useExample(this)">¿Cuál fue el resultado del último build de mi-app?</div>
      <div class="example-cmd" onclick="useExample(this)">Apaga todas las luces de la sala</div>
    </div>
  </div>
</div>

<div class="input-area">
  <div class="input-row">
    <span class="input-prefix">›</span>
    <textarea id="input" placeholder="Dile qué hacer..." rows="1"></textarea>
    <button id="send" onclick="sendMessage()">Enviar</button>
  </div>
</div>

<script>
  const sessionId = 'sess_' + Math.random().toString(36).slice(2);
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const emptyEl = document.getElementById('empty');

  let busy = false;

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  function useExample(el) {
    inputEl.value = el.textContent;
    inputEl.focus();
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || busy) return;

    busy = true;
    sendBtn.disabled = true;
    inputEl.value = '';
    inputEl.style.height = 'auto';

    emptyEl?.remove();
    appendMessage('user', text);
    const typingEl = appendTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId }),
      });

      const data = await res.json();
      typingEl.remove();

      if (data.error) {
        appendMessage('assistant', '❌ Error: ' + data.error, []);
      } else {
        appendMessage('assistant', data.reply, data.toolsUsed ?? []);
      }
    } catch (err) {
      typingEl.remove();
      appendMessage('assistant', '❌ Error de red: ' + err.message, []);
    }

    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  async function resetSession() {
    await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    messagesEl.innerHTML = '';
    window.location.reload();
  }

  function appendMessage(role, text, tools = []) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;

    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? 'Tú' : 'Asistente';

    // Tools trace (solo para assistant)
    if (tools && tools.length > 0) {
      const trace = document.createElement('div');
      trace.className = 'tools-trace';
      for (const t of tools) {
        const item = document.createElement('div');
        item.className = 'tool-item';
        const badge = document.createElement('span');
        badge.className = 'tool-badge ' + getBadgeClass(t.tool);
        badge.textContent = getBadgeLabel(t.tool);
        const name = document.createElement('span');
        name.className = 'tool-name';
        name.textContent = formatToolName(t.tool);
        item.appendChild(badge);
        item.appendChild(name);
        trace.appendChild(item);
      }
      div.appendChild(label);
      div.appendChild(trace);
    } else {
      div.appendChild(label);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    div.appendChild(bubble);

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function appendTyping() {
    const div = document.createElement('div');
    div.className = 'typing';
    div.innerHTML = \`
      <div class="typing-dots">
        <span></span><span></span><span></span>
      </div>
      <span class="typing-label">procesando...</span>
    \`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function getBadgeClass(tool) {
    if (tool.startsWith('jenkins_')) return 'jenkins';
    if (tool.startsWith('ha_')) return 'ha';
    return 'other';
  }

  function getBadgeLabel(tool) {
    if (tool.startsWith('jenkins_')) return 'Jenkins';
    if (tool.startsWith('ha_')) return 'HA';
    return '?';
  }

  function formatToolName(tool) {
    return tool.replace(/^(jenkins_|ha_)/, '').replaceAll('_', ' ');
  }
</script>
</body>
</html>`);
});

// ─── Start ────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Asistente corriendo en http://localhost:${PORT}`);
  console.log(`   Jenkins:        ${process.env.JENKINS_URL || '⚠️  no configurado'}`);
  console.log(`   Home Assistant: ${process.env.HA_URL || '⚠️  no configurado'}\n`);
});
