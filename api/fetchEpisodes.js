const axios = require('axios');

module.exports = async (req, res) => {
  const tmdbId = req.query.id;
  const seasonNumber = req.query.season;
  const apiKey = process.env.TMDB_API_KEY;

  try {
    const response = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}`, {
      params: {
        api_key: apiKey
      }
    });
    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching episodes' });
  }
};
