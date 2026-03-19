import etcd from './db.js';
import crypto from 'crypto';

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
 * Check if this specific node is unsealed (has the DEK in memory)
 */
export const isNodeUnsealed = () => {
  return inMemoryDEK !== null;
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

export const encrypt = (text) => {
  if (!inMemoryDEK) {
    const err = new Error('Node is sealed');
    err.statusCode = 423;
    throw err;
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', inMemoryDEK, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

export const decrypt = (text) => {
  if (!inMemoryDEK) {
    const err = new Error('Node is sealed');
    err.statusCode = 423;
    throw err;
  }
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', inMemoryDEK, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
};

export const getSecret = async (key) => {
  const encryptedValue = await etcd.get(`${SECRETS_PREFIX}${key}`).string();
  if (!encryptedValue) return null;
  return decrypt(encryptedValue);
};

export const setSecret = async (key, value) => {
  const encryptedValue = encrypt(value);
  await etcd.put(`${SECRETS_PREFIX}${key}`).value(encryptedValue);
};

export const deleteSecret = async (key) => {
  await etcd.delete().key(`${SECRETS_PREFIX}${key}`);
};

export const getAllSecretKeys = async () => {
  const allSecrets = await etcd.getAll().prefix(SECRETS_PREFIX).keys();
  return allSecrets.map(k => k.replace(SECRETS_PREFIX, ''));
};

/**
 * Change the master password and re-encrypt the DEK
 * @param {string} currentPassword 
 * @param {string} newPassword 
 */
export const changeMasterPassword = async (currentPassword, newPassword) => {
  if (!isNodeUnsealed()) {
    throw new Error('Node must be unsealed to change master password');
  }

  const storedHashPayload = await etcd.get(MASTER_KEY_HASH_KEY).string();
  if (!storedHashPayload) {
    throw new Error('System not initialized');
  }

  const [salt, storedHash] = storedHashPayload.split(':');
  const hash = crypto.scryptSync(currentPassword, salt, 64).toString('hex');

  if (hash !== storedHash) {
    throw new Error('Invalid current master password');
  }

  // 1. Generate new salt and hash for the new password
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newHash = crypto.scryptSync(newPassword, newSalt, 64).toString('hex');

  // 2. Re-encrypt the existing inMemoryDEK with the new password
  const newMasterKey = crypto.scryptSync(newPassword, newSalt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', newMasterKey, iv);
  let encryptedDEK = cipher.update(inMemoryDEK);
  encryptedDEK = Buffer.concat([encryptedDEK, cipher.final()]);
  
  const encryptedDEKPayload = iv.toString('hex') + ':' + encryptedDEK.toString('hex');

  // 3. Atomically save new hash and new encrypted DEK
  await etcd.transaction()
    .then(t => t.put(MASTER_KEY_HASH_KEY).value(`${newSalt}:${newHash}`))
    .then(t => t.put(ENCRYPTED_DEK_KEY).value(encryptedDEKPayload))
    .commit();

  console.log('[Secrets] Master password changed successfully.');
};

/**
 * Rotate the Data Encryption Key (DEK)
 * Warning: This re-encrypts ALL data under core/ prefix.
 * @param {string} masterPassword - Required to authorize the rotation
 */
export const rotateDEK = async (masterPassword) => {
  if (!isNodeUnsealed()) {
    throw new Error('Node must be unsealed to rotate DEK');
  }

  // 1. Verify master password first
  const storedHashPayload = await etcd.get(MASTER_KEY_HASH_KEY).string();
  const [salt, storedHash] = storedHashPayload.split(':');
  const hash = crypto.scryptSync(masterPassword, salt, 64).toString('hex');

  if (hash !== storedHash) {
    throw new Error('Invalid master password');
  }

  console.log('[Secrets] Starting DEK rotation...');

  // 2. Fetch all keys under 'core/' (encrypted data)
  const allCoreData = await etcd.getAll().prefix('core/').strings();
  
  // 3. Generate a new DEK
  const oldDEK = inMemoryDEK;
  const newDEK = crypto.randomBytes(32);

  // 4. Re-encrypt all data
  const transaction = etcd.transaction();
  
  for (const [key, value] of Object.entries(allCoreData)) {
    // Decrypt with old DEK
    const textParts = value.split(':');
    const ivOld = Buffer.from(textParts.shift(), 'hex');
    const encryptedOld = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', oldDEK, ivOld);
    let decrypted = decipher.update(encryptedOld);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // Encrypt with new DEK
    const ivNew = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', newDEK, ivNew);
    let encryptedNew = cipher.update(decrypted);
    encryptedNew = Buffer.concat([encryptedNew, cipher.final()]);
    const newValue = ivNew.toString('hex') + ':' + encryptedNew.toString('hex');

    transaction.put(key).value(newValue);
  }

  // 5. Re-encrypt the NEW DEK with the master password
  const masterKey = crypto.scryptSync(masterPassword, salt, 32);
  const ivDEK = crypto.randomBytes(16);
  const cipherDEK = crypto.createCipheriv('aes-256-cbc', masterKey, ivDEK);
  let encryptedNewDEK = cipherDEK.update(newDEK);
  encryptedNewDEK = Buffer.concat([encryptedNewDEK, cipherDEK.final()]);
  const encryptedDEKPayload = ivDEK.toString('hex') + ':' + encryptedNewDEK.toString('hex');

  transaction.put(ENCRYPTED_DEK_KEY).value(encryptedDEKPayload);

  // 6. Execute rotation
  await transaction.commit();

  // 7. Update in-memory DEK
  inMemoryDEK = newDEK;

  console.log('[Secrets] DEK rotation completed successfully.');
};
