import http from 'http';
import net from 'net';
import { exec } from 'child_process';
import { logAction, getDb } from './db.js';

let proxyServer = null;
let currentUpstream = null; // { host, port, protocol } or null (direct)

// Helper to run command and return promise
function runCmd(command) {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      resolve({ success: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Perform SOCKS5 handshake on a socket to targetHost:targetPort
function connectSocks5(socksSocket, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    // 1. Send SOCKS5 greeting: Version 5, 1 Auth Method, No Authentication (0x00)
    socksSocket.write(Buffer.from([0x05, 0x01, 0x00]));

    let stage = 1;

    socksSocket.on('data', (data) => {
      try {
        if (stage === 1) {
          // Greeting response should be 2 bytes: [0x05, auth_method]
          if (data[0] !== 0x05 || data[1] !== 0x00) {
            throw new Error(`SOCKS5 Auth method not supported or invalid response: ${data.toString('hex')}`);
          }
          
          // 2. Send CONNECT request
          // Format: [version, cmd(CONNECT=1), reserved, addr_type(DOMAIN=3), domain_len, ...domain, port_high, port_low]
          const hostBuf = Buffer.from(targetHost, 'utf8');
          const request = Buffer.alloc(7 + hostBuf.length);
          request[0] = 0x05; // version
          request[1] = 0x01; // cmd CONNECT
          request[2] = 0x00; // reserved
          request[3] = 0x03; // addr_type domain name
          request[4] = hostBuf.length; // domain len
          hostBuf.copy(request, 5);
          request.writeUInt16BE(targetPort, 5 + hostBuf.length);

          socksSocket.write(request);
          stage = 2;
        } else if (stage === 2) {
          // Connection response: [version, status, reserved, addr_type, ...]
          if (data[0] !== 0x05 || data[1] !== 0x00) {
            throw new Error(`SOCKS5 CONNECT failed with status code ${data[1]}`);
          }
          
          // Connected successfully! Remove listeners and resolve
          socksSocket.removeAllListeners('data');
          socksSocket.removeAllListeners('error');
          resolve();
        }
      } catch (err) {
        socksSocket.destroy();
        reject(err);
      }
    });

    socksSocket.on('error', (err) => {
      reject(err);
    });
  });
}

export function startProxyServer(port = 4141) {
  if (proxyServer) {
    logAction('system', 'warn', `Proxy server already running on port ${port}`);
    return;
  }

  proxyServer = http.createServer((req, res) => {
    // Normal HTTP requests (non-CONNECT)
    // We forward standard HTTP GET/POST if they are fully-qualified, otherwise respond
    if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
      const url = new URL(req.url);
      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers
      };

      const connector = http.request(options, (serverRes) => {
        res.writeHead(serverRes.statusCode, serverRes.headers);
        serverRes.pipe(res);
      });

      req.pipe(connector);
      connector.on('error', (err) => {
        res.writeHead(502);
        res.end(`Proxy error: ${err.message}`);
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('AI-VPN Local Proxy Tunnel Service Active');
    }
  });

  // Handle HTTPS CONNECT tunnel requests
  proxyServer.on('connect', (req, clientSocket, head) => {
    const parts = req.url.split(':');
    const targetHost = parts[0];
    const targetPort = parseInt(parts[1] || 443);

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    let upstreamSocket = null;

    if (!currentUpstream || currentUpstream.direct) {
      // Direct connection
      upstreamSocket = net.connect(targetPort, targetHost, () => {
        if (head && head.length > 0) {
          upstreamSocket.write(head);
        }
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      });
    } else if (currentUpstream.protocol === 'socks5') {
      // Upstream SOCKS5 Proxy routing
      const socksSocket = net.connect(currentUpstream.port, currentUpstream.host, async () => {
        try {
          await connectSocks5(socksSocket, targetHost, targetPort);
          if (head && head.length > 0) {
            socksSocket.write(head);
          }
          clientSocket.pipe(socksSocket);
          socksSocket.pipe(clientSocket);
        } catch (err) {
          logAction('system', 'error', `SOCKS5 upstream handshake failed: ${err.message}`);
          clientSocket.destroy();
        }
      });
      upstreamSocket = socksSocket;
    } else if (currentUpstream.protocol === 'http') {
      // Upstream HTTP Proxy routing
      const httpSocket = net.connect(currentUpstream.port, currentUpstream.host, () => {
        const connectHeaders = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`;
        httpSocket.write(connectHeaders);

        let headersReceived = false;
        let buffer = '';

        httpSocket.on('data', (data) => {
          if (!headersReceived) {
            buffer += data.toString('utf8');
            if (buffer.includes('\r\n\r\n')) {
              headersReceived = true;
              const parts = buffer.split('\r\n\r\n');
              const headerPart = parts[0];
              const bodyPart = parts[1] || '';

              if (headerPart.includes('200')) {
                if (bodyPart.length > 0) {
                  clientSocket.write(Buffer.from(bodyPart, 'utf8'));
                }
                clientSocket.pipe(httpSocket);
                httpSocket.pipe(clientSocket);
              } else {
                logAction('system', 'error', `HTTP upstream proxy rejected tunnel CONNECT: ${headerPart.split('\r\n')[0]}`);
                clientSocket.destroy();
                httpSocket.destroy();
              }
            }
          }
        });
      });
      upstreamSocket = httpSocket;
    }

    if (upstreamSocket) {
      upstreamSocket.on('error', (err) => {
        clientSocket.destroy();
      });
      clientSocket.on('error', (err) => {
        upstreamSocket.destroy();
      });
    }
  });

  proxyServer.listen(port, '127.0.0.1', () => {
    logAction('system', 'info', `Local proxy server listening on http://127.0.0.1:${port}`);
  });

  proxyServer.on('error', (err) => {
    logAction('system', 'error', `Local proxy server error: ${err.message}`);
  });
}

export function setUpstreamProxy(config) {
  currentUpstream = config; // { host, port, protocol, direct }
  if (config && !config.direct) {
    logAction('system', 'info', `Proxy routing updated: Routing via ${config.protocol}://${config.host}:${config.port}`);
  } else {
    logAction('system', 'info', `Proxy routing updated: Direct connection`);
  }
}

export async function enableGitProxy(port = 4141) {
  logAction('system', 'info', 'Configuring Git global proxy...');
  const setHttp = await runCmd(`git config --global http.proxy http://127.0.0.1:${port}`);
  const setHttps = await runCmd(`git config --global https.proxy http://127.0.0.1:${port}`);
  
  if (setHttp.success && setHttps.success) {
    logAction('system', 'info', `Git global proxy configured to http://127.0.0.1:${port}`);
    return true;
  } else {
    logAction('system', 'error', `Git global proxy configuration failed. http: ${setHttp.stderr}, https: ${setHttps.stderr}`);
    return false;
  }
}

export async function disableGitProxy() {
  logAction('system', 'info', 'Clearing Git global proxy...');
  const unsetHttp = await runCmd('git config --global --unset http.proxy');
  const unsetHttps = await runCmd('git config --global --unset https.proxy');
  
  logAction('system', 'info', 'Git global proxy cleared.');
  return true;
}

export async function enableWindowsSystemProxy(port = 4141) {
  logAction('system', 'info', 'Configuring Windows System Proxy Settings...');
  const enableResult = await runCmd(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`);
  const serverResult = await runCmd(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`);
  const overrideResult = await runCmd(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "<local>" /f`);

  if (enableResult.success && serverResult.success) {
    logAction('system', 'info', `Windows System Proxy enabled and set to 127.0.0.1:${port}`);
    return true;
  } else {
    logAction('system', 'error', 'Failed to configure Windows System Proxy settings in registry.');
    return false;
  }
}

export async function disableWindowsSystemProxy() {
  logAction('system', 'info', 'Disabling Windows System Proxy Settings...');
  const disableResult = await runCmd(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`);
  
  if (disableResult.success) {
    logAction('system', 'info', 'Windows System Proxy disabled.');
    return true;
  } else {
    logAction('system', 'error', 'Failed to disable Windows System Proxy in registry.');
    return false;
  }
}

export function stopProxyServer() {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    logAction('system', 'info', 'Local proxy server stopped.');
  }
}
