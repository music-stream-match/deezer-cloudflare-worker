/**
 * Cloudflare Worker proxy for Deezer gw-light.php API
 *
 * This worker handles:
 * - CORS headers for browser requests
 * - ARL cookie forwarding to Deezer
 * - Session cookie management (critical for CSRF token to work)
 * - API token management
 *
 * Based on node-deezer-gw library approach
 */

interface Env {
  ALLOWED_ORIGIN: string;
}

interface DeezerApiResponse {
  results?: unknown;
  error?: Record<string, string> | unknown[];
}

interface UserDataResults {
  checkForm?: string;
  USER?: {
    USER_ID?: number;
    BLOG_NAME?: string;
    USER_PICTURE?: string;
  };
}

const DEEZER_GW_URL = 'https://www.deezer.com/ajax/gw-light.php';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// CORS headers helper
function corsHeaders(origin: string, allowedOrigin: string): HeadersInit {
  const isAllowed = origin === allowedOrigin ||
                    origin.startsWith('http://localhost:') ||
                    origin.startsWith('https://localhost') ||
                    origin.includes('music-stream-match.space') ||
                    origin.includes('music-stream-match.mobulum.com') ||
                    origin.includes('localhost-vite.mobulum.xyz');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Deezer-ARL',
    'Access-Control-Max-Age': '86400',
  };
}

function handleOptions(request: Request, env: Env): Response {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, env.ALLOWED_ORIGIN),
  });
}

// Session state - holds cookies and token from initial getUserData call
interface SessionState {
  cookies: string[];
  apiToken: string;
  userId: number;
  userName: string;
  userPicture?: string;
}

// Make API call to Deezer with session cookie management
async function deezerApiCall(
  method: string,
  body: unknown | null,
  arl: string,
  apiToken: string | null,
  sessionCookies: string[] = []
): Promise<{ data: DeezerApiResponse; newCookies: string[] }> {
  const url = new URL(DEEZER_GW_URL);
  url.searchParams.set('api_version', '1.0');
  url.searchParams.set('input', '3');
  url.searchParams.set('api_token', apiToken === null ? 'null' : apiToken);
  url.searchParams.set('method', method);

  // Build cookie string - combine ARL with session cookies
  const allCookies = [`arl=${arl}`, ...sessionCookies];

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Cookie': allCookies.join('; '),
  };

  const fetchOptions: RequestInit = {
    method: body ? 'POST' : 'GET',
    headers,
  };

  if (body) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(body);
  }

  console.log(`[Deezer API] ${method}, token: ${apiToken === null ? 'null' : apiToken.substring(0, 10) + '...'}, cookies: ${sessionCookies.length}`);

  const response = await fetch(url.toString(), fetchOptions);

  // Extract and merge session cookies
  const newCookies: string[] = [...sessionCookies];
  const rawSetCookie = response.headers.get('set-cookie');

  if (rawSetCookie) {
    // Parse set-cookie header(s)
    const parts = rawSetCookie.split(/,(?=\s*[a-zA-Z_][a-zA-Z0-9_]*=)/);
    for (const part of parts) {
      const cookiePart = part.trim().split(';')[0];
      if (cookiePart && cookiePart.includes('=')) {
        const name = cookiePart.split('=')[0];
        // Remove old cookie with same name
        const idx = newCookies.findIndex(c => c.startsWith(name + '='));
        if (idx >= 0) newCookies.splice(idx, 1);
        newCookies.push(cookiePart);
      }
    }
  }

  const data = await response.json() as DeezerApiResponse;
  return { data, newCookies };
}

// Initialize session - get token, cookies, and user data
async function initSession(arl: string): Promise<SessionState> {
  console.log('[Deezer API] Initializing session...');

  // First call with null token establishes session and returns CSRF token
  const { data, newCookies } = await deezerApiCall('deezer.getUserData', null, arl, null, []);

  console.log('[Deezer API] getUserData response, cookies:', newCookies.length);

  if (!data.results) {
    throw new Error('Failed to get user data - no results');
  }

  const results = data.results as UserDataResults;
  const token = results.checkForm;
  const userId = results.USER?.USER_ID;
  const userName = results.USER?.BLOG_NAME || 'Deezer User';
  const userPicture = results.USER?.USER_PICTURE;

  if (!token) {
    throw new Error('Could not get API token (checkForm) - invalid ARL?');
  }

  if (!userId) {
    throw new Error('Could not get user ID');
  }

  console.log(`[Deezer API] Session initialized, token: ${token.substring(0, 10)}..., userId: ${userId}`);

  return {
    cookies: newCookies,
    apiToken: token,
    userId,
    userName,
    userPicture,
  };
}

