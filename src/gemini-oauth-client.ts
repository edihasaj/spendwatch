// The Gemini CLI's installed-app OAuth client, read from the installed CLI at run time.
//
// Refreshing a Gemini sign-in needs the client the CLI itself signs in with. Google ships it inside the
// open-source CLI bundle as a public installed-app client: it names the application, not a person. Spendwatch
// does not carry a copy in its source. It reads the pair from the `gemini` command that is installed on this
// Mac, which any Gemini sign-in already needs. No CLI means no refresh: the read reports the fixed
// "unavailable" class and a still-valid access token keeps working without one.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

export interface GeminiOAuthClient {
  id: string;
  secret: string;
}

const ID_PATTERN = /\b\d{6,20}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com\b/;
const SECRET_PATTERN = /\bGOCSPX-[A-Za-z0-9_-]{20,40}\b/;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/** Where a `gemini` command lives: PATH first, then the installer locations a launchd PATH usually lacks. */
function commandCandidates(): string[] {
  const fromPath = (process.env.PATH || "").split(delimiter).filter(Boolean).map((dir) => join(dir, "gemini"));
  const home = homedir();
  return [...fromPath, join(home, ".local/share/node/current/bin/gemini"), "/opt/homebrew/bin/gemini",
    join(home, ".local/bin/gemini"), "/usr/local/bin/gemini"];
}

/** The `@google/gemini-cli` package directory that owns a resolved command, if any. */
function packageOf(command: string): string | undefined {
  let dir: string;
  try { dir = dirname(realpathSync(command)); } catch { return undefined; }
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
        if (name === "@google/gemini-cli") return dir;
      } catch { /* not ours */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Scans one package's bundle for the client id and secret that sit together in the CLI's OAuth module. */
export function clientFromPackage(packageDir: string): GeminiOAuthClient | undefined {
  const bundle = join(packageDir, "bundle");
  let files: string[];
  try { files = readdirSync(bundle).filter((name) => name.endsWith(".js")).sort(); } catch { return undefined; }
  for (const name of files) {
    const path = join(bundle, name);
    try { if (!statSync(path).isFile() || statSync(path).size > MAX_CHUNK_BYTES) continue; } catch { continue; }
    let text: string;
    try {
      const fd = openSync(path, "r");
      try { text = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
    } catch { continue; }
    const secret = SECRET_PATTERN.exec(text);
    if (!secret) continue;
    const id = ID_PATTERN.exec(text);
    if (id) return { id: id[0], secret: secret[0] };
  }
  return undefined;
}

let cached: GeminiOAuthClient | null | undefined;

/** The installed CLI's OAuth client, found once per process; undefined when no Gemini CLI is installed. */
export function installedGeminiOAuthClient(): GeminiOAuthClient | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = null;
  const seen = new Set<string>();
  for (const command of commandCandidates()) {
    const dir = packageOf(command);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const client = clientFromPackage(dir);
    if (client) { cached = client; break; }
  }
  return cached ?? undefined;
}
