const { pool } = require('./db');
const { v4: uuidv4 } = require('uuid');

async function createUser(email, passwordHash) {
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)
     RETURNING id, email`,
    [id, email, passwordHash]
  );
  return rows[0];
}

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, password_hash FROM users WHERE email = $1`,
    [email]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query(`SELECT id, email FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

module.exports = { createUser, findUserByEmail, findUserById };
