/**
 * Plugin loader: dynamic-imports explicit plugin entry modules and extracts
 * the plugin object. It never throws for a bad plugin — every failure is
 * collected as an error entry so startup can warn and continue.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { Plugin } from "./types.js";

/** A successfully loaded plugin plus the entry path it came from. */
export interface LoadedPlugin {
  plugin: Plugin;
  entry: string;
}

/** One failed entry: the specifier and why it failed. */
export interface PluginLoadError {
  entry: string;
  error_message: string;
}

const MODULE_QUERY = /(\.mjs|\.js|\.ts|\.mts|\.cts|\.jsx|\.tsx)$/;

function describe_error(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function is_object_with_name(candidate: unknown): candidate is Plugin {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const plugin = candidate as Partial<Plugin>;
  return typeof plugin.name === "string" && plugin.name.length > 0;
}

/** A bare module counts as a plugin only with a name plus tools or hooks. */
function is_plugin_module(candidate: unknown): candidate is Plugin {
  if (is_object_with_name(candidate) === false) {
    return false;
  }
  const plugin = candidate as Partial<Plugin>;
  return plugin.tools !== undefined || plugin.hooks !== undefined;
}

/** Accepts default export, a named `plugin` export, or the module itself. */
function extract_plugin(mod: unknown): Plugin | undefined {
  const module = mod as { default?: unknown; plugin?: unknown };
  for (const candidate of [module?.default, module?.plugin]) {
    if (is_object_with_name(candidate) === true) {
      return candidate;
    }
  }
  if (is_plugin_module(mod) === true) {
    return mod;
  }
  return undefined;
}

async function load_one_entry(entry: string, base_dir: string): Promise<LoadedPlugin> {
  const abs = path.resolve(base_dir, entry);
  if (MODULE_QUERY.test(abs) === false) {
    throw new Error(`plugin_entry_not_a_module: ${entry}`);
  }
  const mod: unknown = await import(pathToFileURL(abs).href);
  const plugin = extract_plugin(mod);
  if (plugin === undefined) {
    throw new Error(`plugin_module_has_no_plugin_export: ${entry}`);
  }
  return { plugin, entry };
}

/**
 * Load plugins from explicit entry paths (relative to `base_dir` or absolute).
 * Broken imports, missing exports, and duplicate names become error entries;
 * nothing is thrown for a bad plugin.
 */
export async function load_plugins(
  entries: readonly string[],
  base_dir: string,
): Promise<{ plugins: LoadedPlugin[]; errors: PluginLoadError[] }> {
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.length === 0) {
      continue;
    }
    try {
      const loaded = await load_one_entry(entry, base_dir);
      if (seen.has(loaded.plugin.name) === true) {
        errors.push({ entry, error_message: `duplicate_plugin_name: ${loaded.plugin.name}` });
        continue;
      }
      seen.add(loaded.plugin.name);
      plugins.push(loaded);
    } catch (error) {
      errors.push({ entry, error_message: describe_error(error) });
    }
  }
  return { plugins, errors };
}

/** Joined one-liner per load error, for a single warn log. */
export function plugin_errors_summary(errors: readonly PluginLoadError[]): string {
  return errors
    .map((error) => `${error.entry}: ${error.error_message}`)
    .join("; ");
}