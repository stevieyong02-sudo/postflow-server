// PostFlow Video Renderer
// Called by server.js to render videos server-side using Remotion

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'public', 'videos');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

let bundleCache = null;

// Use system Chrome on Railway (installed via Dockerfile)
const CHROME_EXECUTABLE = process.env.REMOTION_CHROME_EXECUTABLE || undefined;

export async function renderVideo({ slides, outputFilename }) {
  const videoId = outputFilename || `video_${crypto.randomBytes(6).toString('hex')}`;
  const outputPath = path.join(OUTPUT_DIR, `${videoId}.mp4`);

  console.log(`[Renderer] Starting render for ${videoId}...`);

  try {
    // Bundle the composition (cached after first run)
    if (!bundleCache) {
      console.log('[Renderer] Bundling composition...');
      bundleCache = await bundle({
        entryPoint: path.join(__dirname, 'src', 'VideoComposition.jsx'),
        webpackOverride: (config) => config,
      });
      console.log('[Renderer] Bundle complete');
    }

    // Select the composition
    const composition = await selectComposition({
      serveUrl: bundleCache,
      id: 'PostFlowVideo',
      inputProps: { slides },
    });

    // Render to MP4
    await renderMedia({
      composition,
      serveUrl: bundleCache,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps: { slides },
      chromiumOptions: CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {},
      onProgress: ({ progress }) => {
        process.stdout.write(`\r[Renderer] ${Math.round(progress * 100)}%`);
      },
    });

    console.log(`\n[Renderer] ✅ Done: ${outputPath}`);

    return {
      success: true,
      videoId,
      filename: `${videoId}.mp4`,
      publicUrl: `/videos/${videoId}.mp4`,
    };
  } catch (err) {
    console.error('[Renderer] ❌ Error:', err.message);
    return { success: false, error: err.message };
  }
}
