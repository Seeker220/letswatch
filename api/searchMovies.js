const axios = require('axios');

module.exports = async (req, res) => {
  const query = req.query.q;
  const page = req.query.page || 1;
  const apiKey = process.env.TMDB_API_KEY; // Load the API key from environment variables

  try {
    const response = await axios.get(`https://api.themoviedb.org/3/search/movie`, {
      params: {
        api_key: apiKey,
        query,
        page
      }
    });
    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching movies' });
  }
};
