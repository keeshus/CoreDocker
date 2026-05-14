import React from 'react';
import ContainerLogs from './ContainerLogs';
import { calculateCPU, calculateMemory, getExitCodeDescription } from '../lib/domain-logic';

export default function ContainerRow({ container, stats, isExpanded, onToggle, onEdit, onPersist, onDelete, isSystem = false }) {
  return (
    <>
      <tr 
        onClick={onToggle}
        style={{ 
          borderBottom: '1px solid #f1f5f9', cursor: 'pointer',
          background: isExpanded ? '#f8fafc' : 'transparent',
          opacity: container.State === 'running' ? 1 : 0.8
        }}
      >
        <td style={{ padding: '12px 10px', fontWeight: '500' }}>
          {isExpanded ? '▼ ' : '▶ '} {container.Names[0].replace('/', '')}
          {container.isPersisted && (
            <span style={{
              marginLeft: '8px', padding: '2px 6px', borderRadius: '4px', 
              fontSize: '0.75em', background: '#e0e7ff', color: '#3730a3',
              fontWeight: 'bold', verticalAlign: 'middle'
            }} title="Managed by Core Docker (Persisted)">
              DB
            </span>
          )}
        </td>
        <td style={{ padding: '12px 10px', fontSize: '0.85em', color: '#64748b' }}>{container.Image}</td>
        <td style={{ padding: '12px 10px' }}>
          <span style={{ 
            padding: '2px 8px', borderRadius: '12px', fontSize: '0.85em', fontWeight: '600',
            background: container.State === 'running' ? '#dcfce7' : '#fee2e2',
            color: container.State === 'running' ? '#166534' : '#991b1b'
          }}>
            {container.State}
          </span>
        </td>
        <td style={{ padding: '12px 10px', fontSize: '0.85em', color: '#64748b' }}>
          {container.current_node || 'master'}
        </td>
        <td style={{ padding: '12px 10px', fontFamily: 'monospace' }}>
          {container.State === 'running' ? calculateCPU(stats?.cpu) : '-'}
        </td>
        <td style={{ padding: '12px 10px', fontSize: '0.9em', fontFamily: 'monospace' }}>
          {container.State === 'running' ? calculateMemory(stats?.memory) : '-'}
        </td>
        <td style={{ padding: '12px 10px', color: '#64748b' }}>{container.Status}</td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan="7" style={{ padding: '15px', background: '#f8fafc' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h4 style={{ margin: 0 }}>Details</h4>
                  {!isSystem && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {container.isPersisted ? (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); onEdit(container); }}
                            style={{ padding: '4px 8px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); onDelete(container); }}
                            style={{ padding: '4px 8px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}
                          >
                            Delete
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); onPersist(container); }}
                          style={{ padding: '4px 8px', background: '#8b5cf6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}
                        >
                          Migrate to CoreDocker
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {(container.StateDetails?.Error || container.StateDetails?.Status === 'exited') && (
                  <div style={{ 
                    padding: '10px', background: '#fef2f2', border: '1px solid #fee2e2', 
                    borderRadius: '4px', marginBottom: '15px', color: '#991b1b', fontSize: '0.9em'
                  }}>
                    <strong>Status:</strong> {container.StateDetails?.Status}<br/>
                    {container.StateDetails?.Error && <><strong>Error:</strong> {container.StateDetails.Error}<br/></>}
                    <strong>Exit Code:</strong> {container.StateDetails?.ExitCode}
                  </div>
                )}
                <p style={{ fontSize: '0.9em' }}><strong>ID:</strong> {container.Id.substring(0, 12)}</p>
                <p style={{ fontSize: '0.9em' }}><strong>Created:</strong> {new Date(container.Created * 1000).toLocaleString()}</p>
                <div style={{ fontSize: '0.9em', marginTop: '10px', padding: '10px', background: '#f1f5f9', borderRadius: '4px' }}>
                  <strong>Exit Code:</strong> {container.StateDetails?.ExitCode ?? '-'}
                  {container.StateDetails?.ExitCode !== 0 && container.StateDetails?.ExitCode !== undefined && (
                    <div style={{ fontSize: '0.85em', color: '#991b1b', marginTop: '5px' }}>
                      {getExitCodeDescription(container.StateDetails.ExitCode) || 'ℹ Non-zero exit code: check logs for details.'}
                    </div>
                  )}
                </div>
                <h4 style={{ margin: '15px 0 10px 0' }}>Network</h4>
                {container.NetworkSettings.Networks && Object.keys(container.NetworkSettings.Networks).map(net => (
                  <p key={net} style={{ fontSize: '0.9em' }}>
                    <strong>{net}:</strong> {container.NetworkSettings.Networks[net].IPAddress || 'no-ip'}
                  </p>
                ))}
              </div>
              <div>
                <h4 style={{ margin: '0 0 10px 0' }}>Live Logs</h4>
                <ContainerLogs containerId={container.Id} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
