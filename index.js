'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const config = require('./settings.json');
const express = require('express');
const http = require('http');
const https = require('https');
const mc = require('minecraft-protocol');

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// ---- Bot state ----
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false
};

let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let intentionalDisconnect = false;

// ---- Runtime configuration (overrides settings.json) ----
let runtimeConfig = {};

// Helper to get nested property
function getNested(obj, path) {
  return path.split('.').reduce((o, i) => (o ? o[i] : undefined), obj);
}

// Check if a module is enabled (runtime overrides file)
function isModuleEnabled(path) {
  if (runtimeConfig[path] !== undefined) return runtimeConfig[path];
  return getNested(config, path);
}

// ============================================================
// DASHBOARD HTML (new modern UI)
// ============================================================
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.name} Control Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Roboto, system-ui, sans-serif;
      background: #0b1120;
      color: #e2e8f0;
      padding: 1rem;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .dashboard {
      max-width: 750px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 1.2rem;
    }
    .card {
      background: #1e293b;
      border-radius: 1rem;
      padding: 1.5rem;
      box-shadow: 0 4px 6px rgba(0,0,0,0.4);
    }
    h1 {
      font-size: 2rem;
      text-align: center;
      color: #38bdf8;
      margin-bottom: 0.5rem;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .badge {
      background: #334155;
      padding: 0.3rem 0.8rem;
      border-radius: 2rem;
      font-weight: 600;
      font-size: 0.9rem;
    }
    .online { background: #166534; color: #86efac; }
    .offline { background: #991b1b; color: #fca5a5; }
    .coords {
      font-family: monospace;
      font-size: 1.2rem;
      background: #0f172a;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      display: inline-block;
    }
    .btn {
      background: #2563eb;
      color: white;
      border: none;
      padding: 0.6rem 1.2rem;
      border-radius: 0.5rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
      white-space: nowrap;
    }
    .btn:hover { background: #1d4ed8; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-success { background: #16a34a; }
    .btn-success:hover { background: #15803d; }
    input, select {
      width: 100%;
      padding: 0.6rem;
      border-radius: 0.5rem;
      border: 1px solid #475569;
      background: #0f172a;
      color: white;
      margin-bottom: 0.5rem;
    }
    .flex-row {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .flex-row input { flex: 1; min-width: 80px; }
    .toggle-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.3rem 0;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 26px;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #475569;
      transition: .4s;
      border-radius: 34px;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 18px; width: 18px;
      left: 4px; bottom: 4px;
      background-color: white;
      transition: .4s;
      border-radius: 50%;
    }
    input:checked + .slider { background-color: #16a34a; }
    input:checked + .slider:before { transform: translateX(22px); }
    @media (max-width: 500px) {
      h1 { font-size: 1.5rem; }
      .status-row { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="dashboard">
    <h1>🤖 ${config.name}</h1>

    <!-- STATUS CARD -->
    <div class="card">
      <div class="status-row">
        <div>
          <span id="status-badge" class="badge">● Connecting...</span>
          <span style="margin-left: 1rem;">Uptime: <strong id="uptime">0s</strong></span>
        </div>
        <div>
          <span>📍</span> <span id="position" class="coords">---</span>
        </div>
      </div>
    </div>

    <!-- NAVIGATION CARD -->
    <div class="card">
      <h3 style="margin-bottom: 0.5rem;">🎯 Navigate Bot</h3>
      <div class="flex-row">
        <input id="coordX" type="number" placeholder="X" value="0">
        <input id="coordY" type="number" placeholder="Y" value="100">
        <input id="coordZ" type="number" placeholder="Z" value="0">
        <button class="btn" onclick="setCoords()">Go</button>
      </div>
    </div>

    <!-- CHAT & COMMAND CARD -->
    <div class="card">
      <h3>💬 Chat & Commands</h3>
      <input id="chatInput" placeholder="Type a public message...">
      <div class="flex-row" style="margin-top: 0.5rem;">
        <button class="btn" onclick="sendChat()">Send</button>
        <input id="cmdInput" placeholder="/command (without /)" style="flex:2;">
        <button class="btn btn-success" onclick="sendCmd()">Run</button>
      </div>
    </div>

    <!-- TOGGLES CARD -->
    <div class="card">
      <h3 style="margin-bottom: 0.7rem;">⚙️ Behavior Toggles</h3>
      <div class="toggle-row"><span>Anti-AFK</span><label class="switch"><input type="checkbox" id="tog-anti-afk" onchange="toggleModule('utils.anti-afk.enabled', this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Chat Messages</span><label class="switch"><input type="checkbox" id="tog-chat-messages" onchange="toggleModule('utils.chat-messages.enabled', this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Circle Walk</span><label class="switch"><input type="checkbox" id="tog-circle-walk" onchange="toggleModule('movement.circle-walk.enabled', this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Random Jump</span><label class="switch"><input type="checkbox" id="tog-random-jump" onchange="toggleModule('movement.random-jump.enabled', this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Look Around</span><label class="switch"><input type="checkbox" id="tog-look-around" onchange="toggleModule('movement.look-around.enabled', this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Combat</span><label class="switch"><input type="checkbox" id="tog-combat" onchange="toggleModule('modules.combat', this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Avoid Mobs</span><label class="switch"><input type="checkbox" id="tog-avoidMobs" onchange="toggleModule('modules.avoidMobs', this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Beds (Night)</span><label class="switch"><input type="checkbox" id="tog-beds" onchange="toggleModule('modules.beds', this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Chat Respond</span><label class="switch"><input type="checkbox" id="tog-chat" onchange="toggleModule('modules.chat', this.checked)"><span class="slider"></span></label></div>
    </div>

    <!-- CONTROL CARD -->
    <div class="card">
      <h3>🔧 Service Control</h3>
      <div class="flex-row">
        <button class="btn btn-danger" onclick="restartBot()">🔄 Restart</button>
        <button class="btn" onclick="disconnectBot()">⏹️ Disconnect</button>
        <button class="btn btn-success" onclick="reconnectBot()">🔁 Reconnect</button>
      </div>
      <small style="color: #94a3b8; display: block; margin-top: 0.5rem;">
        "Restart" restarts the whole Render service (takes ~30s).<br>
        "Disconnect" stops the bot but keeps the dashboard online.
      </small>
    </div>

    <div style="text-align: center; color: #64748b; font-size: 0.85rem;">
      Auto-refresh every 3s · ${config.server.ip}:${config.server.port}
    </div>
  </div>

  <script>
    // ---- Status & toggles ----
    async function fetchStatus() {
      try {
        const r = await fetch('/health');
        const d = await r.json();
        document.getElementById('status-badge').textContent = d.status === 'connected' ? '🟢 Online' : '🔴 Offline';
        document.getElementById('status-badge').className = 'badge ' + (d.status === 'connected' ? 'online' : 'offline');
        document.getElementById('uptime').textContent = formatUptime(d.uptime);
        if (d.coords) {
          document.getElementById('position').textContent =
            Math.floor(d.coords.x) + ', ' + Math.floor(d.coords.y) + ', ' + Math.floor(d.coords.z);
        } else {
          document.getElementById('position').textContent = '---';
        }
        // Update toggles
        if (d.runtimeConfig) {
          const rc = d.runtimeConfig;
          setToggle('tog-anti-afk', rc['utils.anti-afk.enabled']);
          setToggle('tog-chat-messages', rc['utils.chat-messages.enabled']);
          setToggle('tog-circle-walk', rc['movement.circle-walk.enabled']);
          setToggle('tog-random-jump', rc['movement.random-jump.enabled']);
          setToggle('tog-look-around', rc['movement.look-around.enabled']);
          setToggle('tog-combat', rc['modules.combat']);
          setToggle('tog-avoidMobs', rc['modules.avoidMobs']);
          setToggle('tog-beds', rc['modules.beds']);
          setToggle('tog-chat', rc['modules.chat']);
        }
      } catch (e) {}
    }

    function setToggle(id, value) {
      const el = document.getElementById(id);
      if (el && value !== undefined) el.checked = value;
    }

    function formatUptime(s) {
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
      return h+'h '+m+'m '+sec+'s';
    }

    // ---- Actions ----
    async function setCoords() {
      const x = document.getElementById('coordX').value;
      const y = document.getElementById('coordY').value;
      const z = document.getElementById('coordZ').value;
      await fetch('/setcoords', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({x: parseInt(x), y: parseInt(y), z: parseInt(z)})
      });
      alert('Sent!');
    }

    async function sendChat() {
      const msg = document.getElementById('chatInput').value;
      if (!msg) return;
      await fetch('/chat', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: msg})
      });
      document.getElementById('chatInput').value = '';
    }

    async function sendCmd() {
      const cmd = document.getElementById('cmdInput').value;
      if (!cmd) return;
      await fetch('/cmd', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({command: cmd})
      });
      document.getElementById('cmdInput').value = '';
    }

    async function restartBot() {
      if (confirm('Restart the whole Render service?')) {
        await fetch('/restart', {method: 'POST'});
      }
    }

    async function disconnectBot() {
      await fetch('/disconnect', {method: 'POST'});
      alert('Disconnected.');
    }

    async function reconnectBot() {
      await fetch('/reconnect', {method: 'POST'});
      alert('Reconnecting...');
    }

    async function toggleModule(path, enabled) {
      await fetch('/toggle', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path, enabled})
      });
    }

    setInterval(fetchStatus, 3000);
    fetchStatus();
  </script>
</body>
</html>`);
});

// ---- API Endpoints ----
app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    runtimeConfig: {
      'utils.anti-afk.enabled': isModuleEnabled('utils.anti-afk.enabled'),
      'utils.chat-messages.enabled': isModuleEnabled('utils.chat-messages.enabled'),
      'movement.circle-walk.enabled': isModuleEnabled('movement.circle-walk.enabled'),
      'movement.random-jump.enabled': isModuleEnabled('movement.random-jump.enabled'),
      'movement.look-around.enabled': isModuleEnabled('movement.look-around.enabled'),
      'modules.combat': isModuleEnabled('modules.combat'),
      'modules.avoidMobs': isModuleEnabled('modules.avoidMobs'),
      'modules.beds': isModuleEnabled('modules.beds'),
      'modules.chat': isModuleEnabled('modules.chat')
    }
  });
});

app.get('/ping', (req, res) => res.send('pong'));

app.post('/setcoords', (req, res) => {
  if (!bot || !botState.connected) return res.status(400).json({error: 'Bot offline'});
  const { x, y, z } = req.body;
  try {
    const mcData = require('minecraft-data')(bot.version);
    const move = new Movements(bot, mcData);
    move.allowFreeMotion = false;
    bot.pathfinder.setMovements(move);
    bot.pathfinder.setGoal(new GoalBlock(x, y, z));
    console.log(`[Dashboard] Navigate to ${x}, ${y}, ${z}`);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/chat', (req, res) => {
  if (!bot || !botState.connected) return res.status(400).json({error: 'Bot offline'});
  bot.chat(req.body.message);
  res.json({success: true});
});

app.post('/cmd', (req, res) => {
  if (!bot || !botState.connected) return res.status(400).json({error: 'Bot offline'});
  bot.chat('/' + req.body.command);
  res.json({success: true});
});

app.post('/restart', (req, res) => {
  res.json({success: true});
  setTimeout(() => process.exit(0), 500);
});

app.post('/disconnect', (req, res) => {
  if (bot) bot.end();
  res.json({success: true});
});

app.post('/reconnect', (req, res) => {
  if (bot) bot.end();
  intentionalDisconnect = false;
  createBot();
  res.json({success: true});
});

app.post('/toggle', (req, res) => {
  const { path, enabled } = req.body;
  if (!path) return res.status(400).json({error: 'Missing path'});
  runtimeConfig[path] = enabled;
  console.log(`[Config] ${path} set to ${enabled}`);
  // Re-initialize modules on the fly by restarting intervals (simplified: reload bot)
  if (bot && botState.connected) {
    clearAllIntervals();
    try {
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;
      initializeModules(bot, mcData, defaultMove);
    } catch (e) {
      console.log('[Config] Could not reload modules:', e.message);
    }
  }
  res.json({success: true});
});

// ---- Server listen ----
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Dashboard on port ${server.address().port}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    server.listen(PORT + 1, '0.0.0.0');
  } else console.error(err);
});

// ---- Self-ping ----
const SELF_PING_INTERVAL = 10 * 60 * 1000;
function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) return console.log('[KeepAlive] No RENDER_EXTERNAL_URL');
  setInterval(() => {
    const protocol = renderUrl.startsWith('https') ? https : http;
    protocol.get(`${renderUrl}/ping`, () => {}).on('error', e => console.log('[KeepAlive] Ping failed:', e.message));
  }, SELF_PING_INTERVAL);
  console.log('[KeepAlive] Started');
}
startSelfPing();

// ---- Memory monitor ----
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`[Memory] Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
}, 5 * 60 * 1000);

// ============================================================
// BOT LOGIC
// ============================================================
function clearBotTimeouts() {
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; }
  if (connectionTimeoutId) { clearTimeout(connectionTimeoutId); connectionTimeoutId = null; }
}

let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000;

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    return 60000 + Math.floor(Math.random() * 60000);
  }
  const base = config.utils['auto-reconnect-delay'] || 10000;
  const max = config.utils['max-reconnect-delay'] || 120000;
  const delay = Math.min(base * Math.pow(2, botState.reconnectAttempts), max);
  return delay + Math.floor(Math.random() * 2000);
}

