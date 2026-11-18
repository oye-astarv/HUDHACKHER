/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  reactStrictMode: true,
  // Keep the dev toolbar off the app's own header in screenshots and demos.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
