const axios = require('axios');

module.exports = async (req, res) => {
  const query = req.query.q;
  const page = parseInt(req.query.page || 1);

  const graphqlQuery = {
    query: `
      query ($search: String, $page: Int) {
        Page(page: $page, perPage: 20) {
          pageInfo {
            total
            perPage
            currentPage
            lastPage
            hasNextPage
          }
          media(search: $search, type: ANIME) {
            id
            title {
              romaji
              english
              native
            }
            coverImage {
              large
            }
            episodes
            format
            seasonYear
            siteUrl
          }
        }
      }
    `,
    variables: {
      search: query,
      page: page
    }
  };

  try {
    const response = await axios.post('https://graphql.anilist.co', graphqlQuery, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    const result = response.data.data.Page;
    res.status(200).json({
      media: result.media,
      totalPages: result.pageInfo.lastPage
    });
  } catch (error) {
    console.error('AniList Error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Error fetching anime from AniList' });
  }
};
