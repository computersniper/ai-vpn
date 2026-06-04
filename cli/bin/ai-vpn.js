#!/usr/bin/env node

import http from 'http';

const API_BASE = 'http://127.0.0.1:4140/api';

// Simple ANSI color helpers
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

// Helper for HTTP requests
function request(path, method = 'GET', body = null, isHuman = false) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Source': isHuman ? 'human' : 'ai'
    };

    const options = {
      method,
      headers
    };

    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject({ status: res.statusCode, message: json.error || 'Request failed' });
          } else {
            resolve(json);
          }
        } catch (e) {
          reject({ status: res.statusCode, message: data || 'Non-JSON response' });
        }
      });
    });

    req.on('error', (err) => {
      reject({ status: 500, message: `Could not connect to AI-VPN Daemon on port 4140. Is it running?` });
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function printHelp() {
  console.log(`
${colors.bright}${colors.cyan}AI-VPN CLI - AI-Friendly Network & Proxy Manager${colors.reset}

${colors.bright}Usage:${colors.reset}
  ai-vpn <command> [options]

${colors.bright}Commands:${colors.reset}
  ${colors.green}status${colors.reset}             View current VPN connection, proxy endpoints, health state, and pings
  ${colors.green}list${colors.reset}               List all imported network nodes and profile configurations
  ${colors.green}connect <id|name>${colors.reset}  Switch network route to target profile node
  ${colors.green}disconnect${colors.reset}         Disconnect all tunnels and restore direct system routing
  ${colors.green}heal${colors.reset}               Force diagnostic connectivity test and trigger AI Auto-Healer
  ${colors.green}logs${colors.reset}               Show recent daemon logs stream
  ${colors.green}sysproxy <on|off>${colors.reset}  Enable or disable Windows system-wide internet proxy routing

${colors.bright}Options:${colors.reset}
  ${colors.yellow}--json${colors.reset}             Output results in raw JSON format (ideal for AI parsing)
  ${colors.yellow}--human${colors.reset}            Identify request origin as Human (bypasses Human Override lock)

${colors.bright}Examples:${colors.reset}
  ai-vpn status --json
  ai-vpn connect mock-proxy-1 --human
  ai-vpn heal
`);
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  const cmd = args[0];
  const isJson = args.includes('--json');
  const isHuman = args.includes('--human');

  try {
    switch (cmd) {
      case 'status': {
        const status = await request('/status', 'GET', null, isHuman);
        if (isJson) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(`\n${colors.bright}${colors.cyan}=== AI-VPN Connection Status ===${colors.reset}`);
          console.log(`Active Profile ID : ${colors.bright}${status.activeProfileId}${colors.reset}`);
          console.log(`Human Override Lock: ${status.humanOverride ? colors.red + 'LOCKED (AI Blocked)' : colors.green + 'UNLOCKED (AI Allowed)'}${colors.reset}`);
          
          console.log(`\n${colors.bright}VPN Tunnel status:${colors.reset}`);
          console.log(`  State        : ${status.vpn.state === 'connected' ? colors.green + 'CONNECTED' : colors.yellow + status.vpn.state.toUpperCase()}${colors.reset}`);
          if (status.vpn.profileName) {
            console.log(`  Profile      : ${status.vpn.profileName}`);
          }
          
          console.log(`\n${colors.bright}Diagnostics Check:${colors.reset}`);
          console.log(`  Internet     : ${status.diagnostics.success ? colors.green + 'ONLINE' : colors.red + 'OFFLINE'}${colors.reset}`);
          console.log(`  Avg Latency  : ${status.diagnostics.success ? colors.green + status.diagnostics.avgLatency + 'ms' : 'N/A'}${colors.reset}`);
          
          console.log(`\n${colors.bright}Endpoints Status:${colors.reset}`);
          status.diagnostics.targets.forEach(t => {
            const latStr = t.success ? `${t.latency}ms` : 'TIMEOUT';
            const latCol = t.success ? colors.green : colors.red;
            console.log(`  - ${t.name.padEnd(12)}: ${latCol}${latStr}${colors.reset} (${t.url})`);
          });
          console.log();
        }
        break;
      }

      case 'list': {
        const profiles = await request('/profiles', 'GET', null, isHuman);
        if (isJson) {
          console.log(JSON.stringify(profiles, null, 2));
        } else {
          console.log(`\n${colors.bright}${colors.cyan}=== Configured VPN/Proxy Nodes ===${colors.reset}`);
          profiles.forEach((p, idx) => {
            const typeStr = p.type.toUpperCase().padEnd(8);
            const latencyStr = p.latency ? `${p.latency}ms` : 'untested';
            console.log(`${idx + 1}. [${typeStr}] ${colors.bright}${p.name.padEnd(30)}${colors.reset} ID: ${p.id.padEnd(20)} Latency: ${latencyStr}`);
          });
          console.log();
        }
        break;
      }

      case 'connect': {
        const target = args[1];
        if (!target) {
          console.error(`${colors.red}Error: Please specify a Profile ID or Name to connect to.${colors.reset}`);
          console.log(`Usage: ai-vpn connect <id_or_name>`);
          return;
        }

        // Get list to resolve name or ID
        const profiles = await request('/profiles', 'GET', null, isHuman);
        const resolved = profiles.find(p => p.id === target || p.name.toLowerCase() === target.toLowerCase());

        if (!resolved) {
          console.error(`${colors.red}Error: Could not resolve Profile ID or Name matching: "${target}"${colors.reset}`);
          return;
        }

        if (!isJson) console.log(`Attempting connection to node: "${resolved.name}"...`);
        const res = await request('/connect', 'POST', { id: resolved.id }, isHuman);
        
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`${colors.green}Success: Route switched. Connected to profile ID: "${res.activeProfileId}".${colors.reset}`);
        }
        break;
      }

      case 'disconnect': {
        if (!isJson) console.log('Disconnecting tunnels and clearing proxies...');
        const res = await request('/disconnect', 'POST', null, isHuman);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`${colors.green}Success: Reset to direct route. System cleared.${colors.reset}`);
        }
        break;
      }

      case 'heal': {
        if (!isJson) console.log('Starting diagnostic healing cycle...');
        const res = await request('/heal', 'POST', null, isHuman);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res.healed) {
            console.log(`${colors.green}Healing Completed: A working route was successfully established!${colors.reset}`);
          } else {
            console.log(`${colors.yellow}Healing Completed: No alternative working connection could be resolved or manual lock was set.${colors.reset}`);
          }
        }
        break;
      }

      case 'logs': {
        const logs = await request('/logs', 'GET', null, isHuman);
        const recent = logs.slice(-15);
        if (isJson) {
          console.log(JSON.stringify(recent, null, 2));
        } else {
          console.log(`\n${colors.bright}${colors.cyan}=== Recent System Logs ===${colors.reset}`);
          recent.forEach(l => {
            const timeStr = new Date(l.timestamp).toLocaleTimeString();
            let srcCol = colors.cyan;
            if (l.source === 'ai') srcCol = colors.magenta;
            if (l.source === 'human') srcCol = colors.green;
            if (l.source === 'openvpn') srcCol = colors.yellow;

            let lvlCol = colors.reset;
            if (l.level === 'warn') lvlCol = colors.yellow;
            if (l.level === 'error') lvlCol = colors.red + colors.bright;

            console.log(`[${timeStr}] [${srcCol}${l.source.toUpperCase()}${colors.reset}] [${lvlCol}${l.level.toUpperCase()}${colors.reset}] ${l.message}`);
          });
          console.log();
        }
        break;
      }

      case 'sysproxy': {
        const sub = args[1];
        if (sub === 'on' || sub === 'enable') {
          const res = await request('/system-proxy/enable', 'POST', null, isHuman);
          console.log(res.success ? `${colors.green}System proxy registry settings enabled.${colors.reset}` : `${colors.red}Registry edit failed.${colors.reset}`);
        } else if (sub === 'off' || sub === 'disable') {
          const res = await request('/system-proxy/disable', 'POST', null, isHuman);
          console.log(res.success ? `${colors.green}System proxy registry settings disabled.${colors.reset}` : `${colors.red}Registry edit failed.${colors.reset}`);
        } else {
          console.log(`Usage: ai-vpn sysproxy <on|off>`);
        }
        break;
      }

      default: {
        console.error(`${colors.red}Unknown command: ${cmd}${colors.reset}`);
        printHelp();
      }
    }
  } catch (err) {
    if (isJson) {
      console.log(JSON.stringify({ error: err.message || err }, null, 2));
    } else {
      console.error(`${colors.red}${colors.bright}Error (${err.status || 500}): ${err.message || err}${colors.reset}\n`);
    }
  }
}

run();
