import React, { useState, useEffect } from 'react';

export default function CreateContainer({ onCreated }) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [existingContainers, setExistingContainers] = useState([]);
  
  const [formData, setFormData] = useState({
    name: '',
    image: '',
    restartPolicy: 'unless-stopped',
    env: [{ key: '', value: '' }],
    volumes: [{ host: '', container: '' }],
    ports: [{ host: '', container: '', ip: '0.0.0.0' }],
    resources: { cpu: '', memory: '' },
    proxy: { enabled: false, uri: '', port: '', domain: '', sslCert: '', sslKey: '' },
    networkContainers: []
  });

  useEffect(() => {
    if (isOpen) {
      fetch('/api/proxy/containers')
        .then(res => res.json())
        .then(data => setExistingContainers(data))
        .catch(console.error);
    }
  }, [isOpen]);

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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    // Clean up empty fields
    const payload = {
      ...formData,
      env: formData.env.filter(e => e.key && e.value),
      volumes: formData.volumes.filter(v => v.host && v.container),
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
      const res = await fetch('/api/proxy/containers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setIsOpen(false);
        if (onCreated) onCreated();
      } else {
        const error = await res.json();
        alert('Error: ' + JSON.stringify(error));
      }
    } catch (err) {
      alert('Error creating container: ' + err.message);
    }
    setLoading(false);
  };

  return (
    <>
      <button 
        onClick={() => setIsOpen(true)}
        style={{ padding: '10px 20px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
      >
        + Create Container
      </button>

      {isOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000 }}>
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '600px', background: 'white', overflowY: 'auto', padding: '20px', boxShadow: '-5px 0 15px rgba(0,0,0,0.1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Create Container</h2>
              <button onClick={() => setIsOpen(false)} style={{ background: 'none', border: 'none', fontSize: '1.5em', cursor: 'pointer' }}>&times;</button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Name</label>
                <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} style={{ width: '100%', padding: '8px' }} placeholder="my-app" />
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
                    <div key={i} style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                      <input type="text" placeholder="Key" value={e.key} onChange={ev => handleArrayChange('env', i, 'key', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      <input type="text" placeholder="Value" value={e.value} onChange={ev => handleArrayChange('env', i, 'value', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      <button type="button" onClick={() => removeArrayItem('env', i)}>X</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('env', {key: '', value: ''})}>+ Add Env</button>
                </div>
              </details>

              <details>
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Volumes</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none' }}>
                  {formData.volumes.map((v, i) => (
                    <div key={i} style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                      <input type="text" placeholder="Host path" value={v.host} onChange={ev => handleArrayChange('volumes', i, 'host', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      <input type="text" placeholder="Container path" value={v.container} onChange={ev => handleArrayChange('volumes', i, 'container', ev.target.value)} style={{ flex: 1, padding: '8px' }} />
                      <button type="button" onClick={() => removeArrayItem('volumes', i)}>X</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addArrayItem('volumes', {host: '', container: ''})}>+ Add Volume</button>
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
                <summary style={{ fontWeight: 'bold', cursor: 'pointer', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>Network Grouping (Private Network)</summary>
                <div style={{ padding: '15px', border: '1px solid #f1f5f9', borderTop: 'none' }}>
                  <p style={{ margin: '0 0 10px 0', fontSize: '0.9em', color: '#64748b' }}>Select other containers to link them securely with this container in an isolated network.</p>
                  <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '10px' }}>
                    {existingContainers.length === 0 ? <p style={{ margin: 0, fontSize: '0.9em' }}>No other containers found.</p> : existingContainers.map(c => {
                      const cName = c.Names[0].replace(/^\//, '');
                      // Skip self or proxy
                      if (cName === 'core-proxy') return null;
                      return (
                        <label key={c.Id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '0.9em' }}>
                          <input 
                            type="checkbox" 
                            checked={formData.networkContainers.includes(c.Id)}
                            onChange={(e) => {
                              const newSelection = e.target.checked 
                                ? [...formData.networkContainers, c.Id] 
                                : formData.networkContainers.filter(id => id !== c.Id);
                              setFormData({...formData, networkContainers: newSelection});
                            }}
                          />
                          {cName} ({c.Image})
                        </label>
                      );
                    })}
                  </div>
                </div>
              </details>

              <button type="submit" disabled={loading} style={{ padding: '15px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1em', marginTop: '10px' }}>
                {loading ? 'Creating (might be pulling image)...' : 'Create Container'}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
