import { getDbPool } from '../lib/db';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

// Helper to get user from JWT
function getUserIdFromReq(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    return payload.id;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const pool = getDbPool();

  // Batch GET watched states
  if (req.method === 'GET') {
    // Accepts ?items=[{item_type,item_id,season_number,episode_number},...]
    // Send as JSON string: items=[{...}]
    let items = [];
    try {
      items = JSON.parse(req.query.items || '[]');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid items param' });
    }
    if (!Array.isArray(items) || items.length === 0) return res.json({ states: {} });

    // Build a composite key for results
    const keys = items.map(
      x =>
        `${x.item_type}:${x.item_id}` +
        (x.season_number !== undefined ? `:s${x.season_number}` : '') +
        (x.episode_number !== undefined ? `:e${x.episode_number}` : '')
    );

    // Build WHERE clause
    const wheres = [];
    const params = [userId];
    items.forEach((x, i) => {
      let clause = `(item_type=$${params.length + 1} AND item_id=$${params.length + 2}`;
      params.push(x.item_type, String(x.item_id));
      if (x.season_number !== undefined)
        clause += ` AND season_number=$${params.length + 1}`, params.push(x.season_number);
      else
        clause += ` AND season_number IS NULL`;
      if (x.episode_number !== undefined)
        clause += ` AND episode_number=$${params.length + 1}`, params.push(x.episode_number);
      else
        clause += ` AND episode_number IS NULL`;
      clause += `)`;
      wheres.push(clause);
    });
    const sql = `SELECT * FROM watched WHERE user_id=$1 AND (${wheres.join(' OR ')})`;
    const { rows } = await pool.query(sql, params);

    // Map to result
    const stateMap = {};
    rows.forEach(row => {
      let k = `${row.item_type}:${row.item_id}`;
      if (row.season_number !== null) k += `:s${row.season_number}`;
      if (row.episode_number !== null) k += `:e${row.episode_number}`;
      stateMap[k] = row.state;
    });

    res.json({ states: stateMap });
  }

  // POST: Set watched state for an item
  else if (req.method === 'POST') {
    const { item_type, item_id, season_number, episode_number, state } = req.body || {};
    if (!item_type || !item_id || !state) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // Upsert watched state
    const { rows } = await pool.query(
      `INSERT INTO watched (user_id, item_type, item_id, season_number, episode_number, state, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id, item_type, item_id, season_number, episode_number)
      DO UPDATE SET state=$6, updated_at=NOW()
      RETURNING *`,
      [
        userId,
        item_type,
        String(item_id),
        season_number !== undefined ? season_number : null,
        episode_number !== undefined ? episode_number : null,
        state,
      ]
    );
    res.json({ ok: true, row: rows[0] });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}