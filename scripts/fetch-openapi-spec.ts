#!/usr/bin/env node
/**
 * @fileoverview Fetches an OpenAPI specification (YAML/JSON) from a URL,
 * parses it, and saves it locally in both YAML and JSON formats.
 * @module scripts/fetch-openapi-spec
 *   Includes fallback logic for common OpenAPI file names (openapi.yaml, openapi.json).
 *   Ensures output paths are within the project directory for security.
 *
 * @example
 * // Fetch spec and save to docs/api/my_api.yaml and docs/api/my_api.json
 * // ts-node --esm scripts/fetch-openapi-spec.ts https://api.example.com/v1 docs/api/my_api
 *
 * @example
 * // Fetch spec from a direct file URL
 * // ts-node --esm scripts/fetch-openapi-spec.ts https://petstore3.swagger.io/api/v3/openapi.json docs/api/petstore_v3
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as yaml from 'js-yaml';

const projectRoot = process.cwd();

const args = process.argv.slice(2);
const helpFlag = args.includes('--help');
const urlArg = args[0];
const outputBaseArg = args[1];

if (helpFlag || !urlArg || !outputBaseArg) {
  console.log(`
Fetch OpenAPI Specification Script

Usage:
  ts-node --esm scripts/fetch-openapi-spec.ts <url> <output-base-path> [--help]

Arguments:
  <url>                Base URL or direct URL to the OpenAPI spec (YAML/JSON).
  <output-base-path>   Base path for output files (relative to project root),
                       e.g., 'docs/api/my_api'. Will generate .yaml and .json.
  --help               Show this help message.

Example:
  ts-node --esm scripts/fetch-openapi-spec.ts https://petstore3.swagger.io/api/v3 docs/api/petstore_v3
`);
  process.exit(helpFlag ? 0 : 1);
}

const outputBasePathAbsolute = path.resolve(projectRoot, outputBaseArg);
const yamlOutputPath = `${outputBasePathAbsolute}.yaml`;
const jsonOutputPath = `${outputBasePathAbsolute}.json`;
const outputDirAbsolute = path.dirname(outputBasePathAbsolute);

// Security Check: Ensure output paths are within project root
if (
  !outputDirAbsolute.startsWith(projectRoot + path.sep) ||
  !yamlOutputPath.startsWith(projectRoot + path.sep) ||
  !jsonOutputPath.startsWith(projectRoot + path.sep)
) {
  console.error(
    `Error: Output path "${outputBaseArg}" resolves outside the project directory. Aborting.`,
  );
  process.exit(1);
}

/**
 * Attempts to fetch content from a given URL.
 * @param url - The URL to fetch data from.
 * @returns A promise resolving to an object with data and content type, or null if fetch fails.
 */
async function tryFetch(url: string): Promise<{ data: string; contentType: string | null } | null> {
  try {
    console.log(`Attempting to fetch from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`Failed to fetch from ${url} (Status: ${response.status})`);
      return null;
    }
    const contentType = response.headers.get('content-type');
    const data = await response.text();
    console.log(
      `Successfully fetched (Status: ${response.status}, Content-Type: ${contentType || 'N/A'})`,
    );
    return { data, contentType };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to fetch from ${url} (${message})`);
    return null;
  }
}

/**
 * Parses fetched data as YAML or JSON, attempting to infer from content type or by trying both.
 * @param data - The raw string data fetched from the URL.
 * @param contentType - The content type header from the HTTP response, if available.
 * @returns The parsed OpenAPI specification as an object, or null if parsing fails.
 */
