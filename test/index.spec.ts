import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Mock Deezer getUserData response
function mockUserDataResponse(token = "test_csrf_token_12345", userId = 123456, userName = "TestUser", userPicture = "abc123") {
	return {
		results: {
			checkForm: token,
			USER: {
				USER_ID: userId,
				BLOG_NAME: userName,
				USER_PICTURE: userPicture,
			},
		},
	};
}

// Helper to create a mock fetch that intercepts Deezer API calls
function createMockFetch(responses: Array<{ match?: (url: string, method: string) => boolean; body: unknown }>) {
	let callIndex = 0;
	return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.url;
		const entry = responses[callIndex] ?? responses[responses.length - 1];
		callIndex++;
		return new Response(JSON.stringify(entry.body), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Set-Cookie": "sid=test_session_id; Path=/",
			},
		});
	});
}

async function callWorker(request: Request<unknown, IncomingRequestCfProperties>) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("Health check", () => {
	it("GET / returns status ok", async () => {
		const response = await callWorker(new IncomingRequest("http://localhost/"));
		expect(response.status).toBe(200);
		const data = await response.json() as { status: string; service: string };
		expect(data.status).toBe("ok");
		expect(data.service).toBe("deezer-proxy");
	});

	it("GET /health returns status ok", async () => {
		const response = await callWorker(new IncomingRequest("http://localhost/health"));
		expect(response.status).toBe(200);
		const data = await response.json() as { status: string };
		expect(data.status).toBe("ok");
	});
});

describe("CORS", () => {
	it("OPTIONS returns 204 with CORS headers", async () => {
		const request = new IncomingRequest("http://localhost/api/call", {
			method: "OPTIONS",
			headers: { Origin: "https://localhost-vite.mobulum.xyz" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost-vite.mobulum.xyz");
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
	});

	it("returns ALLOWED_ORIGIN when Origin header is not present", async () => {
		// Note: Origin is a forbidden request header and cannot be set in the Workers runtime
		const request = new IncomingRequest("http://localhost/");
		const response = await callWorker(request);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(env.ALLOWED_ORIGIN);
	});

	it("CORS headers include correct methods and headers", async () => {
		const request = new IncomingRequest("http://localhost/");
		const response = await callWorker(request);
		expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
		expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Deezer-ARL");
	});
});

describe("Authentication", () => {
	it("returns 401 when X-Deezer-ARL header is missing", async () => {
		const request = new IncomingRequest("http://localhost/init");
		const response = await callWorker(request);
		expect(response.status).toBe(401);
		const data = await response.json() as { error: string };
		expect(data.error).toContain("Missing X-Deezer-ARL");
	});
});

describe("API routes with mocked Deezer", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("GET /init returns user data", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
		]);

		const request = new IncomingRequest("http://localhost/init", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
		const data = await response.json() as { success: boolean; apiToken: string; user: { id: string; name: string; picture: string } };
		expect(data.success).toBe(true);
		expect(data.apiToken).toBe("test_csrf_token_12345");
		expect(data.user.id).toBe("123456");
		expect(data.user.name).toBe("TestUser");
		expect(data.user.picture).toContain("abc123");
	});

	it("GET /api/init also works", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
		]);

		const request = new IncomingRequest("http://localhost/api/init", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
		const data = await response.json() as { success: boolean };
		expect(data.success).toBe(true);
	});

	it("returns 500 when Deezer returns no results", async () => {
		globalThis.fetch = createMockFetch([
			{ body: { error: { type: "DataException" } } },
		]);

		const request = new IncomingRequest("http://localhost/init", {
			headers: { "X-Deezer-ARL": "invalid_arl" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(500);
		const data = await response.json() as { error: string };
		expect(data.error).toContain("Failed to get user data");
	});

	it("POST /api/call proxies API method", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
			{ body: { results: { data: [{ SNG_ID: "123", SNG_TITLE: "Test Song" }] } } },
		]);

		const request = new IncomingRequest("http://localhost/api/call", {
			method: "POST",
			headers: {
				"X-Deezer-ARL": "test_arl_value",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ method: "search.music", params: { query: "test" } }),
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
		const data = await response.json() as { results: { data: unknown[] } };
		expect(data.results.data).toHaveLength(1);
	});

	it("POST /api/call returns 400 when method is missing", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
		]);

		const request = new IncomingRequest("http://localhost/api/call", {
			method: "POST",
			headers: {
				"X-Deezer-ARL": "test_arl_value",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const response = await callWorker(request);
		expect(response.status).toBe(400);
		const data = await response.json() as { error: string };
		expect(data.error).toContain("Missing method");
	});

	it("GET /api/search searches tracks", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
			{ body: { results: { TRACK: { data: [{ SNG_ID: "1" }] } } } },
		]);

		const request = new IncomingRequest("http://localhost/api/search?q=daft+punk&type=TRACK&limit=5", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
	});

	it("GET /api/search returns 400 without query", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
		]);

		const request = new IncomingRequest("http://localhost/api/search", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(400);
		const data = await response.json() as { error: string };
		expect(data.error).toContain("Missing query");
	});

	it("GET /api/playlists returns playlists", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
			{ body: { results: { TAB: { playlists: { data: [] } } } } },
		]);

		const request = new IncomingRequest("http://localhost/api/playlists", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
	});

	it("GET /api/playlist/:id returns playlist details", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
			{ body: { results: { DATA: { PLAYLIST_ID: "999" }, SONGS: { data: [] } } } },
		]);

		const request = new IncomingRequest("http://localhost/api/playlist/999", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
		const data = await response.json() as { results: { DATA: { PLAYLIST_ID: string } } };
		expect(data.results.DATA.PLAYLIST_ID).toBe("999");
	});

	it("POST /api/playlist/create creates a playlist", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
			{ body: { results: 12345 } },
		]);

		const request = new IncomingRequest("http://localhost/api/playlist/create", {
			method: "POST",
			headers: {
				"X-Deezer-ARL": "test_arl_value",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title: "My Playlist", status: "private" }),
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
		const data = await response.json() as { results: number };
		expect(data.results).toBe(12345);
	});

	it("POST /api/playlist/create returns 400 without title", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
		]);

		const request = new IncomingRequest("http://localhost/api/playlist/create", {
			method: "POST",
			headers: {
				"X-Deezer-ARL": "test_arl_value",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const response = await callWorker(request);
		expect(response.status).toBe(400);
		const data = await response.json() as { error: string };
		expect(data.error).toContain("Missing title");
	});

	it("POST /api/playlist/addSongs adds songs", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
			{ body: { results: true } },
		]);

		const request = new IncomingRequest("http://localhost/api/playlist/addSongs", {
			method: "POST",
			headers: {
				"X-Deezer-ARL": "test_arl_value",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ playlistId: "999", songs: ["111", "222"] }),
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
	});

	it("POST /api/playlist/addSongs returns 400 without required fields", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
		]);

		const request = new IncomingRequest("http://localhost/api/playlist/addSongs", {
			method: "POST",
			headers: {
				"X-Deezer-ARL": "test_arl_value",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const response = await callWorker(request);
		expect(response.status).toBe(400);
	});

	it("GET /api/track returns track data", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
			{ body: { results: { SNG_ID: "555", SNG_TITLE: "Test Track" } } },
		]);

		const request = new IncomingRequest("http://localhost/api/track?id=555", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(200);
		const data = await response.json() as { results: { SNG_ID: string } };
		expect(data.results.SNG_ID).toBe("555");
	});

	it("GET /api/track returns 400 without id", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
		]);

		const request = new IncomingRequest("http://localhost/api/track", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(400);
		const data = await response.json() as { error: string };
		expect(data.error).toContain("Missing track id");
	});

	it("returns 404 for unknown routes", async () => {
		globalThis.fetch = createMockFetch([
			{ body: mockUserDataResponse() },
		]);

		const request = new IncomingRequest("http://localhost/unknown", {
			headers: { "X-Deezer-ARL": "test_arl_value" },
		});
		const response = await callWorker(request);
		expect(response.status).toBe(404);
	});
});

