const axios = require('axios');

module.exports = async (req, res) => {
  const query = req.query.q;

  const graphqlQuery = {
    query: `
      query ($search: String) {
        Page(perPage: 20) {
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
      search: query
    }
  };

  try {
    const response = await axios.post('https://graphql.anilist.co', graphqlQuery, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    res.status(200).json(response.data.data.Page.media);
  } catch (error) {
    console.error('AniList Error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Error fetching anime from AniList' });
  }
};
