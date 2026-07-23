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
let botConnectTime = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let intentionalDisconnect = false;

// Runtime config overrides
let runtimeConfig = {};
// Death flag for longer reconnect delay
let lastDeathTime = 0;

function getNested(obj, path) {
  return path.split('.').reduce((o, i) => (o ? o[i] : undefined), obj);
}

function isModuleEnabled(path) {
  if (runtimeConfig[path] !== undefined) return runtimeConfig[path];
  return getNested(config, path);
}

// ============================================================
// DASHBOARD
// ============================================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.name} Control Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0a0f1e;
      color: #cfd4e5;
      padding: 1.5rem;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    .panel {
      max-width: 780px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 1.2rem;
    }
    .card {
      background: #151a2e;
      border-radius: 1.2rem;
      padding: 1.5rem;
      box-shadow: 0 8px 20px rgba(0,0,0,0.5);
      border: 1px solid #242b42;
    }
    h1 {
      font-size: 2rem;
      text-align: center;
      background: linear-gradient(135deg, #6c8cff, #44d4b3);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
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
      padding: 0.4rem 1rem;
      border-radius: 2rem;
      font-weight: 600;
      font-size: 0.9rem;
      letter-spacing: 0.3px;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    .online { background: #1b4332; color: #95d5b2; }
    .offline { background: #5c1a1a; color: #f5a3a3; }
    .ping {
      background: #1d2b44;
      padding: 0.3rem 0.8rem;
      border-radius: 2rem;
      font-size: 0.85rem;
      font-weight: 500;
    }
    .coords {
      font-family: 'Fira Code', monospace;
      font-size: 1.1rem;
      background: #0d1122;
      padding: 0.5rem 1rem;
      border-radius: 0.6rem;
      border: 1px solid #2d3548;
    }
    h3 {
      margin-bottom: 0.8rem;
      color: #9aa4bf;
      font-size: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .btn {
      background: #2d3a5c;
      color: white;
      border: none;
      padding: 0.7rem 1.2rem;
      border-radius: 0.6rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 0.9rem;
      letter-spacing: 0.3px;
    }
    .btn:hover { background: #3b4b73; transform: translateY(-1px); }
    .btn-danger { background: #b52e2e; }
    .btn-danger:hover { background: #d33a3a; }
    .btn-success { background: #2d6a4f; }
    .btn-success:hover { background: #3a8b66; }
    input {
      width: 100%;
      padding: 0.7rem;
      border-radius: 0.6rem;
      border: 1px solid #2d3548;
      background: #0d1122;
      color: white;
      margin-bottom: 0.5rem;
      font-size: 0.95rem;
    }
    .flex-row {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .flex-row input { flex: 1; min-width: 80px; }
    .toggle-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.4rem 0;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 46px;
      height: 24px;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #3b4252;
      transition: .3s;
      border-radius: 34px;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 18px; width: 18px;
      left: 3px; bottom: 3px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
    }
    input:checked + .slider { background-color: #4c9f70; }
    input:checked + .slider:before { transform: translateX(22px); }
    .footer-note {
      text-align: center;
      color: #5c6a8a;
      font-size: 0.8rem;
      margin-top: 0.5rem;
    }
    @media (max-width: 500px) {
      h1 { font-size: 1.6rem; }
      .status-row { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="panel">
    <h1>🤖 ${config.name}</h1>

    <div class="card">
      <div class="status-row">
        <div style="display: flex; align-items: center; gap: 1rem;">
          <span id="status-badge" class="badge offline">⚫ Offline</span>
          <span id="ping-display" class="ping">-- ms</span>
        </div>
        <div>
          <span style="color:#8d99ae;">🕒</span> <strong id="conn-timer">0h 0m 0s</strong>
        </div>
      </div>
      <div style="margin-top: 0.8rem;">
        <span style="color:#8d99ae;">📍</span> <span id="position" class="coords">---</span>
      </div>
    </div>

    <div class="card">
      <h3>🎯 Navigate</h3>
      <div class="flex-row">
        <input id="coordX" type="number" placeholder="X" value="0">
        <input id="coordY" type="number" placeholder="Y" value="100">
        <input id="coordZ" type="number" placeholder="Z" value="0">
        <button class="btn" onclick="setCoords()">Go</button>
      </div>
    </div>

    <div class="card">
      <h3>💬 Chat & Command</h3>
      <input id="chatInput" placeholder="Public message...">
      <div class="flex-row" style="margin-top: 0.5rem;">
        <button class="btn" onclick="sendChat()">Send Chat</button>
        <input id="cmdInput" placeholder="/command (without /)" style="flex:2;">
        <button class="btn btn-success" onclick="sendCmd()">Run</button>
      </div>
    </div>

    <div class="card">
      <h3>⚙️ Behaviour</h3>
      <div class="toggle-row"><span>Anti-AFK</span><label class="switch"><input type="checkbox" id="tog-anti-afk" onchange="toggleModule('utils.anti-afk.enabled',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Chat Messages</span><label class="switch"><input type="checkbox" id="tog-chat-msgs" onchange="toggleModule('utils.chat-messages.enabled',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Circle Walk</span><label class="switch"><input type="checkbox" id="tog-circle" onchange="toggleModule('movement.circle-walk.enabled',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Random Jump</span><label class="switch"><input type="checkbox" id="tog-jump" onchange="toggleModule('movement.random-jump.enabled',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Look Around</span><label class="switch"><input type="checkbox" id="tog-look" onchange="toggleModule('movement.look-around.enabled',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Combat</span><label class="switch"><input type="checkbox" id="tog-combat" onchange="toggleModule('modules.combat',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Avoid Mobs</span><label class="switch"><input type="checkbox" id="tog-avoid" onchange="toggleModule('modules.avoidMobs',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Beds (Night)</span><label class="switch"><input type="checkbox" id="tog-beds" onchange="toggleModule('modules.beds',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Chat Reply</span><label class="switch"><input type="checkbox" id="tog-chat-reply" onchange="toggleModule('modules.chat',this.checked)"><span class="slider"></span></label></div>
      <div class="toggle-row" style="font-weight:600; color:#44d4b3;">
        <span>👥 Leave on player join</span>
        <label class="switch"><input type="checkbox" id="tog-player-detect" onchange="toggleModule('utils.player-detection.enabled',this.checked)"><span class="slider"></span></label>
      </div>
    </div>

    <div class="card">
      <h3>🔧 Service</h3>
      <div class="flex-row">
        <button class="btn btn-danger" onclick="restartBot()">🔄 Restart</button>
        <button class="btn" onclick="disconnectBot()">⏹️ Disconnect</button>
        <button class="btn btn-success" onclick="reconnectBot()">🔁 Reconnect</button>
      </div>
      <div class="footer-note">
        Restart = restart Render service. Disconnect = stop bot only.<br>
        Toggles cause a 3‑second reconnect to apply cleanly.
      </div>
    </div>

    <div class="footer-note" style="margin-top:0;">
      Auto-refresh every 3s · ${config.server.ip}:${config.server.port}
    </div>
  </div>

  <script>
    let connectedSince = null;

    async function fetchStatus() {
      try {
        const r = await fetch('/health');
        const d = await r.json();
        const badge = document.getElementById('status-badge');
        badge.textContent = d.status === 'connected' ? '🟢 Online' : '⚫ Offline';
        badge.className = 'badge ' + (d.status === 'connected' ? 'online' : 'offline');
        document.getElementById('ping-display').textContent = d.ping ? d.ping + ' ms' : '-- ms';
        if (d.connectedSince) {
          connectedSince = d.connectedSince;
        } else {
          connectedSince = null;
        }
        updateTimer();
        if (d.coords) {
          document.getElementById('position').textContent =
            Math.floor(d.coords.x) + ', ' + Math.floor(d.coords.y) + ', ' + Math.floor(d.coords.z);
        } else {
          document.getElementById('position').textContent = '---';
        }
        if (d.runtimeConfig) {
          setToggle('tog-anti-afk', d.runtimeConfig['utils.anti-afk.enabled']);
          setToggle('tog-chat-msgs', d.runtimeConfig['utils.chat-messages.enabled']);
          setToggle('tog-circle', d.runtimeConfig['movement.circle-walk.enabled']);
          setToggle('tog-jump', d.runtimeConfig['movement.random-jump.enabled']);
          setToggle('tog-look', d.runtimeConfig['movement.look-around.enabled']);
          setToggle('tog-combat', d.runtimeConfig['modules.combat']);
          setToggle('tog-avoid', d.runtimeConfig['modules.avoidMobs']);
          setToggle('tog-beds', d.runtimeConfig['modules.beds']);
          setToggle('tog-chat-reply', d.runtimeConfig['modules.chat']);
          setToggle('tog-player-detect', d.runtimeConfig['utils.player-detection.enabled']);
        }
      } catch(e) {}
    }

    function setToggle(id, val) {
      const el = document.getElementById(id);
      if (el && val !== undefined) el.checked = val;
    }

    function updateTimer() {
      const el = document.getElementById('conn-timer');
      if (!connectedSince) {
        el.textContent = '0h 0m 0s';
        return;
      }
      const elapsed = Math.floor((Date.now() - connectedSince) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = elapsed % 60;
      el.textContent = h + 'h ' + m + 'm ' + s + 's';
    }

    setInterval(updateTimer, 1000);

    async function setCoords() {
      const x = document.getElementById('coordX').value;
      const y = document.getElementById('coordY').value;
      const z = document.getElementById('coordZ').value;
      await fetch('/setcoords', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({x:parseInt(x),y:parseInt(y),z:parseInt(z)})
      });
      alert('Sent!');
    }

    async function sendChat() {
      const msg = document.getElementById('chatInput').value;
      if(!msg) return;
      await fetch('/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:msg})});
      document.getElementById('chatInput').value = '';
    }

    async function sendCmd() {
      const cmd = document.getElementById('cmdInput').value;
      if(!cmd) return;
      await fetch('/cmd', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({command:cmd})});
      document.getElementById('cmdInput').value = '';
    }

    async function restartBot() {
      if(confirm('Restart the Render service?')) {
        await fetch('/restart', {method:'POST'});
        alert('Restarting... (page may reload in ~30s)');
      }
    }

    async function disconnectBot() {
      await fetch('/disconnect', {method:'POST'});
      alert('Bot disconnected.');
    }

    async function reconnectBot() {
      await fetch('/reconnect', {method:'POST'});
      alert('Reconnecting...');
    }

    async function toggleModule(path, enabled) {
      await fetch('/toggle', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({path, enabled})
      });
    }

    setInterval(fetchStatus, 3000);
    fetchStatus();
  </script>
</body>
</html>`);
});

// ---- API ENDPOINTS ----
app.get('/health', (req, res) => {
  let pingVal = null;
  if (bot && bot.players && bot.username) {
    const p = bot.players[bot.username];
    if (p) pingVal = p.ping;
  }
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
    ping: pingVal,
    connectedSince: botConnectTime,
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
      'modules.chat': isModuleEnabled('modules.chat'),
      'utils.player-detection.enabled': isModuleEnabled('utils.player-detection.enabled')
    }
  });
});

app.get('/ping', (req, res) => res.send('pong'));

app.post('/setcoords', (req, res) => {
  if (!bot || !botState.connected) return res.status(400).json({error:'Bot offline'});
  const {x, y, z} = req.body;
  try {
    const mcData = require('minecraft-data')(bot.version);
    const move = new Movements(bot, mcData);
    move.allowFreeMotion = false;
    bot.pathfinder.setMovements(move);
    bot.pathfinder.setGoal(new GoalBlock(x, y, z));
    console.log(`[Dash] Navigate -> ${x},${y},${z}`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/chat', (req, res) => {
  if (!bot || !botState.connected) return res.status(400).json({error:'Bot offline'});
  bot.chat(req.body.message);
  res.json({success:true});
});

app.post('/cmd', (req, res) => {
  if (!bot || !botState.connected) return res.status(400).json({error:'Bot offline'});
  bot.chat('/' + req.body.command);
  res.json({success:true});
});

app.post('/restart', (req, res) => {
  res.json({success:true});
  setTimeout(() => process.exit(0), 500);
});

app.post('/disconnect', (req, res) => {
  if (bot) bot.end();
  res.json({success:true});
});

app.post('/reconnect', (req, res) => {
  if (bot) bot.end();
  intentionalDisconnect = false;
  createBot();
  res.json({success:true});
});

app.post('/toggle', (req, res) => {
  const { path, enabled } = req.body;
  if (!path) return res.status(400).json({error:'Missing path'});
  runtimeConfig[path] = enabled;
  console.log(`[Config] ${path} = ${enabled}`);
  if (bot && botState.connected) {
    bot.end();
    setTimeout(() => {
      if (!isReconnecting) createBot();
    }, 3000);
  }
  res.json({success:true, message:'Toggle applied – bot reconnecting in 3s'});
});

// ---- Server ----
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Dashboard on port ${server.address().port}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') server.listen(PORT + 1, '0.0.0.0');
  else console.error(err);
});

// ---- Self-ping ----
function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) return console.log('[KeepAlive] No RENDER_EXTERNAL_URL');
  setInterval(() => {
    const protocol = renderUrl.startsWith('https') ? https : http;
    protocol.get(`${renderUrl}/ping`, () => {}).on('error', e => console.log('[KeepAlive]', e.message));
  }, 10 * 60 * 1000);
  console.log('[KeepAlive] Started');
}
startSelfPing();

// ---- Memory ----
setInterval(() => {
  console.log(`[Memory] ${(process.memoryUsage().heapUsed/1024/1024).toFixed(1)} MB`);
}, 5 * 60 * 1000);

// ============================================================
// BOT LOGIC
// ============================================================
function clearBotTimeouts() {
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; }
  if (connectionTimeoutId) { clearTimeout(connectionTimeoutId); connectionTimeoutId = null; }
}

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function addInterval(cb, delay) {
  const id = setInterval(cb, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    return 60000 + Math.floor(Math.random() * 60000);
  }
  // If the last death was less than 2 minutes ago, use a longer base delay
  const timeSinceDeath = Date.now() - lastDeathTime;
  const isRecentDeath = (lastDeathTime > 0 && timeSinceDeath < 120000);
  const base = config.utils['auto-reconnect-delay'] || (isRecentDeath ? 120000 : 30000); // 2 min if recent death
  const max = config.utils['max-reconnect-delay'] || 300000;
  const delay = Math.min(base * Math.pow(2, botState.reconnectAttempts), max);
  return delay + Math.floor(Math.random() * 5000);
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
  const interval = setInterval(async () => {
    try {
      const data = await pingServer();
      const count = data.players.online;
      console.log(`[PlayerDetect] Online: ${count}`);
      if (count === 0) {
        clearInterval(interval);
        console.log('[PlayerDetect] Server empty – reconnecting now');
        intentionalDisconnect = false;
        createBot();
      }
    } catch (e) { console.log('[PlayerDetect] Ping error:', e.message); }
  }, 5000);
}

function createBot() {
  if (isReconnecting) return;
  isReconnecting = false;

  if (bot) {
    clearAllIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (e) {}
    bot = null;
  }

  console.log('[Bot] Creating bot for', config.server.ip);
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
      botConnectTime = Date.now();
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      console.log(`[Bot] Spawned (${bot.version})`);

      if (config.discord?.events?.connect) sendDiscord(`✅ Connected`, 0x4ade80);

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false; defaultMove.canDig = false;
      defaultMove.liquidCost = 1000; defaultMove.fallDamageCost = 1000;
      initializeModules(bot, mcData, defaultMove);

      // 📌 Teleport to safe location (e.g., /spawn) after a short delay
      setTimeout(() => {
        if (bot && botState.connected) {
          bot.chat('/spawn'); // Assumes server has a /spawn command (Essentials etc.)
        }
      }, 3000);

      if (config.server['try-creative']) {
        setTimeout(() => { if (bot && botState.connected) bot.chat('/gamemode creative'); }, 5000);
      }
    });

    // 💀 Death → disconnect immediately (no respawn loop)
    bot.on('death', () => {
      console.log('[Bot] Died – disconnecting to reconnect cleanly');
      lastDeathTime = Date.now();
      bot.end();
    });

    bot.on('kicked', (reason) => {
      const r = typeof reason === 'object' ? JSON.stringify(reason) : reason;
      console.log('[Bot] Kicked:', r);
      botState.connected = false;
      botConnectTime = null;
      botState.errors.push({type:'kicked',reason:r,time:Date.now()});
      clearAllIntervals();
      if (String(r).toLowerCase().includes('throttl')) botState.wasThrottled = true;
      if (config.discord?.events?.disconnect) sendDiscord(`⛔ Kicked: ${r}`, 0xff0000);
    });

    bot.on('end', (reason) => {
      console.log('[Bot] Disconnected:', reason || 'unknown');
      botState.connected = false;
      botConnectTime = null;
      clearAllIntervals();
      spawnHandled = false;
      if (config.discord?.events?.disconnect) sendDiscord(`🔌 Disconnected`, 0xf87171);
      if (intentionalDisconnect) {
        startEmptyServerMonitor();
        return;
      }
      scheduleReconnect();
    });

    bot.on('error', (err) => {
      console.log('[Bot] Error:', err.message);
      botState.errors.push({type:'error', message:err.message, time:Date.now()});
    });
  } catch (err) {
    console.log('[Bot] Creation error:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearBotTimeouts();
  if (isReconnecting) return;
  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  console.log(`[Bot] Reconnect in ${delay/1000}s (attempt #${botState.reconnectAttempts})`);
  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    createBot();
  }, delay);
}

// ============================================================
// MODULES (unchanged, but with runtime toggles)
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  console.log('[Modules] Initializing...');
  clearAllIntervals();

  if (isModuleEnabled('utils.player-detection.enabled')) {
    bot.on('playerJoined', (player) => {
      if (player.username === bot.username) return;
      if (config.utils['player-detection']['disconnect-on-join'] !== false) {
        console.log(`[PlayerDetect] ${player.username} joined – disconnecting`);
        intentionalDisconnect = true;
        bot.end();
      }
    });
  }

  if (config.utils['auto-auth']?.enabled) {
    const pwd = config.utils['auto-auth'].password;
    let authHandled = false, attempts = 0, maxAttempts = 4;
    const tryLogin = () => {
      if (authHandled || !bot || !botState.connected || attempts >= maxAttempts) return;
      attempts++;
      bot.chat(`/login ${pwd}`);
      console.log(`[Auth] Login attempt ${attempts}`);
    };
    setTimeout(tryLogin, 2000);
    bot.on('messagestr', (msg) => {
      if (authHandled) return;
      const m = msg.toLowerCase();
      if (m.includes('logged in') || m.includes('successfully logged') || m.includes('welcome back') || m.includes('authorized')) {
        authHandled = true;
        console.log('[Auth] Success');
        return;
      }
      if (m.includes('not registered') || m.includes('register first') || m.includes('/register')) {
        if (!authHandled && attempts < maxAttempts) { attempts++; bot.chat(`/register ${pwd} ${pwd}`); }
        return;
      }
      if (m.includes('kicked') || m.includes('time limit') || m.includes('timed out')) authHandled = true;
    });
    const retry = setInterval(() => {
      if (authHandled || attempts >= maxAttempts) clearInterval(retry);
      else tryLogin();
    }, 5000);
  }

  if (isModuleEnabled('utils.chat-messages.enabled')) {
    const msgs = config.utils['chat-messages'].messages;
    if (config.utils['chat-messages'].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) { bot.chat(msgs[i]); i = (i+1) % msgs.length; botState.lastActivity = Date.now(); }
      }, config.utils['chat-messages']['repeat-delay'] * 1000);
    }
  }

  if (config.position?.enabled && !isModuleEnabled('movement.circle-walk.enabled')) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
  }

  if (isModuleEnabled('utils.anti-afk.enabled')) {
    addInterval(() => { try { bot.swingArm(); } catch(e){} }, 10000+Math.random()*50000);
    addInterval(() => { try { bot.setQuickBarSlot(Math.floor(Math.random()*9)); } catch(e){} }, 30000+Math.random()*90000);
    addInterval(() => {
      if (typeof bot.setControlState === 'function' && Math.random() > 0.9) {
        let cnt = 2+Math.floor(Math.random()*4);
        const doT = () => {
          if (cnt<=0||!bot||typeof bot.setControlState!=='function') return;
          bot.setControlState('sneak',true);
          setTimeout(() => { bot.setControlState('sneak',false); cnt--; setTimeout(doT,150); },150);
        };
        doT();
      }
    }, 120000+Math.random()*180000);
    if (!isModuleEnabled('movement.circle-walk.enabled')) {
      addInterval(() => {
        if (typeof bot.setControlState === 'function') {
          bot.look(Math.random()*Math.PI*2, 0, true);
          bot.setControlState('forward', true);
          setTimeout(() => { if (bot) bot.setControlState('forward', false); }, 500+Math.random()*1500);
        }
      }, 120000+Math.random()*360000);
    }
  }

  if (isModuleEnabled('movement.circle-walk.enabled')) startCircleWalk(bot, defaultMove);
  if (isModuleEnabled('movement.random-jump.enabled') && !isModuleEnabled('movement.circle-walk.enabled')) startRandomJump(bot);
  if (isModuleEnabled('movement.look-around.enabled')) startLookAround(bot);

  if (isModuleEnabled('modules.avoidMobs') && !isModuleEnabled('modules.combat')) avoidMobs(bot);
  if (isModuleEnabled('modules.combat')) combatModule(bot, mcData);
  if (isModuleEnabled('modules.beds')) bedModule(bot, mcData);
  if (isModuleEnabled('modules.chat')) chatModule(bot);

  console.log('[Modules] Ready');
}

function startCircleWalk(bot, defMove) {
  const rad = config.movement['circle-walk'].radius;
  let angle = 0, last = 0;
  addInterval(() => {
    if (!bot||!botState.connected) return;
    const now = Date.now();
    if (now-last < 2000) return;
    last = now;
    const x = bot.entity.position.x + Math.cos(angle)*rad;
    const z = bot.entity.position.z + Math.sin(angle)*rad;
    bot.pathfinder.setMovements(defMove);
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
    try { bot.look(Math.random()*Math.PI*2 - Math.PI, Math.random()*Math.PI/2 - Math.PI/4, false); } catch(e) {}
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
        try { await bot.sleep(bed); console.log('[Bed] Sleeping'); } catch(e) {} finally { trying = false; }
      }
    }
  }, 10000);
}

function chatModule(bot) {
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    if (config.discord?.enabled && config.discord?.events?.chat) sendDiscord(`💬 **${username}**: ${message}`, 0x7289da);
    if (config.chat?.respond) {
      const lower = message.toLowerCase();
      if (lower.includes('hello') || lower.includes('hi')) bot.chat(`Hello, ${username}!`);
      if (message.startsWith('!tp ')) { const target = message.split(' ')[1]; if (target) bot.chat(`/tp ${target}`); }
    }
  });
}

// Discord webhook
let lastDiscordSend = 0;
function sendDiscord(content, color = 0x0099ff) {
  if (!config.discord?.enabled || !config.discord.webhookUrl || config.discord.webhookUrl.includes('YOUR_DISCORD')) return;
  const now = Date.now();
  if (now - lastDiscordSend < 5000) return;
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
  req.on('error', (e) => console.log('[Discord]', e.message));
  req.write(payload);
  req.end();
}

// Crash recovery
process.on('uncaughtException', (err) => {
  console.log('[FATAL]', err.message);
  botState.errors.push({ type:'uncaught', message: err.message, time: Date.now() });
  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);
  clearAllIntervals();
  botState.connected = false;
  botConnectTime = null;
  if (isReconnecting) { isReconnecting = false; if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId); }
  setTimeout(scheduleReconnect, 5000);
});

process.on('unhandledRejection', (reason) => {
  console.log('[FATAL] Rejection:', reason);
  botState.errors.push({ type:'rejection', message: String(reason), time: Date.now() });
});

process.on('SIGTERM', () => {
  console.log('[System] SIGTERM – exiting (Render will restart)');
  if (bot) bot.end();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[System] SIGINT – exiting');
  if (bot) bot.end();
  process.exit(0);
});

// ============================================================
// LAUNCH
// ============================================================
console.log('═'.repeat(45));
console.log('  Minecraft AFK Bot – Stable Edition');
console.log('═'.repeat(45));
console.log(`Server: ${config.server.ip}:${config.server.port}`);
createBot();
