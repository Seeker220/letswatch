import { getDbPool } from '../lib/db';
import jwt from 'jsonwebtoken';
// Use CommonJS require for axios if you're not using ES modules
const axios = require('axios');

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const TMDB_API_KEY = process.env.TMDB_API_KEY;

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

      // Series - combine tmdb-tv, tmdb-tv-season, and tmdb-tv-episode into one result set
      // This handles parent-child relationship
      const seriesRows = (
          await pool.query(
              `SELECT DISTINCT ON (item_id) * FROM (
             SELECT item_id, updated_at FROM watched
             WHERE user_id=$1 AND item_type='tmdb-tv' AND state='watching'
             UNION ALL
             SELECT item_id, updated_at FROM watched
             WHERE user_id=$1 AND item_type='tmdb-tv-season' AND state='watching' 
             UNION ALL
             SELECT item_id, updated_at FROM watched
             WHERE user_id=$1 AND item_type='tmdb-tv-episode' AND state='watching'
           ) AS series_data
           ORDER BY item_id, updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Combine anime-series and anime-episode for anime series results
      const animeSeriesRows = (
          await pool.query(
              `SELECT DISTINCT ON (item_id) * FROM (
             SELECT item_id, updated_at FROM watched
             WHERE user_id=$1 AND item_type='anime-series' AND state='watching'
             UNION ALL
             SELECT item_id, updated_at FROM watched
             WHERE user_id=$1 AND item_type='anime-episode' AND state='watching'
             UNION ALL
             SELECT item_id, updated_at FROM watched
             WHERE user_id=$1 AND item_type='anime' AND state='watching' AND season_number!=0
           ) AS anime_series_data
           ORDER BY item_id, updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Anime Movies
      const animeMoviesRows = (
          await pool.query(
              `SELECT DISTINCT ON (item_id) * FROM (
             SELECT item_id, updated_at FROM watched
             WHERE user_id=$1 AND item_type='anime-movie' AND state='watching'
             UNION ALL
             SELECT item_id, updated_at FROM watched
             WHERE user_id=$1 AND item_type='anime' AND state='watching' AND season_number=0
           ) AS anime_movie_data
           ORDER BY item_id, updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Fetch metadata for results
      try {
        // Fetch TMDB metadata
        const movieIds = moviesRows.map(row => row.item_id);
        const seriesIds = seriesRows.map(row => row.item_id);

        // Enrich with metadata in parallel
        const [movieMetadata, seriesMetadata] = await Promise.all([
          fetchTmdbMoviesMetadata(movieIds),
          fetchTmdbSeriesMetadata(seriesIds)
        ]);

        // Merge movie metadata
        const enrichedMovies = moviesRows.map(row => ({
          ...row,
          ...(movieMetadata[row.item_id] || {})
        }));

        // Merge series metadata
        const enrichedSeries = seriesRows.map(row => ({
          ...row,
          ...(seriesMetadata[row.item_id] || {})
        }));

        // Fetch AniList metadata
        const animeIds = [
          ...animeMoviesRows.map(row => row.item_id),
          ...animeSeriesRows.map(row => row.item_id)
        ];
        const animeMetadata = await fetchAnilistMetadata(animeIds);

        // Merge anime movies metadata
        const enrichedAnimeMovies = animeMoviesRows.map(row => ({
          ...row,
          ...(animeMetadata[row.item_id] || {})
        }));

        // Merge anime series metadata
        const enrichedAnimeSeries = animeSeriesRows.map(row => ({
          ...row,
          ...(animeMetadata[row.item_id] || {})
        }));

        // Return the enriched data
        return res.json({
          ok: true,
          movies: enrichedMovies,
          series: enrichedSeries,
          animeMovies: enrichedAnimeMovies,
          animeSeries: enrichedAnimeSeries
        });
      } catch (metadataError) {
        console.error("Metadata fetch error:", metadataError);

        // Fall back to returning data without metadata
        return res.json({
          ok: true,
          movies: moviesRows,
          series: seriesRows,
          animeMovies: animeMoviesRows,
          animeSeries: animeSeriesRows
        });
      }
    } catch (e) {
      console.error('Continue watching error:', e);
      res.status(500).json({ ok: false, error: 'Failed to fetch continue watching.' });
    }
    return;
  }

  // Batch GET watched states
  if (req.method === 'GET') {
    try {
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
    } catch (error) {
      console.error("Error getting watch states:", error);
      return res.status(500).json({ error: 'Database error while fetching watch states' });
    }
  }

  // POST: Set watched state for an item
  if (req.method === 'POST') {
    try {
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
    } catch (error) {
      console.error("Error saving watch state:", error);
      return res.status(500).json({ error: 'Database error while saving watch state' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

// Helper functions for fetching metadata
async function fetchTmdbMoviesMetadata(ids) {
  if (!ids || !ids.length) return {};
  const metadata = {};

  try {
    // Batch in groups of 5 to avoid rate limiting
    const batches = [];
    for (let i = 0; i < ids.length; i += 5) {
      batches.push(ids.slice(i, i + 5));
    }

    for (const batch of batches) {
      const promises = batch.map(id =>
          axios.get(`https://api.themoviedb.org/3/movie/${id}`, {
            params: { api_key: TMDB_API_KEY }
          }).catch(err => console.error(`Error fetching TMDB movie ${id}:`, err.message))
      );

      const results = await Promise.all(promises);
      results.forEach(response => {
        if (response && response.data) {
          metadata[response.data.id] = {
            title: response.data.title,
            poster_path: response.data.poster_path,
            release_date: response.data.release_date
          };
        }
      });
    }
  } catch (error) {
    console.error("Error fetching TMDB movies:", error);
  }

  return metadata;
}

