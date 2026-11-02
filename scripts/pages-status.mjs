import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { repository } from './distribution.mjs';

export const pagesSetupNote = 'The static installation site was built, but GitHub Pages is not configured for Actions deployment. A repository administrator must open Settings → Pages → Build and deployment → Source → GitHub Actions, then run the Publish installation site workflow again. No public website is claimed until deployment succeeds.';

export async function probePages(token, fetcher = fetch) {
  if (!token) throw new Error('A repository read token is required to inspect Pages configuration.');
  const response = await fetcher(`https://api.github.com/repos/${repository}/pages`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Pages configuration could not be checked (${response.status}); this is not treated as an unconfigured site.`);
  const data = await response.json();
  return data.build_type === 'workflow';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const configured = await probePages(process.env.GH_TOKEN);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `configured=${configured}\n`);
    if (!configured) {
      console.log(pagesSetupNote);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## One-time Pages setup required\n\n${pagesSetupNote}\n\nThe generated site is retained as the github-pages workflow artifact.\n`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
