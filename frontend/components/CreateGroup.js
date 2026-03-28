import React, { useState, useEffect } from 'react';

export default function CreateGroup({ onCreated, initialData = null, onClose = null, isOpenMode = false }) {
  const [isOpen, setIsOpen] = useState(isOpenMode);
  const [loading, setLoading] = useState(false);
  
  const defaultFormData = {
    name: '',
    config: {
      highAvailability: false,
      targetNodes: []
    }
  };

  const [formData, setFormData] = useState(defaultFormData);
  const [nodes, setNodes] = useState([]);

  useEffect(() => {
    fetch('/api/nodes')
      .then(res => res.json())
      .then(data => setNodes(data || []))
      .catch(err => console.error('Failed to fetch nodes:', err));
  }, []);

  useEffect(() => {
    if (initialData) {
      setFormData({
        name: initialData.name || '',
        config: initialData.config || {}
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

  const handleClose = () => {
    setIsOpen(false);
    if (onClose) onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      const url = initialData ? `/api/groups/${initialData.id}` : '/api/groups';
      const method = initialData ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      
      if (res.ok) {
        handleClose();
        if (onCreated) onCreated();
      } else {
        const error = await res.json();
        alert('Error: ' + JSON.stringify(error));
      }
    } catch (err) {
      alert('Error saving group: ' + err.message);
    }
    setLoading(false);
  };

  return (
    <>
      {!initialData && !isOpenMode && (
        <button 
          onClick={() => setIsOpen(true)}
          style={{ padding: '10px 20px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', marginLeft: '10px' }}
        >
          + Create Group
        </button>
      )}

      {isOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000 }}>
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '400px', background: 'white', overflowY: 'auto', padding: '20px', boxShadow: '-5px 0 15px rgba(0,0,0,0.1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>{initialData ? 'Edit Group' : 'Create Group'}</h2>
              <button onClick={handleClose} style={{ background: 'none', border: 'none', fontSize: '1.5em', cursor: 'pointer' }}>&times;</button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Group Name</label>
                <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} style={{ width: '100%', padding: '8px' }} placeholder="web-stack" />
              </div>

              <div style={{ padding: '10px', background: '#f8fafc', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <label style={{ display: 'flex', alignItems: 'center', fontWeight: 'bold', cursor: 'pointer' }}>
                  <input type="checkbox" checked={formData.config.highAvailability} onChange={e => setFormData({...formData, config: {...formData.config, highAvailability: e.target.checked}})} style={{ marginRight: '10px' }} />
                  Enable High Availability for Group
                </label>
                <p style={{ margin: '5px 0 10px 25px', fontSize: '0.85em', color: '#64748b' }}>
                  Overrides individual container HA settings.
                </p>
                
                {formData.config.highAvailability && (
                  <div style={{ marginLeft: '25px', marginTop: '10px' }}>
                    <label style={{ display: 'block', fontSize: '0.9em', fontWeight: 'bold', marginBottom: '5px' }}>Target Nodes (Optional)</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '150px', overflowY: 'auto', padding: '5px', border: '1px solid #cbd5e1', borderRadius: '4px', background: 'white' }}>
                      {nodes.map(node => (
                        <label key={node.id} style={{ display: 'flex', alignItems: 'center', fontSize: '0.9em', cursor: 'pointer' }}>
                          <input 
                            type="checkbox" 
                            checked={formData.config.targetNodes?.includes(node.id)} 
                            onChange={e => {
                              const nodes = formData.config.targetNodes || [];
                              const newNodes = e.target.checked ? [...nodes, node.id] : nodes.filter(id => id !== node.id);
                              setFormData({...formData, config: {...formData.config, targetNodes: newNodes}});
                            }} 
                            style={{ marginRight: '8px' }} 
                          />
                          {node.name} ({node.ip})
                        </label>
                      ))}
                      {nodes.length === 0 && <span style={{ color: '#94a3b8', fontSize: '0.8em' }}>No other nodes found</span>}
                    </div>
                  </div>
                )}
              </div>

              <button type="submit" disabled={loading} style={{ padding: '15px', background: '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1em', marginTop: '10px' }}>
                {loading ? 'Saving...' : (initialData ? 'Save Changes' : 'Create Group')}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
