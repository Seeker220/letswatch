const axios = require('axios');

module.exports = async (req, res) => {
  const idMal = req.query.idMal;
  const page = req.query.page || 1;

  const accessToken = process.env.MAL_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(500).json({ error: 'Missing MAL access token' });
  }

  try {
    const response = await axios.get(`https://api.myanimelist.net/v2/anime/${idMal}/episodes`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        limit: 20,
        offset: (page - 1) * 20,
        fields: 'title,number,image'
      }
    });

    res.status(200).json(response.data);
  } catch (error) {
    console.error('MAL error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch episodes from MAL' });
  }
};