describe("Deezer API call details", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends ARL cookie and correct user-agent to Deezer", async () => {
		const mockFn = createMockFetch([
			{ body: mockUserDataResponse() },
		]);
		globalThis.fetch = mockFn;

		const request = new IncomingRequest("http://localhost/init", {
			headers: { "X-Deezer-ARL": "my_secret_arl" },
		});
		await callWorker(request);

		expect(mockFn).toHaveBeenCalledTimes(1);
		const [calledUrl, calledInit] = mockFn.mock.calls[0];
		const url = typeof calledUrl === "string" ? calledUrl : calledUrl.url;
		expect(url).toContain("gw-light.php");
		expect(url).toContain("method=deezer.getUserData");
		expect(url).toContain("api_token=null");
		const headers = calledInit?.headers as Record<string, string>;
		expect(headers["Cookie"]).toContain("arl=my_secret_arl");
		expect(headers["User-Agent"]).toContain("Chrome");
	});

	it("passes session cookies to subsequent API calls", async () => {
		const mockFn = createMockFetch([
			{ body: mockUserDataResponse() },
			{ body: { results: { data: [] } } },
		]);
		globalThis.fetch = mockFn;

		const request = new IncomingRequest("http://localhost/api/call", {
			method: "POST",
			headers: {
				"X-Deezer-ARL": "test_arl",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ method: "search.music", params: { query: "test" } }),
		});
		await callWorker(request);

		expect(mockFn).toHaveBeenCalledTimes(2);
		// Second call should include session cookies from first response
		const [, secondInit] = mockFn.mock.calls[1];
		const headers = secondInit?.headers as Record<string, string>;
		expect(headers["Cookie"]).toContain("sid=test_session_id");
		expect(headers["Cookie"]).toContain("arl=test_arl");

		// Second call should use the CSRF token from first response
		const [secondUrl] = mockFn.mock.calls[1];
		const url = typeof secondUrl === "string" ? secondUrl : secondUrl.url;
		expect(url).toContain("api_token=test_csrf_token_12345");
	});
});
