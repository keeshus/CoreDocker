import React, { useState, useEffect } from 'react';
import { buildContainerPayload, parseEnvFromInitialData } from '../lib/domain-logic';
import { useUI } from '../lib/UIProvider';

export default function CreateContainer({ onCreated, initialData = null, onClose = null, isOpenMode = false }) {
  const { showToast } = useUI();
  const [isOpen, setIsOpen] = useState(isOpenMode);
  const [loading, setLoading] = useState(false);
  const [secrets, setSecrets] = useState([]);
  const [groups, setGroups] = useState([]);
  const [nodes, setNodes] = useState([]);
  const defaultFormData = {
    name: '', image: '', restartPolicy: 'unless-stopped',
    env: [{ key: '', value: '', isSecret: false }],
    volumes: [{ type: 'backup', host: '', container: '' }],
    ports: [{ host: '', container: '', ip: '0.0.0.0' }],
    resources: { cpu: '', memory: '' },
    proxy: { enabled: false, uri: '', port: '', domain: '', sslCert: '', sslKey: '' },
    group: '', tmpfs: '', stopGracePeriod: '', shmSize: '', devices: '',
    privileged: false, internetAccess: false, ha: false, ha_allowed_nodes: [], current_node: ''
  };

  const [formData, setFormData] = useState(defaultFormData);

  const fetchGroups = () =>
    fetch('/api/groups').then(res => res.json()).then(data => setGroups(data || [])).catch(() => {});
  const fetchSecrets = () =>
    fetch('/api/secrets').then(res => res.ok ? res.json() : []).then(data => setSecrets(Array.isArray(data) ? data : [])).catch(() => {});
  const fetchNodes = () =>
    fetch('/api/nodes').then(res => res.json()).then(data => setNodes(data || [])).catch(() => {});

  useEffect(() => { fetchSecrets(); fetchGroups(); fetchNodes(); }, []);
  useEffect(() => { if (isOpen) { fetchGroups(); fetchSecrets(); fetchNodes(); } }, [isOpen]);

  useEffect(() => {
    if (initialData) {
      const parsedEnv = parseEnvFromInitialData(initialData.env);
      setFormData({
        ...defaultFormData, ...initialData,
        env: parsedEnv.length ? parsedEnv : [{ key: '', value: '', isSecret: false }],
        volumes: initialData.volumes?.length ? initialData.volumes : [{ type: 'backup', host: '', container: '' }],
        ports: initialData.ports?.length ? initialData.ports : [{ host: '', container: '', ip: '0.0.0.0' }],
        resources: initialData.resources || { cpu: '', memory: '' },
        proxy: initialData.proxy || { enabled: false, uri: '', port: '', domain: '', sslCert: '', sslKey: '' },
        tmpfs: initialData.tmpfs || '', stopGracePeriod: initialData.stopGracePeriod || '',
        shmSize: initialData.shmSize || '', devices: initialData.devices || '',
        privileged: initialData.privileged || false, internetAccess: initialData.internetAccess ?? false
      });
      setIsOpen(true);
    } else {
      setFormData(defaultFormData);
    }
  }, [initialData]);

  useEffect(() => { if (isOpenMode) setIsOpen(true); }, [isOpenMode]);

  const handleArrayChange = (field, index, key, value) => {
    const newArray = [...formData[field]];
    newArray[index][key] = value;
    setFormData({ ...formData, [field]: newArray });
  };

  const addArrayItem = (field, defaultItem) => {
    setFormData({ ...formData, [field]: [...formData[field], defaultItem] });
  };

  const removeArrayItem = (field, index) => {
    setFormData({ ...formData, [field]: formData[field].filter((_, i) => i !== index) });
  };

  const handleClose = () => { setIsOpen(false); if (onClose) onClose(); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    const payload = buildContainerPayload(formData);
    try {
      const url = initialData ? `/api/containers/${initialData.dockerId}` : '/api/containers';
      const method = initialData ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (res.ok) { handleClose(); if (onCreated) onCreated(); }
      else { const error = await res.json(); showToast('Error: ' + JSON.stringify(error), 'error'); }
    } catch (err) { showToast('Error saving container: ' + err.message, 'error'); }
    setLoading(false);
  };

  const inputStyle = {
    width: '100%', padding: '10px 12px',
    border: '1px solid var(--md-outline)', borderRadius: 'var(--md-radius-sm)',
    background: 'var(--md-surface)', color: 'var(--md-on-surface)',
    fontSize: '0.9rem', fontFamily: 'var(--md-font)', boxSizing: 'border-box',
    outline: 'none', transition: 'border-color var(--md-transition)',
  };
  const labelStyle = { display: 'block', fontWeight: 500, marginBottom: '6px', fontSize: '0.85rem', color: 'var(--md-on-surface-variant)' };
  const btnStyle = { padding: '8px 12px', background: 'var(--md-surface)', color: 'var(--md-primary)', border: '1px solid var(--md-outline)', borderRadius: 'var(--md-radius-sm)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500, fontFamily: 'var(--md-font)' };
  const dangerBtnStyle = { ...btnStyle, background: 'var(--md-error-container)', color: 'var(--md-on-error-container)', borderColor: 'var(--md-error)' };

  return (
    <>
      {!initialData && !isOpenMode && (
        <button
          onClick={() => setIsOpen(true)}
          style={{
            padding: '10px 24px', background: 'var(--md-primary)', color: 'var(--md-on-primary)',
            border: 'none', borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
            fontWeight: 600, fontSize: '0.9rem', fontFamily: 'var(--md-font)',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '1.2rem' }}>add</span>
          Create Container
        </button>
      )}

      {isOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 1000,
          backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: '620px',
            background: 'var(--md-surface-container)', overflowY: 'auto',
            padding: '24px', boxShadow: 'var(--md-elevation-5)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h2 style={{ margin: 0, color: 'var(--md-on-surface)', fontSize: '1.35rem', fontWeight: 600 }}>
                {initialData ? 'Edit Container' : 'Create Container'}
              </h2>
              <button onClick={handleClose} style={{
                background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer',
                color: 'var(--md-on-surface-variant)', width: '40px', height: '40px',
                borderRadius: 'var(--md-radius-full)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={labelStyle}>Name</label>
                <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} style={inputStyle} placeholder="my-app" disabled={!!initialData} />
              </div>

              <div>
                <label style={labelStyle}>Image</label>
                <input required type="text" value={formData.image} onChange={e => setFormData({...formData, image: e.target.value})} style={inputStyle} placeholder="nginx:latest" />
              </div>

              <div>
                <label style={labelStyle}>Restart Policy</label>
                <select value={formData.restartPolicy} onChange={e => setFormData({...formData, restartPolicy: e.target.value})} style={inputStyle}>
                  <option value="no">no</option>
                  <option value="always">always</option>
                  <option value="unless-stopped">unless-stopped</option>
                  <option value="on-failure">on-failure</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>Group</label>
                <select value={formData.group || ''} onChange={e => setFormData({...formData, group: e.target.value})} style={inputStyle}>
                  <option value="">-- No Group --</option>
                  {groups.map(g => <option key={g.id} value={g.name}>{g.name} {g.config?.highAvailability ? '(HA Group)' : ''}</option>)}
                </select>
                <small style={{ color: 'var(--md-on-surface-variant)', display: 'block', marginTop: '4px' }}>Containers with the same group name are linked in an isolated network.</small>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={formData.internetAccess} onChange={e => setFormData({...formData, internetAccess: e.target.checked})} style={{ width: '18px', height: '18px', cursor: 'pointer' }} />
                <span style={{ fontWeight: 500, color: 'var(--md-on-surface)', fontSize: '0.9rem' }}>Internet connected</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={formData.ha} onChange={e => setFormData({...formData, ha: e.target.checked})} style={{ width: '18px', height: '18px', cursor: 'pointer' }} />
                <span style={{ fontWeight: 500, color: 'var(--md-on-surface)', fontSize: '0.9rem' }}>High Availability</span>
              </label>

              {formData.ha && (
                <div style={{ marginLeft: '28px' }}>
                  <label style={{ ...labelStyle, fontSize: '0.8rem' }}>Allowed Nodes (optional)</label>
                  <div style={{
                    display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '150px', overflowY: 'auto',
                    padding: '8px', border: '1px solid var(--md-outline)', borderRadius: 'var(--md-radius-sm)',
                    background: 'var(--md-surface)',
                  }}>
                    {nodes.map(node => (
                      <label key={node.id} style={{ display: 'flex', alignItems: 'center', fontSize: '0.85rem', cursor: 'pointer', gap: '8px' }}>
                        <input type="checkbox" checked={(formData.ha || []) && Array.isArray(formData.ha_allowed_nodes) && formData.ha_allowed_nodes.includes(node.id)}
                          onChange={e => {
                            const selected = Array.isArray(formData.ha_allowed_nodes) ? [...formData.ha_allowed_nodes] : [];
                            const newSelected = e.target.checked ? [...selected, node.id] : selected.filter(id => id !== node.id);
                            setFormData({...formData, ha_allowed_nodes: newSelected});
                          }}
                        />
                        <span style={{ color: 'var(--md-on-surface)' }}>{node.name} ({node.ip})</span>
                      </label>
                    ))}
                    {nodes.length === 0 && <span style={{ color: 'var(--md-on-surface-variant)', fontSize: '0.8rem' }}>No other nodes found</span>}
                  </div>
                </div>
              )}

              <details style={{ borderTop: '1px solid var(--md-outline-variant)', paddingTop: '12px' }}>
                <summary style={{ fontWeight: 600, cursor: 'pointer', padding: '8px 0', color: 'var(--md-on-surface)' }}>Proxy Settings (Nginx)</summary>
                <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={formData.proxy.enabled} onChange={e => setFormData({...formData, proxy: {...formData.proxy, enabled: e.target.checked}})} />
                    Enable Reverse Proxy
                  </label>
                  {formData.proxy.enabled && (
                    <>
                      <input type="text" placeholder="URI (e.g., /my-app or /)" value={formData.proxy.uri} onChange={e => setFormData({...formData, proxy: {...formData.proxy, uri: e.target.value}})} style={inputStyle} required />
                      <input type="number" placeholder="Target Container Port (e.g., 80)" value={formData.proxy.port} onChange={e => setFormData({...formData, proxy: {...formData.proxy, port: e.target.value}})} style={inputStyle} required />
                      <div style={{ borderTop: '1px solid var(--md-outline-variant)', margin: '8px 0' }} />
                      <p style={{ margin: '0 0 5px 0', fontWeight: 600, fontSize: '0.85rem', color: 'var(--md-on-surface)' }}>Optional SSL/Domain Config</p>
                      <input type="text" placeholder="Domain Name (e.g., example.com)" value={formData.proxy.domain || ''} onChange={e => setFormData({...formData, proxy: {...formData.proxy, domain: e.target.value}})} style={inputStyle} />
                      <textarea placeholder="SSL Certificate (PEM/CRT)" value={formData.proxy.sslCert || ''} onChange={e => setFormData({...formData, proxy: {...formData.proxy, sslCert: e.target.value}})} style={{ ...inputStyle, minHeight: '80px', fontFamily: 'var(--md-font-mono)' }} />
                      <textarea placeholder="SSL Key (PEM/KEY)" value={formData.proxy.sslKey || ''} onChange={e => setFormData({...formData, proxy: {...formData.proxy, sslKey: e.target.value}})} style={{ ...inputStyle, minHeight: '80px', fontFamily: 'var(--md-font-mono)' }} />
                    </>
                  )}
                </div>
              </details>

              <details style={{ borderTop: '1px solid var(--md-outline-variant)', paddingTop: '12px' }}>
                <summary style={{ fontWeight: 600, cursor: 'pointer', padding: '8px 0', color: 'var(--md-on-surface)' }}>Environment Variables</summary>
                <div style={{ padding: '12px 0' }}>
                  {formData.env.map((e, i) => (
                    <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '10px', alignItems: 'center' }}>
                      <input type="text" placeholder="Key" value={e.key} onChange={ev => handleArrayChange('env', i, 'key', ev.target.value)} style={{ flex: 1, ...inputStyle }} />
                      {e.isSecret ? (
                        <select value={e.value} onChange={ev => handleArrayChange('env', i, 'value', ev.target.value)} style={{ flex: 1, ...inputStyle }}>
                          <option value="">-- Select Secret --</option>
                          {secrets.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <input type="text" placeholder="Value" value={e.value} onChange={ev => handleArrayChange('env', i, 'value', ev.target.value)} style={{ flex: 1, ...inputStyle }} />
                      )}
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                        <input type="checkbox" checked={e.isSecret} onChange={ev => handleArrayChange('env', i, 'isSecret', ev.target.checked)} />
                        Secret
                      </label>
                      <button type="button" onClick={() => removeArrayItem('env', i)} style={dangerBtnStyle}>X</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('env', {key: '', value: '', isSecret: false})} style={btnStyle}>+ Add Env</button>
                </div>
              </details>

              <details style={{ borderTop: '1px solid var(--md-outline-variant)', paddingTop: '12px' }}>
                <summary style={{ fontWeight: 600, cursor: 'pointer', padding: '8px 0', color: 'var(--md-on-surface)' }}>Volumes</summary>
                <div style={{ padding: '12px 0' }}>
                  {formData.volumes.map((v, i) => (
                    <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '10px', alignItems: 'center' }}>
                      <select value={v.type || 'custom'} onChange={ev => handleArrayChange('volumes', i, 'type', ev.target.value)} style={{ padding: '8px', borderRadius: 'var(--md-radius-sm)', border: '1px solid var(--md-outline)', background: 'var(--md-surface)', color: 'var(--md-on-surface)' }}>
                        <option value="backup">Backup</option>
                        <option value="non-backup">Non-Backup</option>
                        <option value="custom">Custom Path</option>
                      </select>
                      <input type="text" placeholder={v.type === 'custom' ? "Host absolute path" : "Folder name (optional)"} value={v.host} onChange={ev => handleArrayChange('volumes', i, 'host', ev.target.value)} style={{ flex: 1, ...inputStyle }} />
                      <input type="text" placeholder="Container path (e.g. /app/data)" value={v.container} onChange={ev => handleArrayChange('volumes', i, 'container', ev.target.value)} style={{ flex: 1, ...inputStyle }} required />
                      <button type="button" onClick={() => removeArrayItem('volumes', i)} style={dangerBtnStyle}>X</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('volumes', {type: 'backup', host: '', container: ''})} style={btnStyle}>+ Add Volume</button>
                </div>
              </details>

              <details style={{ borderTop: '1px solid var(--md-outline-variant)', paddingTop: '12px' }}>
                <summary style={{ fontWeight: 600, cursor: 'pointer', padding: '8px 0', color: 'var(--md-on-surface)' }}>Ports</summary>
                <div style={{ padding: '12px 0' }}>
                  {formData.ports.map((p, i) => (
                    <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                      <input type="text" placeholder="IP (0.0.0.0)" value={p.ip} onChange={ev => handleArrayChange('ports', i, 'ip', ev.target.value)} style={{ flex: 1, ...inputStyle }} />
                      <input type="number" placeholder="Host Port" value={p.host} onChange={ev => handleArrayChange('ports', i, 'host', ev.target.value)} style={{ flex: 1, ...inputStyle }} />
                      <input type="number" placeholder="Container Port" value={p.container} onChange={ev => handleArrayChange('ports', i, 'container', ev.target.value)} style={{ flex: 1, ...inputStyle }} />
                      <button type="button" onClick={() => removeArrayItem('ports', i)} style={dangerBtnStyle}>X</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('ports', {host: '', container: '', ip: '0.0.0.0'})} style={btnStyle}>+ Add Port</button>
                </div>
              </details>

              <details style={{ borderTop: '1px solid var(--md-outline-variant)', paddingTop: '12px' }}>
                <summary style={{ fontWeight: 600, cursor: 'pointer', padding: '8px 0', color: 'var(--md-on-surface)' }}>Resources</summary>
                <div style={{ padding: '12px 0', display: 'flex', gap: '12px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '5px', color: 'var(--md-on-surface-variant)' }}>CPUs</label>
                    <input type="number" step="0.1" placeholder="e.g. 1.5" value={formData.resources.cpu} onChange={e => setFormData({...formData, resources: {...formData.resources, cpu: e.target.value}})} style={inputStyle} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '5px', color: 'var(--md-on-surface-variant)' }}>Memory (MB)</label>
                    <input type="number" placeholder="e.g. 512" value={formData.resources.memory} onChange={e => setFormData({...formData, resources: {...formData.resources, memory: e.target.value}})} style={inputStyle} />
                  </div>
                </div>
              </details>

              <details style={{ borderTop: '1px solid var(--md-outline-variant)', paddingTop: '12px' }}>
                <summary style={{ fontWeight: 600, cursor: 'pointer', padding: '8px 0', color: 'var(--md-on-surface)' }}>Target Node</summary>
                <div style={{ padding: '12px 0' }}>
                  <select value={formData.current_node || ''} onChange={e => setFormData({...formData, current_node: e.target.value})} style={inputStyle}>
                    <option value="">-- Local Node (Auto) --</option>
                    {nodes.map(n => <option key={n.id} value={n.id}>{n.name} ({n.ip})</option>)}
                  </select>
                </div>
              </details>

              <details style={{ borderTop: '1px solid var(--md-outline-variant)', paddingTop: '12px' }}>
                <summary style={{ fontWeight: 600, cursor: 'pointer', padding: '8px 0', color: 'var(--md-on-surface)' }}>Advanced Options</summary>
                <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  <div>
                    <label style={labelStyle}>Tmpfs Mounts</label>
                    <input type="text" placeholder="e.g. /run,/tmp" value={formData.tmpfs} onChange={e => setFormData({...formData, tmpfs: e.target.value})} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Stop Grace Period (seconds)</label>
                    <input type="number" placeholder="e.g. 30" value={formData.stopGracePeriod} onChange={e => setFormData({...formData, stopGracePeriod: e.target.value})} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Shared Memory Size (shm_size)</label>
                    <input type="text" placeholder="e.g. 64m or 1g" value={formData.shmSize} onChange={e => setFormData({...formData, shmSize: e.target.value})} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Device Pass-through</label>
                    <input type="text" placeholder="e.g. /dev/dri:/dev/dri" value={formData.devices} onChange={e => setFormData({...formData, devices: e.target.value})} style={inputStyle} />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={formData.privileged} onChange={e => setFormData({...formData, privileged: e.target.checked})} />
                    <span style={{ fontWeight: 500, color: 'var(--md-on-surface)' }}>Privileged Mode</span>
                  </label>
                </div>
              </details>

              <button type="submit" disabled={loading} style={{
                padding: '14px 24px', background: 'var(--md-primary)', color: 'var(--md-on-primary)',
                border: 'none', borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                fontWeight: 600, fontSize: '1rem', fontFamily: 'var(--md-font)',
                marginTop: '8px', opacity: loading ? 0.7 : 1,
              }}>
                {loading ? 'Saving (might be pulling image)...' : (initialData ? 'Save Changes' : 'Create Container')}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
