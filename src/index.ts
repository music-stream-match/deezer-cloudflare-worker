/**
 * Cloudflare Worker proxy for Deezer gw-light.php API
 * 
 * This worker handles:
 * - CORS headers for browser requests
 * - ARL cookie forwarding to Deezer
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
  // Allow localhost for development
  const isAllowed = origin === allowedOrigin || 
                    origin.startsWith('http://localhost:') || 
                    origin.startsWith('https://localhost');
  
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Deezer-ARL',
    'Access-Control-Max-Age': '86400',
  };
}

// Handle preflight requests
function handleOptions(request: Request, env: Env): Response {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, env.ALLOWED_ORIGIN),
  });
}

// Make API call to Deezer
async function deezerApiCall(
  method: string,
  body: unknown | null,
  arl: string,
  apiToken: string | null,
  params: Record<string, string> = {}
): Promise<Response> {
  const url = new URL(DEEZER_GW_URL);
  url.searchParams.set('api_version', '1.0');
  url.searchParams.set('input', '3');
  url.searchParams.set('api_token', apiToken || 'null');
  url.searchParams.set('method', method);
  
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const fetchOptions: RequestInit = {
    method: body ? 'POST' : 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Cookie': `arl=${arl}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    fetchOptions.body = JSON.stringify(body);
  }

  return fetch(url.toString(), fetchOptions);
}

// Get API token from user data
async function getApiToken(arl: string): Promise<{ token: string; userData: UserDataResults }> {
  const response = await deezerApiCall('deezer.getUserData', null, arl, null);
  const data = await response.json() as DeezerApiResponse;
  
  if (!data.results) {
    throw new Error('Failed to get user data');
  }
  
  const results = data.results as UserDataResults;
  const token = results.checkForm;
  
  if (!token) {
    throw new Error('Could not get API token - invalid ARL?');
  }
  
  return { token, userData: results };
}

// Main request handler
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

  try {
    const url = new URL(request.url);
    const path = url.pathname;

    // Get ARL from header
    const arl = request.headers.get('X-Deezer-ARL');
    if (!arl) {
      return new Response(JSON.stringify({ error: 'Missing X-Deezer-ARL header' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Route handling
    if (path === '/init' || path === '/api/init') {
      // Initialize and get user data + API token
      const { token, userData } = await getApiToken(arl);
      
      return new Response(JSON.stringify({
        success: true,
        apiToken: token,
        user: {
          id: userData.USER?.USER_ID?.toString() || '',
          name: userData.USER?.BLOG_NAME || 'Deezer User',
          picture: userData.USER?.USER_PICTURE 
            ? `https://e-cdns-images.dzcdn.net/images/user/${userData.USER.USER_PICTURE}/100x100-000000-80-0-0.jpg`
            : undefined,
        },
      }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (path === '/api/call' || path === '/call') {
      // Generic API call endpoint
      const body = await request.json() as {
        method: string;
        params?: unknown;
        apiToken?: string;
      };
      
      if (!body.method) {
        return new Response(JSON.stringify({ error: 'Missing method parameter' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      let apiToken = body.apiToken;
      
      // If no token provided, get one
      if (!apiToken) {
        const { token } = await getApiToken(arl);
        apiToken = token;
      }

      const response = await deezerApiCall(body.method, body.params || null, arl, apiToken);
      const data = await response.json() as DeezerApiResponse;

      // Check for token errors and retry
      if (data.error && !(data.error instanceof Array)) {
        const errorObj = data.error as Record<string, string>;
        if (errorObj.GATEWAY_ERROR === 'invalid api token' || 
            errorObj.VALID_TOKEN_REQUIRED === 'Invalid CSRF token') {
          // Get fresh token and retry
          const { token: newToken } = await getApiToken(arl);
          const retryResponse = await deezerApiCall(body.method, body.params || null, arl, newToken);
          const retryData = await retryResponse.json();
          
          return new Response(JSON.stringify(retryData), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Convenience endpoints
    if (path === '/api/playlists' || path === '/playlists') {
      const { token } = await getApiToken(arl);
      
      // Get user's playlists using pageProfile
      const userId = url.searchParams.get('userId');
      
      if (!userId) {
        // First get user ID from userData
        const userDataResponse = await deezerApiCall('deezer.getUserData', null, arl, token);
        const userData = await userDataResponse.json() as DeezerApiResponse;
        const results = userData.results as UserDataResults;
        const actualUserId = results?.USER?.USER_ID;
        
        if (!actualUserId) {
          return new Response(JSON.stringify({ error: 'Could not get user ID' }), {
            status: 400,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        
        const response = await deezerApiCall('deezer.pageProfile', {
          user_id: actualUserId,
          tab: 'playlists',
          nb: 10000,
        }, arl, token);
        
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const response = await deezerApiCall('deezer.pageProfile', {
        user_id: parseInt(userId),
        tab: 'playlists',
        nb: 10000,
      }, arl, token);
      
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (path.startsWith('/api/playlist/') || path.startsWith('/playlist/')) {
      const playlistId = path.split('/').pop();
      
      if (!playlistId) {
        return new Response(JSON.stringify({ error: 'Missing playlist ID' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const { token } = await getApiToken(arl);
      const response = await deezerApiCall('deezer.pagePlaylist', {
        playlist_id: playlistId,
        lang: 'en',
        nb: 10000,
        start: 0,
        tab: 0,
        header: true,
      }, arl, token);
      
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (path === '/api/playlist/create' || path === '/playlist/create') {
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

      const { token } = await getApiToken(arl);
      const statusIndex = ['public', 'private', 'collaborative'].indexOf(body.status || 'private');
      const songs = (body.songs || []).map(id => [id, 0]);

      const response = await deezerApiCall('playlist.create', {
        title: body.title,
        description: body.description || '',
        status: statusIndex,
        songs,
      }, arl, token);
      
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (path === '/api/playlist/addSongs' || path === '/playlist/addSongs') {
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

      const { token } = await getApiToken(arl);
      const songs = body.songs.map(id => [id, 0]);

      const response = await deezerApiCall('playlist.addSongs', {
        playlist_id: body.playlistId,
        songs,
        offset: -1,
      }, arl, token);
      
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

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

      const { token } = await getApiToken(arl);
      const response = await deezerApiCall('search.music', {
        query,
        output: type,
        start,
        nb: limit,
        filter: 'ALL',
      }, arl, token);
      
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (path === '/api/track' || path === '/track') {
      const trackId = url.searchParams.get('id');
      
      if (!trackId) {
        return new Response(JSON.stringify({ error: 'Missing track id parameter' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const { token } = await getApiToken(arl);
      const response = await deezerApiCall('song.getData', {
        sng_id: trackId,
      }, arl, token);
      
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Health check
    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        service: 'deezer-proxy',
        endpoints: [
          'GET /init - Initialize and get user data',
          'POST /api/call - Generic API call',
          'GET /api/playlists - Get user playlists',
          'GET /api/playlist/:id - Get playlist details',
          'POST /api/playlist/create - Create playlist',
          'POST /api/playlist/addSongs - Add songs to playlist',
          'GET /api/search?q=query&type=TRACK - Search',
          'GET /api/track?id=trackId - Get track data',
        ],
      }), {
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
