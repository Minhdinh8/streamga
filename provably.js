// provably.js
const crypto = require('crypto');

// HMAC-SHA512 hex
function hmacSha512Hex(key, message) {
  return crypto.createHmac('sha512', key).update(message).digest('hex');
}

// Convert first 16 hex chars (8 bytes) to float in [0,1)
function hexToFloat01(hex) {
  const part = hex.slice(0, 16);
  const n = BigInt('0x' + part);
  const denom = BigInt('0x10000000000000000'); // 2^64
  // Using Number(n) / Number(denom). For values < 2^53 we are safe; this mapping is standard enough.
  return Number(n) / Number(denom);
}

// For a given serverSeed and clientSeed and message produce {hex, float}
function hmacFloatForMessage(serverSeed, message) {
  const hex = hmacSha512Hex(serverSeed, message);
  return {
    hex,
    float: hexToFloat01(hex)
  };
}

// Build entry objects for user with weight entries (duplicates with index)
function buildEntriesForUser(serverSeed, clientSeed, userId, entriesCount) {
  const arr = [];
  for (let i = 0; i < entriesCount; i++) {
    const message = `${clientSeed}:${userId}:${i}`;
    const { hex, float } = hmacFloatForMessage(serverSeed, message);
    arr.push({ userId, index: i, float, hex });
  }
  return arr;
}

module.exports = {
  hmacSha512Hex,
  hexToFloat01,
  hmacFloatForMessage,
  buildEntriesForUser
};
