import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cacheLife } from 'next/cache';

const GITHUB_RAW_URL =
  'https://raw.githubusercontent.com/Kilo-Org/kilo-marketplace/main/mcps/marketplace.yaml';

async function fetchMarketplaceYaml() {
  'use cache';
  cacheLife({ revalidate: 3600 });

  const response = await fetch(GITHUB_RAW_URL);
  if (!response.ok) {
    console.error(`Failed to fetch MCPs from GitHub: ${response.status} ${response.statusText}`);
    return null;
  }
  return response.text();
}

export async function GET(_request: NextRequest) {
  try {
    const yamlContent = await fetchMarketplaceYaml();

    if (!yamlContent) {
      return new NextResponse('items: []\n', {
        status: 502,
        headers: { 'Content-Type': 'application/x-yaml' },
      });
    }

    return new NextResponse(yamlContent, {
      headers: {
        'Content-Type': 'application/x-yaml',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (error) {
    console.error('Error fetching MCPs marketplace data:', error);

    return new NextResponse('items: []\n', {
      status: 500,
      headers: { 'Content-Type': 'application/x-yaml' },
    });
  }
}
