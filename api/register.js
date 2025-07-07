import { getDbPool } from '../lib/db';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required.' });
  }

  const pool = getDbPool();
  try {
    // Check for existing user/email
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    if (rows.length) {
      return res.status(400).json({ error: 'Username or email already exists.' });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)',
      [username, email, hash]
    );
    res.status(201).json({ ok: true, message: 'Registration successful.' });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
}