// /api/imdb.js
export default async function handler(req, res) {
  const { type, id } = req.query;

  if (!type || !id) {
    return res.status(400).json({ error: "Missing type or id" });
  }

  const apiKey = process.env.TMDB_API_KEY;
  const tmdbUrl =
    type === "movie"
      ? `https://api.themoviedb.org/3/movie/${id}/external_ids?api_key=${apiKey}`
      : `https://api.themoviedb.org/3/tv/${id}/external_ids?api_key=${apiKey}`;

  try {
    const response = await fetch(tmdbUrl);
    if (!response.ok) {
      return res.status(500).json({ error: "Failed to fetch from TMDB" });
    }

    const data = await response.json();
    return res.status(200).json({ imdb_id: data.imdb_id || null });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
}
