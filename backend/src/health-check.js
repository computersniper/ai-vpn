import http from 'http';
import net from 'net';
import { getDb, updateDb, logAction } from './db.js';
import { setUpstreamProxy, enableGitProxy, disableGitProxy } from './proxy-manager.js';
import { startOpenVpn, startSingbox, stopTunnel } from './vpn-manager.js';

let checkIntervalId = null;
let isHealing = false;
let consecutiveFailures = 0;

// Test latency to a single URL
async function testUrlLatency(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (AI-VPN Agent)' }
    });
    clearTimeout(timeoutId);
    return {
      success: res.ok || res.status < 500, // redirect or not server error
      latency: Date.now() - start
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return { success: false, latency: 9999, error: err.message };
  }
}

// Fetch URL through the local proxy server (port 4141) to isolate tests from host VPN
function fetchThroughProxy(urlStr, proxyPort = 4141) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const options = {
        host: '127.0.0.1',
        port: proxyPort,
        path: url.href, // Send full URL to HTTP proxy
        method: 'GET',
        headers: {
          'Host': url.host,
          'User-Agent': 'Mozilla/5.0 (AI-VPN Agent)'
        },
        timeout: 4000
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Proxy fetch timeout'));
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Fetch IP info directly through SOCKS5 proxy tunnel
function fetchIpThroughSocks5(socksPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socksPort, '127.0.0.1', () => {
      // 1. Send SOCKS5 greeting
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    let stage = 1;
    let responseData = '';

    socket.on('data', (data) => {
      try {
        if (stage === 1) {
          if (data[0] !== 0x05 || data[1] !== 0x00) {
            throw new Error('SOCKS5 auth failed');
          }
          // 2. Send CONNECT request to ifconfig.co:80
          const hostBuf = Buffer.from('ifconfig.co', 'utf8');
          const request = Buffer.alloc(7 + hostBuf.length);
          request[0] = 0x05;
          request[1] = 0x01; // CONNECT
          request[2] = 0x00;
          request[3] = 0x03; // Domain
          request[4] = hostBuf.length;
          hostBuf.copy(request, 5);
          request.writeUInt16BE(80, 5 + hostBuf.length);
          
          socket.write(request);
          stage = 2;
        } else if (stage === 2) {
          if (data[0] !== 0x05 || data[1] !== 0x00) {
            throw new Error('SOCKS5 CONNECT failed');
          }
          // 3. Connection established! Send HTTP GET request
          const httpRequest = [
            'GET /json HTTP/1.1',
            'Host: ifconfig.co',
            'User-Agent: Mozilla/5.0 (AI-VPN Agent)',
            'Connection: close',
            '',
            ''
          ].join('\r\n');
          
          socket.write(httpRequest);
          stage = 3;
        } else if (stage === 3) {
          responseData += data.toString('utf8');
        }
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });

    socket.on('end', () => {
      try {
        const parts = responseData.split('\r\n\r\n');
        const body = parts[1] || '';
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error(`Failed to parse body: ${err.message}`));
      }
    });

    socket.on('error', reject);
  });
}

