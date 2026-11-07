'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_ACTIVE = 2;
const MAX_QUEUED = 16;
let active = 0;
const queue = [];

function validatePassword(password) {
  if (typeof password !== 'string') throw new Error('PASSWORD_INVALID');
  const length = Array.from(password).length;
  if (length < 12 || length > 128 || Buffer.byteLength(password, 'utf8') > 512) throw new Error('PASSWORD_INVALID');
  return password;
}

function drain() {
  while (active < MAX_ACTIVE && queue.length) {
    const task = queue.shift();
    active++;
    task().finally(() => {
      active--;
      drain();
    });
  }
}

function boundedScrypt(password, salt, keylen, options) {
  if (active >= MAX_ACTIVE && queue.length >= MAX_QUEUED) return Promise.reject(new Error('HASH_QUEUE_FULL'));
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      try { resolve(await scrypt(password, salt, keylen, options)); }
      catch (error) { reject(error); }
    });
    drain();
  });
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await boundedScrypt(password, salt, KEY_LENGTH, PARAMETERS);
  return '$scrypt$N=32768,r=8,p=3$' + salt.toString('base64url') + '$' + Buffer.from(derived).toString('base64url');
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const match = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return false;
  const [, n, r, p, saltText, hashText] = match;
  if (Number(n) !== PARAMETERS.N || Number(r) !== PARAMETERS.r || Number(p) !== PARAMETERS.p) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length < SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
    const actual = Buffer.from(await boundedScrypt(password, salt, expected.length, PARAMETERS));
    return crypto.timingSafeEqual(actual, expected);
  } catch (error) {
    if (error.message === 'HASH_QUEUE_FULL') throw error;
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, validatePassword, PARAMETERS };
