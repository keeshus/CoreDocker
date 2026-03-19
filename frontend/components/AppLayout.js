import React from 'react';
import CreateContainer from './CreateContainer';

export default function AppLayout({ children, activeTab, setActiveTab, info, onRefresh }) {
  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '1400px', margin: '0 auto' }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginBottom: '30px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0 }}>Docker Manager</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            {info && (
              <div style={{ 
                display: 'flex', gap: '20px', fontSize: '0.85em', background: '#f8fafc', 
                padding: '8px 15px', borderRadius: '20px', border: '1px solid #e2e8f0', color: '#64748b' 
              }}>
                <span><strong>OS:</strong> {info.OperatingSystem}</span>
                <span><strong>Kernel:</strong> {info.KernelVersion}</span>
                <span><strong>Containers:</strong> {info.Containers} (Run: {info.ContainersRunning})</span>
                <span><strong>CPUs:</strong> {info.NCPU}</span>
              </div>
            )}
            <CreateContainer onCreated={onRefresh} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px', borderBottom: '1px solid #e2e8f0', paddingBottom: '10px' }}>
          {['containers', 'nodes', 'secrets', 'tasks', 'settings'].map(tab => (
            <button 
              key={tab}
              onClick={() => setActiveTab(tab)} 
              style={{ 
                background: activeTab === tab ? '#3b82f6' : '#f1f5f9', 
                color: activeTab === tab ? '#fff' : '#475569', 
                border: 'none', padding: '8px 16px', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold',
                textTransform: 'capitalize'
              }}
            >
              {tab === 'nodes' ? 'Cluster Nodes' : tab === 'tasks' ? 'Scheduler & Tasks' : tab}
            </button>
          ))}
        </div>
      </header>
      <main>
        {children}
      </main>
    </div>
  );
}
