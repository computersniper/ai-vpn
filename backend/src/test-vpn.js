import assert from 'assert';
import { parseNodeUrl } from './subscription-parser.js';
import { getDb, logAction } from './db.js';

async function testSubscriptionParser() {
  console.log('🧪 Running Test: Subscription Node Parser...');
  
  // Test case 1: Standard AnyTLS node url
  const testUrl = 'anytls://11111111-2222-3333-4444-555555555555@node1.dummyproxy.net:33400?insecure=1#%E7%BE%8E%E5%9B%BD%E7%9B%B4%E8%BF%9E-0.5%E5%80%8D%E7%8E%87';
  const node = parseNodeUrl(testUrl);
  
  assert.ok(node, 'Node parsing returned null');
  assert.strictEqual(node.protocol, 'anytls', 'Protocol should be anytls');
  assert.strictEqual(node.uuid, '11111111-2222-3333-4444-555555555555', 'UUID is incorrect');
  assert.strictEqual(node.host, 'node1.dummyproxy.net', 'Hostname is incorrect');
  assert.strictEqual(node.port, 33400, 'Port is incorrect');
  assert.strictEqual(node.nodeName, '美国直连-0.5倍率', 'Node name decoding failed');
  assert.strictEqual(node.insecure, true, 'Insecure flag should be true');
  assert.strictEqual(node.isInfo, false, 'Node should not be flagged as informational text');

  // Test case 2: Info text node filtering
  const infoUrl = 'anytls://11111111-2222-3333-4444-555555555555@node1.dummyproxy.net:33400?insecure=1#%E5%89%A9%E4%BD%99%E6%B5%81%E9%87%8F%EF%BC%9A66.44%20GB';
  const infoNode = parseNodeUrl(infoUrl);
  assert.ok(infoNode, 'Info node parsing returned null');
  assert.strictEqual(infoNode.isInfo, true, 'Node with traffic limit info should be flagged as informational');

  console.log('✅ Subscription Node Parser tests passed!');
}

async function testDatabase() {
  console.log('🧪 Running Test: Database Layer...');
  const db = getDb();
  assert.ok(db.profiles.length > 0, 'Database profiles list should not be empty');
  assert.ok(db.settings.testUrls.length > 0, 'Health targets settings should be loaded');
  console.log('✅ Database Layer tests passed!');
}

import { runDiagnostics } from './health-check.js';

async function testLiveDiagnostics() {
  console.log('🧪 Running Test: Live Diagnostics & Google Reachability...');
  const diag = await runDiagnostics();
  console.log(`  - Diagnostics Success: ${diag.success}`);
  console.log(`  - Exit IP: ${diag.ipInfo.ip}`);
  console.log(`  - Exit Country: ${diag.ipInfo.country}`);
  console.log(`  - Exit Region: ${diag.ipInfo.region}`);
  
  assert.ok(diag.success, 'Diagnostics failed (cannot connect to endpoints like Google/GitHub)');
  if (diag.ipInfo.ip !== 'Offline') {
    assert.ok(diag.ipInfo.country !== 'Unknown', 'Proxy exit country is unknown');
    console.log('✅ Live Diagnostics & Google Reachability tests passed!');
  } else {
    console.log('⚠️ Proxy is offline, skipping exit IP validation.');
  }
}

async function runAllTests() {
  console.log('\n=======================================');
  console.log('🚀 RUNNING AI-VPN INTEGRATION TESTS');
  console.log('=======================================\n');
  
  try {
    await testSubscriptionParser();
    await testDatabase();
    await testLiveDiagnostics();
    
    console.log('\n=======================================');
    console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY!');
    console.log('=======================================\n');
  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED:');
    console.error(err);
    process.exit(1);
  }
}

runAllTests();
