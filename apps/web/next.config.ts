import { loadEnvConfig } from "@next/env";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

loadEnvConfig(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: [
    "@promptlab/contracts",
    "@promptlab/db",
    "@promptlab/providers",
  ],
  poweredByHeader: false,
  reactStrictMode: true,
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
