import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.0.101", "192.168.0.103", "open.claw", "develop.home"],
  experimental: {
    proxyClientMaxBodySize: "1gb",
  },
};

export default nextConfig;
