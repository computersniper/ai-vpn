import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { fileURLToPath } from 'url';
import { logAction, getDb } from './db.js';
import { ensureSingbox } from './downloader.js';
import { setUpstreamProxy } from './proxy-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OVPN_TEMP = path.join(__dirname, '../active.ovpn.temp');
const SINGBOX_TEMP = path.join(__dirname, '../singbox.json.temp');

let activeChildProcess = null;
let connectionState = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'error'
let activeProfileName = '';
let activeProcessType = null; // 'openvpn' or 'singbox'

export function getVpnState() {
  return {
    state: connectionState,
    profileName: activeProfileName,
    processType: activeProcessType
  };
}

// Bypasses system fake-IP/hijacked DNS servers (e.g. Clash Verge) by querying public resolvers via DNS-over-HTTPS
async function resolveDirect(hostname) {
  if (/^[0-9.]+$/.test(hostname)) {
    return hostname;
  }

  logAction('system', 'info', `Resolving real IP for "${hostname}" using DNS-over-HTTPS (DoH)...`);

  // Try AliDNS DoH
  try {
    const res = await fetch(`https://dns.alidns.com/resolve?name=${hostname}&type=A`, {
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      const json = await res.json();
      if (json.Answer && json.Answer.length > 0) {
        const ip = json.Answer[0].data;
        if (/^[0-9.]+$/.test(ip)) {
          logAction('system', 'info', `DoH (AliDNS) resolved "${hostname}" to "${ip}"`);
          return ip;
        }
      }
    }
  } catch (err) {
    console.warn('AliDNS DoH resolution failed, trying Cloudflare...', err.message);
  }

  // Try Cloudflare DoH
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`, {
      headers: { 'Accept': 'application/dns-json' }
    });
    if (res.ok) {
      const json = await res.json();
      if (json.Answer && json.Answer.length > 0) {
        const ip = json.Answer[0].data;
        if (/^[0-9.]+$/.test(ip)) {
          logAction('system', 'info', `DoH (Cloudflare) resolved "${hostname}" to "${ip}"`);
          return ip;
        }
      }
    }
  } catch (err) {
    console.warn('Cloudflare DoH resolution failed', err.message);
  }

  // Fallback to standard DNS resolver
  logAction('system', 'warn', `DoH resolution failed. Falling back to default system resolver.`);
  return new Promise((resolve) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses.length) {
        resolve(hostname);
      } else {
        resolve(addresses[0]);
      }
    });
  });
}

function generateSingboxConfig(nodeConfig, resolvedIp) {
  return {
    log: {
      level: "info",
      timestamp: true
    },
    inbounds: [
      {
        type: "socks",
        tag: "socks-in",
        listen: "127.0.0.1",
        listen_port: 4142
      }
    ],
    outbounds: [
      {
        type: nodeConfig.protocol, // 'anytls'
        tag: "proxy-out",
        server: resolvedIp, // Use real IP to prevent hijack loops
        server_port: nodeConfig.port,
        password: nodeConfig.uuid,
        tls: {
          enabled: true,
          server_name: nodeConfig.host, // Keep domain for SNI certificate matching
          insecure: nodeConfig.insecure || false
        }
      },
      {
        type: "direct",
        tag: "direct-out"
      }
    ]
  };
}

export function startOpenVpn(profile, onStateChange) {
  return new Promise((resolve, reject) => {
    const db = getDb();
    const openvpnPath = db.settings.openvpnPath;

    stopTunnel();

    logAction('openvpn', 'info', `Starting OpenVPN with profile: ${profile.name}`);
    activeProfileName = profile.name;
    connectionState = 'connecting';
    activeProcessType = 'openvpn';
    if (onStateChange) onStateChange(connectionState);

    try {
      fs.writeFileSync(OVPN_TEMP, profile.content, 'utf8');
    } catch (err) {
      connectionState = 'error';
      if (onStateChange) onStateChange(connectionState);
      const errMsg = `Failed to write temp OVPN config: ${err.message}`;
      logAction('openvpn', 'error', errMsg);
      return reject(new Error(errMsg));
    }

    if (!fs.existsSync(openvpnPath)) {
      connectionState = 'error';
      if (onStateChange) onStateChange(connectionState);
      const errMsg = `OpenVPN executable not found at: ${openvpnPath}. Please install OpenVPN or configure the correct path in Settings.`;
      logAction('openvpn', 'error', errMsg);
      return reject(new Error(errMsg));
    }

    try {
      activeChildProcess = spawn(openvpnPath, ['--config', OVPN_TEMP]);
      let connectionResolved = false;

      activeChildProcess.stdout.on('data', (data) => {
        const output = data.toString('utf8');
        if (output.includes('Initialization Sequence Completed')) {
          connectionState = 'connected';
          logAction('openvpn', 'info', 'OpenVPN Connection Established successfully!');
          if (onStateChange) onStateChange(connectionState);
          if (!connectionResolved) {
            connectionResolved = true;
            resolve();
          }
        }
        
        const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (line.includes('ERROR') || line.includes('Failed') || line.includes('fatal')) {
            logAction('openvpn', 'error', `[OpenVPN] ${line}`);
          } else if (line.includes('warning') || line.includes('WARNING')) {
            logAction('openvpn', 'warn', `[OpenVPN] ${line}`);
          } else if (line.includes('Peer') || line.includes('TUN/TAP') || line.includes('AUTH')) {
            logAction('openvpn', 'info', `[OpenVPN] ${line}`);
          }
        }
      });

      activeChildProcess.stderr.on('data', (data) => {
        const output = data.toString('utf8').trim();
        logAction('openvpn', 'error', `[OpenVPN Stderr] ${output}`);
      });

      activeChildProcess.on('close', (code) => {
        logAction('openvpn', 'info', `OpenVPN process exited with code ${code}`);
        connectionState = 'disconnected';
        activeProfileName = '';
        activeProcessType = null;
        activeChildProcess = null;
        if (onStateChange) onStateChange(connectionState);
        cleanupTempFiles();
        
        if (!connectionResolved) {
          connectionResolved = true;
          reject(new Error(`OpenVPN exited early with code ${code}`));
        }
      });

      activeChildProcess.on('error', (err) => {
        connectionState = 'error';
        logAction('openvpn', 'error', `Failed to start OpenVPN: ${err.message}`);
        if (onStateChange) onStateChange(connectionState);
        cleanupTempFiles();
        if (!connectionResolved) {
          connectionResolved = true;
          reject(err);
        }
      });

    } catch (err) {
      connectionState = 'error';
      logAction('openvpn', 'error', `Process spawning error: ${err.message}`);
      if (onStateChange) onStateChange(connectionState);
      cleanupTempFiles();
      reject(err);
    }
  });
}

export function startSingbox(profile, onStateChange) {
  return new Promise(async (resolve, reject) => {
    stopTunnel();

    logAction('system', 'info', `Starting sing-box with profile: ${profile.name}`);
    activeProfileName = profile.name;
    connectionState = 'connecting';
    activeProcessType = 'singbox';
    if (onStateChange) onStateChange(connectionState);

    let singboxExePath = null;
    try {
      singboxExePath = await ensureSingbox();
    } catch (err) {
      connectionState = 'error';
      if (onStateChange) onStateChange(connectionState);
      logAction('system', 'error', `sing-box executable check failed: ${err.message}`);
      return reject(err);
    }

    let nodeConfig = null;
    let resolvedIp = null;
    try {
      nodeConfig = JSON.parse(profile.content);
      // Resolve host directly to bypass Clash / fake-IP hijacks
      resolvedIp = await resolveDirect(nodeConfig.host);
      
      const sbConfig = generateSingboxConfig(nodeConfig, resolvedIp);
      fs.writeFileSync(SINGBOX_TEMP, JSON.stringify(sbConfig, null, 2), 'utf8');
    } catch (err) {
      connectionState = 'error';
      if (onStateChange) onStateChange(connectionState);
      logAction('system', 'error', `Failed to generate sing-box configuration: ${err.message}`);
      return reject(err);
    }

    try {
      activeChildProcess = spawn(singboxExePath, ['run', '-c', SINGBOX_TEMP]);
      let connectionResolved = false;

      const handleLogs = (data) => {
        const output = data.toString('utf8');
        const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
        
        for (const line of lines) {
          console.log(`[sing-box] ${line}`);
          
          if (line.includes('started') || line.includes('inbound/socks')) {
            if (connectionState !== 'connected') {
              connectionState = 'connected';
              logAction('system', 'info', 'sing-box Tunnel Client is online and listening on 127.0.0.1:4142!');
              setUpstreamProxy({ host: '127.0.0.1', port: 4142, protocol: 'socks5' });
              
              if (onStateChange) onStateChange(connectionState);
              if (!connectionResolved) {
                connectionResolved = true;
                resolve();
              }
            }
          }
          
          if (line.includes('ERROR') || line.includes('FATAL') || line.includes('failed')) {
            logAction('system', 'error', `[sing-box] ${line}`);
          }
        }
      };

      activeChildProcess.stderr.on('data', handleLogs);
      activeChildProcess.stdout.on('data', handleLogs);

      activeChildProcess.on('close', (code) => {
        logAction('system', 'info', `sing-box process exited with code ${code}`);
        connectionState = 'disconnected';
        activeProfileName = '';
        activeProcessType = null;
        activeChildProcess = null;
        setUpstreamProxy({ direct: true });
        if (onStateChange) onStateChange(connectionState);
        cleanupTempFiles();
        
        if (!connectionResolved) {
          connectionResolved = true;
          reject(new Error(`sing-box exited early with code ${code}`));
        }
      });

      activeChildProcess.on('error', (err) => {
        connectionState = 'error';
        logAction('system', 'error', `Failed to start sing-box process: ${err.message}`);
        setUpstreamProxy({ direct: true });
        if (onStateChange) onStateChange(connectionState);
        cleanupTempFiles();
        if (!connectionResolved) {
          connectionResolved = true;
          reject(err);
        }
      });

    } catch (err) {
      connectionState = 'error';
      logAction('system', 'error', `sing-box execution failed: ${err.message}`);
      if (onStateChange) onStateChange(connectionState);
      cleanupTempFiles();
      reject(err);
    }
  });
}

export function stopTunnel() {
  if (activeChildProcess) {
    logAction('system', 'info', `Stopping active ${activeProcessType} child process...`);
    activeChildProcess.kill('SIGTERM');
    const proc = activeChildProcess;
    setTimeout(() => {
      try {
        if (proc) proc.kill('SIGKILL');
      } catch (e) {}
    }, 2000);
    activeChildProcess = null;
  }
  connectionState = 'disconnected';
  activeProfileName = '';
  activeProcessType = null;
  setUpstreamProxy({ direct: true });
  cleanupTempFiles();
}

function cleanupTempFiles() {
  try {
    if (fs.existsSync(OVPN_TEMP)) fs.unlinkSync(OVPN_TEMP);
    if (fs.existsSync(SINGBOX_TEMP)) fs.unlinkSync(SINGBOX_TEMP);
  } catch (e) {
    // Ignore errors
  }
}

// Clean up processes on exit
process.on('exit', () => {
  stopTunnel();
});