function parseSpec(data: string, contentType: string | null): object | null {
  try {
    const lowerContentType = contentType?.toLowerCase();
    if (lowerContentType?.includes('yaml') || lowerContentType?.includes('yml')) {
      console.log('Parsing content as YAML based on Content-Type...');
      const parsed = yaml.load(data);
      if (parsed && typeof parsed === 'object') return parsed;
      return null;
    } else if (lowerContentType?.includes('json')) {
      console.log('Parsing content as JSON based on Content-Type...');
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === 'object') return parsed;
      return null;
    } else {
      console.log('Content-Type is ambiguous or missing. Attempting to parse as YAML first...');
      try {
        const parsedYaml = yaml.load(data);
        // Basic validation: check if it's a non-null object.
        if (parsedYaml && typeof parsedYaml === 'object') {
          console.log('Successfully parsed as YAML.');
          return parsedYaml;
        }
      } catch (_yamlError) {
        console.log('YAML parsing failed. Attempting to parse as JSON...');
        try {
          const parsedJson = JSON.parse(data) as unknown;
          if (parsedJson && typeof parsedJson === 'object') {
            console.log('Successfully parsed as JSON.');
            return parsedJson;
          }
        } catch (_jsonError) {
          console.warn('Could not parse content as YAML or JSON after attempting both.');
          return null;
        }
      }
      // If YAML parsing resulted in a non-object (e.g. string, number) but didn't throw
      console.warn('Content parsed as YAML but was not a valid object structure. Trying JSON.');
      try {
        const parsedJson = JSON.parse(data) as unknown;
        if (parsedJson && typeof parsedJson === 'object') {
          console.log('Successfully parsed as JSON on second attempt for non-object YAML.');
          return parsedJson;
        }
      } catch (_jsonError) {
        console.warn('Could not parse content as YAML or JSON after attempting both.');
        return null;
      }
    }
  } catch (parseError) {
    console.error(
      `Error parsing specification: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    );
  }
  return null;
}

/**
 * Main orchestrator function. Fetches the OpenAPI spec from the provided URL (with fallbacks),
 * parses it, and saves it to the specified output paths in both YAML and JSON formats.
 */
async function fetchAndProcessSpec(): Promise<void> {
  if (!urlArg) {
    console.error('URL argument is missing.');
    process.exit(1);
  }
  let fetchedResult: { data: string; contentType: string | null } | null = null;
  const potentialUrls: string[] = [urlArg];

  if (!urlArg.endsWith('.yaml') && !urlArg.endsWith('.yml') && !urlArg.endsWith('.json')) {
    const urlWithoutTrailingSlash = urlArg.endsWith('/') ? urlArg.slice(0, -1) : urlArg;
    potentialUrls.push(`${urlWithoutTrailingSlash}/openapi.yaml`);
    potentialUrls.push(`${urlWithoutTrailingSlash}/openapi.json`);
  }

  for (const url of potentialUrls) {
    fetchedResult = await tryFetch(url);
    if (fetchedResult) break;
  }

  if (!fetchedResult) {
    console.error(
      `Error: Failed to fetch specification from all attempted URLs: ${potentialUrls.join(', ')}. Aborting.`,
    );
    process.exit(1);
  }

  const openapiSpec = parseSpec(fetchedResult.data, fetchedResult.contentType);

  if (!openapiSpec || typeof openapiSpec !== 'object') {
    console.error(
      'Error: Failed to parse specification content or content is not a valid object. Aborting.',
    );
    process.exit(1);
  }

  try {
    await fs.access(outputDirAbsolute);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      console.log(`Output directory not found. Creating: ${outputDirAbsolute}`);
      await fs.mkdir(outputDirAbsolute, { recursive: true });
    } else {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `Error accessing output directory ${outputDirAbsolute}: ${errorMessage}. Aborting.`,
      );
      process.exit(1);
    }
  }

  try {
    console.log(`Saving YAML specification to: ${yamlOutputPath}`);
    await fs.writeFile(yamlOutputPath, yaml.dump(openapiSpec), 'utf8');
    console.log(`Successfully saved YAML specification.`);
  } catch (error: unknown) {
    console.error(
      `Error saving YAML to ${yamlOutputPath}: ${error instanceof Error ? error.message : String(error)}. Aborting.`,
    );
    process.exit(1);
  }

  try {
    console.log(`Saving JSON specification to: ${jsonOutputPath}`);
    await fs.writeFile(jsonOutputPath, JSON.stringify(openapiSpec, null, 2), 'utf8');
    console.log(`Successfully saved JSON specification.`);
  } catch (error: unknown) {
    console.error(
      `Error saving JSON to ${jsonOutputPath}: ${error instanceof Error ? error.message : String(error)}. Aborting.`,
    );
    process.exit(1);
  }

  console.log('OpenAPI specification processed and saved successfully.');
}

// Intentionally not awaiting; internal try/catch handles errors.
void fetchAndProcessSpec();
