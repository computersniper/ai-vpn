import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import cors from 'cors';
import { getDb, updateDb, logAction } from './db.js';
import { startProxyServer, setUpstreamProxy, enableGitProxy, disableGitProxy, enableWindowsSystemProxy, disableWindowsSystemProxy } from './proxy-manager.js';
import { startOpenVpn, stopOpenVpn, getVpnState } from './vpn-manager.js';
import { runDiagnostics, triggerHealing, startHealthCheckLoop, stopHealthCheckLoop } from './health-check.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 4140;
let wsClients = new Set();

// WebSocket message broadcaster helper
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wsClients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// Global hooks for events
global.broadcastLog = (logEntry) => {
  broadcast('log', logEntry);
};

global.broadcastStatus = async () => {
  const db = getDb();
  const vpn = getVpnState();
  
  broadcast('status', {
    activeProfileId: db.activeProfileId,
    humanOverride: db.humanOverride,
    vpnState: vpn.state,
    vpnProfileName: vpn.profileName,
    settings: db.settings,
    profiles: db.profiles
  });
};

// Handle WebSocket connections
wss.on('connection', (ws) => {
  wsClients.add(ws);
  
  // Send initial data immediately
  const db = getDb();
  const vpn = getVpnState();
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      activeProfileId: db.activeProfileId,
      humanOverride: db.humanOverride,
      vpnState: vpn.state,
      vpnProfileName: vpn.profileName,
      settings: db.settings,
      profiles: db.profiles,
      logs: db.logs
    }
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

// Middleware to block AI actions when Human Override Lock is active
function enforceOverride(req, res, next) {
  const db = getDb();
  const source = req.headers['x-request-source'] || 'ai'; // Default to ai if header is missing
  
  if (db.humanOverride && source === 'ai') {
    logAction('ai', 'warn', `AI blocked from executing ${req.path} due to Human Override Lock`);
    return res.status(403).json({
      error: 'Access Denied: The connection configurations have been locked by a human supervisor.'
    });
  }
  next();
}

// REST Routes

// Fetch complete connection status
app.get('/api/status', async (req, res) => {
  const db = getDb();
  const vpn = getVpnState();
  const diag = await runDiagnostics();
  
  res.json({
    activeProfileId: db.activeProfileId,
    humanOverride: db.humanOverride,
    vpn: vpn,
    diagnostics: diag,
    settings: db.settings
  });
});

// Fetch all profiles
app.get('/api/profiles', (req, res) => {
  const db = getDb();
  res.json(db.profiles);
});

// Create/Upload profile
app.post('/api/profiles', enforceOverride, (req, res) => {
  const { name, type, content } = req.body;
  if (!name || !type || !content) {
    return res.status(400).json({ error: 'Missing name, type, or content' });
  }

  const newProfile = {
    id: `profile-${Date.now()}`,
    name,
    type, // 'openvpn' or 'proxy'
    content,
    latency: null,
    lastConnected: null
  };

  updateDb(db => {
    db.profiles.push(newProfile);
  });

  logAction('system', 'info', `New profile added: "${name}" (${type})`);
  global.broadcastStatus();
  res.json({ success: true, profile: newProfile });
});

// Delete profile
app.delete('/api/profiles/:id', enforceOverride, (req, res) => {
  const { id } = req.params;
  const db = getDb();
  
  if (id === 'direct-default') {
    return res.status(400).json({ error: 'Cannot delete the direct connection profile' });
  }

  if (db.activeProfileId === id) {
    return res.status(400).json({ error: 'Cannot delete the active connection profile. Disconnect or switch nodes first.' });
  }

  updateDb(data => {
    data.profiles = data.profiles.filter(p => p.id !== id);
  });

  logAction('system', 'info', `Profile deleted: ${id}`);
  global.broadcastStatus();
  res.json({ success: true });
});

// Trigger connection
app.post('/api/connect', enforceOverride, async (req, res) => {
  const { id } = req.body;
  const db = getDb();
  const profile = db.profiles.find(p => p.id === id);
  const source = req.headers['x-request-source'] || 'ai';

  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  logAction(source, 'info', `Connecting to profile "${profile.name}"...`);
  
  try {
    if (profile.type === 'proxy') {
      // Clean up OpenVPN if running
      stopOpenVpn();
      
      const config = JSON.parse(profile.content);
      setUpstreamProxy(config);
      
      if (config.direct) {
        await disableGitProxy();
      } else {
        await enableGitProxy();
      }
    } else if (profile.type === 'openvpn') {
      // Revert upstream proxy settings to direct, route system via tunnel
      setUpstreamProxy({ direct: true });
      await disableGitProxy();
      
      await startOpenVpn(profile, () => {
        global.broadcastStatus();
      });
    }

    updateDb(data => {
      data.activeProfileId = id;
      const idx = data.profiles.findIndex(p => p.id === id);
      if (idx !== -1) {
        data.profiles[idx].lastConnected = new Date().toISOString();
      }
    });

    logAction('system', 'info', `Connected successfully to "${profile.name}".`);
    global.broadcastStatus();
    res.json({ success: true, activeProfileId: id });
  } catch (err) {
    logAction('system', 'error', `Failed to connect to "${profile.name}": ${err.message}`);
    global.broadcastStatus();
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Disconnect
app.post('/api/disconnect', enforceOverride, async (req, res) => {
  const source = req.headers['x-request-source'] || 'ai';
  logAction(source, 'info', 'Disconnecting client and resetting to direct route...');
  
  try {
    stopOpenVpn();
    setUpstreamProxy({ direct: true });
    await disableGitProxy();
    await disableWindowsSystemProxy();

    updateDb(data => {
      data.activeProfileId = 'direct-default';
    });

    logAction('system', 'info', 'Disconnected. System routing restored to direct.');
    global.broadcastStatus();
    res.json({ success: true });
  } catch (err) {
    logAction('system', 'error', `Disconnection error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Heal Connection
app.post('/api/heal', enforceOverride, async (req, res) => {
  const source = req.headers['x-request-source'] || 'ai';
  logAction(source, 'info', 'Manual healing diagnostic requested.');
  const healed = await triggerHealing();
  res.json({ success: true, healed });
});

// Toggle Human Override Lock
app.post('/api/toggle-override', (req, res) => {
  const { override } = req.body;
  if (typeof override !== 'boolean') {
    return res.status(400).json({ error: 'override must be boolean' });
  }

  updateDb(data => {
    data.humanOverride = override;
  });

  logAction('human', 'info', `Human Override Lock toggled to: ${override ? 'LOCKED (AI Blocked)' : 'UNLOCKED (AI Permitted)'}`);
  global.broadcastStatus();
  res.json({ success: true, humanOverride: override });
});

// Settings Config
app.post('/api/settings', enforceOverride, (req, res) => {
  const { openvpnPath, healthCheckInterval, testUrls } = req.body;
  
  updateDb(db => {
    if (openvpnPath !== undefined) db.settings.openvpnPath = openvpnPath;
    if (healthCheckInterval !== undefined) db.settings.healthCheckInterval = Number(healthCheckInterval);
    if (testUrls !== undefined) db.settings.testUrls = testUrls;
  });

  logAction('system', 'info', 'Settings configurations updated.');
  
  // Restart loop with new interval
  stopHealthCheckLoop();
  startHealthCheckLoop();
  
  global.broadcastStatus();
  res.json({ success: true, settings: getDb().settings });
});

// Fetch recent logs
app.get('/api/logs', (req, res) => {
  const db = getDb();
  res.json(db.logs);
});

// Registry controls (expose system proxy shortcuts)
app.post('/api/system-proxy/enable', enforceOverride, async (req, res) => {
  const success = await enableWindowsSystemProxy();
  res.json({ success });
});

app.post('/api/system-proxy/disable', enforceOverride, async (req, res) => {
  const success = await disableWindowsSystemProxy();
  res.json({ success });
});

// Daemon startup logic
async function bootstrap() {
  logAction('system', 'info', 'Starting AI-VPN backend daemon...');
  
  // Start local proxy server (port 4141)
  startProxyServer();
  
  // Load database active profile and apply it on boot
  const db = getDb();
  const activeProfile = db.profiles.find(p => p.id === db.activeProfileId) || db.profiles[0];
  logAction('system', 'info', `Applying initial connection profile on boot: "${activeProfile.name}"`);
  
  try {
    if (activeProfile.type === 'proxy') {
      const config = JSON.parse(activeProfile.content);
      setUpstreamProxy(config);
      if (!config.direct) {
        await enableGitProxy();
      }
    } else if (activeProfile.type === 'openvpn') {
      await startOpenVpn(activeProfile);
    }
  } catch (err) {
    logAction('system', 'error', `Failed to apply initial profile: ${err.message}`);
  }

  // Start periodic health monitor
  startHealthCheckLoop();

  // Listen on PORT 4140
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 AI-VPN Daemon REST API & WS server running on http://127.0.0.1:${PORT}`);
    console.log(`🛡️  Human Override Lock status: ${db.humanOverride ? 'ACTIVE' : 'INACTIVE'}`);
    console.log(`======================================================\n`);
  });
}

bootstrap().catch(err => {
  console.error('Fatal bootstrapping error:', err);
});
