import { getDb, updateDb, logAction } from './db.js';
import { setUpstreamProxy, enableGitProxy, disableGitProxy } from './proxy-manager.js';
import { startOpenVpn, stopOpenVpn } from './vpn-manager.js';

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

// Perform health diagnostic across all configured test URLs
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

  return {
    success: overallSuccess,
    targets: results,
    avgLatency
  };
}

// Temporary profile switcher for testing during healing
async function applyProfileConfig(profile) {
  if (profile.type === 'proxy') {
    stopOpenVpn();
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
