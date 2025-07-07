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
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const pool = getDbPool();

  // CONTINUE WATCHING: Return lists for dashboard if ?continue=1
  if (req.method === 'GET' && req.query.continue === '1') {
    try {
      // Movies (most recent 5 watching)
      const moviesRows = (
          await pool.query(
              `SELECT * FROM watched
               WHERE user_id=$1 AND item_type='tmdb-movie' AND state='watching'
               ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Series (most recent 5 watching)
      const seriesRows = (
          await pool.query(
              `SELECT * FROM watched
               WHERE user_id=$1 AND item_type='tmdb-tv' AND state='watching'
               ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Old logic for anime (backwards compatibility)
      // Anime Movies: item_type='anime', season_number=0
      const oldAnimeMoviesRows = (
          await pool.query(
              `SELECT * FROM watched
               WHERE user_id=$1 AND item_type='anime' AND state='watching' AND season_number=0
               ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Anime Series: item_type='anime', season_number!=0
      const oldAnimeSeriesRows = (
          await pool.query(
              `SELECT * FROM watched
           WHERE user_id=$1 AND item_type='anime' AND state='watching' AND season_number!=0
           ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // New logic for separate anime-movie and anime-series
      const newAnimeMoviesRows = (
          await pool.query(
              `SELECT * FROM watched
               WHERE user_id=$1 AND item_type='anime-movie' AND state='watching'
               ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      const newAnimeSeriesRows = (
          await pool.query(
              `SELECT * FROM watched
           WHERE user_id=$1 AND item_type='anime-series' AND state='watching'
           ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Combine old and new anime movies
      const combinedAnimeMovies = [...oldAnimeMoviesRows, ...newAnimeMoviesRows].sort(
          (a, b) => b.updated_at - a.updated_at
      );
      // Combine old and new anime series
      const combinedAnimeSeries = [...oldAnimeSeriesRows, ...newAnimeSeriesRows].sort(
          (a, b) => b.updated_at - a.updated_at
      );

      // Return the top 5 of each combined set
      res.json({
        ok: true,
        movies: moviesRows,
        series: seriesRows,
        animeMovies: combinedAnimeMovies.slice(0, 5),
        animeSeries: combinedAnimeSeries.slice(0, 5),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Failed to fetch continue watching.' });
    }
    return;
  }

  // Batch GET watched states
  if (req.method === 'GET') {
    let items = [];
    try {
      items = JSON.parse(req.query.items || '[]');
    } catch {
      return res.status(400).json({ error: 'Invalid items param' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ states: {} });
    }

    const wheres = [];
    const params = [userId];
    items.forEach((x) => {
      // always use 0 if undefined/null
      const season = x.season_number !== undefined && x.season_number !== null ? x.season_number : 0;
      const episode = x.episode_number !== undefined && x.episode_number !== null ? x.episode_number : 0;
      const clause = `(item_type=$${params.length + 1} AND item_id=$${params.length + 2} AND season_number=$${
          params.length + 3
      } AND episode_number=$${params.length + 4})`;
      params.push(x.item_type, String(x.item_id), season, episode);
      wheres.push(clause);
    });

    const sql = `SELECT * FROM watched WHERE user_id=$1 AND (${wheres.join(' OR ')})`;
    const { rows } = await pool.query(sql, params);

    const stateMap = {};
    rows.forEach((row) => {
      let k = `${row.item_type}:${row.item_id}`;
      if (row.season_number !== 0) k += `:s${row.season_number}`;
      if (row.episode_number !== 0) k += `:e${row.episode_number}`;
      stateMap[k] = row.state;
    });

    return res.json({ states: stateMap });
  }

  // POST: Set watched state for an item
  if (req.method === 'POST') {
    const { item_type, item_id, season_number, episode_number, state } = req.body || {};
    if (!item_type || !item_id || state === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Always use 0 for missing season/episode
    const season = season_number !== undefined && season_number !== null ? season_number : 0;
    const episode = episode_number !== undefined && episode_number !== null ? episode_number : 0;

    if (state === 'not_watched') {
      // Remove entry if exists
      await pool.query(
          `DELETE FROM watched
         WHERE user_id=$1 AND item_type=$2 AND item_id=$3 AND season_number=$4 AND episode_number=$5`,
          [userId, item_type, String(item_id), season, episode]
      );
      return res.json({ ok: true, deleted: true });
    } else {
      // Upsert watched state
      const { rows } = await pool.query(
          `INSERT INTO watched (user_id, item_type, item_id, season_number, episode_number, state, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, item_type, item_id, season_number, episode_number)
         DO UPDATE SET state=$6, updated_at=NOW()
         RETURNING *`,
          [userId, item_type, String(item_id), season, episode, state]
      );
      return res.json({ ok: true, row: rows[0] });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}