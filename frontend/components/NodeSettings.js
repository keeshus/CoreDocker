import React, { useState, useEffect } from 'react';
import ContainerRow from './ContainerRow';

export default function NodeSettings({ systemContainers = [], stats = {} }) {
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loadingNodes, setLoadingNodes] = useState(true);
  const [expandedContainer, setExpandedContainer] = useState(null);

  useEffect(() => {
    fetch('/api/nodes')
      .then(res => res.json())
      .then(data => {
        setNodes(data);
        if (data.length > 0 && !selectedNodeId) {
          setSelectedNodeId(data[0].id);
        }
        setLoadingNodes(false);
      })
      .catch(e => {
        console.error('Failed to load nodes:', e);
        setLoadingNodes(false);
      });
  }, []);

  if (loadingNodes) return <div>Loading nodes...</div>;

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  
  const filteredSystemContainers = systemContainers.filter(c => {
    if (selectedNode) {
      const containerNode = c.current_node || '';
      const nameMatch = c.Names[0].includes(selectedNode.name);
      // Treat 'master' as the first node in the cluster if it's node-1
      const isMasterNodeMatch = containerNode === 'master' && selectedNode.name === 'node-1';
      
      return containerNode === selectedNode.name || 
             containerNode === selectedNode.id ||
             nameMatch ||
             isMasterNodeMatch;
    }
    return true;
  });

  return (
    <div style={{ background: '#f8fafc', padding: '20px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
      <h2 style={{ marginTop: 0 }}>Node Settings</h2>
      <p style={{ color: '#64748b' }}>Configure settings and monitor system containers for specific nodes.</p>

      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Select Node</label>
        <select 
          value={selectedNodeId} 
          onChange={e => setSelectedNodeId(e.target.value)}
          style={{ width: '100%', maxWidth: '400px', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
        >
          {nodes.map(node => (
            <option key={node.id} value={node.id}>{node.name} ({node.ip})</option>
          ))}
        </select>
      </div>

      {selectedNode && selectedNode.system && (
        <div style={{ padding: '15px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', marginBottom: '20px', maxWidth: '400px' }}>
          <strong>Hardware Resources</strong>
          <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
            <span>CPUs: {selectedNode.system.cpus || 'Unknown'}</span>
            <span>Memory: {selectedNode.system.totalMem ? (selectedNode.system.totalMem / 1024 / 1024 / 1024).toFixed(2) + ' GB' : 'Unknown'}</span>
          </div>
        </div>
      )}

      {selectedNodeId ? (
        <>
          <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' }}>
            <h3 style={{ marginTop: 0 }}>System Containers on {selectedNode?.name}</h3>
            <p style={{ color: '#64748b', fontSize: '0.9em' }}>Monitor core application containers running on this node.</p>
            
            {filteredSystemContainers.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '15px', background: 'white', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontSize: '0.9em', background: '#f8fafc' }}>
                    <th style={{ padding: '12px 10px' }}>Name</th>
                    <th style={{ padding: '12px 10px' }}>Image</th>
                    <th style={{ padding: '12px 10px' }}>State</th>
                    <th style={{ padding: '12px 10px' }}>CPU %</th>
                    <th style={{ padding: '12px 10px' }}>Memory</th>
                    <th style={{ padding: '12px 10px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSystemContainers.map(c => (
                    <ContainerRow
                      key={c.Id}
                      container={c}
                      stats={stats[c.Id]}
                      isExpanded={expandedContainer === c.Id}
                      onToggle={() => setExpandedContainer(expandedContainer === c.Id ? null : c.Id)}
                      onEdit={() => {}}
                      onPersist={() => {}}
                      isSystem={true}
                    />
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: '#94a3b8', marginTop: '15px' }}>No system containers found on this node.</p>
            )}
          </div>
        </>
      ) : (
        <p>No node selected or no nodes available.</p>
      )}
    </div>
  );
}
