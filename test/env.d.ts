declare module "cloudflare:workers" {
	interface ProvidedEnv {
		ALLOWED_ORIGIN: string;
	}
}
