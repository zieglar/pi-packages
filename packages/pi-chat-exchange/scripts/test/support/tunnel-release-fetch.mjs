// Only the uncontrollable public API boundary is mocked; release gate code runs unchanged.
const version = '0.0.19', commit = 'a'.repeat(40);
globalThis.fetch = async url => {
  if (url === 'https://api.github.com/repos/openai/tunnel-client/releases/latest') return { ok: true, json: async () => ({ tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-10-30T20:26:10Z', html_url: `https://github.com/openai/tunnel-client/releases/tag/v${version}` }) };
  if (url === `https://api.github.com/repos/openai/tunnel-client/commits/v${version}`) return { ok: true, json: async () => ({ sha: commit }) };
  throw new Error('Unexpected network request in release regression');
};
