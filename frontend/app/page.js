'use client';

import React, { useEffect, useState, useRef } from 'react';
import ContainerRow from '../components/ContainerRow';
import CreateGroup from '../components/CreateGroup';
import SecretsTab from '../components/SecretsTab';
import TasksTab from '../components/TasksTab';
import ClusterSettings from '../components/ClusterSettings';
import NodeSettings from '../components/NodeSettings';
import AppLayout from '../components/AppLayout';
import UnsealView from '../components/UnsealView';
import SetupView from '../components/SetupView';
import CreateContainer from '../components/CreateContainer';
import { UIProvider, useUI } from '../lib/UIProvider';
import { ThemeProvider } from '../lib/ThemeProvider';

function HomeInner() {
  const { showToast, showConfirm } = useUI();
  const [booting, setBooting] = useState(true);
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
  const [editingGroup, setEditingGroup] = useState(null);
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
        if (statusData.sealed || !statusData.authenticated) return;
      }

      if (containersRes.ok) setContainers(await containersRes.json());
      if (groupsRes.ok) setGroups(await groupsRes.json());
      if (infoRes.ok) setInfo(await infoRes.json());
    } catch (err) {
      console.error('Refresh error:', err);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async function pollReady() {
      while (!cancelled) {
        try {
          const res = await fetch('/api/health/ready');
          if (res.ok) { setBooting(false); return; }
        } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    refreshData().finally(() => setLoading(false));

    const sessionRefreshInterval = setInterval(async () => {
      try {
        await fetch('/api/system/session/refresh', { method: 'POST' });
      } catch (e) {
        console.error('Session refresh failed:', e);
      }
    }, 4 * 60 * 60 * 1000);

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
    return () => {
      eventSource.close();
      clearInterval(sessionRefreshInterval);
    };
  }, []);

  useEffect(() => {
    if (eventScrollRef.current) {
      eventScrollRef.current.scrollTop = 0;
    }
  }, [events]);

  const handleUnseal = async (payload) => {
    const endpoint = status.initialized ? '/api/system/unseal' : '/api/system/setup';
    try {
      let body;
      let headers = {};
      if (payload instanceof HTMLFormElement || payload?.snapshotFile) {
        const formData = new FormData();
        if (payload.mode) formData.append('mode', payload.mode);
        if (payload.password) formData.append('password', payload.password);
        if (payload.primaryIp) formData.append('primaryIp', payload.primaryIp);
        if (payload.joinToken) formData.append('joinToken', payload.joinToken);
        if (payload.snapshotFile) formData.append('snapshotFile', payload.snapshotFile);
        body = formData;
      } else if (typeof payload === 'string') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ password: payload });
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(payload);
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body
      });
      if (res.ok) {
        refreshData();
      } else {
        const err = await res.json();
        showToast(err.error, 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
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
        showToast('Container migrated to CoreDocker.', 'success');
        refreshData();
      } else {
        const err = await res.json();
        showToast('Failed to migrate: ' + err.error, 'error');
      }
    } catch (e) {
      showToast('Failed to migrate: ' + e.message, 'error');
    }
  };

  const handleDelete = async (container) => {
    const confirmed = await showConfirm(`Delete container "${container.Names[0]}"? This action cannot be undone.`);
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/containers/${container.Id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Container deleted.', 'success');
        refreshData();
      } else {
        const err = await res.json();
        showToast('Failed to delete: ' + err.error, 'error');
      }
    } catch (e) {
      showToast('Failed to delete: ' + e.message, 'error');
    }
  };

  const handleEditGroup = (group) => {
    setEditingGroup(group);
  };

  const handleDeleteGroup = async (group) => {
    const confirmed = await showConfirm(`Delete group "${group.name}"? Containers in this group will not be removed.`);
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/groups/${group.id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Group deleted.', 'success');
        refreshData();
      } else {
        const err = await res.json();
        showToast('Failed to delete group: ' + err.error, 'error');
      }
    } catch (e) {
      showToast('Failed to delete group: ' + e.message, 'error');
    }
  };

  if (booting) return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100vh', fontFamily: 'var(--md-font)', color: 'var(--md-on-surface-variant)', gap: '24px',
      background: 'var(--md-background)',
    }}>
      <div style={{
        width: '48px', height: '48px',
        border: '4px solid var(--md-outline-variant)',
        borderTopColor: 'var(--md-primary)',
        borderRadius: '50%',
        animation: 'spin 1s linear infinite'
      }} />
      <div style={{
        fontSize: '1.25rem', fontWeight: 600, color: 'var(--md-on-surface)',
        letterSpacing: '-0.01em'
      }}>
        CoreDocker is starting up...
      </div>
      <div style={{ fontSize: '0.9rem', color: 'var(--md-on-surface-variant)' }}>
        Please wait while services initialize.
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (loading) return (
    <div style={{
      padding: '20px', fontFamily: 'var(--md-font)',
      color: 'var(--md-on-surface-variant)', background: 'var(--md-background)',
    }}>
      Loading...
    </div>
  );

  if (status && (status.sealed || !status.authenticated)) {
    if (!status.initialized) {
      return <SetupView onSetup={handleUnseal} />;
    }
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
            <section style={{
              padding: '16px', background: 'var(--md-surface-container)',
              borderRadius: 'var(--md-radius-lg)', border: '1px solid var(--md-outline-variant)',
            }}>
              <h2 style={{
                marginTop: 0, fontSize: '1.1rem', fontWeight: 600, color: 'var(--md-on-surface)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                Live Events
                <span style={{ fontSize: '0.75rem', color: 'var(--md-on-surface-variant)', fontWeight: 400 }}>
                  Showing last 20 events
                </span>
              </h2>
              <div
                ref={eventScrollRef}
                style={{
                  maxHeight: '250px', overflowY: 'auto', fontSize: '0.85rem',
                  background: 'var(--md-surface)', padding: '12px',
                  borderRadius: 'var(--md-radius-md)', border: '1px solid var(--md-outline-variant)',
                }}
              >
                {events.length === 0 ? (
                  <p style={{ color: 'var(--md-on-surface-variant)', margin: 0 }}>Waiting for events...</p>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column-reverse' }}>
                    {events.map(e => (
                      <li key={e.id} style={{
                        padding: '6px 0', borderBottom: '1px solid var(--md-outline-variant)',
                        display: 'flex', alignItems: 'center', gap: '12px',
                      }}>
                        <span style={{
                          color: 'var(--md-on-surface-variant)', fontFamily: 'var(--md-font-mono)',
                          fontSize: '0.8rem', width: '100px', flexShrink: 0,
                        }}>
                          [{e.time}]
                        </span>
                        <span style={{
                          display: 'inline-block', width: '80px', fontWeight: 600,
                          textTransform: 'uppercase', fontSize: '0.8rem',
                          color: ['die', 'kill', 'stop'].includes(e.action)
                            ? 'var(--md-status-failed)' : 'var(--md-status-success)',
                        }}>
                          {e.action}
                        </span>
                        <span style={{ color: 'var(--md-on-surface)' }}>{e.name}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '20px', gap: '10px' }}>
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
              <section key={group.id} style={{
                marginBottom: '40px',
                background: 'var(--md-surface-container)',
                borderRadius: 'var(--md-radius-lg)',
                border: '1px solid var(--md-outline-variant)',
                overflow: 'hidden',
              }}>
                <div style={{
                  padding: '16px 20px',
                  background: 'var(--md-surface)',
                  borderBottom: '1px solid var(--md-outline-variant)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <h3 style={{
                    margin: 0, fontSize: '1.1rem', fontWeight: 600,
                    color: 'var(--md-on-surface)',
                  }}>
                    {group.name}
                  </h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--md-on-surface-variant)' }}>
                      {groupContainers.length} Container(s)
                    </span>
                    {group.id !== 'ungrouped' && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEditGroup(group); }}
                          style={{
                            padding: '6px 16px', background: 'var(--md-primary)',
                            color: 'var(--md-on-primary)', border: 'none',
                            borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                            fontSize: '0.8rem', fontWeight: 600,
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group); }}
                          style={{
                            padding: '6px 16px', background: 'var(--md-error)',
                            color: 'var(--md-on-error)', border: 'none',
                            borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                            fontSize: '0.8rem', fontWeight: 600,
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{
                      textAlign: 'left',
                      borderBottom: '1px solid var(--md-outline-variant)',
                      color: 'var(--md-on-surface-variant)',
                      fontSize: '0.8rem', fontWeight: 600,
                      background: 'var(--md-surface-container)',
                    }}>
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
                        <td colSpan="7" style={{
                          padding: '30px', textAlign: 'center',
                          color: 'var(--md-on-surface-variant)', fontSize: '0.9rem',
                        }}>
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
          {editingGroup && (
            <CreateGroup
              isOpenMode={true}
              initialData={editingGroup}
              onCreated={() => { setEditingGroup(null); refreshData(); }}
              onClose={() => setEditingGroup(null)}
            />
          )}
        </>
      )}

      {activeTab === 'secrets' && <SecretsTab />}
      {activeTab === 'tasks' && <TasksTab />}
      {activeTab === 'cluster-settings' && <ClusterSettings />}
      {activeTab === 'node-settings' && <NodeSettings systemContainers={containers.filter(c => c.Names[0].startsWith('/core-docker-'))} stats={stats} />}
    </AppLayout>
  );
}

export default function Home() {
  return (
    <ThemeProvider>
      <UIProvider>
        <HomeInner />
      </UIProvider>
    </ThemeProvider>
  );
}
