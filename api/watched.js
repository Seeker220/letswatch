import { getDbPool } from '../lib/db';
import jwt from 'jsonwebtoken';
import axios from 'axios';

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_IMAGE_URL = 'https://image.tmdb.org/t/p/w500';

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

// Helper to fetch TMDB metadata in batch
async function fetchTmdbMetadata(items) {
  const movies = items.filter(item => item.item_type === 'tmdb-movie');
  const tvShows = items.filter(item => item.item_type === 'tmdb-tv' ||
      item.item_type === 'tmdb-tv-season' ||
      item.item_type === 'tmdb-tv-episode');

  const results = {};

  // Fetch movie data
  await Promise.all(movies.map(async (movie) => {
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/movie/${movie.item_id}`, {
        params: { api_key: TMDB_API_KEY }
      });

      results[`tmdb-movie:${movie.item_id}`] = {
        title: response.data.title,
        poster_path: response.data.poster_path,
        release_date: response.data.release_date
      };
    } catch (error) {
      console.error(`Error fetching movie ${movie.item_id}:`, error.message);
    }
  }));

  // Fetch TV show data - for both parent shows and episodes/seasons
  const uniqueTvIds = [...new Set(tvShows.map(item => item.item_id))];
  await Promise.all(uniqueTvIds.map(async (tvId) => {
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/tv/${tvId}`, {
        params: { api_key: TMDB_API_KEY }
      });

      results[`tmdb-tv:${tvId}`] = {
        name: response.data.name,
        poster_path: response.data.poster_path,
        first_air_date: response.data.first_air_date
      };
    } catch (error) {
      console.error(`Error fetching TV show ${tvId}:`, error.message);
    }
  }));

  return results;
}

