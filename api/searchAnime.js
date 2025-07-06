// searchanime.js (Updated: 20 items per page)
const axios = require('axios');

module.exports = async (req, res) => {
  const query = req.query.q;
  const moviesPage = parseInt(req.query.moviesPage || 1);
  const seriesPage = parseInt(req.query.seriesPage || 1);
  const perPage = 20; // updated to 20 items per page for frontend

  let allAnime = [];
  let current = 1;
  const maxPerFetch = 50;

  try {
    while (true) {
      const graphqlQuery = {
        query: `
          query ($search: String, $page: Int, $perPage: Int) {
            Page(page: $page, perPage: $perPage) {
              pageInfo {
                currentPage
                hasNextPage
              }
              media(search: $search, type: ANIME) {
                id
                title {
                  romaji
                  english
                }
                episodes
                format
                seasonYear
                coverImage {
                  large
                }
              }
            }
          }
        `,
        variables: {
          search: query,
          page: current,
          perPage: maxPerFetch
        }
      };

      const response = await axios.post('https://graphql.anilist.co', graphqlQuery, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const result = response.data.data.Page;
      allAnime.push(...result.media);

      if (!result.pageInfo.hasNextPage) break;
      current++;
    }

    // Categorize
    const animeMovies = [];
    const animeSeries = [];

    for (const anime of allAnime) {
      const episodes = anime.episodes;
      const format = anime.format;

      const isMovie = (episodes === 1) || (episodes == null && !['TV', 'TV_SHORT'].includes(format));
      if (isMovie) animeMovies.push(anime);
      else animeSeries.push(anime);
    }

    const totalPages = (list) => Math.ceil(list.length / perPage);
    const getPaginated = (list, page) => list.slice((page - 1) * perPage, page * perPage);

    res.status(200).json({
      animeMovies: getPaginated(animeMovies, moviesPage),
      animeSeries: getPaginated(animeSeries, seriesPage),
      totalPages: {
        movies: totalPages(animeMovies),
        series: totalPages(animeSeries)
      },
      page: {
        movies: moviesPage,
        series: seriesPage
      }
    });
  } catch (error) {
    console.error('AniList Error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Error fetching anime from AniList' });
  }
};