// Perform health diagnostic across all configured test URLs and lookup IP info
export async function runDiagnostics() {
  const db = getDb();
  const targets = db.settings.testUrls || [];
  const results = [];
  
  for (const target of targets) {
    const res = await testUrlLatency(target.url);
    results.push({
      name: target.name,
      url: target.url,
      success: res.success,
      latency: res.latency
    });
  }
  
  const okCount = results.filter(r => r.success).length;
  const overallSuccess = okCount > 0; // If at least one site is reachable, we have internet
  const avgLatency = okCount > 0 
    ? Math.round(results.filter(r => r.success).reduce((acc, r) => acc + r.latency, 0) / okCount) 
    : 9999;

  // Retrieve IP location via the local proxy (runs independently of host system VPN)
  let ipInfo = { ip: 'Offline', country: 'Unknown', region: 'Unknown' };
  if (overallSuccess) {
    try {
      if (db.activeProfileId === 'direct-default') {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch('http://ifconfig.co/json', { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          const json = await res.json();
          ipInfo = {
            ip: json.ip || 'Offline',
            country: json.country || 'Unknown',
            region: json.time_zone || json.region_name || 'Unknown'
          };
        }
      } else {
        const activeProfile = db.profiles.find(p => p.id === db.activeProfileId);
        if (activeProfile) {
          let socksPort = null;
          if (activeProfile.type === 'singbox') {
            socksPort = 4142; // sing-box SOCKS5 port
          } else if (activeProfile.type === 'proxy') {
            const config = JSON.parse(activeProfile.content);
            if (config.protocol === 'socks5') {
              socksPort = config.port;
            }
          }
          
          if (socksPort) {
            const json = await fetchIpThroughSocks5(socksPort);
            ipInfo = {
              ip: json.ip || 'Offline',
              country: json.country || 'Unknown',
              region: json.time_zone || json.region_name || 'Unknown'
            };
          } else {
            const proxiedRes = await fetchThroughProxy('http://ifconfig.co/json');
            if (proxiedRes.statusCode === 200) {
              const json = JSON.parse(proxiedRes.body);
              ipInfo = {
                ip: json.ip || 'Offline',
                country: json.country || 'Unknown',
                region: json.time_zone || json.region_name || 'Unknown'
              };
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to lookup IP info through proxy:', err.message);
    }
  }

  return {
    success: overallSuccess,
    targets: results,
    avgLatency,
    ipInfo
  };
}

// Temporary profile switcher for testing during healing
async function applyProfileConfig(profile) {
  if (profile.type === 'proxy') {
    stopTunnel();
    const config = JSON.parse(profile.content);
    setUpstreamProxy(config);
    if (config.direct) {
      await disableGitProxy();
    } else {
      await enableGitProxy();
    }
  } else if (profile.type === 'openvpn') {
    setUpstreamProxy({ direct: true });
    await disableGitProxy();
    await startOpenVpn(profile);
  } else if (profile.type === 'singbox') {
    setUpstreamProxy({ direct: true });
    await disableGitProxy();
    await startSingbox(profile);
    await enableGitProxy();
  }
}

// Trigger healing loop to find a working node
export async function triggerHealing() {
  if (isHealing) return;
  isHealing = true;
  
  logAction('ai', 'warn', 'AI Auto-Healer triggered: Testing profiles to restore connectivity...');
  
  const db = getDb();
  if (db.humanOverride) {
    logAction('ai', 'warn', 'Healing aborted: Human Override is active. The human user has locked connection configurations.');
    isHealing = false;
    return false;
  }
  
  const originalProfileId = db.activeProfileId;
  const candidates = db.profiles.filter(p => p.id !== originalProfileId);
  
  logAction('ai', 'info', `Found ${candidates.length} alternative nodes to test.`);
  
  for (const candidate of candidates) {
    logAction('ai', 'info', `Testing profile node: "${candidate.name}"...`);
    
    try {
      // 1. Temporarily apply candidate profile
      await applyProfileConfig(candidate);
      
      // Wait 3 seconds for OpenVPN/proxy to settle
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // 2. Run diagnostics
      const diag = await runDiagnostics();
      if (diag.success) {
        // Found a working node!
        logAction('ai', 'info', `Success! Node "${candidate.name}" restored connectivity. Latency: ${diag.avgLatency}ms.`);
        
        updateDb(data => {
          data.activeProfileId = candidate.id;
          const idx = data.profiles.findIndex(p => p.id === candidate.id);
          if (idx !== -1) {
            data.profiles[idx].latency = diag.avgLatency;
            data.profiles[idx].lastConnected = new Date().toISOString();
          }
        });
        
        logAction('ai', 'info', `Auto-Healer successfully updated active connection to: "${candidate.name}".`);
        isHealing = false;
        consecutiveFailures = 0;
        
        // Notify any websocket listeners of state change
        if (global.broadcastStatus) {
          global.broadcastStatus();
        }
        return true;
      } else {
        logAction('ai', 'warn', `Node "${candidate.name}" is unreachable. Moving to next candidate.`);
      }
    } catch (err) {
      logAction('ai', 'error', `Error testing node "${candidate.name}": ${err.message}`);
    }
  }
  
  // If we reach here, no alternative nodes worked. Revert to original profile.
  logAction('ai', 'error', 'Auto-Healer failed: All alternative profiles tested are unreachable. Reverting to original node.');
  const originalProfile = db.profiles.find(p => p.id === originalProfileId);
  if (originalProfile) {
    await applyProfileConfig(originalProfile);
  }
  
  isHealing = false;
  return false;
}

// Start polling connectivity loop
export function startHealthCheckLoop() {
  if (checkIntervalId) clearInterval(checkIntervalId);
  
  const db = getDb();
  const intervalSeconds = db.settings.healthCheckInterval || 30;
  
  logAction('system', 'info', `Health check loop started (Interval: ${intervalSeconds}s)`);
  
  checkIntervalId = setInterval(async () => {
    if (isHealing) return; // Skip if we are currently mid-heal
    
    const diag = await runDiagnostics();
    
    // Update active profile latency in db
    updateDb(data => {
      const activeId = data.activeProfileId;
      const idx = data.profiles.findIndex(p => p.id === activeId);
      if (idx !== -1) {
        data.profiles[idx].latency = diag.success ? diag.avgLatency : null;
      }
    });
    
    // Notify clients of periodic stats
    if (global.broadcastStatus) {
      global.broadcastStatus();
    }
    
    if (!diag.success) {
      consecutiveFailures++;
      console.warn(`[Health Check] Target endpoints unreachable. Failure count: ${consecutiveFailures}/3`);
      
      if (consecutiveFailures >= 3) {
        logAction('system', 'warn', 'Network has failed three consecutive health checks.');
        triggerHealing();
      }
    } else {
      consecutiveFailures = 0;
    }
  }, intervalSeconds * 1000);
}

export function stopHealthCheckLoop() {
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
    logAction('system', 'info', 'Health check loop stopped.');
  }
}
