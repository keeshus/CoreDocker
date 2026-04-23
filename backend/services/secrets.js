import etcd from './db.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const SECRETS_PREFIX = 'secrets/';
const MASTER_KEY_HASH_KEY = 'system/master_hash';
const ENCRYPTED_DEK_KEY = 'system/encrypted_dek';

// The Data Encryption Key (DEK) - held ONLY in memory
let inMemoryDEK = null;

/**
 * Check if the system is initialized (has a master hash)
 */
export const isSystemInitialized = async () => {
  const hash = await etcd.get(MASTER_KEY_HASH_KEY).string();
  return !!hash;
};

/**
 * Check if this specific node is sealed (lacks the DEK in memory)
 */
export const isNodeSealed = () => {
  return inMemoryDEK === null;
};

/**
 * Initialize the system for the first time
 * @param {string} password - The master password
 */
export const initializeSystem = async (password) => {
  if (await isSystemInitialized()) {
    throw new Error('System is already initialized');
  }

  // 1. Hash the password for future verification
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  await etcd.put(MASTER_KEY_HASH_KEY).value(`${salt}:${hash}`);

  // 1.5 Store the system-wide default paths
  await etcd.put('system/backup_path').value(process.env.HOST_BACKUP_PATH || '/data/backup');
  await etcd.put('system/non_backup_path').value(process.env.HOST_NONBACKUP_PATH || '/data/non-backup');

  // 2. Generate a random Data Encryption Key (DEK)
  const dek = crypto.randomBytes(32);
  inMemoryDEK = dek;

  // 3. Encrypt the DEK with the master password and store it in ETCD
  const masterKey = crypto.scryptSync(password, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', masterKey, iv);
  let encryptedDEK = cipher.update(dek);
  encryptedDEK = Buffer.concat([encryptedDEK, cipher.final()]);
  
  const encryptedDEKPayload = iv.toString('hex') + ':' + encryptedDEK.toString('hex');
  await etcd.put(ENCRYPTED_DEK_KEY).value(encryptedDEKPayload);

  console.log('[Secrets] System initialized and node unsealed.');
};

/**
 * Unseal this node using the master password
 * @param {string} password - The master password
 */
export const unsealNode = async (password) => {
  const storedHashPayload = await etcd.get(MASTER_KEY_HASH_KEY).string();
  if (!storedHashPayload) {
    throw new Error('System not initialized');
  }

  const [salt, storedHash] = storedHashPayload.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');

  if (hash !== storedHash) {
    throw new Error('Invalid master password');
  }

  // Decrypt the DEK from ETCD
  const encryptedDEKPayload = await etcd.get(ENCRYPTED_DEK_KEY).string();
  if (!encryptedDEKPayload) {
    throw new Error('System initialized but DEK not found');
  }

  const [ivHex, encryptedHex] = encryptedDEKPayload.split(':');
  const masterKey = crypto.scryptSync(password, salt, 32);
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedDEK = Buffer.from(encryptedHex, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', masterKey, iv);
  let dek = decipher.update(encryptedDEK);
  dek = Buffer.concat([dek, decipher.final()]);

  inMemoryDEK = dek;
  console.log('[Secrets] Node successfully unsealed.');
};

/**
 * Get the current DEK if unsealed
 */
export const getDEK = () => {
  if (isNodeSealed()) {
    throw new Error('Node is sealed');
  }
  return inMemoryDEK;
};

/**
 * Encrypt a value using the DEK
 */
export const encrypt = (value) => {
  const dek = getDEK();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', dek, iv);
  let encrypted = cipher.update(value, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

/**
 * Decrypt a value using the DEK
 */
export const decrypt = (encryptedPayload) => {
  const dek = getDEK();
  const [ivHex, encryptedHex] = encryptedPayload.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', dek, iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
};

export const changeMasterPassword = async (currentPassword, newPassword) => {
  if (isNodeSealed()) {
    throw new Error('Node must be unsealed to change master password');
  }
  
  // Verify current password
  const storedHashPayload = await etcd.get(MASTER_KEY_HASH_KEY).string();
  const [salt, storedHash] = storedHashPayload.split(':');
  const hash = crypto.scryptSync(currentPassword, salt, 64).toString('hex');

  if (hash !== storedHash) {
    throw new Error('Invalid current master password');
  }

  // Generate new salt and hash for the new password
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = crypto.scryptSync(newPassword, newSalt, 64).toString('hex');
  await etcd.put(MASTER_KEY_HASH_KEY).value(`${newSalt}:${newHash}`);

  // Re-encrypt the DEK with the new master password
  const newMasterKey = crypto.scryptSync(newPassword, newSalt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', newMasterKey, iv);
  let encryptedDEK = cipher.update(inMemoryDEK);
  encryptedDEK = Buffer.concat([encryptedDEK, cipher.final()]);
  
  const encryptedDEKPayload = iv.toString('hex') + ':' + encryptedDEK.toString('hex');
  await etcd.put(ENCRYPTED_DEK_KEY).value(encryptedDEKPayload);
};

export const rotateDEK = async (masterPassword) => {
  if (isNodeSealed()) {
    throw new Error('Node must be unsealed to rotate DEK');
  }

  // Verify master password
  const storedHashPayload = await etcd.get(MASTER_KEY_HASH_KEY).string();
  const [salt, storedHash] = storedHashPayload.split(':');
  const hash = crypto.scryptSync(masterPassword, salt, 64).toString('hex');

  if (hash !== storedHash) {
    throw new Error('Invalid master password');
  }

  // 1. Decrypt all secrets with the OLD DEK
  const secrets = await etcd.get(SECRETS_PREFIX, { isPrefix: true }).all();
  const decryptedSecrets = secrets.map(s => ({
    key: s.key,
    value: decrypt(s.value)
  }));

  // 2. Generate a NEW DEK
  const newDek = crypto.randomBytes(32);
  const oldDek = inMemoryDEK;
  inMemoryDEK = newDek;

  try {
    // 3. Re-encrypt all secrets with the NEW DEK
    for (const secret of decryptedSecrets) {
      await etcd.put(secret.key).value(encrypt(secret.value));
    }

    // 4. Update the stored encrypted DEK
    const masterKey = crypto.scryptSync(masterPassword, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', masterKey, iv);
    let encryptedDEK = cipher.update(newDek);
    encryptedDEK = Buffer.concat([encryptedDEK, cipher.final()]);
    
    const encryptedDEKPayload = iv.toString('hex') + ':' + encryptedDEK.toString('hex');
    await etcd.put(ENCRYPTED_DEK_KEY).value(encryptedDEKPayload);

    console.log('[Secrets] DEK rotated and secrets re-encrypted.');
  } catch (err) {
    // Rollback DEK in memory if something goes wrong
    inMemoryDEK = oldDek;
    throw err;
  }
};

export const verifyClusterToken = (token) => {
  try {
    const dek = getDEK();
    return jwt.verify(token, dek.toString('hex'));
  } catch (err) {
    throw new Error('Invalid cluster token');
  }
};

export const signClusterToken = (payload) => {
  const dek = getDEK();
  return jwt.sign(payload, dek.toString('hex'), { expiresIn: '1h' });
};

export const generateClusterToken = (payload) => signClusterToken(payload);

/**
 * Get a secret by key
 */
export const getSecret = async (key) => {
  const encryptedValue = await etcd.get(`${SECRETS_PREFIX}${key}`).string();
  if (!encryptedValue) return null;
  return decrypt(encryptedValue);
};

/**
 * Set a secret
 */
export const setSecret = async (key, value) => {
  const encryptedValue = encrypt(value);
  await etcd.put(`${SECRETS_PREFIX}${key}`).value(encryptedValue);
};

/**
 * Delete a secret
 */
export const deleteSecret = async (key) => {
  await etcd.delete(`${SECRETS_PREFIX}${key}`);
};

/**
 * Get all secret keys
 */
export const getAllSecretKeys = async () => {
  const secrets = await etcd.get(SECRETS_PREFIX, { isPrefix: true }).all();
  return secrets.map(s => s.key.replace(SECRETS_PREFIX, ''));
};