function pingServer() {
  return new Promise((resolve, reject) => {
    mc.ping({
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version || false
    }, (err, res) => err ? reject(err) : resolve(res));
  });
}

function startEmptyServerMonitor() {
  console.log('[PlayerDetect] Monitoring for empty server...');
  let first = true;
  const interval = setInterval(async () => {
    try {
      const data = await pingServer();
      const count = data.players.online;
      console.log(`[PlayerDetect] Players online: ${count}`);
      if (first) { first = false; if (count === 0) return; }
      if (count === 0) {
        clearInterval(interval);
        console.log('[PlayerDetect] Server empty, reconnecting...');
        intentionalDisconnect = false;
        createBot();
      }
    } catch (e) {
      console.log(`[PlayerDetect] Ping error: ${e.message}`);
    }
  }, 20000);
}

function createBot() {
  if (isReconnecting) return;
  isReconnecting = false; // reset lock immediately

  if (bot) {
    clearAllIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (e) {}
    bot = null;
  }

  console.log('[Bot] Creating bot instance, connecting to', config.server.ip);
  try {
    const version = config.server.version && config.server.version.trim() ? config.server.version : false;
    bot = mineflayer.createBot({
      username: config['bot-account'].username,
      password: config['bot-account'].password || undefined,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: config.server.port,
      version,
      hideErrors: false,
      checkTimeoutInterval: 60000
    });

    bot.loadPlugin(pathfinder);
    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        console.log('[Bot] Connection timeout');
        try { bot.removeAllListeners(); bot.end(); } catch (e) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;
    bot.once('spawn', () => {
      if (spawnHandled) return;
      spawnHandled = true;
      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      console.log(`[Bot] Spawned (${bot.version})`);

      if (config.discord?.events?.connect) sendDiscordWebhook(`✅ Connected to \`${config.server.ip}\``, 0x4ade80);

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      initializeModules(bot, mcData, defaultMove);

      if (config.server['try-creative']) {
        setTimeout(() => { if (bot && botState.connected) bot.chat('/gamemode creative'); }, 3000);
      }
    });

    bot.on('kicked', (reason) => {
      const kickReason = typeof reason === 'object' ? JSON.stringify(reason) : reason;
      console.log('[Bot] Kicked:', kickReason);
      botState.connected = false;
      botState.errors.push({ type: 'kicked', reason: kickReason, time: Date.now() });
      clearAllIntervals();
      if (String(kickReason).toLowerCase().includes('throttl')) botState.wasThrottled = true;
      if (config.discord?.events?.disconnect) sendDiscordWebhook(`⛔ Kicked: ${kickReason}`, 0xff0000);
    });

    bot.on('end', (reason) => {
      console.log('[Bot] Disconnected:', reason || 'Unknown');
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;
      if (config.discord?.events?.disconnect) sendDiscordWebhook(`🔌 Disconnected: ${reason || 'Unknown'}`, 0xf87171);
      if (intentionalDisconnect) {
        startEmptyServerMonitor();
        return;
      }
      scheduleReconnect();
    });

    bot.on('error', (err) => {
      console.log('[Bot] Error:', err.message);
      botState.errors.push({ type: 'error', message: err.message, time: Date.now() });
    });
  } catch (err) {
    console.log('[Bot] Failed to create bot:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearBotTimeouts();
  if (isReconnecting) return;
  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  console.log(`[Bot] Reconnecting in ${delay/1000}s (attempt #${botState.reconnectAttempts})`);
  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION (with runtime toggles)
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  console.log('[Modules] Initializing...');

  // Player detection
  if (config.utils['player-detection']?.enabled) {
    bot.on('playerJoined', (player) => {
      if (player.username === bot.username) return;
      if (config.utils['player-detection']['disconnect-on-join']) {
        console.log(`[PlayerDetect] ${player.username} joined -> disconnecting`);
        intentionalDisconnect = true;
        bot.end();
      }
    });
  }

  // Auto auth
  if (config.utils['auto-auth']?.enabled) {
    const pwd = config.utils['auto-auth'].password;
    let authHandled = false;
    const tryCmd = (cmd) => { if (!authHandled && bot && botState.connected) { bot.chat(cmd); console.log(`[Auth] Sent: ${cmd}`); } };
    setTimeout(() => tryCmd(`/login ${pwd}`), 2000);
    bot.on('messagestr', (msg) => {
      if (authHandled) return;
      const m = msg.toLowerCase();
      if (m.includes('logged in') || m.includes('successfully logged')) { authHandled = true; return; }
      if (m.includes('not registered') || m.includes('register') || m.includes('/register')) tryCmd(`/register ${pwd} ${pwd}`);
      if (m.includes('incorrect password') || m.includes('wrong password')) tryCmd(`/register ${pwd} ${pwd}`);
    });
    setTimeout(() => { if (!authHandled && bot && botState.connected) tryCmd(`/login ${pwd}`); }, 8000);
  }

  // Chat messages
  if (isModuleEnabled('utils.chat-messages.enabled')) {
    const msgs = config.utils['chat-messages'].messages;
    if (config.utils['chat-messages'].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) { bot.chat(msgs[i]); i = (i+1) % msgs.length; botState.lastActivity = Date.now(); }
      }, config.utils['chat-messages']['repeat-delay'] * 1000);
    }
  }

  // Move to position (only if not circle-walk)
  if (config.position?.enabled && !isModuleEnabled('movement.circle-walk.enabled')) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
  }

  // Anti-AFK
  if (isModuleEnabled('utils.anti-afk.enabled')) {
    addInterval(() => { try { bot.swingArm(); } catch (e) {} }, 10000 + Math.random()*50000);
    addInterval(() => { try { bot.setQuickBarSlot(Math.floor(Math.random()*9)); } catch (e) {} }, 30000 + Math.random()*90000);
    addInterval(() => {
      if (typeof bot.setControlState === 'function' && Math.random() > 0.9) {
        let cnt = 2+Math.floor(Math.random()*4);
        const doT = () => {
          if (cnt<=0||!bot||typeof bot.setControlState!=='function') return;
          bot.setControlState('sneak', true);
          setTimeout(() => { bot.setControlState('sneak', false); cnt--; setTimeout(doT,150); },150);
        };
        doT();
      }
    }, 120000+Math.random()*180000);
    if (!isModuleEnabled('movement.circle-walk.enabled')) {
      addInterval(() => {
        if (typeof bot.setControlState === 'function') {
          const yaw = Math.random()*Math.PI*2;
          bot.look(yaw, 0, true);
          bot.setControlState('forward', true);
          setTimeout(() => { if (bot) bot.setControlState('forward', false); }, 500+Math.random()*1500);
        }
      }, 120000+Math.random()*360000);
    }
  }

  // Movement modules
  if (isModuleEnabled('movement.circle-walk.enabled')) startCircleWalk(bot, defaultMove);
  if (isModuleEnabled('movement.random-jump.enabled') && !isModuleEnabled('movement.circle-walk.enabled')) startRandomJump(bot);
  if (isModuleEnabled('movement.look-around.enabled')) startLookAround(bot);

  // Custom modules
  if (isModuleEnabled('modules.avoidMobs') && !isModuleEnabled('modules.combat')) avoidMobs(bot);
  if (isModuleEnabled('modules.combat')) combatModule(bot, mcData);
  if (isModuleEnabled('modules.beds')) bedModule(bot, mcData);
  if (isModuleEnabled('modules.chat')) chatModule(bot);

  console.log('[Modules] Initialized');
}

