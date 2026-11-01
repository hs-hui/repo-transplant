import { readFile, writeFile } from "node:fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { TransplantError } from "../util/errors.js";

export interface VisualComparison {
  width: number;
  height: number;
  size_match: boolean;
  mismatched_pixels: number;
  mismatch_percent: number;
  diff_path: string;
}

function padTo(image: PNG, width: number, height: number): Buffer {
  const canvas = new PNG({ width, height });
  canvas.data.fill(255);
  PNG.bitblt(image, canvas, 0, 0, image.width, image.height, 0, 0);
  return canvas.data;
}

async function readPng(file: string): Promise<PNG> {
  try {
    return PNG.sync.read(await readFile(file));
  } catch (error) {
    throw new TransplantError("invalid_image", `Could not read PNG ${file}: ${(error as Error).message}`);
  }
}

/** Pixel-diffs two screenshots. Smaller images are padded so differing sizes still compare. */
export async function compareScreenshots(
  beforePath: string,
  afterPath: string,
  diffPath: string,
  threshold = 0.1,
): Promise<VisualComparison> {
  const [before, after] = await Promise.all([readPng(beforePath), readPng(afterPath)]);
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(
    padTo(before, width, height),
    padTo(after, width, height),
    diff.data,
    width,
    height,
    {
      threshold,
    },
  );
  await writeFile(diffPath, PNG.sync.write(diff));
  return {
    width,
    height,
    size_match: before.width === after.width && before.height === after.height,
    mismatched_pixels: mismatched,
    mismatch_percent: Math.round((mismatched / (width * height)) * 10_000) / 100,
    diff_path: diffPath,
  };
}
