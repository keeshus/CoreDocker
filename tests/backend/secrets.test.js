import { describe, it, expect, vi, beforeEach } from 'vitest';

const etcdStore = {};

const mockDbDefault = {
  get: vi.fn((key) => ({
    string: () => Promise.resolve(etcdStore[key] || null),
    all: () => {
      const prefix = key;
      const results = [];
      for (const [k, v] of Object.entries(etcdStore)) {
        if (k.startsWith(prefix)) {
          results.push({ key: k, value: v });
        }
      }
      return Promise.resolve(results);
    },
  })),
  put: vi.fn((key) => ({
    value: (val) => {
      etcdStore[key] = val;
      return Promise.resolve();
    },
  })),
  delete: vi.fn(() => ({
    key: (k) => {
      delete etcdStore[k];
      return Promise.resolve();
    },
  })),
  getAll: vi.fn(() => ({
    prefix: (prefix) => ({
      keys: () => {
        const keys = [];
        for (const k of Object.keys(etcdStore)) {
          if (k.startsWith(prefix)) {
            keys.push(k);
          }
        }
        return Promise.resolve(keys);
      },
      strings: () => {
        const results = {};
        for (const [k, v] of Object.entries(etcdStore)) {
          if (k.startsWith(prefix)) {
            results[k] = v;
          }
        }
        return Promise.resolve(results);
      },
    }),
  })),
};

vi.mock('../../backend/services/db.js', () => ({
  etcd: mockDbDefault,
}));

const PASSWORD = 'MyStr0ng!Pass';
const NEW_PASSWORD = 'NewStr0ng!Pass';

beforeEach(() => {
  for (const key of Object.keys(etcdStore)) {
    delete etcdStore[key];
  }
  vi.clearAllMocks();
});

function module() {
  return import('../../backend/services/secrets.js');
}

describe('validatePasswordStrength', () => {
  it('throws for empty password', async () => {
    const { validatePasswordStrength } = await module();
    expect(() => validatePasswordStrength('')).toThrow('Password must be at least 12 characters long');
  });

  it('throws for short password', async () => {
    const { validatePasswordStrength } = await module();
    expect(() => validatePasswordStrength('Short1!')).toThrow('at least 12 characters long');
  });

  it('throws when missing uppercase', async () => {
    const { validatePasswordStrength } = await module();
    expect(() => validatePasswordStrength('lowercase1!only')).toThrow('uppercase');
  });

  it('throws when missing lowercase', async () => {
    const { validatePasswordStrength } = await module();
    expect(() => validatePasswordStrength('UPPERCASE1!ONLY')).toThrow('lowercase');
  });

  it('throws when missing digit', async () => {
    const { validatePasswordStrength } = await module();
    expect(() => validatePasswordStrength('NoDigits!Here')).toThrow('digit');
  });

  it('throws when missing special character', async () => {
    const { validatePasswordStrength } = await module();
    expect(() => validatePasswordStrength('NoSpecialChar1')).toThrow('special character');
  });

  it('passes for a valid password', async () => {
    const { validatePasswordStrength } = await module();
    expect(() => validatePasswordStrength(PASSWORD)).not.toThrow();
  });
});

describe('isSystemInitialized', () => {
  it('returns false when no master key hash exists', async () => {
    const { isSystemInitialized } = await module();
    expect(await isSystemInitialized()).toBe(false);
  });

  it('returns true when master key hash exists', async () => {
    etcdStore['system/master_hash'] = 'salt:hash';
    const { isSystemInitialized } = await module();
    expect(await isSystemInitialized()).toBe(true);
  });
});

describe('node sealed state - runs first before any init', () => {
  it('isNodeSealed returns true for fresh instance', async () => {
    const { isNodeSealed } = await module();
    expect(isNodeSealed()).toBe(true);
  });

  it('getDEK throws when sealed', async () => {
    const { getDEK } = await module();
    expect(() => getDEK()).toThrow('Node is sealed');
  });

  it('changeMasterPassword throws if node is sealed', async () => {
    const { changeMasterPassword } = await module();
    await expect(changeMasterPassword(PASSWORD, NEW_PASSWORD)).rejects.toThrow('must be unsealed');
  });

  it('rotateDEK throws if node is sealed', async () => {
    const { rotateDEK } = await module();
    await expect(rotateDEK(PASSWORD)).rejects.toThrow('must be unsealed');
  });
});

