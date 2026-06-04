import React, { useState, useEffect, useRef } from 'react';

const DAEMON_URL = 'http://127.0.0.1:4140';
const API_BASE = `${DAEMON_URL}/api`;
const WS_URL = 'ws://127.0.0.1:4140';

export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState('direct-default');
  const [humanOverride, setHumanOverride] = useState(false);
  const [vpnState, setVpnState] = useState('disconnected');
  const [vpnProfileName, setVpnProfileName] = useState('');
  const [settings, setSettings] = useState({ openvpnPath: '', healthCheckInterval: 30 });
  const [logs, setLogs] = useState([]);
  const [wsConnected, setWsConnected] = useState(false);
  
  // Diagnostics
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState({
    success: false,
    avgLatency: 9999,
    targets: [
      { name: 'GitHub', url: 'https://github.com', success: false, latency: 9999 },
      { name: 'OpenAI API', url: 'https://api.openai.com', success: false, latency: 9999 },
      { name: 'Google', url: 'https://www.google.com', success: false, latency: 9999 }
    ]
  });

  // UI state
  const [logFilter, setLogFilter] = useState('all'); // 'all', 'system', 'openvpn', 'ai', 'human'
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileType, setNewProfileType] = useState('proxy'); // 'proxy', 'openvpn'
  // Proxy options
  const [proxyHost, setProxyHost] = useState('127.0.0.1');
  const [proxyPort, setProxyPort] = useState('7890');
  const [proxyProtocol, setProxyProtocol] = useState('socks5');
  // OpenVPN option
  const [ovpnContent, setOvpnContent] = useState('');

  // Simulated traffic speeds
  const [downSpeed, setDownSpeed] = useState(0);
  const [upSpeed, setUpSpeed] = useState(0);

  const logsEndRef = useRef(null);
  const wsRef = useRef(null);

  // Helper for REST requests
  const apiCall = async (path, method = 'GET', body = null) => {
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Source': 'human' // Identify as human request from Web UI
    };
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${API_BASE}${path}`, options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  // Connect WebSocket for live streams
  const connectWs = () => {
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const { type, data } = message;

        if (type === 'init') {
          setProfiles(data.profiles || []);
          setActiveProfileId(data.activeProfileId || 'direct-default');
          setHumanOverride(data.humanOverride || false);
          setVpnState(data.vpnState || 'disconnected');
          setVpnProfileName(data.vpnProfileName || '');
          setSettings(data.settings || {});
          setLogs(data.logs || []);
        } else if (type === 'status') {
          setActiveProfileId(data.activeProfileId);
          setHumanOverride(data.humanOverride);
          setVpnState(data.vpnState);
          setVpnProfileName(data.vpnProfileName);
          setProfiles(data.profiles);
          setSettings(data.settings);
        } else if (type === 'log') {
          setLogs(prev => [...prev, data].slice(-300)); // limit to 300 logs in memory
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        setTimeout(connectWs, 3000); // Retry reconnect in 3s
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch (e) {
      setTimeout(connectWs, 3000);
    }
  };

  // Trigger diagnostic pings
  const refreshDiagnostics = async () => {
    setDiagnosticLoading(true);
    try {
      const status = await apiCall('/status');
      setDiagnosticResult(status.diagnostics);
    } catch (err) {
      console.error('Diagnostic error:', err);
    } finally {
      setDiagnosticLoading(false);
    }
  };

  // Initialize
  useEffect(() => {
    connectWs();
    refreshDiagnostics();

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Update speed simulator
  useEffect(() => {
    const isConnected = activeProfileId !== 'direct-default' || vpnState === 'connected';
    
    const interval = setInterval(() => {
      if (isConnected) {
        // Connected speed fluctuations
        setDownSpeed(Math.max(12, Math.floor(Math.random() * 2500) + 1200));
        setUpSpeed(Math.max(3, Math.floor(Math.random() * 400) + 180));
      } else {
        // Disconnected
        setDownSpeed(0);
        setUpSpeed(0);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [activeProfileId, vpnState]);

  // Auto-scroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Action handlers
  const handleToggleOverride = async () => {
    try {
      const targetState = !humanOverride;
      await apiCall('/toggle-override', 'POST', { override: targetState });
      setHumanOverride(targetState);
    } catch (err) {
      alert(`Failed to toggle override: ${err.message}`);
    }
  };

  const handleConnectProfile = async (id) => {
    try {
      await apiCall('/connect', 'POST', { id });
      setTimeout(refreshDiagnostics, 4000); // Trigger ping check after it settles
    } catch (err) {
      alert(`Connection failed: ${err.message}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await apiCall('/disconnect', 'POST');
      setTimeout(refreshDiagnostics, 2000);
    } catch (err) {
      alert(`Disconnection failed: ${err.message}`);
    }
  };

  const handleTriggerHeal = async () => {
    try {
      await apiCall('/heal', 'POST');
    } catch (err) {
      alert(`Healing failed: ${err.message}`);
    }
  };

  const handleDeleteProfile = async (e, id) => {
    e.stopPropagation(); // prevent connecting click
    if (!confirm('Are you sure you want to delete this profile?')) return;
    try {
      await apiCall(`/profiles/${id}`, 'DELETE');
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  const handleAddProfile = async (e) => {
    e.preventDefault();
    if (!newProfileName) return alert('Name is required');

    let content = '';
    if (newProfileType === 'proxy') {
      content = JSON.stringify({
        host: proxyHost,
        port: parseInt(proxyPort),
        protocol: proxyProtocol
      });
    } else {
      if (!ovpnContent) return alert('OpenVPN config content is required');
      content = ovpnContent;
    }

    try {
      await apiCall('/profiles', 'POST', {
        name: newProfileName,
        type: newProfileType,
        content
      });
      // Reset form
      setNewProfileName('');
      setNewProfileType('proxy');
      setOvpnContent('');
      setShowAddForm(false);
    } catch (err) {
      alert(`Add profile failed: ${err.message}`);
    }
  };

  // Filter logs based on selection
  const filteredLogs = logs.filter(l => {
    if (logFilter === 'all') return true;
    return l.source === logFilter;
  });

  const getLatencyClass = (latency) => {
    if (latency === null || latency === 9999) return 'latency-bad';
    if (latency < 150) return 'latency-good';
    if (latency < 400) return 'latency-ok';
    return 'latency-bad';
  };

  const getLatencyText = (latency) => {
    if (latency === null || latency === 9999) return 'Offline';
    return `${latency}ms`;
  };

  const activeProfile = profiles.find(p => p.id === activeProfileId);
  const activeProfileNameText = activeProfile ? activeProfile.name : 'Direct Connection';

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="logo-section">
          <svg className="logo-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" rx="20" fill="#0d1117" />
            <path d="M30 70 L50 30 L70 70 Z" stroke="#00ff88" strokeWidth="8" strokeLinejoin="round"/>
            <circle cx="50" cy="45" r="6" fill="#00f0ff" />
          </svg>
          <h1 className="logo-text">AI-VPN</h1>
          <span className="logo-tag">AUTOPILOT</span>
        </div>
        
        <div className="header-controls">
          {/* Daemon connectivity state */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem' }}>
            <span style={{ 
              width: '10px', 
              height: '10px', 
              borderRadius: '50%', 
              backgroundColor: wsConnected ? 'var(--accent-green)' : 'var(--accent-magenta)',
              boxShadow: wsConnected ? '0 0 8px var(--accent-green)' : '0 0 8px var(--accent-magenta)'
            }} />
            <span style={{ color: 'var(--text-secondary)' }}>
              {wsConnected ? 'Daemon Online' : 'Daemon Reconnecting...'}
            </span>
          </div>

          {/* Physical human override switch */}
          <div className="override-toggle-container">
            <span className={`override-label ${humanOverride ? 'locked' : 'unlocked'}`}>
              {humanOverride ? 'LOCK: HUMAN OVERRIDE' : 'AUTO: AI AUTOPILOT'}
            </span>
            <label className="switch">
              <input 
                type="checkbox" 
                checked={humanOverride} 
                onChange={handleToggleOverride}
              />
              <span className="slider"></span>
            </label>
          </div>
        </div>
      </header>

      {/* Grid Content */}
      <div className="dashboard-grid">
        {/* Left Side Panels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* Connection Status Panel */}
          <section className="card" style={{ position: 'relative' }}>
            <h2 className="card-title">
              Connection Telemetry
              <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                Port: 4141
              </span>
            </h2>
            
            <div className="status-display">
              <div className="status-item">
                <span className="status-item-label">Active Node</span>
                <span className="status-item-value" style={{ fontSize: '1rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {activeProfileNameText}
                </span>
              </div>
              
              <div className="status-item">
                <span className="status-item-label">Tunnel Mode</span>
                <span className={`status-item-value ${
                  vpnState === 'connected' ? 'value-connected' :
                  vpnState === 'connecting' ? 'value-connecting' :
                  vpnState === 'error' ? 'value-error' : 'value-disconnected'
                }`}>
                  {activeProfileId === 'direct-default' ? 'DIRECT' : (activeProfile?.type?.toUpperCase() || 'PROXY')}
                </span>
              </div>
            </div>

            {/* Traffic Dial Stats */}
            <div className="traffic-stats">
              <div className="traffic-bubble">
                <div className="status-item-label" style={{ fontSize: '0.65rem' }}>↓ Downstream Speed</div>
                <div className="traffic-val">
                  {downSpeed > 0 ? (downSpeed / 1000).toFixed(2) : '0.00'} <span style={{ fontSize: '0.8rem' }}>MB/s</span>
                </div>
              </div>
              
              <div className="traffic-bubble">
                <div className="status-item-label" style={{ fontSize: '0.65rem' }}>↑ Upstream Speed</div>
                <div className="traffic-val">
                  {upSpeed > 0 ? upSpeed : '0'} <span style={{ fontSize: '0.8rem' }}>KB/s</span>
                </div>
              </div>
            </div>

            {/* Controls */}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button 
                className="btn btn-primary" 
                style={{ flex: 1 }}
                onClick={handleTriggerHeal}
                disabled={humanOverride}
              >
                ⚡ Trigger AI Healing
              </button>
              
              <button 
                className="btn btn-danger" 
                style={{ flex: 1 }}
                onClick={handleDisconnect}
                disabled={activeProfileId === 'direct-default'}
              >
                ✕ Disconnect
              </button>
            </div>
          </section>

          {/* Connection Speed Diagnostic Pings */}
          <section className="card">
            <div className="flex-row" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
              <h2 className="card-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                Diagnostic Targets
              </h2>
              <button 
                className="btn btn-small"
                onClick={refreshDiagnostics}
                disabled={diagnosticLoading}
              >
                {diagnosticLoading ? 'Testing...' : '🔄 Speed Test'}
              </button>
            </div>

            <div className="targets-list">
              {diagnosticResult.targets.map((t, idx) => (
                <div key={idx} className="target-row">
                  <div className="target-info">
                    <span className="target-name">{t.name}</span>
                    <span className="target-url">{t.url}</span>
                  </div>
                  <span className={`target-latency ${getLatencyClass(t.latency)}`}>
                    {getLatencyText(t.latency)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* VPN Node Switcher Profile list */}
          <section className="card" style={{ position: 'relative' }}>
            <div className="flex-row" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
              <h2 className="card-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                Profile Manager
              </h2>
              <button 
                className="btn btn-small"
                onClick={() => setShowAddForm(!showAddForm)}
              >
                {showAddForm ? 'Cancel' : '+ Import Node'}
              </button>
            </div>

            {/* Locked screen overlay for AI configuration */}
            {humanOverride && (
              <div className="connection-lock-overlay" style={{ display: 'none' /* We keep UI interactive for humans, overlay only for AI requests, but here we can show a banner */ }}></div>
            )}

            {/* Profile Import Form */}
            {showAddForm && (
              <form className="profile-form" onSubmit={handleAddProfile}>
                <div className="form-group">
                  <label>Node Label/Name</label>
                  <input 
                    type="text" 
                    className="input-text" 
                    placeholder="e.g. US West Node"
                    value={newProfileName}
                    onChange={e => setNewProfileName(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Protocol Connection Type</label>
                  <select 
                    className="select-input" 
                    value={newProfileType} 
                    onChange={e => setNewProfileType(e.target.value)}
                  >
                    <option value="proxy">Upstream Proxy (HTTP/SOCKS5)</option>
                    <option value="openvpn">OpenVPN Profile (.ovpn)</option>
                  </select>
                </div>

                {newProfileType === 'proxy' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px' }}>
                    <div className="form-group">
                      <label>Host IP/Domain</label>
                      <input 
                        type="text" 
                        className="input-text"
                        value={proxyHost}
                        onChange={e => setProxyHost(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>Port</label>
                      <input 
                        type="text" 
                        className="input-text"
                        value={proxyPort}
                        onChange={e => setProxyPort(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>Protocol</label>
                      <select 
                        className="select-input"
                        value={proxyProtocol}
                        onChange={e => setProxyProtocol(e.target.value)}
                      >
                        <option value="socks5">SOCKS5</option>
                        <option value="http">HTTP</option>
                      </select>
                    </div>
                  </div>
                ) : (
                  <div className="form-group">
                    <label>OVPN Configuration Text</label>
                    <textarea 
                      rows="6" 
                      className="textarea-input"
                      placeholder="Paste complete #ovpn file contents here..."
                      value={ovpnContent}
                      onChange={e => setOvpnContent(e.target.value)}
                    ></textarea>
                  </div>
                )}

                <div className="form-actions">
                  <button type="submit" className="btn btn-primary">Import & Save</button>
                </div>
              </form>
            )}

            <div className="profile-list-container">
              {profiles.map((p) => (
                <div 
                  key={p.id} 
                  className={`profile-card ${p.id === activeProfileId ? 'active' : ''}`}
                  onClick={() => handleConnectProfile(p.id)}
                >
                  <div className="profile-meta">
                    <span className={`profile-badge badge-${p.type}`}>
                      {p.type}
                    </span>
                    <span className="profile-name">{p.name}</span>
                  </div>
                  
                  <div className="profile-actions">
                    <span className="profile-latency">
                      {p.latency ? `${p.latency}ms` : ''}
                    </span>
                    {p.id !== 'direct-default' && (
                      <button 
                        className="btn btn-danger btn-small"
                        onClick={(e) => handleDeleteProfile(e, p.id)}
                        style={{ border: 'none', background: 'transparent', padding: '5px' }}
                        title="Delete Profile"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

        </div>

        {/* Right Side Logs Console */}
        <section className="card console-card">
          <div className="flex-row" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
            <h2 className="card-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              AI Autopilot Logs Console
            </h2>
            
            <button 
              className="btn btn-small"
              onClick={() => setLogs([])}
            >
              Clear Screen
            </button>
          </div>

          {/* Filter Toolbar */}
          <div className="console-filters">
            {['all', 'system', 'openvpn', 'ai', 'human'].map(filter => (
              <button
                key={filter}
                className={`filter-btn ${logFilter === filter ? 'active' : ''}`}
                onClick={() => setLogFilter(filter)}
              >
                {filter.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Logs Feed Window */}
          <div className="console-logs-feed">
            {filteredLogs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '20px' }}>
                -- Console empty. Awaiting daemon broadcasts... --
              </div>
            ) : (
              filteredLogs.map((l, index) => {
                const timeStr = new Date(l.timestamp).toLocaleTimeString();
                return (
                  <div key={index} className="log-line">
                    <span className="log-timestamp">[{timeStr}]</span>
                    <span className={`log-source source-${l.source}`}>
                      [{l.source.toUpperCase()}]
                    </span>
                    <span className={`log-content log-level-${l.level}`}>
                      {l.message}
                    </span>
                  </div>
                );
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </section>

      </div>
    </div>
  );
}
