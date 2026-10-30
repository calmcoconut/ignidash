import type { NextConfig } from 'next';
import bundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
  output: process.env.SELF_HOSTED === 'true' ? 'standalone' : undefined,
};

export default withBundleAnalyzer(nextConfig);
