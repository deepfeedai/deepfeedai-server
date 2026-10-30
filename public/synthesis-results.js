/* Shared safe synthesis diagnostics. Never return provider payloads or credentials. */
(function(root) {
  'use strict';
  const messages = {
    storage: 'Article storage is missing a required field. Contact your administrator.',
    budget: 'AI generation is unavailable or the configured budget was exhausted.',
    empty: 'The AI returned no article content.',
    short: 'The generated article was too short to save.',
    provider: 'The AI provider rejected the request. Check provider settings and server logs.',
    failed: 'Synthesis failed. Check server logs for details.'
  };
  function classifyError(error) {
    const text = String(error && error.message || '');
    let code = 'failed';
    if ((error && error.code === '42703') || /^column "[a-z_]+" of relation "[a-z_]+" does not exist$/.test(text)) code = 'storage';
    else if (text === 'Budget exceeded or AI unavailable') code = 'budget';
    else if (text === 'AI returned no content') code = 'empty';
    else if (/^Generated content too short \(\d+ words\)\./.test(text)) code = 'short';
    else if (/^(OpenAI|OpenRouter|Anthropic|Gemini) API error \d{3}\b/.test(text)) code = 'provider';
    return { code, message: messages[code] };
  }
  function count(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
  function skipReason(value) {
    if (value === 'Writer not found') return 'Writer no longer exists.';
    if (value === 'No recent articles found') return 'No recent source articles were available.';
    if (value === 'No clusters met minimum size') return 'No clusters met the minimum source count.';
    if (/^Cooldown: last synthesis \d+h ago \(use \?force=true to override\)$/.test(value)) return 'Writer is on cooldown.';
    if (/^Writer budget reached \(\d+\/\d+ today\)$/.test(value)) return 'Writer daily article budget was reached.';
    return 'The run was skipped. Check server logs for details.';
  }
  function summarize(results, selected) {
    let generated = 0;
    const details = [];
    for (const result of results) {
      generated += count(result.generated);
      const prefix = count(Number(result.writerId)) ? `Writer ${Number(result.writerId)}: ` : '';
      if (result.error) details.push(prefix + 'Request failed. Check your connection, permissions or server logs.');
      if (result.skipped) details.push(prefix + skipReason(String(result.skipped)));
      if (count(result.skippedDedup)) details.push(prefix + `${count(result.skippedDedup)} cluster(s) skipped as duplicates.`);
      if (count(result.skippedBlocked)) details.push(prefix + `${count(result.skippedBlocked)} cluster(s) blocked by the topic watchlist.`);
      if (count(result.skippedBudget)) details.push(prefix + `${count(result.skippedBudget)} cluster(s) skipped because the writer daily article budget was reached.`);
      if (Array.isArray(result.errorDetails) && result.errorDetails.length) {
        for (const error of result.errorDetails) {
          const index = Number.isSafeInteger(error.clusterIndex) && error.clusterIndex >= 0 ? `Cluster ${error.clusterIndex + 1}: ` : '';
          const message = Object.prototype.hasOwnProperty.call(messages, error.code) ? messages[error.code] : messages.failed;
          details.push(prefix + index + message);
        }
      } else if (Array.isArray(result.errors)) {
        // Older backends can return raw errors. Do not display their contents.
        for (const ignored of result.errors) details.push(prefix + messages.failed);
      }
      if (!result.generated && !result.error && !result.skipped && !result.skippedDedup && !result.skippedBlocked && !result.skippedBudget && !result.errors?.length && !result.errorDetails?.length)
        details.push(prefix + 'No article was saved. Refresh the queue and check server logs.');
    }
    return { generated, hasIssues: details.length > 0, details,
      title: `Generated ${generated} article(s) from ${count(selected)} selected cluster(s)` + (details.length ? `; ${details.length} issue(s) or skip reason(s).` : '.') };
  }
  function render(container, summary) {
    container.replaceChildren();
    const doc = container.ownerDocument;
    const title = doc.createElement('p'); title.textContent = summary.title; container.appendChild(title);
    if (summary.details.length) {
      const list = doc.createElement('ul');
      for (const text of summary.details) { const item = doc.createElement('li'); item.textContent = text; list.appendChild(item); }
      container.appendChild(list);
    }
    container.hidden = false;
  }
  const api = { classifyError, summarize, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SynthesisResults = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
