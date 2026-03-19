import React, { useState, useEffect } from 'react';

export default function CreateContainer({ onCreated, initialData = null, onClose = null, isOpenMode = false }) {
  const [isOpen, setIsOpen] = useState(isOpenMode);
  const [loading, setLoading] = useState(false);
  const [secrets, setSecrets] = useState([]);
  
  const defaultFormData = {
    name: '',
    image: '',
    restartPolicy: 'unless-stopped',
    env: [{ key: '', value: '', isSecret: false }],
    volumes: [{ type: 'backup', host: '', container: '' }],
    ports: [{ host: '', container: '', ip: '0.0.0.0' }],
    resources: { cpu: '', memory: '' },
    proxy: { enabled: false, uri: '', port: '', domain: '', sslCert: '', sslKey: '' },
    group: '',
    ha: false,
    ha_allowed_nodes: [],
    tmpfs: '',
    stopGracePeriod: '',
    shmSize: '',
    devices: '',
    privileged: false
  };

  const [formData, setFormData] = useState(defaultFormData);

  useEffect(() => {
    fetch('/api/secrets')
      .then(res => res.json())
      .then(data => setSecrets(data || []))
      .catch(err => console.error('Failed to fetch secrets:', err));
  }, []);

  useEffect(() => {
    if (initialData) {
      const parsedEnv = (initialData.env || []).map(e => {
        const secretMatch = e.value?.match(/^\{\{SECRET:(.+)\}\}$/);
        if (secretMatch) {
          return { key: e.key, value: secretMatch[1], isSecret: true };
        }
        return { ...e, isSecret: false };
      });

      setFormData({
        ...defaultFormData,
        ...initialData,
        env: parsedEnv.length ? parsedEnv : [{ key: '', value: '', isSecret: false }],
        volumes: initialData.volumes?.length ? initialData.volumes : [{ type: 'backup', host: '', container: '' }],
        ports: initialData.ports?.length ? initialData.ports : [{ host: '', container: '', ip: '0.0.0.0' }],
        resources: initialData.resources || { cpu: '', memory: '' },
        proxy: initialData.proxy || { enabled: false, uri: '', port: '', domain: '', sslCert: '', sslKey: '' },
        ha: initialData.ha || false,
        tmpfs: initialData.tmpfs || '',
        stopGracePeriod: initialData.stopGracePeriod || '',
        shmSize: initialData.shmSize || '',
        devices: initialData.devices || '',
        privileged: initialData.privileged || false
      });
      setIsOpen(true);
    } else {
      setFormData(defaultFormData);
    }
  }, [initialData]);

  useEffect(() => {
    if (isOpenMode) {
      setIsOpen(true);
    }
  }, [isOpenMode]);

  const handleArrayChange = (field, index, key, value) => {
    const newArray = [...formData[field]];
    newArray[index][key] = value;
    setFormData({ ...formData, [field]: newArray });
  };

  const addArrayItem = (field, defaultItem) => {
    setFormData({ ...formData, [field]: [...formData[field], defaultItem] });
  };

  const removeArrayItem = (field, index) => {
    const newArray = formData[field].filter((_, i) => i !== index);
    setFormData({ ...formData, [field]: newArray });
  };

  const handleClose = () => {
    setIsOpen(false);
    if (onClose) onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    // Clean up empty fields
    const payload = {
      ...formData,
      env: formData.env
        .filter(e => e.key && e.value)
        .map(e => ({
          key: e.key,
          value: e.isSecret ? `{{SECRET:${e.value}}}` : e.value
        })),
      volumes: formData.volumes.filter(v => (v.type !== 'custom' || v.host) && v.container),
      ports: formData.ports.filter(p => p.container).map(p => ({
        ...p,
        host: p.host ? parseInt(p.host, 10) : null,
        container: parseInt(p.container, 10)
      })),
      resources: {
        cpu: formData.resources.cpu ? parseFloat(formData.resources.cpu) : null,
        memory: formData.resources.memory ? parseInt(formData.resources.memory, 10) : null,
      }
    };

    if (payload.proxy.enabled) {
      payload.proxy.port = parseInt(payload.proxy.port, 10);
    }

    try {
      const url = initialData ? `/api/containers/${initialData.dockerId}` : '/api/containers';
      const method = initialData ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        handleClose();
        if (onCreated) onCreated();
      } else {
        const error = await res.json();
        alert('Error: ' + JSON.stringify(error));
      }
    } catch (err) {
      alert('Error saving container: ' + err.message);
    }
    setLoading(false);
  };

  return (
    <>
      {!initialData && !isOpenMode && (
        <button 
          onClick={() => setIsOpen(true)}
          style={{ padding: '10px 20px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
        >
          + Create Container
        </button>
      )}

      {isOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000 }}>
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '600px', background: 'white', overflowY: 'auto', padding: '20px', boxShadow: '-5px 0 15px rgba(0,0,0,0.1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>{initialData ? 'Edit Container' : 'Create Container'}</h2>
              <button onClick={handleClose} style={{ background: 'none', border: 'none', fontSize: '1.5em', cursor: 'pointer' }}>&times;</button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Name</label>
                <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} style={{ width: '100%', padding: '8px' }} placeholder="my-app" disabled={!!initialData} />
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Image</label>
                <input required type="text" value={formData.image} onChange={e => setFormData({...formData, image: e.target.value})} style={{ width: '100%', padding: '8px' }} placeholder="nginx:latest" />
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Restart Policy</label>
                <select value={formData.restartPolicy} onChange={e => setFormData({...formData, restartPolicy: e.target.value})} style={{ width: '100%', padding: '8px' }}>
                  <option value="no">no</option>
                  <option value="always">always</option>
                  <option value="unless-stopped">unless-stopped</option>
                  <option value="on-failure">on-failure</option>
                </select>
              </div>

              <details>
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Proxy Settings (Nginx)</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <input type="checkbox" checked={formData.proxy.enabled} onChange={e => setFormData({...formData, proxy: {...formData.proxy, enabled: e.target.checked}})} />
                    Enable Reverse Proxy
                  </label>
                  {formData.proxy.enabled && (
                    <>
                      <input type="text" placeholder="URI (e.g., /my-app or /)" value={formData.proxy.uri} onChange={e => setFormData({...formData, proxy: {...formData.proxy, uri: e.target.value}})} style={{ width: '100%', padding: '8px' }} required />
                      <input type="number" placeholder="Target Container Port (e.g., 80)" value={formData.proxy.port} onChange={e => setFormData({...formData, proxy: {...formData.proxy, port: e.target.value}})} style={{ width: '100%', padding: '8px' }} required />
                      
                      <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '10px 0' }} />
                      <p style={{ margin: '0 0 5px 0', fontWeight: 'bold', fontSize: '0.9em' }}>Optional SSL/Domain Config</p>
                      <input type="text" placeholder="Domain Name (e.g., example.com)" value={formData.proxy.domain || ''} onChange={e => setFormData({...formData, proxy: {...formData.proxy, domain: e.target.value}})} style={{ width: '100%', padding: '8px' }} />
                      <textarea placeholder="SSL Certificate (PEM/CRT)" value={formData.proxy.sslCert || ''} onChange={e => setFormData({...formData, proxy: {...formData.proxy, sslCert: e.target.value}})} style={{ width: '100%', padding: '8px', minHeight: '80px', fontFamily: 'monospace', fontSize: '0.85em' }} />
                      <textarea placeholder="SSL Key (PEM/KEY)" value={formData.proxy.sslKey || ''} onChange={e => setFormData({...formData, proxy: {...formData.proxy, sslKey: e.target.value}})} style={{ width: '100%', padding: '8px', minHeight: '80px', fontFamily: 'monospace', fontSize: '0.85em' }} />
                    </>
                  )}
                </div>
              </details>

              <details>
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Environment Variables</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none' }}>
                  {formData.env.map((e, i) => (
                    <div key={i} style={{ display: 'flex', gap: '10px', marginBottom: '10px', alignItems: 'center' }}>
                      <input type="text" placeholder="Key" value={e.key} onChange={ev => handleArrayChange('env', i, 'key', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      
                      {e.isSecret ? (
                        <select
                          value={e.value}
                          onChange={ev => handleArrayChange('env', i, 'value', ev.target.value)}
                          style={{ flex: 1, padding: '8px' }}
                        >
                          <option value="">-- Select Secret --</option>
                          {secrets.map(s => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      ) : (
                        <input type="text" placeholder="Value" value={e.value} onChange={ev => handleArrayChange('env', i, 'value', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      )}

                      <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.85em', whiteSpace: 'nowrap' }}>
                        <input
                          type="checkbox"
                          checked={e.isSecret}
                          onChange={ev => handleArrayChange('env', i, 'isSecret', ev.target.checked)}
                        />
                        Secret
                      </label>

                      <button type="button" onClick={() => removeArrayItem('env', i)} style={{ padding: '4px 8px' }}>X</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('env', {key: '', value: '', isSecret: false})}>+ Add Env</button>
                </div>
              </details>

              <details>
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Volumes</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none' }}>
                  {formData.volumes.map((v, i) => (
                    <div key={i} style={{ display: 'flex', gap: '10px', marginBottom: '10px', alignItems: 'center' }}>
                      <select
                        value={v.type || 'custom'}
                        onChange={ev => handleArrayChange('volumes', i, 'type', ev.target.value)}
                        style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      >
                        <option value="backup">Backup</option>
                        <option value="non-backup">Non-Backup</option>
                        <option value="custom">Custom Path</option>
                      </select>
                      
                      <input
                        type="text"
                        placeholder={v.type === 'custom' ? "Host absolute path" : "Folder name (optional)"}
                        value={v.host}
                        onChange={ev => handleArrayChange('volumes', i, 'host', ev.target.value)}
                        style={{ flex: 1, padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                      />
                      <input
                        type="text"
                        placeholder="Container path (e.g. /app/data)"
                        value={v.container}
                        onChange={ev => handleArrayChange('volumes', i, 'container', ev.target.value)}
                        style={{ flex: 1, padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                        required
                      />
                      <button type="button" onClick={() => removeArrayItem('volumes', i)} style={{ padding: '8px 12px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>X</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('volumes', {type: 'backup', host: '', container: ''})} style={{ padding: '8px 12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>+ Add Volume</button>
                </div>
              </details>

              <details>
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Ports</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none' }}>
                  {formData.ports.map((p, i) => (
                    <div key={i} style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                      <input type="text" placeholder="IP (0.0.0.0)" value={p.ip} onChange={ev => handleArrayChange('ports', i, 'ip', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      <input type="number" placeholder="Host Port" value={p.host} onChange={ev => handleArrayChange('ports', i, 'host', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      <input type="number" placeholder="Container Port" value={p.container} onChange={ev => handleArrayChange('ports', i, 'container', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      <button type="button" onClick={() => removeArrayItem('ports', i)}>X</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('ports', {host: '', container: '', ip: '0.0.0.0'})}>+ Add Port</button>
                </div>
              </details>

              <details>
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Resources</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none', display: 'flex', gap: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '0.9em', marginBottom: '5px' }}>CPUs</label>
                    <input type="number" step="0.1" placeholder="e.g. 1.5" value={formData.resources.cpu} onChange={e => setFormData({...formData, resources: {...formData.resources, cpu: e.target.value}})} style={{ width: '100%', padding: '8px' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '0.9em', marginBottom: '5px' }}>Memory (MB)</label>
                    <input type="number" placeholder="e.g. 512" value={formData.resources.memory} onChange={e => setFormData({...formData, resources: {...formData.resources, memory: e.target.value}})} style={{ width: '100%', padding: '8px' }} />
                  </div>
                </div>
              </details>

              <details>
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Container Group & HA Configuration</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    <span style={{ fontWeight: 'bold', color: '#475569' }}>Group Name</span>
                    <input 
                      type="text" 
                      value={formData.group || ''} 
                      onChange={e => setFormData({...formData, group: e.target.value})} 
                      placeholder="e.g. web-stack (Leave empty for no group)"
                      style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    />
                    <small style={{ color: '#64748b' }}>Containers with the same group name are linked in an isolated network.</small>
                  </label>
                  
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
                    <input
                      type="checkbox"
                      checked={formData.ha}
                      onChange={e => setFormData({...formData, ha: e.target.checked})}
                    />
                    <span style={{ fontWeight: 'bold', color: '#475569' }}>High Availability (HA) Failover</span>
                  </label>
                  <small style={{ color: '#64748b', marginLeft: '25px' }}>If enabled, this container group will automatically fail over to a healthy node if its current host fails.</small>
                </div>
              </details>

              <details>
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Advanced Options</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none', display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  
                  <div>
                    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', fontSize: '0.9em' }}>Tmpfs Mounts</label>
                    <input type="text" placeholder="e.g. /run,/tmp" value={formData.tmpfs} onChange={e => setFormData({...formData, tmpfs: e.target.value})} style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                    <small style={{ color: '#64748b' }}>Comma-separated container paths to mount as volatile memory-based filesystems.</small>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', fontSize: '0.9em' }}>Stop Grace Period (seconds)</label>
                    <input type="number" placeholder="e.g. 30" value={formData.stopGracePeriod} onChange={e => setFormData({...formData, stopGracePeriod: e.target.value})} style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                    <small style={{ color: '#64748b' }}>Timeout for graceful container shutdown before forceful kill.</small>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', fontSize: '0.9em' }}>Shared Memory Size (shm_size)</label>
                    <input type="text" placeholder="e.g. 64m or 1g" value={formData.shmSize} onChange={e => setFormData({...formData, shmSize: e.target.value})} style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                    <small style={{ color: '#64748b' }}>Size of /dev/shm. E.g. useful for specialized databases.</small>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', fontSize: '0.9em' }}>Device Pass-through</label>
                    <input type="text" placeholder="e.g. /dev/dri:/dev/dri" value={formData.devices} onChange={e => setFormData({...formData, devices: e.target.value})} style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                    <small style={{ color: '#64748b' }}>Comma-separated list of host devices to pass to the container.</small>
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <input
                      type="checkbox"
                      checked={formData.privileged}
                      onChange={e => setFormData({...formData, privileged: e.target.checked})}
                    />
                    <span style={{ fontWeight: 'bold', color: '#475569', fontSize: '0.9em' }}>Privileged Mode</span>
                  </label>
                  <small style={{ color: '#64748b', marginLeft: '25px', marginTop: '-5px' }}>Run the container with full host access. Use with caution.</small>

                  <div style={{ marginTop: '15px', borderTop: '1px solid #e2e8f0', paddingTop: '15px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <input
                        type="checkbox"
                        checked={formData.ha}
                        onChange={e => setFormData({...formData, ha: e.target.checked})}
                      />
                      <span style={{ fontWeight: 'bold', color: '#475569', fontSize: '0.9em' }}>Enable High Availability (ETCD-DNS)</span>
                    </label>
                    {formData.ha && (
                      <div style={{ marginTop: '10px', marginLeft: '25px' }}>
                        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px', fontSize: '0.85em' }}>Allowed Nodes (comma separated ID's, empty = any)</label>
                        <input 
                          type="text" 
                          placeholder="e.g. node-1,node-2" 
                          value={formData.ha_allowed_nodes.join(',')} 
                          onChange={e => setFormData({...formData, ha_allowed_nodes: e.target.value.split(',').map(s => s.trim()).filter(Boolean)})} 
                          style={{ width: '100%', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '4px' }} 
                        />
                      </div>
                    )}
                  </div>
                  
                </div>
              </details>

              <button type="submit" disabled={loading} style={{ padding: '15px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1em', marginTop: '10px' }}>
                {loading ? 'Saving (might be pulling image)...' : (initialData ? 'Save Changes' : 'Create Container')}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