// ---- Movement helpers ----
function startCircleWalk(bot, defaultMove) {
  const rad = config.movement['circle-walk'].radius;
  let angle = 0, last = 0;
  addInterval(() => {
    if (!bot||!botState.connected) return;
    const now = Date.now();
    if (now-last < 2000) return;
    last = now;
    const x = bot.entity.position.x + Math.cos(angle)*rad;
    const z = bot.entity.position.z + Math.sin(angle)*rad;
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
    angle += Math.PI/4;
  }, config.movement['circle-walk'].speed);
}

function startRandomJump(bot) {
  addInterval(() => {
    if (typeof bot.setControlState === 'function') {
      bot.setControlState('jump', true);
      setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 300);
    }
  }, config.movement['random-jump'].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    try { bot.look(Math.random()*Math.PI*2 - Math.PI, Math.random()*Math.PI/2 - Math.PI/4, false); } catch (e) {}
  }, config.movement['look-around'].interval);
}

function avoidMobs(bot) {
  addInterval(() => {
    if (!bot||!botState.connected||typeof bot.setControlState!=='function') return;
    const entities = Object.values(bot.entities).filter(e => e.type==='mob'||(e.type==='player'&&e.username!==bot.username));
    for (const e of entities) {
      if (!e.position) continue;
      if (bot.entity.position.distanceTo(e.position) < 5) {
        bot.setControlState('back', true);
        setTimeout(() => { if (bot) bot.setControlState('back', false); }, 500);
        break;
      }
    }
  }, 2000);
}

