const axios = require('axios');

module.exports = async (req, res) => {
  const query = req.query.q;
  const accessToken = process.env.MAL_ACCESS_TOKEN;

  try {
    const response = await axios.get('https://api.myanimelist.net/v2/anime', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        q: query,
        limit: 20,
        fields: 'id,title,main_picture,media_type,start_date'
      }
    });

    res.status(200).json(response.data);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch MAL data' });
  }
};
