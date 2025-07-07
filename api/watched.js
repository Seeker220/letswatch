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
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

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

      // TV: combine tmdb-tv, tmdb-tv-season, tmdb-tv-episode (most recent 5 watching)
      const tvRows = (
          await pool.query(
              `SELECT * FROM watched
               WHERE user_id=$1
                 AND item_type IN ('tmdb-tv', 'tmdb-tv-season', 'tmdb-tv-episode')
                 AND state='watching'
               ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Anime: combine anime-series, anime-episode (most recent 5 watching)
      const animeRows = (
          await pool.query(
              `SELECT * FROM watched
           WHERE user_id=$1 
             AND item_type IN ('anime-series', 'anime-episode')
             AND state='watching'
           ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Anime Movies (most recent 5 watching)
      const animeMoviesRows = (
          await pool.query(
              `SELECT * FROM watched
               WHERE user_id=$1 AND item_type='anime-movie' AND state='watching'
               ORDER BY updated_at DESC LIMIT 5`,
              [userId]
          )
      ).rows;

      // Fetch details for each item for display (title/poster)
      async function enrichRows(rows) {
        // Group by type for optimal batching
        const tmdbMovieIds = [];
        const tmdbTvIds = [];
        const animeIds = [];
        const animeEpisodeIds = [];
        rows.forEach(row => {
          if (row.item_type === 'tmdb-movie') tmdbMovieIds.push(row.item_id);
          else if (row.item_type === 'tmdb-tv') tmdbTvIds.push(row.item_id);
          else if (row.item_type === 'anime-movie' || row.item_type === 'anime-series') animeIds.push(row.item_id);
          else if (row.item_type === 'anime-episode') animeEpisodeIds.push(row.item_id);
        });
        // TMDB movies
        let tmdbMovieData = {};
        if (tmdbMovieIds.length) {
          const results = await fetch(`https://api.themoviedb.org/3/movie?ids=${tmdbMovieIds.join(',')}&api_key=${process.env.TMDB_API_KEY}`).then(r => r.json()).catch(() => []);
          if (Array.isArray(results)) {
            for (const movie of results) {
              tmdbMovieData[movie.id] = movie;
            }
          }
        }
        // TMDB TV (for top-level shows only; seasons/episodes handled below)
        let tmdbTvData = {};
        if (tmdbTvIds.length) {
          const results = await fetch(`https://api.themoviedb.org/3/tv?ids=${tmdbTvIds.join(',')}&api_key=${process.env.TMDB_API_KEY}`).then(r => r.json()).catch(() => []);
          if (Array.isArray(results)) {
            for (const tv of results) {
              tmdbTvData[tv.id] = tv;
            }
          }
        }
        // AniList: fetch each anime (series/movie)
        let animeData = {};
        if (animeIds.length) {
          for (const id of animeIds) {
            try {
              const res = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query: `
                    query ($id: Int) {
                      Media(id: $id) {
                        id
                        title { english romaji }
                        coverImage { large }
                        seasonYear
                      }
                    }`,
                  variables: { id: Number(id) }
                })
              });
              const data = await res.json();
              if (data?.data?.Media) animeData[id] = data.data.Media;
            } catch {}
          }
        }
        // Anime episodes: get show data for episode parent (use episode row.item_id as anime id)
        let animeEpisodeData = {};
        if (animeEpisodeIds.length) {
          for (const id of animeEpisodeIds) {
            try {
              const res = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query: `
                    query ($id: Int) {
                      Media(id: $id) {
                        id
                        title { english romaji }
                        coverImage { large }
                        seasonYear
                      }
                    }`,
                  variables: { id: Number(id) }
                })
              });
              const data = await res.json();
              if (data?.data?.Media) animeEpisodeData[id] = data.data.Media;
            } catch {}
          }
        }

        // Return rows with attached metadata
        return rows.map(row => {
          let meta = {};
          if (row.item_type === 'tmdb-movie' && tmdbMovieData[row.item_id]) {
            meta = {
              title: tmdbMovieData[row.item_id].title,
              poster_path: tmdbMovieData[row.item_id].poster_path,
              year: (tmdbMovieData[row.item_id].release_date || '').split('-')[0]
            };
          } else if (row.item_type === 'tmdb-tv' && tmdbTvData[row.item_id]) {
            meta = {
              title: tmdbTvData[row.item_id].name,
              poster_path: tmdbTvData[row.item_id].poster_path,
              year: (tmdbTvData[row.item_id].first_air_date || '').split('-')[0]
            };
          } else if ((row.item_type === 'anime-movie' || row.item_type === 'anime-series') && animeData[row.item_id]) {
            meta = {
              title: animeData[row.item_id].title.english || animeData[row.item_id].title.romaji,
              coverImage: animeData[row.item_id].coverImage,
              year: animeData[row.item_id].seasonYear
            };
          } else if (row.item_type === 'anime-episode' && animeEpisodeData[row.item_id]) {
            meta = {
              title: animeEpisodeData[row.item_id].title.english || animeEpisodeData[row.item_id].title.romaji,
              coverImage: animeEpisodeData[row.item_id].coverImage,
              year: animeEpisodeData[row.item_id].seasonYear,
              episode_number: row.episode_number
            };
          }
          return { ...row, ...meta };
        });
      }

      const enrichedMovies = await enrichRows(moviesRows);
      const enrichedTv = await enrichRows(tvRows);
      const enrichedAnimeMovies = await enrichRows(animeMoviesRows);
      const enrichedAnime = await enrichRows(animeRows);

      res.json({
        ok: true,
        movies: enrichedMovies,
        series: enrichedTv,
        animeMovies: enrichedAnimeMovies,
        animeSeries: enrichedAnime
      });
    } catch (e) {
      console.error(e);
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

    const season = season_number !== undefined && season_number !== null ? season_number : 0;
    const episode = episode_number !== undefined && episode_number !== null ? episode_number : 0;

    if (state === 'not_watched') {
      await pool.query(
          `DELETE FROM watched
           WHERE user_id=$1 AND item_type=$2 AND item_id=$3 AND season_number=$4 AND episode_number=$5`,
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