function combatModule(bot, mcData) {
  let lastAttack = 0, target = null, targetExpiry = 0;
  bot.on('physicsTick', () => {
    if (!isModuleEnabled('modules.combat') || !config.combat['attack-mobs']) return;
    const now = Date.now();
    if (now - lastAttack < 620) return;
    if (target && now < targetExpiry && bot.entities[target.id]?.position) {
      if (bot.entity.position.distanceTo(target.position) < 4) {
        bot.attack(target); lastAttack = now; return;
      } else target = null;
    }
    const mobs = Object.values(bot.entities).filter(e => e.type==='mob' && e.position && bot.entity.position.distanceTo(e.position) < 4);
    if (mobs.length) { target = mobs[0]; targetExpiry = now+3000; bot.attack(target); lastAttack = now; }
  });
  bot.on('health', () => {
    if (!config.combat['auto-eat']) return;
    if (bot.food < 14) {
      const food = bot.inventory.items().find(i => i.foodPoints > 0);
      if (food) bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
    }
  });
}

function bedModule(bot, mcData) {
  let trying = false;
  addInterval(async () => {
    if (!config.beds['place-night'] || trying) return;
    if (bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500) {
      const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 8 });
      if (bed) {
        trying = true;
        try { await bot.sleep(bed); console.log('[Bed] Sleeping'); } catch (e) {} finally { trying = false; }
      }
    }
  }, 10000);
}

