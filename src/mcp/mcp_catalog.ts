import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safe_json_parse } from "../util/json.js";

export interface CatalogManifest {
  name: string;
  description: string;
  transport: "stdio" | "none";
  command?: string;
  args?: string[];
  command_basename?: string;
  args_prefix?: string[];
  exclude_tools?: string[];
  missing_hint?: string;
  note?: string;
}

let cached: readonly CatalogManifest[] | undefined;

function catalog_dir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = path.join(dir, "optional-mcps");
    if (existsSync(path.join(candidate, "redot", "manifest.json")) === true) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error("mcp catalog not found");
}

function read_manifest(file: string): CatalogManifest {
  const parsed = safe_json_parse<CatalogManifest>(readFileSync(file, "utf8"));
  if (parsed === undefined || typeof parsed.name !== "string") {
    throw new Error("mcp catalog manifest rejected");
  }
  return parsed;
}

export function load_catalog(): readonly CatalogManifest[] {
  if (cached !== undefined) {
    return cached;
  }
  const manifests: CatalogManifest[] = [];
  for (const name of readdirSync(catalog_dir())) {
    const file = path.join(catalog_dir(), name, "manifest.json");
    if (existsSync(file) === true) {
      manifests.push(read_manifest(file));
    }
  }
  cached = manifests;
  return cached;
}

export function catalog_by_name(name: string): CatalogManifest | undefined {
  return load_catalog().find((entry) => entry.name === name);
}
