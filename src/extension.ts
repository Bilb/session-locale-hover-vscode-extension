import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface PluralForms {
  one?: string;
  other: string;
}

type TokenValue = string | PluralForms;
type TokenMap = Record<string, TokenValue>;

let tokenMap: TokenMap = {};
let fileWatcher: vscode.FileSystemWatcher | undefined;

async function getEnglishTsPath(): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  const config = vscode.workspace.getConfiguration('sessionLocaleHover');
  const configuredPath = config.get<string>('englishTsPath');

  // If the user explicitly set a path, honour it
  if (configuredPath) {
    return path.join(workspaceFolders[0].uri.fsPath, configuredPath);
  }

  // Otherwise auto-discover the first english.ts in the workspace
  const found = await vscode.workspace.findFiles('**/english.ts', '**/node_modules/**', 1);
  return found[0]?.fsPath;
}

function unescapeString(raw: string): string {
  return raw
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

/**
 * Convert basic HTML found in translation strings to something readable in markdown.
 */
function htmlToMarkdown(str: string): string {
  return str
    .replace(/<b>/g, '**')
    .replace(/<\/b>/g, '**')
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(/<[^>]+>/g, ''); // strip remaining tags
}

function parseEnglishTs(content: string): TokenMap {
  const map: TokenMap = {};

  // --- Simple entries: "  key: 'value'" or '  key: "value"' ---
  // These cover enSimpleNoArgs and enSimpleWithArgs.
  // The indent is exactly 2 spaces; plural sub-keys (one/other) use 4 spaces.
  const simpleRe = /^ {2}(\w+):\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gm;
  let m: RegExpExecArray | null;
  while ((m = simpleRe.exec(content)) !== null) {
    const key = m[1];
    const raw = m[2] !== undefined ? m[2] : m[3];
    map[key] = unescapeString(raw);
  }

  // --- Plural entries: "  key: {\n    one: '...', other: '...' }" ---
  // Match the block lazily so we don't swallow the whole file.
  const pluralBlockRe = /^ {2}(\w+):\s*\{([\s\S]*?)\n {2}\}/gm;
  while ((m = pluralBlockRe.exec(content)) !== null) {
    const key = m[1];
    const block = m[2];

    const oneM = / {4}one:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/m.exec(block);
    const otherM = / {4}other:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/m.exec(block);

    if (otherM) {
      const plural: PluralForms = {
        other: unescapeString(otherM[1] !== undefined ? otherM[1] : otherM[2]),
      };
      if (oneM) {
        plural.one = unescapeString(oneM[1] !== undefined ? oneM[1] : oneM[2]);
      }
      map[key] = plural;
    }
  }

  return map;
}

async function loadTokenMap(): Promise<void> {
  const englishTsPath = await getEnglishTsPath();
  if (!englishTsPath) {
    return;
  }
  try {
    const content = fs.readFileSync(englishTsPath, 'utf-8');
    tokenMap = parseEnglishTs(content);
    console.log(`[session-locale-hover] Loaded ${Object.keys(tokenMap).length} tokens from ${englishTsPath}`);
  } catch (err) {
    console.error('[session-locale-hover] Failed to read english.ts:', err);
  }
}

interface TokenRange {
  name: string;
  /** inclusive index of opening quote */
  quoteStart: number;
  /** inclusive index of closing quote */
  quoteEnd: number;
}

/**
 * Scan a single line of source code and return all localization token strings
 * that appear in it, together with their character ranges.
 *
 * Patterns detected:
 *   tr('tokenName')                – first argument of the tr() helper
 *   tr('tokenName', { ... })       – same, with args
 *   token: 'tokenName'             – token property in any object literal
 *   { token: 'tokenName' }         – JSX attribute or inline object
 */
function findTokensInLine(line: string): TokenRange[] {
  const results: TokenRange[] = [];

  const patterns: RegExp[] = [
    // tr('tokenName') or tr("tokenName") – first arg only
    /\btr\(\s*(['"])(\w+)\1/g,
    // tStripped('tokenName') or tStripped("tokenName") – first arg only
    /\btStripped\(\s*(['"])(\w+)\1/g,
    // token: 'tokenName' or token: "tokenName"
    /\btoken\s*:\s*(['"])(\w+)\1/g,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const quoteChar = m[1];
      const tokenName = m[2];
      // The opening quote is the first occurrence of quoteChar in match[0]
      const openQuoteOffset = m[0].indexOf(quoteChar);
      const quoteStart = m.index + openQuoteOffset;
      const quoteEnd = quoteStart + 1 + tokenName.length; // index of closing quote
      results.push({ name: tokenName, quoteStart, quoteEnd });
    }
  }

  return results;
}

function findTokenAtPosition(line: string, col: number): string | null {
  for (const t of findTokensInLine(line)) {
    // Include quote characters in the hover trigger zone
    if (col >= t.quoteStart && col <= t.quoteEnd) {
      return t.name;
    }
  }
  return null;
}

function buildHoverContent(tokenName: string, value: TokenValue): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;

  if (typeof value === 'string') {
    const display = htmlToMarkdown(value);
    md.appendMarkdown(`**\`${tokenName}\`**\n\n`);
    md.appendMarkdown(display);
  } else {
    // Plural
    md.appendMarkdown(`**\`${tokenName}\`** *(plural)*\n\n`);
    if (value.one !== undefined) {
      md.appendMarkdown(`**one:** ${htmlToMarkdown(value.one)}  \n`);
    }
    md.appendMarkdown(`**other:** ${htmlToMarkdown(value.other)}`);
  }

  return md;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[session-locale-hover] Activating…');

  await loadTokenMap();

  // Watch english.ts for changes (it is auto-generated)
  const englishTsPath = await getEnglishTsPath();
  if (englishTsPath) {
    const watchPattern = new vscode.RelativePattern(
      path.dirname(englishTsPath),
      path.basename(englishTsPath)
    );
    fileWatcher = vscode.workspace.createFileSystemWatcher(watchPattern);
    fileWatcher.onDidChange(loadTokenMap);
    fileWatcher.onDidCreate(loadTokenMap);
    context.subscriptions.push(fileWatcher);
  }

  // Re-read when the user changes the configured path
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('sessionLocaleHover.englishTsPath')) {
        loadTokenMap();
      }
    })
  );

  const hoverProvider = vscode.languages.registerHoverProvider(
    [
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'typescriptreact' },
    ],
    {
      provideHover(document, position): vscode.Hover | undefined {
        const line = document.lineAt(position.line).text;
        const tokenName = findTokenAtPosition(line, position.character);

        if (!tokenName) {
          return undefined;
        }

        const value = tokenMap[tokenName];
        if (value === undefined) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`**\`${tokenName}\`** — *not found in english.ts*`);
          return new vscode.Hover(md);
        }

        return new vscode.Hover(buildHoverContent(tokenName, value));
      },
    }
  );

  context.subscriptions.push(hoverProvider);
  console.log('[session-locale-hover] Ready');
}

export function deactivate(): void {
  fileWatcher?.dispose();
}
