import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, '../data.json');

const DEFAULT_DATA = {
  profiles: [
    {
      id: 'direct-default',
      name: 'Direct Connection (No Proxy)',
      type: 'proxy',
      content: JSON.stringify({ direct: true }),
      latency: null,
      lastConnected: null
    },
    {
      id: 'mock-proxy-1',
      name: 'Mock US Proxy (Fallback Node)',
      type: 'proxy',
      content: JSON.stringify({ host: '127.0.0.1', port: 1080, protocol: 'socks5' }),
      latency: null,
      lastConnected: null
    }
  ],
  activeProfileId: 'direct-default',
  humanOverride: false,
  settings: {
    openvpnPath: 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe',
    healthCheckInterval: 30,
    testUrls: [
      { name: 'GitHub', url: 'https://github.com' },
      { name: 'OpenAI API', url: 'https://api.openai.com' },
      { name: 'Google', url: 'https://www.google.com' }
    ]
  },
  logs: []
};

// Ensure directory exists
const dir = path.dirname(DB_FILE);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return { ...DEFAULT_DATA, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error('Failed to load DB, using defaults', error);
  }
  return { ...DEFAULT_DATA };
}

export function saveDb(data) {
  try {
    // Keep logs capped to last 200 items in DB to avoid bloat
    if (data.logs && data.logs.length > 200) {
      data.logs = data.logs.slice(-200);
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save DB', error);
  }
}

// Memory cache of DB
let cache = loadDb();

export function getDb() {
  return cache;
}

export function updateDb(fn) {
  fn(cache);
  saveDb(cache);
  return cache;
}

export function logAction(source, level, message) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    source, // 'system', 'openvpn', 'ai', 'human'
    level,  // 'info', 'warn', 'error'
    message
  };
  
  updateDb(db => {
    db.logs.push(logEntry);
  });
  
  console.log(`[${logEntry.timestamp}] [${source.toUpperCase()}] [${level.toUpperCase()}] ${message}`);
  
  // Expose function to trigger websocket broadcasts if registered
  if (global.broadcastLog) {
    global.broadcastLog(logEntry);
  }
}
