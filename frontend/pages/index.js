import React, { useEffect, useState, useRef } from 'react';
import ContainerRow from '../components/ContainerRow';
import CreateGroup from '../components/CreateGroup';
import NodesTab from '../components/NodesTab';
import SecretsTab from '../components/SecretsTab';
import TasksTab from '../components/TasksTab';
import SettingsTab from '../components/SettingsTab';
import AppLayout from '../components/AppLayout';
import UnsealView from '../components/UnsealView';
import CreateContainer from '../components/CreateContainer';

export default function Home() {
  const [activeTab, setActiveTab] = useState('containers');
  const [containers, setContainers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({});
  const [events, setEvents] = useState([]);
  const [expandedContainer, setExpandedContainer] = useState(null);
  const [editingContainer, setEditingContainer] = useState(null);
  const eventScrollRef = useRef(null);

  const refreshData = async () => {
    try {
      const [containersRes, groupsRes, infoRes, statusRes] = await Promise.all([
        fetch('/api/containers'),
        fetch('/api/groups'),
        fetch('/api/info'),
        fetch('/api/system/status')
      ]);
      
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setStatus(statusData);
        if (!statusData.unsealed || !statusData.authenticated) return;
      }

      if (containersRes.ok) setContainers(await containersRes.json());
      if (groupsRes.ok) setGroups(await groupsRes.json());
      if (infoRes.ok) setInfo(await infoRes.json());
    } catch (err) {
      console.error('Refresh error:', err);
    }
  };

  useEffect(() => {
    refreshData().finally(() => setLoading(false));

    const eventSource = new EventSource('/api/events');
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'docker-event') {
          setEvents(prev => [...prev, { 
            id: Date.now() + Math.random(), 
            time: new Date().toLocaleTimeString(), 
            ...data 
          }].slice(-20));
          refreshData();
        } else if (data.type === 'container-stats') {
          setStats(prev => ({ ...prev, [data.id]: data }));
        }
      } catch (e) {}
    };
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, []);

  useEffect(() => {
    if (eventScrollRef.current) {
      eventScrollRef.current.scrollTop = 0;
    }
  }, [events]);

  const handleUnseal = async (password) => {
    const endpoint = status.initialized ? '/api/system/unseal' : '/api/system/setup';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (res.ok) {
        refreshData();
      } else {
        const err = await res.json();
        alert(err.error);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  const handleEdit = (container) => {
    setEditingContainer({
      dockerId: container.Id,
      ...container.persistedConfig
    });
  };

  const handlePersist = async (container) => {
    try {
      const res = await fetch(`/api/containers/${container.Id}/persist`, { method: 'POST' });
      if (res.ok) {
        alert('Container successfully migrated to CoreDocker.');
        refreshData();
      } else {
        const err = await res.json();
        alert('Failed to migrate: ' + err.error);
      }
    } catch (e) {
      alert('Failed to migrate: ' + e.message);
    }
  };

  const handleDelete = async (container) => {
    if (!window.confirm(`Are you sure you want to completely delete ${container.Names[0]}?`)) return;
    try {
      const res = await fetch(`/api/containers/${container.Id}`, { method: 'DELETE' });
      if (res.ok) {
        alert('Container deleted.');
        refreshData();
      } else {
        const err = await res.json();
        alert('Failed to delete: ' + err.error);
      }
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  if (loading) return <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>Loading...</div>;
  
  if (status && (!status.unsealed || !status.authenticated)) {
    return <UnsealView status={status} onUnseal={handleUnseal} />;
  }

  return (
    <AppLayout 
      activeTab={activeTab} 
      setActiveTab={setActiveTab} 
      info={info} 
      onRefresh={refreshData}
    >
      {activeTab === 'containers' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '20px', marginBottom: '40px' }}>
            <section style={{ padding: '15px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <h2 style={{ marginTop: 0, fontSize: '1.2em', display: 'flex', justifyContent: 'space-between' }}>
                Live Events 
                <span style={{ fontSize: '0.6em', color: '#94a3b8', fontWeight: 'normal' }}>Showing last 20 events</span>
              </h2>
              <div 
                ref={eventScrollRef}
                style={{ maxHeight: '250px', overflowY: 'auto', fontSize: '0.85em', background: '#fff', padding: '10px', borderRadius: '4px', border: '1px solid #f1f5f9' }}
              >
                {events.length === 0 ? <p style={{ color: '#94a3b8', margin: 0 }}>Waiting for events...</p> : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column-reverse' }}>
                    {events.map(e => (
                      <li key={e.id} style={{ padding: '6px 0', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8', fontFamily: 'monospace', width: '100px' }}>[{e.time}]</span> 
                        <span style={{ 
                          display: 'inline-block', width: '80px', fontWeight: 'bold', textTransform: 'uppercase', 
                          color: ['die', 'kill', 'stop'].includes(e.action) ? '#ef4444' : '#10b981'
                        }}>
                          {e.action}
                        </span> 
                        <span style={{ color: '#1e293b' }}>{e.name}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '20px' }}>
            <CreateContainer onCreated={refreshData} />
            <CreateGroup onCreated={refreshData} />
          </div>

          {[...groups, { id: 'ungrouped', name: 'Ungrouped' }].map(group => {
            const groupContainers = containers.filter(c => {
              if (c.Names[0].startsWith('/core-docker-')) return false;
              if (group.id === 'ungrouped') return !c.persistedConfig?.group || !groups.find(g => g.name === c.persistedConfig.group);
              return c.persistedConfig?.group === group.name;
            });

            if (groupContainers.length === 0 && group.id === 'ungrouped') return null;

            return (
              <section key={group.id} style={{ marginBottom: '40px', background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                <div style={{ padding: '15px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0, fontSize: '1.2em', color: '#1e293b' }}>{group.name}</h3>
                  <span style={{ fontSize: '0.85em', color: '#64748b' }}>{groupContainers.length} Container(s)</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', color: '#64748b', fontSize: '0.85em', background: '#fcfcfc' }}>
                      <th style={{ padding: '10px 20px' }}>Name</th>
                      <th style={{ padding: '10px 20px' }}>Image</th>
                      <th style={{ padding: '10px 20px' }}>State</th>
                      <th style={{ padding: '10px 20px' }}>Node</th>
                      <th style={{ padding: '10px 20px' }}>CPU %</th>
                      <th style={{ padding: '10px 20px' }}>Memory</th>
                      <th style={{ padding: '10px 20px' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupContainers.map(c => (
                      <ContainerRow
                        key={c.Id} container={c} stats={stats[c.Id]}
                        isExpanded={expandedContainer === c.Id}
                        onToggle={() => setExpandedContainer(expandedContainer === c.Id ? null : c.Id)}
                        onEdit={handleEdit}
                        onPersist={handlePersist}
                        onDelete={handleDelete}
                      />
                    ))}
                    {groupContainers.length === 0 && (
                      <tr>
                        <td colSpan="7" style={{ padding: '30px', textAlign: 'center', color: '#94a3b8', fontSize: '0.9em' }}>
                          No containers in this group.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            );
          })}

          {editingContainer && (
            <CreateContainer 
              isOpenMode={true} 
              initialData={editingContainer} 
              onCreated={() => { setEditingContainer(null); refreshData(); }} 
              onClose={() => setEditingContainer(null)} 
            />
          )}
        </>
      )}
      
      {activeTab === 'nodes' && <NodesTab />}
      {activeTab === 'secrets' && <SecretsTab />}
      {activeTab === 'tasks' && <TasksTab />}
      {activeTab === 'settings' && <SettingsTab systemContainers={containers.filter(c => c.Names[0].startsWith('/core-docker-'))} stats={stats} />}
    </AppLayout>
  );
}
