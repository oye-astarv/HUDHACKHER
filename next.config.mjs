/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";

const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  reactStrictMode: true,
  ...(isDev
    ? {
        // In dev, the Worker runs separately under `wrangler dev` on :8787.
        async rewrites() {
          return [
            { source: "/api/:path*", destination: "http://127.0.0.1:8787/api/:path*" },
            { source: "/track/:id", destination: "/track" },
          ];
        },
      }
    : {
        // Production: static export served by the Cloudflare Worker (wrangler.jsonc).
        output: "export",
        images: { unoptimized: true },
      }),
};

export default nextConfig;