// Helper to fetch AniList metadata in batch
async function fetchAnilistMetadata(items) {
  const animeItems = items.filter(item =>
      item.item_type === 'anime-movie' ||
      item.item_type === 'anime-series' ||
      item.item_type === 'anime-episode' ||
      item.item_type === 'anime');

  if (!animeItems.length) return {};

  const uniqueIds = [...new Set(animeItems.map(item => item.item_id))];
  const results = {};

  // Batch fetch using GraphQL
  try {
    const idsString = uniqueIds.join(',');
    const graphqlQuery = {
      query: `
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
      `,
      variables: {
        ids: uniqueIds.map(Number)
      }
    };

    const response = await axios.post('https://graphql.anilist.co', graphqlQuery, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    response.data.data.Page.media.forEach(anime => {
      const key = `anime:${anime.id}`;
      const title = anime.title.english || anime.title.romaji || 'Unknown Title';

      results[key] = {
        id: anime.id,
        title_english: anime.title.english,
        title_romaji: anime.title.romaji,
        coverImage: anime.coverImage,
        seasonYear: anime.seasonYear,
        format: anime.format,
        episodes: anime.episodes
      };

      // Store duplicates for different item types
      results[`anime-movie:${anime.id}`] = results[key];
      results[`anime-series:${anime.id}`] = results[key];
      results[`anime-episode:${anime.id}`] = results[key];
    });

    return results;
  } catch (error) {
    console.error('Error fetching AniList metadata:', error.message);
    return {};
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
      // Get all items marked as "watching" with their most recent update time
      // For child items (episodes/seasons), we'll need to normalize them to their parent item

      // TMDB Movies (simplest case, no parent/child relationship)
      const moviesQuery = `
        SELECT DISTINCT ON (item_id) *
        FROM watched
        WHERE user_id=$1 AND item_type='tmdb-movie' AND state='watching'
        ORDER BY item_id, updated_at DESC 
        LIMIT 5
      `;
      const moviesRows = (await pool.query(moviesQuery, [userId])).rows;

      // TMDB TV Shows (parent) and episodes/seasons (children)
      // We need to get both directly marked shows and shows that have episodes/seasons marked
      const seriesQuery = `
        WITH tv_items AS (
          -- Direct tv shows
          SELECT item_id, updated_at, 'tmdb-tv' as source_type
          FROM watched
          WHERE user_id=$1 AND item_type='tmdb-tv' AND state='watching'
          
          UNION
          
          -- TV seasons (use parent show ID)
          SELECT item_id, updated_at, 'tmdb-tv-season' as source_type
          FROM watched
          WHERE user_id=$1 AND item_type='tmdb-tv-season' AND state='watching'
          
          UNION
          
          -- TV episodes (use parent show ID)
          SELECT item_id, updated_at, 'tmdb-tv-episode' as source_type
          FROM watched
          WHERE user_id=$1 AND item_type='tmdb-tv-episode' AND state='watching'
        )
        SELECT DISTINCT ON (item_id) item_id, updated_at, source_type
        FROM tv_items
        ORDER BY item_id, updated_at DESC
        LIMIT 5
      `;
      const seriesRows = (await pool.query(seriesQuery, [userId])).rows;

      // Anime Items - both movies and series
      // We'll split them after fetching metadata
      const animeQuery = `
        WITH anime_items AS (
          -- Direct anime movies
          SELECT item_id, updated_at, 'anime-movie' as source_type
          FROM watched
          WHERE user_id=$1 AND item_type='anime-movie' AND state='watching'
          
          UNION
          
          -- Direct anime series
          SELECT item_id, updated_at, 'anime-series' as source_type
          FROM watched
          WHERE user_id=$1 AND item_type='anime-series' AND state='watching'
          
          UNION
          
          -- Anime episodes (use parent anime ID)
          SELECT item_id, updated_at, 'anime-episode' as source_type
          FROM watched
          WHERE user_id=$1 AND item_type='anime-episode' AND state='watching'
          
          UNION
          
          -- Legacy anime items
          SELECT item_id, updated_at, 'anime' as source_type
          FROM watched
          WHERE user_id=$1 AND item_type='anime' AND state='watching'
        )
        SELECT DISTINCT ON (item_id) item_id, updated_at, source_type
        FROM anime_items
        ORDER BY item_id, updated_at DESC
      `;
      const animeRows = (await pool.query(animeQuery, [userId])).rows;

      // Fetch metadata for all items
      const movieMetadata = await fetchTmdbMetadata(
          moviesRows.map(row => ({ item_type: 'tmdb-movie', item_id: row.item_id }))
      );

      const seriesMetadata = await fetchTmdbMetadata(
          seriesRows.map(row => ({ item_type: 'tmdb-tv', item_id: row.item_id }))
      );

      const animeMetadata = await fetchAnilistMetadata(
          animeRows.map(row => ({ item_type: row.source_type, item_id: row.item_id }))
      );

      // Enrich movies data with metadata
      const enrichedMovies = moviesRows.map(row => {
        const meta = movieMetadata[`tmdb-movie:${row.item_id}`] || {};
        return {
          ...row,
          ...meta,
          item_id: row.item_id
        };
      }).filter(movie => movie.title && movie.poster_path);

      // Enrich series data with metadata
      const enrichedSeries = seriesRows.map(row => {
        const meta = seriesMetadata[`tmdb-tv:${row.item_id}`] || {};
        return {
          ...row,
          ...meta,
          item_id: row.item_id
        };
      }).filter(series => series.name && series.poster_path);

      // Split and enrich anime data
      const allAnimeWithMeta = animeRows.map(row => {
        const keyBase = row.source_type === 'anime'
            ? 'anime'
            : row.source_type;
        const meta = animeMetadata[`${keyBase}:${row.item_id}`] || {};

        return {
          ...row,
          ...meta,
          item_id: row.item_id
        };
      });

      // Filter anime with metadata and split into movies/series
      const enrichedAnimeItems = allAnimeWithMeta.filter(item =>
          item.coverImage && (item.title_english || item.title_romaji)
      );

      // Separate anime movies from series based on format & episodes
      const enrichedAnimeMovies = enrichedAnimeItems
          .filter(anime => {
            // Movies typically have 1 episode or are marked as MOVIE format
            return anime.episodes === 1 || anime.format === 'MOVIE';
          })
          .slice(0, 5); // Limit to top 5

      const enrichedAnimeSeries = enrichedAnimeItems
          .filter(anime => {
            // Series have multiple episodes or aren't specifically movies
            return anime.episodes > 1 || (anime.format !== 'MOVIE' && anime.episodes !== 1);
          })
          .slice(0, 5); // Limit to top 5

      res.json({
        ok: true,
        movies: enrichedMovies.slice(0, 5),
        series: enrichedSeries.slice(0, 5),
        animeMovies: enrichedAnimeMovies,
        animeSeries: enrichedAnimeSeries,
      });
    } catch (e) {
      console.error('Continue watching error:', e);
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