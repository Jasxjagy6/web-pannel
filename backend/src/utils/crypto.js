const crypto = require('crypto');
const bcrypt = require('bcrypt');

const ENCRYPTION_KEY = process.env.JWT_SECRET || 'default-encryption-key-32chars';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_ROUNDS = 10;

const encrypt = (text) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, '0')),
    iv
  );
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
};

const decrypt = (encryptedText) => {
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, '0')),
    iv
  );
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

const hashPassword = async (password) => {
  return bcrypt.hash(password, SALT_ROUNDS);
};

const comparePassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

const generateToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const hashValue = (value) => {
  return crypto.createHash('sha256').update(value).digest('hex');
};

module.exports = {
  encrypt,
  decrypt,
  hashPassword,
  comparePassword,
  generateToken,
  hashValue,
};
