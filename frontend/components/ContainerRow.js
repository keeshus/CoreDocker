import React from 'react';
import ContainerLogs from './ContainerLogs';
import { calculateCPU, calculateMemory, getExitCodeDescription } from '../lib/domain-logic';

export default function ContainerRow({ container, stats, isExpanded, onToggle, onEdit, onPersist, onDelete, isSystem = false }) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          borderBottom: '1px solid var(--md-outline-variant)', cursor: 'pointer',
          background: isExpanded ? 'var(--md-surface-container)' : 'transparent',
          opacity: container.State === 'running' ? 1 : 0.7,
          transition: 'background var(--md-transition)',
        }}
      >
        <td style={{ padding: '12px 20px', fontWeight: 500, color: 'var(--md-on-surface)' }}>
          {isExpanded ? '▼ ' : '▶ '} {container.Names[0].replace('/', '')}
          {container.isPersisted && (
            <span style={{
              marginLeft: '8px', padding: '2px 8px', borderRadius: 'var(--md-radius-sm)',
              fontSize: '0.7rem', background: 'var(--md-primary-container)',
              color: 'var(--md-on-primary-container)',
              fontWeight: 700, verticalAlign: 'middle',
            }} title="Managed by Core Docker (Persisted)">
              DB
            </span>
          )}
        </td>
        <td style={{ padding: '12px 20px', fontSize: '0.85rem', color: 'var(--md-on-surface-variant)', fontFamily: 'var(--md-font-mono)' }}>
          {container.Image}
        </td>
        <td style={{ padding: '12px 20px' }}>
          <span style={{
            padding: '2px 10px', borderRadius: 'var(--md-radius-full)', fontSize: '0.8rem', fontWeight: 600,
            background: container.State === 'running' ? 'var(--md-success-container)' : 'var(--md-error-container)',
            color: container.State === 'running' ? 'var(--md-on-success-container)' : 'var(--md-on-error-container)',
          }}>
            {container.State}
          </span>
        </td>
        <td style={{ padding: '12px 20px', fontFamily: 'var(--md-font-mono)', fontSize: '0.8rem', color: 'var(--md-on-surface-variant)' }}>
          {container.Id.substring(0, 12)}
        </td>
        <td style={{ padding: '12px 20px', fontFamily: 'var(--md-font-mono)', fontSize: '0.85rem', color: 'var(--md-on-surface)' }}>
          {container.State === 'running' ? calculateCPU(stats?.cpu) : '-'}
        </td>
        <td style={{ padding: '12px 20px', fontSize: '0.9rem', fontFamily: 'var(--md-font-mono)', color: 'var(--md-on-surface)' }}>
          {container.State === 'running' ? calculateMemory(stats?.memory) : '-'}
        </td>
        <td style={{ padding: '12px 20px', color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>
          {container.Status}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan="7" style={{ padding: '16px', background: 'var(--md-surface-container)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h4 style={{ margin: 0, color: 'var(--md-on-surface)' }}>Details</h4>
                  {!isSystem && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {container.isPersisted ? (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); onEdit(container); }}
                            style={{
                              padding: '6px 14px', background: 'var(--md-primary)',
                              color: 'var(--md-on-primary)', border: 'none',
                              borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                              fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--md-font)',
                            }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); onDelete(container); }}
                            style={{
                              padding: '6px 14px', background: 'var(--md-error)',
                              color: 'var(--md-on-error)', border: 'none',
                              borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                              fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--md-font)',
                            }}
                          >
                            Delete
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); onPersist(container); }}
                          style={{
                            padding: '6px 14px', background: 'var(--md-tertiary)',
                            color: 'var(--md-on-tertiary)', border: 'none',
                            borderRadius: 'var(--md-radius-full)', cursor: 'pointer',
                            fontSize: '0.8rem', fontWeight: 600, fontFamily: 'var(--md-font)',
                          }}
                        >
                          Migrate to CoreDocker
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {(container.StateDetails?.Error || container.StateDetails?.Status === 'exited') && (
                  <div style={{
                    padding: '10px', background: 'var(--md-error-container)',
                    border: '1px solid var(--md-error)', borderRadius: 'var(--md-radius-md)',
                    marginBottom: '15px', color: 'var(--md-on-error-container)', fontSize: '0.9rem',
                  }}>
                    <strong>Status:</strong> {container.StateDetails?.Status}<br/>
                    {container.StateDetails?.Error && <><strong>Error:</strong> {container.StateDetails.Error}<br/></>}
                    <strong>Exit Code:</strong> {container.StateDetails?.ExitCode}
                  </div>
                )}
                <p style={{ fontSize: '0.9rem', color: 'var(--md-on-surface)' }}>
                  <strong>ID:</strong> <span style={{ fontFamily: 'var(--md-font-mono)' }}>{container.Id.substring(0, 12)}</span>
                </p>
                <p style={{ fontSize: '0.9rem', color: 'var(--md-on-surface)' }}>
                  <strong>Created:</strong> {new Date(container.Created * 1000).toLocaleString()}
                </p>
                <div style={{
                  fontSize: '0.9rem', marginTop: '10px',
                  padding: '12px', background: 'var(--md-surface-container-high)',
                  borderRadius: 'var(--md-radius-md)', color: 'var(--md-on-surface)',
                }}>
                  <strong>Exit Code:</strong> {container.StateDetails?.ExitCode ?? '-'}
                  {container.StateDetails?.ExitCode !== 0 && container.StateDetails?.ExitCode !== undefined && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--md-on-error-container)', marginTop: '5px' }}>
                      {getExitCodeDescription(container.StateDetails.ExitCode) || 'Non-zero exit code: check logs for details.'}
                    </div>
                  )}
                </div>
                <h4 style={{ margin: '15px 0 10px 0', color: 'var(--md-on-surface)' }}>Network</h4>
                {container.NetworkSettings.Networks && Object.keys(container.NetworkSettings.Networks).map(net => (
                  <p key={net} style={{ fontSize: '0.9rem', color: 'var(--md-on-surface)' }}>
                    <strong>{net}:</strong> {container.NetworkSettings.Networks[net].IPAddress || 'no-ip'}
                  </p>
                ))}
              </div>
              <div>
                <h4 style={{ margin: '0 0 10px 0', color: 'var(--md-on-surface)' }}>Live Logs</h4>
                <ContainerLogs containerId={container.Id} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