async function fetchTmdbSeriesMetadata(ids) {
  if (!ids || !ids.length) return {};
  const metadata = {};

  try {
    // Batch in groups of 5 to avoid rate limiting
    const batches = [];
    for (let i = 0; i < ids.length; i += 5) {
      batches.push(ids.slice(i, i + 5));
    }

    for (const batch of batches) {
      const promises = batch.map(id =>
          axios.get(`https://api.themoviedb.org/3/tv/${id}`, {
            params: { api_key: TMDB_API_KEY }
          }).catch(err => console.error(`Error fetching TMDB TV ${id}:`, err.message))
      );

      const results = await Promise.all(promises);
      results.forEach(response => {
        if (response && response.data) {
          metadata[response.data.id] = {
            name: response.data.name,
            poster_path: response.data.poster_path,
            first_air_date: response.data.first_air_date
          };
        }
      });
    }
  } catch (error) {
    console.error("Error fetching TMDB series:", error);
  }

  return metadata;
}

async function fetchAnilistMetadata(ids) {
  if (!ids || !ids.length) return {};
  const metadata = {};

  try {
    // GraphQL query to fetch multiple anime at once
    const query = `
      query ($ids: [Int]) {
        Page {
          media(id_in: $ids, type: ANIME) {
            id
            title {
              romaji
              english
            }
            coverImage {
              large
            }
            seasonYear
            format
            episodes
          }
        }
      }
    `;

    const response = await axios.post('https://graphql.anilist.co', {
      query,
      variables: { ids: ids.map(id => parseInt(id, 10)) }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (response.data && response.data.data && response.data.data.Page && response.data.data.Page.media) {
      response.data.data.Page.media.forEach(anime => {
        metadata[anime.id] = {
          title_english: anime.title.english,
          title_romaji: anime.title.romaji,
          coverImage: anime.coverImage,
          seasonYear: anime.seasonYear
        };
      });
    }
  } catch (error) {
    console.error("Error fetching AniList metadata:", error);
  }

  return metadata;
}