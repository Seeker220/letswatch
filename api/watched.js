import { getDbPool } from '../lib/db';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch'; // Ensure this is available in your env

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const ANILIST_API_URL = 'https://graphql.anilist.co';

// Extract user ID from JWT token
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

// TMDB movie or series metadata
async function fetchTmdbMeta(item_id, type) {
  const url = `https://api.themoviedb.org/3/${type === 'tmdb-movie' ? 'movie' : 'tv'}/${item_id}?api_key=${TMDB_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    return {
      title: data.title || data.name || '',
      poster_path: data.poster_path || '',
      year: (data.release_date || data.first_air_date || '').split('-')[0]
    };
  } catch {
    return {};
  }
}

// AniList anime metadata
async function fetchAnilistMeta(item_id) {
  const query = `
    query ($id: Int) {
      Media(id: $id) {
        title {
          english
          romaji
        }
        coverImage {
          large
        }
        seasonYear
      }
    }
  `;
  const variables = { id: Number(item_id) };
  try {
    const res = await fetch(ANILIST_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!json.data || !json.data.Media) return {};
    const m = json.data.Media;
    return {
      title: m.title.english || m.title.romaji || '',
      coverImage: m.coverImage || {},
      year: m.seasonYear || ''
    };
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const pool = getDbPool();

  // CONTINUE WATCHING SECTION
  if (req.method === 'GET' && req.query.continue === '1') {
    try {
      // Get latest 5 "watching" for each item_type
      const types = ['tmdb-movie', 'tmdb-tv', 'anime-movie', 'anime-series'];
      const result = {};

      for (const type of types) {
        const { rows } = await pool.query(
            `SELECT * FROM watched WHERE user_id=$1 AND item_type=$2 AND state='watching'
           ORDER BY updated_at DESC LIMIT 5`,
            [userId, type]
        );

        // Enrich with metadata
        const enriched = await Promise.all(rows.map(async (row) => {
          let meta = {};
          if (type === 'tmdb-movie' || type === 'tmdb-tv') {
            meta = await fetchTmdbMeta(row.item_id, type);
          } else if (type === 'anime-movie' || type === 'anime-series') {
            meta = await fetchAnilistMeta(row.item_id);
          }
          return {
            ...row,
            ...meta
          };
        }));

        if (type === 'tmdb-movie') result.movies = enriched;
        else if (type === 'tmdb-tv') result.series = enriched;
        else if (type === 'anime-movie') result.animeMovies = enriched;
        else if (type === 'anime-series') result.animeSeries = enriched;
      }

      res.json({ ok: true, ...result });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Failed to fetch continue watching.' });
    }
    return;
  }

  // BATCH GET watched states
  if (req.method === 'GET') {
    let items = [];
    try {
      items = JSON.parse(req.query.items || '[]');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid items param' });
    }
    if (!Array.isArray(items) || items.length === 0) return res.json({ states: {} });

    const wheres = [];
    const params = [userId];
    items.forEach((x, i) => {
      const season = x.season_number ?? 0;
      const episode = x.episode_number ?? 0;
      const clause = `(item_type=$${params.length + 1} AND item_id=$${params.length + 2} AND season_number=$${params.length + 3} AND episode_number=$${params.length + 4})`;
      params.push(x.item_type, String(x.item_id), season, episode);
      wheres.push(clause);
    });

    const sql = `SELECT * FROM watched WHERE user_id=$1 AND (${wheres.join(' OR ')})`;
    const { rows } = await pool.query(sql, params);

    const stateMap = {};
    rows.forEach(row => {
      let k = `${row.item_type}:${row.item_id}`;
      if (row.season_number !== 0) k += `:s${row.season_number}`;
      if (row.episode_number !== 0) k += `:e${row.episode_number}`;
      stateMap[k] = row.state;
    });

    res.json({ states: stateMap });
    return;
  }

  // POST: Set watched state
  if (req.method === 'POST') {
    const { item_type: rawType, item_id, season_number, episode_number, state } = req.body || {};
    if (!rawType || !item_id || state === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Normalize item_type
    let item_type = rawType;
    const season = season_number ?? 0;
    const episode = episode_number ?? 0;

    if (rawType === 'anime') {
      if (season !== 0 || episode !== 0) {
        item_type = 'anime-series';
      } else {
        item_type = 'anime-movie';
      }
    }

    if (state === 'not_watched') {
      await pool.query(
          `DELETE FROM watched WHERE user_id=$1 AND item_type=$2 AND item_id=$3 AND season_number=$4 AND episode_number=$5`,
          [userId, item_type, String(item_id), season, episode]
      );
      return res.json({ ok: true, deleted: true });
    } else {
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
