/**
 * Extract documented jq recipes and run them. jq is a user tool; if it
 * is missing, callers compare the filter text to the golden file instead.
 */
import { spawn } from "node:child_process";

export interface Recipe {
  id: string;
  flags: string[];
  filter: string;
}

export function extract_recipes(markdown: string): Recipe[] {
  const recipes: Recipe[] = [];
  const blocks = markdown.matchAll(/```bash\n([\s\S]*?)```/g);
  for (const block of blocks) {
    const recipe = recipe_from_block(block[1] ?? "");
    if (recipe !== undefined) {
      recipes.push(recipe);
    }
  }
  return recipes;
}

function recipe_from_block(body: string): Recipe | undefined {
  const id = /# \(([^)]+)\)/.exec(body)?.[1];
  const parsed = parse_jq(body);
  if (id === undefined || parsed === undefined) {
    return undefined;
  }
  return { id, flags: parsed.flags, filter: parsed.filter };
}

function parse_jq(body: string): { flags: string[]; filter: string } | undefined {
  const flattened = body.replace(/\\\n/g, " ");
  const start = flattened.indexOf("jq ");
  if (start === -1) {
    return undefined;
  }
  const after = flattened.slice(start + "jq ".length);
  const quote = after.indexOf("'");
  const end = quote === -1 ? -1 : after.indexOf("'", quote + 1);
  if (quote === -1 || end === -1) {
    return undefined;
  }
  const flag_text = after.slice(0, quote).trim();
  const flags = flag_text.length === 0 ? [] : flag_text.split(/\s+/);
  return { flags, filter: after.slice(quote + 1, end).trim() };
}

export function run_jq(recipe: Recipe, files: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("jq", [...recipe.flags, recipe.filter, ...files], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `jq exited ${code ?? "unknown"}`));
        return;
      }
      resolve(stdout);
    });
  });
}
