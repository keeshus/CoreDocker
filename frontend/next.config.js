/** @type {import('next').NextConfig} */
const backendHost = process.env.BACKEND_HOST || 'backend';

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `http://${backendHost}:3000/api/:path*`,
      },
    ]
  },
}

export default nextConfig;