function chatModule(bot) {
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    if (config.discord?.enabled && config.discord?.events?.chat) sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
    if (config.chat?.respond) {
      const lower = message.toLowerCase();
      if (lower.includes('hello') || lower.includes('hi')) bot.chat(`Hello, ${username}!`);
      if (message.startsWith('!tp ')) { const target = message.split(' ')[1]; if (target) bot.chat(`/tp ${target}`); }
    }
  });
}

// ---- Discord webhook ----
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord?.enabled || !config.discord.webhookUrl || config.discord.webhookUrl.includes('YOUR_DISCORD')) return;
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) return;
  lastDiscordSend = now;
  const protocol = config.discord.webhookUrl.startsWith('https') ? https : http;
  const url = new URL(config.discord.webhookUrl);
  const payload = JSON.stringify({
    username: config.name,
    embeds: [{ description: content, color, timestamp: new Date().toISOString(), footer: { text: 'AFK Bot' } }]
  });
  const req = protocol.request({
    hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, () => {});
  req.on('error', (e) => console.log('[Discord] Error:', e.message));
  req.write(payload);
  req.end();
}

// ---- Crash recovery ----
process.on('uncaughtException', (err) => {
  console.log('[FATAL] Uncaught Exception:', err.message);
  botState.errors.push({ type: 'uncaught', message: err.message, time: Date.now() });
  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);
  clearAllIntervals();
  botState.connected = false;
  if (isReconnecting) { isReconnecting = false; if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId); }
  setTimeout(() => scheduleReconnect(), 5000);
});

process.on('unhandledRejection', (reason) => {
  console.log('[FATAL] Unhandled Rejection:', reason);
  botState.errors.push({ type: 'rejection', message: String(reason), time: Date.now() });
});

// ---- Graceful exit for Render restart (let Render restart us) ----
process.on('SIGTERM', () => {
  console.log('[System] SIGTERM – exiting so Render restarts us');
  if (bot) bot.end();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[System] SIGINT – exiting');
  if (bot) bot.end();
  process.exit(0);
});

// ============================================================
// START
// ============================================================
console.log('='.repeat(50));
console.log('  Minecraft AFK Bot – Full Control Panel');
console.log('='.repeat(50));
console.log(`Server: ${config.server.ip}:${config.server.port}`);
console.log('='.repeat(50));
createBot();
