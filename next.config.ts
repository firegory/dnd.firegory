import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.0.101", "open.claw", "develop.home", "dnd.firegory.site"],
  experimental: {
    proxyClientMaxBodySize: "1gb",
  },
};

export default nextConfig;
