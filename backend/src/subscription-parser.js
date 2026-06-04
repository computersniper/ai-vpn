import { logAction } from './db.js';

const INFO_KEYWORDS = ['流量', '到期', '重置', '官网', '提示', '注意', '下载', '订阅', '在线', '说明', '公告', '客服', '购买'];

export function parseNodeUrl(urlStr) {
  try {
    // Standardize URL schema for node's native URL parser
    const schemeMatch = urlStr.match(/^([a-zA-Z0-9]+):\/\//);
    if (!schemeMatch) return null;
    
    const protocol = schemeMatch[1].toLowerCase();
    const httpEquiv = urlStr.replace(/^[a-zA-Z0-9]+:\/\//, 'http://');
    const parsed = new URL(httpEquiv);
    
    const uuid = parsed.username || parsed.pathname.split('@')[0].replace('//', '');
    const host = parsed.hostname;
    const port = parseInt(parsed.port);
    
    let nodeName = parsed.hash ? decodeURIComponent(parsed.hash.replace('#', '')) : `${protocol}-${host}`;
    nodeName = nodeName.trim();

    const insecure = parsed.searchParams.get('insecure') === '1' || parsed.searchParams.get('insecure') === 'true';
    
    // Filter out info nodes (informational messages from the provider)
    const isInfo = INFO_KEYWORDS.some(kw => nodeName.includes(kw));

    return {
      protocol,
      uuid,
      host,
      port,
      nodeName,
      insecure,
      isInfo
    };
  } catch (err) {
    console.error('Error parsing URL:', urlStr, err.message);
    return null;
  }
}

export async function fetchSubscription(url) {
  logAction('system', 'info', `Fetching subscription from: ${url}`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Subscription server returned ${res.status}`);
    const text = await res.text();
    
    // Base64 decode
    const decoded = Buffer.from(text.trim(), 'base64').toString('utf8');
    const lines = decoded.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    
    logAction('system', 'info', `Decoded ${lines.length} lines from subscription.`);
    
    const parsedNodes = [];
    for (const line of lines) {
      const node = parseNodeUrl(line);
      if (node && !node.isInfo) {
        parsedNodes.push(node);
      }
    }
    
    logAction('system', 'info', `Extracted ${parsedNodes.length} working proxy nodes.`);
    return parsedNodes;
  } catch (err) {
    logAction('system', 'error', `Failed to parse subscription: ${err.message}`);
    throw err;
  }
}
