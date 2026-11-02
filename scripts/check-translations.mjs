import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';

const dictionaries = await Promise.all(['en', 'backend-en', 'domain-en'].map(async name => JSON.parse(await readFile(`src/i18n/${name}.json`, 'utf8'))));
const dictionary = Object.assign({}, ...dictionaries);
const keys = new Set();
async function visitDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await visitDirectory(path);
    else if (path.endsWith('.ts')) {
      const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) keys.add(node.arguments[0].text);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}
await visitDirectory('src');
const missing = [...keys].filter(key => !dictionary[key]);
const slots = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort().join(',');
const invalid = Object.entries(dictionary).filter(([key, value]) => typeof value !== 'string' || !value.trim() || slots(key) !== slots(value));
if (missing.length || invalid.length) throw new Error(`Incomplete translations. Missing: ${JSON.stringify(missing)}. Invalid placeholders: ${JSON.stringify(invalid.map(([key]) => key))}`);
console.log(`${keys.size} translated message keys checked; all placeholders preserved.`);
