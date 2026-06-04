import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logAction, getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OVPN_TEMP = path.join(__dirname, '../active.ovpn.temp');

let openvpnProcess = null;
let connectionState = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'error'
let activeProfileName = '';

export function getVpnState() {
  return {
    state: connectionState,
    profileName: activeProfileName
  };
}

export function startOpenVpn(profile, onStateChange) {
  return new Promise((resolve, reject) => {
    const db = getDb();
    const openvpnPath = db.settings.openvpnPath;

    if (openvpnProcess) {
      logAction('openvpn', 'warn', 'An OpenVPN process is already running. Stopping it first.');
      stopOpenVpn();
    }

    logAction('openvpn', 'info', `Starting OpenVPN with profile: ${profile.name}`);
    activeProfileName = profile.name;
    connectionState = 'connecting';
    if (onStateChange) onStateChange(connectionState);

    try {
      // Write profile content to temp file
      fs.writeFileSync(OVPN_TEMP, profile.content, 'utf8');
    } catch (err) {
      connectionState = 'error';
      if (onStateChange) onStateChange(connectionState);
      const errMsg = `Failed to write temp OVPN config: ${err.message}`;
      logAction('openvpn', 'error', errMsg);
      return reject(new Error(errMsg));
    }

    // Check if openvpn.exe exists
    if (!fs.existsSync(openvpnPath)) {
      connectionState = 'error';
      if (onStateChange) onStateChange(connectionState);
      const errMsg = `OpenVPN executable not found at: ${openvpnPath}. Please install OpenVPN or configure the correct path in Settings.`;
      logAction('openvpn', 'error', errMsg);
      return reject(new Error(errMsg));
    }

    try {
      // Spawn OpenVPN process
      // --log /dev/stdout or standard output piping
      // Windows needs runas or elevated privileges if routing tables are changed, but we spawn directly first.
      openvpnProcess = spawn(openvpnPath, ['--config', OVPN_TEMP]);

      let connectionResolved = false;

      openvpnProcess.stdout.on('data', (data) => {
        const output = data.toString('utf8');
        // Standard OpenVPN connection completed log
        if (output.includes('Initialization Sequence Completed')) {
          connectionState = 'connected';
          logAction('openvpn', 'info', 'OpenVPN Connection Established successfully!');
          if (onStateChange) onStateChange(connectionState);
          if (!connectionResolved) {
            connectionResolved = true;
            resolve();
          }
        }
        
        // Log individual lines to our system actions database
        const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (line.includes('ERROR') || line.includes('Failed') || line.includes('fatal') || line.includes('Fatal')) {
            logAction('openvpn', 'error', `[OpenVPN Output] ${line}`);
          } else if (line.includes('warning') || line.includes('WARNING')) {
            logAction('openvpn', 'warn', `[OpenVPN Output] ${line}`);
          } else {
            // Log general OpenVPN progress to console, skip logging every line to DB to avoid noise unless it looks important
            if (line.includes('Peer') || line.includes('TUN/TAP') || line.includes('AUTH') || line.includes('Sequence')) {
              logAction('openvpn', 'info', `[OpenVPN Output] ${line}`);
            } else {
              console.log(`[OpenVPN] ${line}`);
            }
          }
        }
      });

      openvpnProcess.stderr.on('data', (data) => {
        const output = data.toString('utf8').trim();
        logAction('openvpn', 'error', `[OpenVPN Stderr] ${output}`);
      });

      openvpnProcess.on('close', (code) => {
        logAction('openvpn', 'info', `OpenVPN process exited with code ${code}`);
        connectionState = 'disconnected';
        activeProfileName = '';
        openvpnProcess = null;
        if (onStateChange) onStateChange(connectionState);
        cleanupTempFiles();
        
        if (!connectionResolved) {
          connectionResolved = true;
          reject(new Error(`OpenVPN exited early with code ${code}`));
        }
      });

      openvpnProcess.on('error', (err) => {
        connectionState = 'error';
        logAction('openvpn', 'error', `Failed to start OpenVPN process: ${err.message}`);
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

export function stopOpenVpn() {
  if (openvpnProcess) {
    logAction('openvpn', 'info', 'Stopping OpenVPN process...');
    openvpnProcess.kill('SIGTERM');
    // Force kill if it doesn't shut down in 3 seconds
    const proc = openvpnProcess;
    setTimeout(() => {
      try {
        if (proc) proc.kill('SIGKILL');
      } catch (e) {}
    }, 3000);
    openvpnProcess = null;
  }
  connectionState = 'disconnected';
  activeProfileName = '';
  cleanupTempFiles();
}

function cleanupTempFiles() {
  try {
    if (fs.existsSync(OVPN_TEMP)) {
      fs.unlinkSync(OVPN_TEMP);
    }
  } catch (e) {
    // Ignore cleanup error
  }
}

// Clean up processes on exit
process.on('exit', () => {
  stopOpenVpn();
});
