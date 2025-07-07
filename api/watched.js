import { getDbPool } from '../lib/db';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const ANILIST_API = 'https://graphql.anilist.co';

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

// Fetch TMDB details by type/id
async function fetchTMDBDetails(item_type, item_id) {
  if (!TMDB_API_KEY) return {};
  try {
    let url = "";
    if (item_type === "tmdb-movie") {
      url = `https://api.themoviedb.org/3/movie/${item_id}?api_key=${TMDB_API_KEY}&language=en-US`;
    } else if (item_type === "tmdb-tv") {
      url = `https://api.themoviedb.org/3/tv/${item_id}?api_key=${TMDB_API_KEY}&language=en-US`;
    }
    if (!url) return {};
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const data = await resp.json();
    return {
      title: data.title || data.name || "",
      year: (data.release_date || data.first_air_date || "").split("-")[0],
      poster_path: data.poster_path,
      tmdb_id: data.id
    };
  } catch (e) { return {}; }
}

// Fetch AniList details by id/type
async function fetchAniListDetails(item_type, item_id) {
  try {
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title { english romaji }
          coverImage { large }
          seasonYear
        }
      }
    `;
    const resp = await fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: parseInt(item_id) } })
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    const media = data.data?.Media;
    if (!media) return {};
    return {
      title: media.title.english || media.title.romaji || "",
      year: media.seasonYear,
      coverImage: media.coverImage,
      anilist_id: media.id
    };
  } catch (e) { return {}; }
}

export default async function handler(req, res) {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const pool = getDbPool();

  // CONTINUE WATCHING with live details
  if (req.method === 'GET' && req.query.continue === '1') {
    try {
      // Get top 5 of each type in watching state
      const types = ['tmdb-movie', 'tmdb-tv', 'anime-movie', 'anime-series'];
      const result = {};
      for (const t of types) {
        const { rows } = await pool.query(
            `SELECT * FROM watched WHERE user_id=$1 AND item_type=$2 AND state='watching' ORDER BY updated_at DESC LIMIT 5`,
            [userId, t]
        );
        // Enrich with external data
        const enriched = [];
        for (const row of rows) {
          let detail = {};
          if (t === "tmdb-movie" || t === "tmdb-tv") {
            detail = await fetchTMDBDetails(t, row.item_id);
          } else if (t === "anime-movie" || t === "anime-series") {
            detail = await fetchAniListDetails(t, row.item_id);
          }
          enriched.push({
            ...row,
            ...detail
          });
        }
        if (t === "tmdb-movie") result.movies = enriched;
        else if (t === "tmdb-tv") result.series = enriched;
        else if (t === "anime-movie") result.animeMovies = enriched;
        else if (t === "anime-series") result.animeSeries = enriched;
      }
      res.json({ ok: true, ...result });
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
    } catch (e) {
      return res.status(400).json({ error: 'Invalid items param' });
    }
    if (!Array.isArray(items) || items.length === 0) return res.json({ states: {} });

    const wheres = [];
    const params = [userId];
    items.forEach((x, i) => {
      // always use 0 if undefined/null
      const season = x.season_number !== undefined && x.season_number !== null ? x.season_number : 0;
      const episode = x.episode_number !== undefined && x.episode_number !== null ? x.episode_number : 0;
      let clause = `(item_type=$${params.length + 1} AND item_id=$${params.length + 2} AND season_number=$${params.length + 3} AND episode_number=$${params.length + 4})`;
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

  // POST: Set watched state for an item
  else if (req.method === 'POST') {
    let { item_type, item_id, season_number, episode_number, state } = req.body || {};
    if (!item_type || !item_id || state === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Always use 0 for missing season/episode
    const season = season_number !== undefined && season_number !== null ? season_number : 0;
    const episode = episode_number !== undefined && episode_number !== null ? episode_number : 0;

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
      res.json({ ok: true, row: rows[0] });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}