// Main request handler
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

  try {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check - no auth needed
    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'deezer-proxy',
      }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const arl = request.headers.get('X-Deezer-ARL');
    if (!arl) {
      return new Response(JSON.stringify({ error: 'Missing X-Deezer-ARL header' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Initialize session for all API calls
    const session = await initSession(arl);

    // Route: /init - just return user data
    if (path === '/init' || path === '/api/init') {
      return new Response(JSON.stringify({
        success: true,
        apiToken: session.apiToken,
        user: {
          id: session.userId.toString(),
          name: session.userName,
          picture: session.userPicture
            ? `https://e-cdns-images.dzcdn.net/images/user/${session.userPicture}/100x100-000000-80-0-0.jpg`
            : undefined,
        },
      }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Route: /api/call - generic API call
    if (path === '/api/call' || path === '/call') {
      const body = await request.json() as {
        method: string;
        params?: unknown;
      };

      if (!body.method) {
        return new Response(JSON.stringify({ error: 'Missing method parameter' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const { data } = await deezerApiCall(body.method, body.params || null, arl, session.apiToken, session.cookies);

      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Route: /api/playlists - get user's playlists
    if (path === '/api/playlists' || path === '/playlists') {
      const { data } = await deezerApiCall('deezer.pageProfile', {
        user_id: session.userId,
        tab: 'playlists',
        nb: 10000,
      }, arl, session.apiToken, session.cookies);

      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Route: /api/playlist/:id or special endpoints
    if (path.startsWith('/api/playlist/') || path.startsWith('/playlist/')) {
      const pathParts = path.split('/').filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];

      // POST /api/playlist/create
      if (lastPart === 'create') {
        const body = await request.json() as {
          title: string;
          description?: string;
          status?: 'public' | 'private' | 'collaborative';
          songs?: string[];
        };

        if (!body.title) {
          return new Response(JSON.stringify({ error: 'Missing title' }), {
            status: 400,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        const statusIndex = ['public', 'private', 'collaborative'].indexOf(body.status || 'private');
        const songs = (body.songs || []).map(id => [id, 0]);

        const { data } = await deezerApiCall('playlist.create', {
          title: body.title,
          description: body.description || '',
          status: statusIndex,
          songs,
        }, arl, session.apiToken, session.cookies);

        return new Response(JSON.stringify(data), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // POST /api/playlist/addSongs
      if (lastPart === 'addSongs') {
        const body = await request.json() as {
          playlistId: string;
          songs: string[];
        };

        if (!body.playlistId || !body.songs) {
          return new Response(JSON.stringify({ error: 'Missing playlistId or songs' }), {
            status: 400,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }

        const songs = body.songs.map(id => [id, 0]);

        const { data } = await deezerApiCall('playlist.addSongs', {
          playlist_id: body.playlistId,
          songs,
          offset: -1,
        }, arl, session.apiToken, session.cookies);

        return new Response(JSON.stringify(data), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // GET /api/playlist/:id - get playlist details
      const playlistId = lastPart;

      if (!playlistId || playlistId === 'playlist' || playlistId === 'api') {
        return new Response(JSON.stringify({ error: 'Missing playlist ID' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const { data } = await deezerApiCall('deezer.pagePlaylist', {
        playlist_id: playlistId,
        lang: 'en',
        nb: 10000,
        start: 0,
        tab: 0,
        header: true,
      }, arl, session.apiToken, session.cookies);

      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Route: /api/search
    if (path === '/api/search' || path === '/search') {
      const query = url.searchParams.get('q') || '';
      const type = url.searchParams.get('type') || 'TRACK';
      const start = parseInt(url.searchParams.get('start') || '0');
      const limit = parseInt(url.searchParams.get('limit') || '10');

      if (!query) {
        return new Response(JSON.stringify({ error: 'Missing query parameter q' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const { data } = await deezerApiCall('search.music', {
        query,
        output: type,
        start,
        nb: limit,
        filter: 'ALL',
      }, arl, session.apiToken, session.cookies);

      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Route: /api/track
    if (path === '/api/track' || path === '/track') {
      const trackId = url.searchParams.get('id');

      if (!trackId) {
        return new Response(JSON.stringify({ error: 'Missing track id parameter' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const { data } = await deezerApiCall('song.getData', {
        sng_id: trackId,
      }, arl, session.apiToken, session.cookies);

      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Worker error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Internal server error'
    }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return handleOptions(request, env);
    }
    return handleRequest(request, env);
  },
};
