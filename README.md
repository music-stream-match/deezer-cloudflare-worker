# Deezer Proxy - Cloudflare Worker

Proxy server for Deezer's internal `gw-light.php` API, enabling browser-based applications to interact with Deezer using ARL authentication.

## Setup

1. Install dependencies:
   ```bash
   cd cloudflare-worker
   npm install
   ```

2. Login to Cloudflare:
   ```bash
   npx wrangler login
   ```

3. Deploy:
   ```bash
   npm run deploy
   ```

4. Add custom domain in Cloudflare Dashboard:
   - Go to Workers & Pages > deezer-proxy > Settings > Triggers > Custom Domains
   - Add: `deezer.music-stream-match.mobulum.com`

## Local Development

```bash
npm run dev
```

This starts a local server at `http://localhost:8787`

## API Endpoints

All endpoints require `X-Deezer-ARL` header with user's ARL cookie value.

### `GET /init`
Initialize session and get user data.

**Response:**
```json
{
  "success": true,
  "apiToken": "...",
  "user": {
    "id": "123456",
    "name": "Username",
    "picture": "https://..."
  }
}
```

### `POST /api/call`
Generic API call to Deezer gw-light.php.

**Body:**
```json
{
  "method": "deezer.pagePlaylist",
  "params": { "playlist_id": "123456" },
  "apiToken": "optional - will be fetched if not provided"
}
```

### `GET /api/playlists`
Get user's playlists.

### `GET /api/playlist/:id`
Get playlist details with tracks.

### `POST /api/playlist/create`
Create a new playlist.

**Body:**
```json
{
  "title": "My Playlist",
  "description": "Description",
  "status": "private",
  "songs": ["123", "456"]
}
```

### `POST /api/playlist/addSongs`
Add songs to a playlist.

**Body:**
```json
{
  "playlistId": "123456",
  "songs": ["789", "012"]
}
```

### `GET /api/search?q=query&type=TRACK&start=0&limit=10`
Search for tracks, artists, albums, or playlists.

**Parameters:**
- `q` - Search query (required)
- `type` - TRACK, ARTIST, ALBUM, or PLAYLIST (default: TRACK)
- `start` - Start index (default: 0)
- `limit` - Number of results (default: 10)

### `GET /api/track?id=trackId`
Get track details.

## Security

- CORS is restricted to allowed origins configured in `wrangler.toml`
- ARL tokens are never stored, only forwarded to Deezer
- All communication uses HTTPS