describe('getOrCreateJwtSecret', () => {
  it('creates and stores a JWT secret when none exists', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    const secret = await mod.getOrCreateJwtSecret();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBe(128);
    // Value is stored encrypted in etcd
    expect(etcdStore['system/jwt_secret']).toBeDefined();
    expect(etcdStore['system/jwt_secret']).toContain(':');
  });

  it('returns existing JWT secret from cache on second call', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    const secret1 = await mod.getOrCreateJwtSecret();
    const secret2 = await mod.getOrCreateJwtSecret();
    expect(secret2).toBe(secret1);
  });
});

describe('initializeSystem', () => {
  it('creates proper etcd entries', async () => {
    const { initializeSystem, isNodeSealed } = await module();
    await initializeSystem(PASSWORD);

    expect(etcdStore['system/master_hash']).toBeDefined();
    expect(etcdStore['system/master_hash']).toContain(':');
    expect(etcdStore['system/encrypted_dek']).toBeDefined();
    expect(etcdStore['system/encrypted_dek']).toContain(':');
    expect(etcdStore['system/jwt_secret']).toBeDefined();
    expect(etcdStore['system/jwt_secret']).toContain(':');
    expect(etcdStore['system/backup_path']).toBeDefined();
    expect(etcdStore['system/non_backup_path']).toBeDefined();
    expect(isNodeSealed()).toBe(false);
  });

  it('throws if already initialized', async () => {
    etcdStore['system/master_hash'] = 'exists';
    const { initializeSystem } = await module();
    await expect(initializeSystem(PASSWORD)).rejects.toThrow('already initialized');
  });

  it('throws on weak password', async () => {
    const { initializeSystem } = await module();
    await expect(initializeSystem('weak')).rejects.toThrow('at least 12 characters');
  });
});

describe('encrypt / decrypt roundtrip', () => {
  it('encrypts and decrypts a value', async () => {
    const { initializeSystem, encrypt, decrypt } = await module();
    await initializeSystem(PASSWORD);
    const original = 'sensitive-data-123!@#';
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).toContain(':');
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(original);
  });

  it('produces different ciphertext for same plaintext (random IV)', async () => {
    const { initializeSystem, encrypt } = await module();
    await initializeSystem(PASSWORD);
    const original = 'same-value';
    const e1 = encrypt(original);
    const e2 = encrypt(original);
    expect(e1).not.toBe(e2);
  });
});

describe('unsealNode', () => {
  it('throws if not initialized', async () => {
    const { unsealNode } = await module();
    await expect(unsealNode(PASSWORD)).rejects.toThrow('System not initialized');
  });

  it('throws on wrong password after init', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    await expect(mod.unsealNode('WrongP@ssword1')).rejects.toThrow('Invalid master password');
  });

  it('populates JWT secret cache after unseal', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    expect(mod.getJwtSecret()).toBeTruthy();
    expect(mod.getJwtSecret().length).toBe(128);
  });
});

describe('changeMasterPassword', () => {
  it('throws on weak new password', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    await expect(mod.changeMasterPassword(PASSWORD, 'weak')).rejects.toThrow('at least 12 characters');
  });

  it('throws on wrong current password', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    await expect(mod.changeMasterPassword('WrongP@ssword1', NEW_PASSWORD)).rejects.toThrow('Invalid current master password');
  });

  it('successfully changes password and preserves DEK', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    await mod.changeMasterPassword(PASSWORD, NEW_PASSWORD);

    const testValue = 'test-data-to-verify';
    const encrypted = mod.encrypt(testValue);
    const decrypted = mod.decrypt(encrypted);
    expect(decrypted).toBe(testValue);
  });
});

describe('rotateDEK', () => {
  it('throws on wrong password', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    await expect(mod.rotateDEK('WrongP@ssword1')).rejects.toThrow('Invalid master password');
  });

  it('rotates DEK and re-encrypts existing secrets, containers, and groups', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);

    etcdStore['secrets/mykey'] = mod.encrypt('my-secret-value');
    etcdStore['core/containers/c1'] = mod.encrypt(JSON.stringify({ id: 'c1', name: 'web', image: 'nginx' }));
    etcdStore['core/groups/g1'] = mod.encrypt(JSON.stringify({ id: 'g1', name: 'web-services', config: {} }));

    const secretBefore = etcdStore['secrets/mykey'];
    const containerBefore = etcdStore['core/containers/c1'];
    const groupBefore = etcdStore['core/groups/g1'];

    await mod.rotateDEK(PASSWORD);

    // All entries should have different ciphertext after rotation
    expect(etcdStore['secrets/mykey']).not.toBe(secretBefore);
    expect(etcdStore['core/containers/c1']).not.toBe(containerBefore);
    expect(etcdStore['core/groups/g1']).not.toBe(groupBefore);

    // All entries should still decrypt correctly
    expect(mod.decrypt(etcdStore['secrets/mykey'])).toBe('my-secret-value');
    expect(mod.decrypt(etcdStore['core/containers/c1'])).toBe(JSON.stringify({ id: 'c1', name: 'web', image: 'nginx' }));
    expect(mod.decrypt(etcdStore['core/groups/g1'])).toBe(JSON.stringify({ id: 'g1', name: 'web-services', config: {} }));
  });
});

describe('JWT token operations', () => {
  it('signClusterToken and verifyClusterToken roundtrip', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    const payload = { node: 'test-node', role: 'admin' };
    const token = mod.signClusterToken(payload);
    expect(typeof token).toBe('string');
    const decoded = mod.verifyClusterToken(token);
    expect(decoded.node).toBe('test-node');
    expect(decoded.role).toBe('admin');
  });

  it('generateClusterToken is alias for signClusterToken', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    const token = mod.generateClusterToken({ node: 'alias-test' });
    const decoded = mod.verifyClusterToken(token);
    expect(decoded.node).toBe('alias-test');
  });

  it('verifyClusterToken throws for invalid token', async () => {
    const mod = await module();
    await mod.initializeSystem(PASSWORD);
    expect(() => mod.verifyClusterToken('invalid-token')).toThrow('Invalid cluster token');
  });
});

describe('secret CRUD operations', () => {
  let mod;

  beforeEach(async () => {
    mod = await module();
    await mod.initializeSystem(PASSWORD);
  });

  it('setSecret stores encrypted value', async () => {
    await mod.setSecret('db-password', 'sup3rs3cr3t');
    const stored = etcdStore['secrets/db-password'];
    expect(stored).toBeDefined();
    expect(stored).toContain(':');
    expect(stored).not.toContain('sup3rs3cr3t');
  });

  it('getSecret retrieves decrypted value', async () => {
    await mod.setSecret('api-key', 'sk-123456');
    const value = await mod.getSecret('api-key');
    expect(value).toBe('sk-123456');
  });

  it('getSecret returns null for non-existent key', async () => {
    const value = await mod.getSecret('non-existent');
    expect(value).toBeNull();
  });

  it('deleteSecret removes the key', async () => {
    await mod.setSecret('temp-key', 'temp-value');
    expect(etcdStore['secrets/temp-key']).toBeDefined();
    await mod.deleteSecret('temp-key');
    expect(etcdStore['secrets/temp-key']).toBeUndefined();
  });

  it('getAllSecretKeys returns all secret keys', async () => {
    await mod.setSecret('key1', 'val1');
    await mod.setSecret('key2', 'val2');
    await mod.setSecret('key3', 'val3');
    const keys = await mod.getAllSecretKeys();
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
    expect(keys).toContain('key3');
    expect(keys.length).toBe(3);
  });
});
